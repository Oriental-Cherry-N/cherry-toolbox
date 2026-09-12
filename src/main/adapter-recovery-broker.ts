import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { writeJsonAtomically } from './file-store';
import { isSafeAdapterId, runElevatedPowerShell } from './network';
import type { AdapterRecoveryRecord } from './recovery';

const BROKER_DIRECTORY_NAME = 'adapter-recovery-broker';
const CURRENT_FILE_NAME = 'current.json';
const COMMAND_FILE_NAME = 'command.json';
const HEARTBEAT_FILE_NAME = 'heartbeat.txt';
const STATE_FILE_NAME = 'state.json';
const WATCHDOG_FILE_NAME = 'watchdog.ps1';
const BROKER_VERSION = 1;
const POLL_INTERVAL_MS = 200;
const APPLY_TIMEOUT_MS = 30_000;
const RESTORE_TIMEOUT_MS = 120_000;

type BrokerPhase =
  | 'active'
  | 'error'
  | 'restored'
  | 'restoring'
  | 'starting';

interface BrokerDescriptor {
  directory: string;
  sessionId: string;
  token: string;
  version: 1;
}

interface BrokerCommand {
  action: 'apply' | 'restore';
  records: AdapterRecoveryRecord[];
  sequence: number;
  sessionId: string;
  token: string;
  version: 1;
}

interface BrokerState {
  helperPid: number;
  lastError: string | null;
  phase: BrokerPhase;
  sequence: number;
  sessionId: string;
  token: string;
  updatedAt: string;
  version: 1;
}

interface ActiveBrokerSession extends BrokerDescriptor {
  records: AdapterRecoveryRecord[];
  sequence: number;
}

interface AdapterRecoveryBrokerOperations {
  launch: (script: string) => Promise<void>;
  now: () => string;
}

const WATCHDOG_SCRIPT = String.raw`
param(
  [Parameter(Mandatory = $true)][string]$SessionDirectory,
  [Parameter(Mandatory = $true)][int]$ParentPid,
  [Parameter(Mandatory = $true)][string]$SessionId,
  [Parameter(Mandatory = $true)][string]$Token
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$commandPath = Join-Path $SessionDirectory 'command.json'
$heartbeatPath = Join-Path $SessionDirectory 'heartbeat.txt'
$statePath = Join-Path $SessionDirectory 'state.json'
$script:sequence = 0
$script:records = @{}

function Write-BrokerState([string]$Phase, [AllowNull()][string]$LastError) {
  $state = [ordered]@{
    version = 1
    sessionId = $SessionId
    token = $Token
    helperPid = $PID
    sequence = $script:sequence
    phase = $Phase
    lastError = $LastError
    updatedAt = [DateTime]::UtcNow.ToString('o')
  }
  $temporary = $statePath + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  [IO.File]::WriteAllText(
    $temporary,
    ($state | ConvertTo-Json -Compress -Depth 8),
    (New-Object Text.UTF8Encoding($false))
  )
  Move-Item -LiteralPath $temporary -Destination $statePath -Force
}

function Test-ParentHealthy {
  if ($null -eq (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) {
    return $false
  }
  if (-not (Test-Path -LiteralPath $heartbeatPath -PathType Leaf)) {
    return $false
  }
  $age = [DateTime]::UtcNow - (Get-Item -LiteralPath $heartbeatPath).LastWriteTimeUtc
  return $age.TotalSeconds -le 10
}

function Resolve-Adapter($Record) {
  $adapter = $null
  $identifier = [string]$Record.adapterId
  if ($identifier -match '^guid:([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})$') {
    $requestedGuid = [Guid]$Matches[1]
    $adapter = @(Get-NetAdapter -Name '*' -IncludeHidden -ErrorAction Stop |
      Where-Object { $_.InterfaceGuid -eq $requestedGuid })[0]
  } elseif ($identifier -match '^name:[a-f0-9]{32}$') {
    $requestedName = [string]$Record.adapterName
    $adapter = @(Get-NetAdapter -Name '*' -IncludeHidden -ErrorAction Stop |
      Where-Object { $_.Name -ceq $requestedName })[0]
  } else {
    throw 'The recovery broker received an invalid adapter identifier.'
  }
  if ($null -eq $adapter) {
    throw "The network adapter '$([string]$Record.adapterName)' is unavailable."
  }
  return $adapter
}

function Set-AdapterEnabled($Record, [bool]$Enabled) {
  $adapter = Resolve-Adapter $Record
  $isEnabled = $adapter.AdminStatus.ToString() -eq 'Up'
  if ($isEnabled -eq $Enabled) { return }
  if ($Enabled) {
    $adapter | Enable-NetAdapter -Confirm:$false -ErrorAction Stop
  } else {
    $adapter | Disable-NetAdapter -Confirm:$false -ErrorAction Stop
  }
}

function Merge-Records($Records) {
  $items = @($Records)
  if ($items.Count -gt 64) { throw 'Too many recovery records were supplied.' }
  foreach ($record in $items) {
    if ($null -eq $record -or
        [string]::IsNullOrWhiteSpace([string]$record.adapterId) -or
        [string]::IsNullOrWhiteSpace([string]$record.adapterName) -or
        $record.originalEnabled -isnot [bool] -or
        $record.requestedEnabled -isnot [bool]) {
      throw 'The recovery broker received an invalid recovery record.'
    }
    $key = [string]$record.adapterId
    if ($script:records.ContainsKey($key) -and
        [bool]$script:records[$key].originalEnabled -ne [bool]$record.originalEnabled) {
      throw 'An adapter original state changed within one broker session.'
    }
    $script:records[$key] = $record
  }
}

function Restore-UntilSuccessful([AllowNull()][string]$Reason) {
  while ($true) {
    try {
      Write-BrokerState 'restoring' $Reason
      $failures = @()
      foreach ($record in @($script:records.Values)) {
        try { Set-AdapterEnabled $record ([bool]$record.originalEnabled) }
        catch { $failures += $_.Exception.Message }
      }
      if ($failures.Count -gt 0) { throw ($failures -join '; ') }
      Write-BrokerState 'restored' $null
      exit 0
    } catch {
      Write-BrokerState 'error' $_.Exception.Message
      Start-Sleep -Seconds 2
    }
  }
}

Write-BrokerState 'starting' $null
while ($true) {
  try {
    if (-not (Test-ParentHealthy)) {
      Restore-UntilSuccessful 'The Cherry Toolbox process or heartbeat stopped.'
    }
    if (Test-Path -LiteralPath $commandPath -PathType Leaf) {
      $command = Get-Content -LiteralPath $commandPath -Raw -Encoding UTF8 |
        ConvertFrom-Json -ErrorAction Stop
      if ([int]$command.sequence -gt $script:sequence) {
        if ([int]$command.version -ne 1 -or
            [string]$command.sessionId -cne $SessionId -or
            [string]$command.token -cne $Token) {
          throw 'The recovery broker command failed authentication.'
        }
        $script:sequence = [int]$command.sequence
        Merge-Records $command.records
        switch ([string]$command.action) {
          'apply' {
            if (-not (Test-ParentHealthy)) {
              Restore-UntilSuccessful 'The parent stopped before an adapter change.'
            }
            foreach ($record in @($command.records)) {
              Set-AdapterEnabled $record ([bool]$record.requestedEnabled)
            }
            Write-BrokerState 'active' $null
          }
          'restore' { Restore-UntilSuccessful $null }
          default { throw 'The recovery broker received an invalid action.' }
        }
      }
    }
  } catch {
    $failure = $_.Exception.Message
    Write-BrokerState 'error' $failure
    Restore-UntilSuccessful $failure
  }
  Start-Sleep -Milliseconds 500
}
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isToken(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function isSessionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f-]{27,35}$/iu.test(value)
  );
}

function withinDirectory(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function parseDescriptor(value: unknown, rootDirectory: string): BrokerDescriptor {
  if (
    !isRecord(value) ||
    value.version !== BROKER_VERSION ||
    !isSessionId(value.sessionId) ||
    !isToken(value.token) ||
    typeof value.directory !== 'string' ||
    !path.isAbsolute(value.directory) ||
    !withinDirectory(rootDirectory, value.directory) ||
    path.basename(value.directory) !== value.sessionId
  ) {
    throw new Error('The adapter recovery broker descriptor is invalid.');
  }
  return {
    directory: path.resolve(value.directory),
    sessionId: value.sessionId,
    token: value.token,
    version: 1,
  };
}

function parseState(value: unknown, session: BrokerDescriptor): BrokerState {
  const phases = new Set<BrokerPhase>([
    'active',
    'error',
    'restored',
    'restoring',
    'starting',
  ]);
  if (
    !isRecord(value) ||
    value.version !== BROKER_VERSION ||
    value.sessionId !== session.sessionId ||
    value.token !== session.token ||
    typeof value.helperPid !== 'number' ||
    !Number.isSafeInteger(value.helperPid) ||
    value.helperPid < 1 ||
    typeof value.sequence !== 'number' ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 0 ||
    typeof value.phase !== 'string' ||
    !phases.has(value.phase as BrokerPhase) ||
    (value.lastError !== null && typeof value.lastError !== 'string') ||
    typeof value.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.updatedAt))
  ) {
    throw new Error('The adapter recovery broker returned invalid state.');
  }
  return {
    helperPid: value.helperPid,
    lastError: value.lastError,
    phase: value.phase as BrokerPhase,
    sequence: value.sequence,
    sessionId: value.sessionId,
    token: value.token,
    updatedAt: value.updatedAt,
    version: 1,
  };
}

function copyRecords(
  records: readonly AdapterRecoveryRecord[],
): AdapterRecoveryRecord[] {
  if (records.length === 0 || records.length > 64) {
    throw new Error('The adapter recovery broker requires 1 to 64 records.');
  }
  const identifiers = new Set<string>();
  return records.map((record) => {
    if (
      !isSafeAdapterId(record.adapterId) ||
      record.adapterName.trim().length === 0 ||
      record.adapterName.length > 256 ||
      typeof record.originalEnabled !== 'boolean' ||
      typeof record.requestedEnabled !== 'boolean' ||
      identifiers.has(record.adapterId)
    ) {
      throw new Error('The adapter recovery broker received invalid records.');
    }
    identifiers.add(record.adapterId);
    return { ...record, adapterName: record.adapterName.trim() };
  });
}

function launchScript(session: BrokerDescriptor): string {
  const encodedWatcherPath = Buffer.from(
    path.join(session.directory, WATCHDOG_FILE_NAME),
    'utf8',
  ).toString('base64');
  const encodedDirectory = Buffer.from(session.directory, 'utf8').toString(
    'base64',
  );
  return String.raw`
$ErrorActionPreference = 'Stop'
$watchdogPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedWatcherPath}'))
$sessionDirectory = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedDirectory}'))
$powershell = Join-Path $PSHOME 'powershell.exe'
$arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $watchdogPath + '" -SessionDirectory "' + $sessionDirectory + '" -ParentPid ${process.pid} -SessionId ${session.sessionId} -Token ${session.token}'
Start-Process -FilePath $powershell -ArgumentList $arguments -WindowStyle Hidden | Out-Null
`;
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class AdapterRecoveryBroker {
  private readonly currentPath: string;
  private readonly operations: AdapterRecoveryBrokerOperations;
  private readonly rootDirectory: string;
  private heartbeat: NodeJS.Timeout | null = null;
  private session: ActiveBrokerSession | null = null;

  constructor(
    dataDirectory: string,
    operations: Partial<AdapterRecoveryBrokerOperations> = {},
  ) {
    this.rootDirectory = path.join(dataDirectory, BROKER_DIRECTORY_NAME);
    this.currentPath = path.join(this.rootDirectory, CURRENT_FILE_NAME);
    this.operations = {
      launch: runElevatedPowerShell,
      now: () => new Date().toISOString(),
      ...operations,
    };
  }

  get isActive(): boolean {
    return this.session !== null;
  }

  private commandPath(session: BrokerDescriptor): string {
    return path.join(session.directory, COMMAND_FILE_NAME);
  }

  private heartbeatPath(session: BrokerDescriptor): string {
    return path.join(session.directory, HEARTBEAT_FILE_NAME);
  }

  private statePath(session: BrokerDescriptor): string {
    return path.join(session.directory, STATE_FILE_NAME);
  }

  private async pulse(session: BrokerDescriptor): Promise<void> {
    await writeFile(this.heartbeatPath(session), this.operations.now(), {
      encoding: 'utf8',
      flush: true,
    });
  }

  private startHeartbeat(session: BrokerDescriptor): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      void this.pulse(session).catch(() => undefined);
    }, 1_000);
    this.heartbeat.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private async writeCommand(
    session: ActiveBrokerSession,
    action: BrokerCommand['action'],
  ): Promise<void> {
    const command: BrokerCommand = {
      action,
      records: copyRecords(session.records),
      sequence: session.sequence,
      sessionId: session.sessionId,
      token: session.token,
      version: 1,
    };
    await writeJsonAtomically(this.commandPath(session), command);
  }

  private async readState(session: BrokerDescriptor): Promise<BrokerState | null> {
    try {
      return parseState(await readJson(this.statePath(session)), session);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async waitFor(
    session: BrokerDescriptor,
    timeout: number,
    accept: (state: BrokerState) => boolean,
  ): Promise<BrokerState> {
    const deadline = Date.now() + timeout;
    let lastState: BrokerState | null = null;
    while (Date.now() < deadline) {
      const state = await this.readState(session);
      if (state) {
        lastState = state;
        if (accept(state)) return state;
      }
      await delay(POLL_INTERVAL_MS);
    }
    throw new Error(
      lastState?.lastError ??
        'The independent adapter recovery broker did not finish in time.',
    );
  }

  private async createSession(
    records: readonly AdapterRecoveryRecord[],
  ): Promise<ActiveBrokerSession> {
    const sessionId = randomUUID();
    const directory = path.join(this.rootDirectory, sessionId);
    const session: ActiveBrokerSession = {
      directory,
      records: copyRecords(records),
      sequence: 1,
      sessionId,
      token: randomBytes(32).toString('hex'),
      version: 1,
    };
    await mkdir(this.rootDirectory, { recursive: true });
    await mkdir(directory, { recursive: false });
    await writeFile(path.join(directory, WATCHDOG_FILE_NAME), WATCHDOG_SCRIPT, {
      encoding: 'utf8',
      flag: 'wx',
      flush: true,
    });
    await this.pulse(session);
    await this.writeCommand(session, 'apply');
    await writeJsonAtomically(this.currentPath, {
      directory: session.directory,
      sessionId: session.sessionId,
      token: session.token,
      version: 1,
    } satisfies BrokerDescriptor);
    return session;
  }

  async apply(records: readonly AdapterRecoveryRecord[]): Promise<void> {
    if (!this.session) {
      const session = await this.createSession(records);
      this.session = session;
      this.startHeartbeat(session);
      try {
        await this.operations.launch(launchScript(session));
        const state = await this.waitFor(
          session,
          APPLY_TIMEOUT_MS,
          (candidate) =>
            candidate.sequence >= session.sequence &&
            (candidate.phase === 'active' ||
              candidate.phase === 'error' ||
              candidate.phase === 'restored'),
        );
        if (state.phase !== 'active' || state.lastError) {
          throw new Error(
            state.lastError ?? 'The adapter recovery broker rejected the change.',
          );
        }
        return;
      } catch (error) {
        this.stopHeartbeat();
        throw error;
      }
    }

    this.session.records = copyRecords(records);
    this.session.sequence += 1;
    await this.pulse(this.session);
    await this.writeCommand(this.session, 'apply');
    const state = await this.waitFor(
      this.session,
      APPLY_TIMEOUT_MS,
      (candidate) =>
        candidate.sequence >= (this.session?.sequence ?? Number.MAX_SAFE_INTEGER) &&
        (candidate.phase === 'active' ||
          candidate.phase === 'error' ||
          candidate.phase === 'restored'),
    );
    if (state.phase !== 'active' || state.lastError) {
      throw new Error(
        state.lastError ?? 'The adapter recovery broker rejected the change.',
      );
    }
  }

  private async loadCurrent(): Promise<ActiveBrokerSession | null> {
    try {
      const descriptor = parseDescriptor(
        await readJson(this.currentPath),
        this.rootDirectory,
      );
      return { ...descriptor, records: [], sequence: 0 };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async cleanup(session: BrokerDescriptor): Promise<void> {
    if (!withinDirectory(this.rootDirectory, session.directory)) {
      throw new Error('Refusing to remove an unsafe broker directory.');
    }
    await rm(session.directory, { force: true, recursive: true });
    await rm(this.currentPath, { force: true });
  }

  async recoverOrphanedSession(): Promise<void> {
    const session = await this.loadCurrent();
    if (!session) return;
    const state = await this.readState(session);
    if (!state) {
      // No helper ever acknowledged this session, so no mutation is proven.
      await this.cleanup(session);
      return;
    }
    if (state.phase === 'restored') {
      await this.cleanup(session);
      return;
    }
    try {
      process.kill(state.helperPid, 0);
    } catch {
      // The durable v3 journal remains authoritative for startup recovery.
      await this.cleanup(session);
      return;
    }
    this.session = { ...session, sequence: state.sequence };
    await this.restore();
  }

  async restore(): Promise<boolean> {
    const session = this.session ?? (await this.loadCurrent());
    if (!session) return false;
    const state = await this.readState(session);
    if (state?.phase === 'restored') {
      this.stopHeartbeat();
      this.session = null;
      await this.cleanup(session);
      return true;
    }
    if (!state) {
      this.stopHeartbeat();
      this.session = null;
      await this.cleanup(session);
      return false;
    }
    try {
      process.kill(state.helperPid, 0);
    } catch {
      this.stopHeartbeat();
      this.session = null;
      await this.cleanup(session);
      return false;
    }
    session.sequence = Math.max(session.sequence, state.sequence) + 1;
    if (session.records.length === 0) {
      // The helper already holds the authenticated originals in memory.
      const command: BrokerCommand = {
        action: 'restore',
        records: [],
        sequence: session.sequence,
        sessionId: session.sessionId,
        token: session.token,
        version: 1,
      };
      await writeJsonAtomically(this.commandPath(session), command);
    } else {
      await this.writeCommand(session, 'restore');
    }
    const restored = await this.waitFor(
      session,
      RESTORE_TIMEOUT_MS,
      (candidate) =>
        candidate.sequence >= session.sequence && candidate.phase === 'restored',
    );
    if (restored.lastError) throw new Error(restored.lastError);
    this.stopHeartbeat();
    this.session = null;
    await this.cleanup(session);
    return true;
  }

  async shutdown(): Promise<void> {
    await this.restore();
  }
}

export const ADAPTER_RECOVERY_WATCHDOG_SCRIPT = WATCHDOG_SCRIPT;
export const parseAdapterRecoveryBrokerState = parseState;
