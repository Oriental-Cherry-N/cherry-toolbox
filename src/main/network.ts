import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

const MAX_OUTPUT_BYTES = 1024 * 1024;
const QUERY_TIMEOUT_MS = 15_000;
const ELEVATION_TIMEOUT_MS = 120_000;
const GUID_PATTERN =
  /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;

const LIST_ADAPTERS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$items = @(
  Get-NetAdapter -Name '*' -ErrorAction Stop |
    Sort-Object -Property Name |
    ForEach-Object {
      [PSCustomObject]@{
        id = $_.InterfaceGuid.ToString()
        name = $_.Name
        description = $_.InterfaceDescription
        ifIndex = $_.ifIndex
        status = $_.Status.ToString()
        adminStatus = $_.AdminStatus.ToString()
        mediaState = $_.MediaConnectionState.ToString()
      }
    }
)
ConvertTo-Json -InputObject $items -Compress -Depth 3
`;

interface CommandOptions {
  timeout: number;
}

interface StdinCommandOptions extends CommandOptions {
  timeoutMessage: string;
}

interface StdinCommandResult {
  exitCode: number | null;
  stderr: string;
  stdout: string;
}

interface ElevationPayload {
  action: AdapterAction;
  guid: string | null;
  name: string;
}

export interface AdapterStateChange {
  action: AdapterAction;
  adapter: NetworkAdapter;
}

function windowsExecutable(name: 'cmd.exe' | 'powershell.exe'): string {
  const systemRoot = process.env.SystemRoot;
  if (systemRoot && path.isAbsolute(systemRoot)) {
    if (name === 'powershell.exe') {
      return path.join(
        systemRoot,
        'System32',
        'WindowsPowerShell',
        'v1.0',
        name,
      );
    }
    return path.join(systemRoot, 'System32', name);
  }
  return name;
}

function runTextCommand(
  executable: string,
  args: readonly string[],
  options: CommandOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      {
        encoding: 'utf8',
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: options.timeout,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim() || error.message;
          reject(new Error(detail, { cause: error }));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function runTextCommandFromStdin(
  executable: string,
  args: readonly string[],
  input: string,
  options: StdinCommandOptions,
): Promise<StdinCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let outputBytes = 0;
    let settled = false;
    let stderr = '';
    let stdout = '';
    const finishWithError = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    const appendOutput = (target: 'stderr' | 'stdout', chunk: string): void => {
      outputBytes += Buffer.byteLength(chunk, 'utf8');
      if (outputBytes > MAX_OUTPUT_BYTES) {
        finishWithError(new Error('The Windows command returned too much data.'));
        return;
      }
      if (target === 'stderr') stderr += chunk;
      else stdout += chunk;
    };
    const timer = setTimeout(
      () => finishWithError(new Error(options.timeoutMessage)),
      options.timeout,
    );

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => appendOutput('stdout', chunk));
    child.stderr.on('data', (chunk: string) => appendOutput('stderr', chunk));
    child.on('error', (error) => finishWithError(error));
    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stderr, stdout });
    });
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') finishWithError(error);
    });
    child.stdin.end(input, 'utf8');
  });
}

function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function buildPowerShellStdinCommand(script: string): string {
  const encodedScript = encodePowerShell(script);
  return `$ErrorActionPreference = 'Stop'; try { $decodedScript = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedScript}')); & ([ScriptBlock]::Create($decodedScript)) } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function normalizedWord(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
}

function inferEnabled(adminStatus: string): boolean | null {
  const normalized = normalizedWord(adminStatus);
  const enabledWords = new Set([
    'up',
    'enabled',
    'active',
    'activé',
    'ativado',
    'habilitado',
    'aktiviert',
    'ingeschakeld',
    'abilitato',
    '已启用',
    '启用',
    '有効',
    '활성화',
  ]);
  const disabledWords = new Set([
    'down',
    'disabled',
    'inactive',
    'désactivé',
    'desativado',
    'deshabilitado',
    'deaktiviert',
    'uitgeschakeld',
    'disabilitato',
    '已禁用',
    '禁用',
    '無効',
    '비활성화',
  ]);
  if (enabledWords.has(normalized)) return true;
  if (disabledWords.has(normalized)) return false;
  return null;
}

function inferConnected(status: string, mediaState = ''): boolean | null {
  const values = [normalizedWord(status), normalizedWord(mediaState)];
  if (
    values.some(
      (value) => value === 'up' || value === 'connected' || value === '已连接',
    )
  ) {
    return true;
  }
  if (
    values.some(
      (value) =>
        value === 'down' ||
        value === 'disconnected' ||
        value === 'disabled' ||
        value === '已断开连接' ||
        value === '未连接',
    )
  ) {
    return false;
  }
  return null;
}

function normalizedGuid(value: string): string | null {
  const candidate = value.replace(/^\{/, '').replace(/\}$/, '').toUpperCase();
  return GUID_PATTERN.test(candidate) ? candidate : null;
}

function fallbackAdapterId(name: string): string {
  const digest = createHash('sha256')
    .update(name.normalize('NFKC').toLocaleLowerCase('en-US'))
    .digest('hex')
    .slice(0, 32);
  return `name:${digest}`;
}

function adapterId(rawGuid: string, name: string): string {
  const guid = normalizedGuid(rawGuid);
  return guid ? `guid:${guid}` : fallbackAdapterId(name);
}

function compareAdapters(left: NetworkAdapter, right: NetworkAdapter): number {
  return left.name.localeCompare(right.name, undefined, {
    sensitivity: 'base',
  });
}

export function parsePowerShellAdapters(output: string): NetworkAdapter[] {
  const trimmed = output.replace(/^\uFEFF/, '').trim();
  if (!trimmed) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch (error) {
    throw new Error('Windows returned malformed network adapter data.', {
      cause: error,
    });
  }

  const records = Array.isArray(parsed) ? parsed : [parsed];
  return records
    .map((record, index): NetworkAdapter => {
      if (!isRecord(record)) {
        throw new Error(`Network adapter entry ${index + 1} is invalid.`);
      }

      const name = stringValue(record.name);
      if (!name) {
        throw new Error(`Network adapter entry ${index + 1} has no name.`);
      }

      const adminStatus = stringValue(record.adminStatus);
      const connectionStatus = stringValue(record.status);
      return {
        id: adapterId(stringValue(record.id), name),
        name,
        description: stringValue(record.description),
        interfaceIndex: numberValue(record.ifIndex),
        adminStatus,
        connectionStatus,
        enabled: inferEnabled(adminStatus),
        connected: inferConnected(
          connectionStatus,
          stringValue(record.mediaState),
        ),
      };
    })
    .sort(compareAdapters);
}

export function parseNetshAdapters(output: string): NetworkAdapter[] {
  const lines = output
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  const separatorIndex = lines.findIndex((line) =>
    /^-{3,}$/u.test(line.trim()),
  );
  const dataLines =
    separatorIndex >= 0 ? lines.slice(separatorIndex + 1) : lines.slice(2);
  const adapters: NetworkAdapter[] = [];

  for (const line of dataLines) {
    const match = line.trim().match(/^(\S+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/u);
    if (!match) continue;

    const adminStatus = match[1] ?? '';
    const connectionStatus = match[2] ?? '';
    const name = (match[4] ?? '').trim();
    if (!name) continue;

    adapters.push({
      id: fallbackAdapterId(name),
      name,
      description: '',
      interfaceIndex: null,
      adminStatus,
      connectionStatus,
      enabled: inferEnabled(adminStatus),
      connected: inferConnected(connectionStatus),
    });
  }

  return adapters.sort(compareAdapters);
}

export function isAdapterAction(value: unknown): value is AdapterAction {
  return value === 'enable' || value === 'disable';
}

export function isSafeAdapterId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.startsWith('guid:')) return GUID_PATTERN.test(value.slice(5));
  return /^name:[a-f0-9]{32}$/u.test(value);
}

export function resolveSelectedAdapterId(
  adapters: readonly NetworkAdapter[],
  preferredId: string | null,
): string | null {
  if (preferredId && adapters.some((adapter) => adapter.id === preferredId))
    return preferredId;
  return (
    adapters.find((adapter) => adapter.connected === true)?.id ??
    adapters.find((adapter) => adapter.enabled === true)?.id ??
    adapters[0]?.id ??
    null
  );
}

export async function listNetworkAdapters(): Promise<NetworkAdapter[]> {
  if (process.platform !== 'win32') {
    throw new Error('Cherry Toolbox supports Windows only.');
  }

  try {
    const output = await runPowerShellScript(LIST_ADAPTERS_SCRIPT);
    return parsePowerShellAdapters(output);
  } catch (powerShellError) {
    try {
      const output = await runTextCommand(
        windowsExecutable('cmd.exe'),
        ['/d', '/s', '/c', 'chcp 65001>nul & netsh interface show interface'],
        { timeout: QUERY_TIMEOUT_MS },
      );
      return parseNetshAdapters(output);
    } catch (netshError) {
      throw new AggregateError(
        [powerShellError, netshError],
        'Windows could not enumerate network adapters.',
      );
    }
  }
}

function elevationPayload(
  adapter: NetworkAdapter,
  action: AdapterAction,
): ElevationPayload {
  return {
    action,
    guid: adapter.id.startsWith('guid:') ? adapter.id.slice(5) : null,
    name: adapter.name,
  };
}

function buildElevatedAdapterScript(
  payload: readonly ElevationPayload[],
): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64',
  );
  return String.raw`
$ErrorActionPreference = 'Stop'
$json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedPayload}'))
$requests = @($json | ConvertFrom-Json)
$adapters = @(Get-NetAdapter -Name '*' -IncludeHidden -ErrorAction Stop)
foreach ($request in $requests) {
  $adapter = $null
  if (-not [string]::IsNullOrWhiteSpace([string]$request.guid)) {
    $requestedGuid = [Guid]$request.guid
    $adapter = @($adapters | Where-Object { $_.InterfaceGuid -eq $requestedGuid })[0]
  }
  if ($null -eq $adapter) {
    $adapter = @($adapters | Where-Object { $_.Name -ceq [string]$request.name })[0]
  }
  if ($null -eq $adapter) {
    throw "The network adapter '$($request.name)' no longer exists."
  }
  switch ([string]$request.action) {
    'enable' { $adapter | Enable-NetAdapter -Confirm:$false -ErrorAction Stop }
    'disable' { $adapter | Disable-NetAdapter -Confirm:$false -ErrorAction Stop }
    default { throw 'Unsupported adapter action.' }
  }
}
`;
}

export function runElevatedPowerShell(innerScript: string): Promise<void> {
  const innerCommand = encodePowerShell(innerScript);
  const outerScript = String.raw`
$ErrorActionPreference = 'Stop'
$basePath = Join-Path ([IO.Path]::GetTempPath()) ('cherry-toolbox-' + [Guid]::NewGuid().ToString('N'))
$resultPath = $basePath + '.result.txt'
$exitCode = 1
try {
  $decodedScript = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${innerCommand}'))
  $encodedResult = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($resultPath))
  $runner = '$ErrorActionPreference = ''Stop''; $resultPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(''' + $encodedResult + ''')); try { & { ' + $decodedScript + ' }; exit 0 } catch { [IO.File]::WriteAllText($resultPath, $_.Exception.Message); exit 1 }'
  $encodedRunner = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($runner))
  $powershell = Join-Path $PSHOME 'powershell.exe'
  $arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + $encodedRunner
  if ($arguments.Length -gt 30000) { throw 'The legacy recovery command is too large for safe in-memory elevation.' }
  $process = Start-Process -FilePath $powershell -ArgumentList $arguments -Verb RunAs -Wait -PassThru -WindowStyle Hidden
  $exitCode = $process.ExitCode
  if ($exitCode -ne 0 -and (Test-Path -LiteralPath $resultPath)) {
    [Console]::Error.WriteLine([IO.File]::ReadAllText($resultPath))
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  $nativeCode = $_.Exception.NativeErrorCode
  $exitCode = if ($nativeCode -eq 1223) { 1223 } else { 1 }
} finally {
  Remove-Item -LiteralPath $resultPath -Force -ErrorAction SilentlyContinue
}
exit $exitCode
`;
  return runTextCommandFromStdin(
    windowsExecutable('powershell.exe'),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      '-',
    ],
    buildPowerShellStdinCommand(outerScript),
    {
      timeout: ELEVATION_TIMEOUT_MS,
      timeoutMessage: 'The administrator permission request timed out.',
    },
  ).then((result) => {
    if (result.exitCode === 0) return;
    if (result.exitCode === 1223) {
      throw new Error('Administrator permission was not granted.');
    }
    throw new Error(
      result.stderr.trim() ||
        'Windows could not change the network adapter state.',
    );
  }, (error: unknown) => {
    if (error instanceof Error && error.message.includes('timed out')) {
      throw error;
    }
    throw new Error(
      'Windows could not start the administrator permission request.',
      { cause: error },
    );
  });
}

export async function runPowerShellScript(innerScript: string): Promise<string> {
  const result = await runTextCommandFromStdin(
    windowsExecutable('powershell.exe'),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      '-',
    ],
    buildPowerShellStdinCommand(innerScript),
    {
      timeout: QUERY_TIMEOUT_MS,
      timeoutMessage: 'The Windows PowerShell command timed out.',
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() || 'Windows PowerShell could not complete the command.',
    );
  }
  return result.stdout;
}

export async function setNetworkAdapterState(
  adapter: NetworkAdapter,
  action: AdapterAction,
): Promise<void> {
  await setNetworkAdapterStates([{ action, adapter }]);
}

export async function setNetworkAdapterStates(
  changes: readonly AdapterStateChange[],
): Promise<void> {
  if (changes.length === 0) return;
  if (changes.length > 64)
    throw new Error('Too many network adapter changes were requested.');
  const adapterIds = new Set<string>();
  const payload: ElevationPayload[] = [];
  for (const { action, adapter } of changes) {
    if (!isAdapterAction(action))
      throw new Error('Unsupported adapter action.');
    if (!isSafeAdapterId(adapter.id))
      throw new Error('Invalid network adapter identifier.');
    if (adapterIds.has(adapter.id))
      throw new Error('Duplicate network adapter change requested.');
    adapterIds.add(adapter.id);
    payload.push(elevationPayload(adapter, action));
  }
  await runElevatedPowerShell(buildElevatedAdapterScript(payload));
}
