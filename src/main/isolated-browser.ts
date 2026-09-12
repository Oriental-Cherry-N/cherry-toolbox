import { execFile, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, mkdir, lstat, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { writeJsonAtomically } from './file-store';
import { runPowerShellScript } from './network';
import { ComponentLifecycle } from './lifecycle';
import { startNativeHelper, stopNativeHelper } from './native-helper';
import { BrowserControl } from './browser-control';

const execFileAsync = promisify(execFile);
const PROFILE_PREFIX = 'cherry-toolbox-isolated-browser-';
const SESSION_FILE_NAME = 'isolated-browser-session.json';
const PROCESS_EXIT_TIMEOUT_MS = 8_000;

interface StoredBrowserSession {
  browserPath: string;
  createdAt: string;
  pid: number;
  profilePath: string;
  version: 1 | 2;
}

export interface IsolatedBrowserSession {
  browserPath: string;
  pid: number;
  profilePath: string;
  control?: BrowserControl;
}

export interface IsolatedBrowserOperations {
  closeProcessTree: (pid: number) => Promise<void>;
  findBrowser: () => Promise<string>;
  launchBrowser: (
    browserPath: string,
    arguments_: readonly string[],
  ) => ChildProcess | Promise<{ child: ChildProcess; pid: number; control?: BrowserControl }>;
  findProfileProcesses: (profilePath: string) => Promise<number[]>;
  stopSupervisor: (child: ChildProcess) => Promise<void>;
  processOwnsProfile: (pid: number, profilePath: string) => Promise<boolean>;
}

function sessionPath(dataDirectory: string): string {
  return path.join(dataDirectory, SESSION_FILE_NAME);
}

function parseStoredSession(value: unknown): StoredBrowserSession {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !('version' in value) ||
    (value.version !== 1 && value.version !== 2) ||
    !('pid' in value) ||
    typeof value.pid !== 'number' ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < (value.version === 2 ? 0 : 1) ||
    !('browserPath' in value) ||
    typeof value.browserPath !== 'string' ||
    !path.isAbsolute(value.browserPath) ||
    !('profilePath' in value) ||
    typeof value.profilePath !== 'string' ||
    !safeProfilePath(value.profilePath) ||
    !('createdAt' in value) ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt))
  ) {
    throw new Error('The isolated-browser recovery record is invalid.');
  }
  return {
    browserPath: value.browserPath,
    createdAt: value.createdAt,
    pid: value.pid,
    profilePath: value.profilePath,
    version: value.version,
  };
}

export function safeProfilePath(profilePath: string): boolean {
  const resolved = path.resolve(profilePath);
  return (
    path.dirname(resolved).toLocaleLowerCase('en-US') ===
      path.resolve(os.tmpdir()).toLocaleLowerCase('en-US') &&
    path.basename(resolved).startsWith(PROFILE_PREFIX)
  );
}

export async function findSupportedBrowser(): Promise<string> {
  await assertBrowserIsolationPolicies();
  const roots = [
    process.env.PROGRAMFILES,
    process.env['PROGRAMFILES(X86)'],
    process.env.LOCALAPPDATA,
  ].filter((value): value is string => Boolean(value && path.isAbsolute(value)));
  const candidates = [
    ...roots.flatMap((root) => [
      path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ]),
  ];
  for (const candidate of [...new Set(candidates)]) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next fixed, trusted installation path.
    }
  }
  throw new Error(
    'No supported Edge or Chrome installation was found for the isolated browser session.',
  );
}

async function assertBrowserIsolationPolicies(): Promise<void> {
  await runPowerShellScript(String.raw`
$ErrorActionPreference = 'Stop'
foreach ($root in @('HKLM:\SOFTWARE\Policies\Google\Chrome','HKCU:\SOFTWARE\Policies\Google\Chrome','HKLM:\SOFTWARE\Policies\Microsoft\Edge','HKCU:\SOFTWARE\Policies\Microsoft\Edge')) {
  if (Test-Path -LiteralPath $root) {
    $key = Get-Item -LiteralPath $root -ErrorAction Stop
    foreach ($name in @('ProxyMode','ProxyServer','ProxyPacUrl','ProxySettings','WebRtcIPHandlingPolicy','QuicAllowed','RemoteDebuggingAllowed','DeveloperToolsAvailability','AutoLaunchProtocolsFromOrigins','DownloadDirectory','PromptForDownloadLocation','DownloadRestrictions','ExtensionSettings')) {
      if (@($key.GetValueNames()) -contains $name) { throw 'A managed browser policy can override isolation. Use an unmanaged Edge or Chrome installation.' }
    }
  }
  foreach ($policy in @('ExtensionInstallForcelist','AutoLaunchProtocolsFromOrigins','ExtensionSettings')) {
    if (Test-Path -LiteralPath ($root + '\' + $policy)) { throw 'Managed browser extensions or external application rules prevent a verifiable disposable session.' }
  }
}
`);
}

async function processOwnsProfile(
  pid: number,
  profilePath: string,
): Promise<boolean> {
  const encoded = Buffer.from(profilePath, 'utf8').toString('base64');
  const output = await runPowerShellScript(String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$profile = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))
$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue
if ($null -eq $process) { 'false'; exit 0 }
$pattern = '(?:^|[ "])--user-data-dir=' + [regex]::Escape($profile) + '(?:"|\s|$)'
if ($process.Name -in @('msedge.exe','chrome.exe') -and [string]$process.CommandLine -match $pattern) { 'true' } else { 'false' }
`);
  return output.trim().toLocaleLowerCase('en-US') === 'true';
}

async function closeProcessTree(pid: number): Promise<void> {
  try {
    await execFileAsync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), [
      '/PID',
      String(pid),
      '/T',
      '/F',
    ], { timeout: PROCESS_EXIT_TIMEOUT_MS, windowsHide: true });
  } catch (error) {
    const code = Number((error as { code?: unknown }).code);
    const stdout = String(
      (error as { stdout?: string | Buffer }).stdout ?? '',
    ).toLocaleLowerCase('en-US');
    if (code === 128 || stdout.includes('not found')) return;
    throw new Error('The isolated browser process tree could not be stopped.', {
      cause: error,
    });
  }
}

export async function launchManagedBrowser(browserPath: string, arguments_: readonly string[]): Promise<{ child: ChildProcessWithoutNullStreams; pid: number; control: BrowserControl }> {
  const profilePath = arguments_.find(value => value.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
  if (!profilePath || !safeProfilePath(profilePath)) throw new Error('Invalid browser profile.');
  const control = new BrowserControl();
  const { child, ready } = await startNativeHelper('job', { executable: browserPath, arguments: arguments_, workingDirectory: path.dirname(browserPath), cleanupDirectory: profilePath, browserPipe: true }, value => control.accept(value));
  control.attach(child);
  if (typeof ready.pid !== 'number') { await stopNativeHelper(child); throw new Error('The supervisor did not identify its browser.'); }
  return { child, pid: ready.pid, control };
}

const DEFAULT_OPERATIONS: IsolatedBrowserOperations = {
  closeProcessTree,
  findBrowser: findSupportedBrowser,
  launchBrowser: launchManagedBrowser,
  stopSupervisor: child => stopNativeHelper(child as ChildProcessWithoutNullStreams),
  findProfileProcesses: async profilePath => {
    const encoded = Buffer.from(profilePath, 'utf8').toString('base64');
    const output = await runPowerShellScript(String.raw`
$ErrorActionPreference = 'Stop'
$profile = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))
$pattern = '(?:^|[ "])--user-data-dir=' + [regex]::Escape($profile) + '(?:"|\s|$)'
$ids = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -in @('msedge.exe','chrome.exe') -and $_.CommandLine -match $pattern } | Select-Object -ExpandProperty ProcessId)
ConvertTo-Json -InputObject @($ids) -Compress
`);
    const ids: unknown = JSON.parse(output);
    if (!Array.isArray(ids) || ids.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error('Unable to verify orphaned browser ownership.');
    return ids as number[];
  },
  processOwnsProfile,
};

export class IsolatedBrowserManager {
  private readonly dataDirectory: string;
  private readonly operations: IsolatedBrowserOperations;
  private child: ChildProcess | null = null;
  private session: IsolatedBrowserSession | null = null;
  private control: BrowserControl | null = null;
  private readonly lifecycle = new ComponentLifecycle();

  constructor(
    dataDirectory: string,
    operations: Partial<IsolatedBrowserOperations> = {},
  ) {
    this.dataDirectory = dataDirectory;
    this.operations = { ...DEFAULT_OPERATIONS, ...operations };
  }

  get activeSession(): IsolatedBrowserSession | null {
    return this.session ? { ...this.session, ...(this.control ? { control: this.control } : {}) } : null;
  }

  get isRunning(): boolean {
    return Boolean(
      this.session && this.child && this.child.exitCode === null && this.child.signalCode == null,
    );
  }

  inspectBrowser(): Promise<string> {
    return this.operations.findBrowser();
  }

  async recoverOrphanedSession(): Promise<void> {
    let record: StoredBrowserSession;
    try {
      record = parseStoredSession(
        JSON.parse(
          await readFile(sessionPath(this.dataDirectory), 'utf8'),
        ) as unknown,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (record.version === 2) {
      for (const pid of await this.operations.findProfileProcesses(record.profilePath)) await this.operations.closeProcessTree(pid);
      if ((await this.operations.findProfileProcesses(record.profilePath)).length > 0) throw new Error('An isolated browser is still running; recovery remains pending.');
    } else if (await this.operations.processOwnsProfile(record.pid, record.profilePath)) {
      await this.operations.closeProcessTree(record.pid);
    }
    await this.removeProfile(record.profilePath);
    await rm(sessionPath(this.dataDirectory), { force: true });
  }

  start(proxyUrl: string, initialUrl: string, mode: SplitRoutingMode = 'sites'): Promise<IsolatedBrowserSession> {
    return this.lifecycle.run(() => this.startInternal(proxyUrl, initialUrl, mode));
  }

  private async startInternal(proxyUrl: string, initialUrl: string, mode: SplitRoutingMode): Promise<IsolatedBrowserSession> {
    if (this.session) throw new Error('The isolated browser is already running.');
    await this.recoverOrphanedSession();
    if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/u.test(proxyUrl) || Number(new URL(proxyUrl).port) > 65535) {
      throw new Error('The isolated browser received an invalid fixed proxy.');
    }
    const initial = new URL(initialUrl);
    if (initial.protocol !== 'https:' || initial.username || initial.password) throw new Error('An HTTPS website is required.');
    const browserPath = await this.operations.findBrowser();
    const profilePath = path.join(os.tmpdir(), PROFILE_PREFIX + randomUUID());
    await writeJsonAtomically(sessionPath(this.dataDirectory), { browserPath, pid: 0, profilePath, createdAt: new Date().toISOString(), version: 2 } satisfies StoredBrowserSession);
    await mkdir(profilePath);
    const downloads = path.join(profilePath, 'Downloads');
    await mkdir(downloads);
    await writeJsonAtomically(path.join(profilePath, 'Default', 'Preferences'), {
      credentials_enable_service: false,
      profile: { password_manager_enabled: false, default_content_setting_values: { notifications: 2, geolocation: 2, media_stream_mic: 2, media_stream_camera: 2 } },
      download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true, extensions_to_open: '' },
      protocol_handler: { allowed_origin_protocol_pairs: {}, policy: { auto_launch_protocols_from_origins: [] } },
      external_protocol_dialog: { show_always_open_checkbox: false },
    });
    const arguments_ = [
      `--user-data-dir=${profilePath}`,
      `--proxy-server=${proxyUrl}`,
      '--proxy-bypass-list=<-loopback>',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      '--disable-quic',
      // Domain-based mode must not reuse an HTTP/2 connection across lanes.
      // ChatGPT mode has one lane for the entire browser and keeps HTTP/2.
      ...(mode === 'sites' ? ['--disable-http2'] : []),
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-extensions',
      '--remote-debugging-pipe',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-mode',
      '--disable-sync',
      '--new-window',
      'about:blank',
    ];
    let child: ChildProcess;
    let browserPid: number | undefined;
    try {
      const result = await this.operations.launchBrowser(browserPath, arguments_);
      child = 'child' in result ? result.child : result;
      browserPid = 'child' in result ? result.pid : child.pid;
      this.control = 'child' in result ? result.control ?? null : null;
    } catch (error) {
      await this.removeProfile(profilePath);
      throw error;
    }
    if (!browserPid) {
      child.kill();
      await this.removeProfile(profilePath);
      throw new Error('The isolated browser did not return a process identifier.');
    }
    const session = { browserPath, pid: browserPid, profilePath };
    this.child = child;
    this.session = session;
    try {
      await writeJsonAtomically(sessionPath(this.dataDirectory), {
        ...session,
        createdAt: new Date().toISOString(),
        version: 2,
      } satisfies StoredBrowserSession);
      if (this.control) {
        await this.control.command('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: false });
        const targets = await this.control.command('Target.getTargets');
        const page = (targets.targetInfos as { type: string; targetId: string }[]).find(value => value.type === 'page');
        if (!page) throw new Error('The private browser window did not initialize.');
        const attached = await this.control.command('Target.attachToTarget', { targetId: page.targetId, flatten: true });
        try { await this.control.command('Page.navigate', { url: initialUrl }, String(attached.sessionId)); }
        finally { await this.control.command('Target.detachFromTarget', { sessionId: attached.sessionId }); }
      } else if (mode === 'chatgpt-web') {
        throw new Error('ChatGPT web mode requires the private browser control pipe.');
      }
    } catch (error) {
      await this.operations.stopSupervisor(child);
      throw error;
    }
    return this.activeSession as IsolatedBrowserSession;
  }

  stop(): Promise<void> { return this.lifecycle.stop(() => this.stopInternal()); }

  private async stopInternal(): Promise<void> {
    const session = this.session;
    if (!session) return;
    if (this.child && this.child.exitCode === null && this.child.signalCode == null) await this.operations.stopSupervisor(this.child);
    if (await this.operations.processOwnsProfile(session.pid, session.profilePath)) {
      await this.operations.closeProcessTree(session.pid);
    }
    if ((await this.operations.findProfileProcesses(session.profilePath)).length > 0) throw new Error('The isolated browser is still running; cleanup remains pending.');
    await this.removeProfile(session.profilePath);
    await rm(sessionPath(this.dataDirectory), { force: true });
    this.session = null;
    this.child = null;
    this.control?.close(); this.control = null;
  }

  private async removeProfile(profilePath: string): Promise<void> {
    if (!safeProfilePath(profilePath)) {
      throw new Error('Refusing to remove an unsafe isolated-browser profile path.');
    }
    try { if ((await lstat(profilePath)).isSymbolicLink()) throw new Error('Refusing a linked browser profile.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await rm(profilePath, { force: true, recursive: true, maxRetries: 3 });
  }
}
