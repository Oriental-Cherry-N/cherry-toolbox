import {
  assertFlClashMixedPortIsLoopbackOnly,
  defaultFlClashConfigPath,
  flClashControllerIsAlive,
  inspectFlClashRuntimeReadOnly,
  restoreFlClashRuntime,
  waitForFlClashMixedPort,
  type FlClashReadOnlyRuntime,
} from './flclash';
import {
  IsolatedBrowserManager,
  type IsolatedBrowserSession,
} from './isolated-browser';
import { PacServer } from './pac-server';
import { DedicatedRouting, inspectDedicatedRouting, type DedicatedPreparation } from './dedicated-routing';
import { ComponentLifecycle, cleanupAll } from './lifecycle';
import { verifyBrowserRouting } from './browser-routing-verification';
import {
  setSplitRoutingRecovery,
  type RecoveryJournal,
  type SplitRoutingRecoveryPhase,
  type SplitRoutingRecoveryRecord,
} from './recovery';
import {
  DEFAULT_SPLIT_ROUTING_SETTINGS,
  loadSplitRoutingSettings,
  parseSplitRoutingSettings,
  proxyDomainsForSettings,
} from './split-routing-settings';
import {
  verifySplitRoutingPaths,
  type SplitRoutingVerificationAdapters,
} from './split-routing-verification';
import {
  captureSystemNetworkFingerprint,
  systemNetworkFingerprintsMatch,
  type SystemNetworkFingerprint,
} from './system-network-fingerprint';
import {
  restoreWinInetPac,
  restoreWinInetSnapshot,
  restoreWindowsNetworkIsolation,
  verifyWindowsNetworkRestored,
} from './windows-split-routing';

const MONITOR_INTERVAL_MS = 2_000;

interface SplitRoutingDependencies {
  browserManager?: SplitRoutingBrowser;
  dataDirectory: string;
  getRecoveryJournal: () => RecoveryJournal | null;
  operations?: Partial<SplitRoutingOperations>;
  pacServer?: SplitRoutingPacServer;
  routing?: Pick<DedicatedRouting, 'url' | 'isRunning' | 'recover' | 'start' | 'stop' | 'evidence' | 'corePid'>;
  replaceRecoveryJournal: (journal: RecoveryJournal | null) => Promise<void>;
  sessionId: string;
  stateChanged: () => void;
}

interface SplitRoutingPacServer {
  readonly url: string | null;
  start: (domains: readonly string[], mixedPort: number) => Promise<string>;
  stop: () => Promise<void>;
}

interface SplitRoutingBrowser {
  readonly activeSession: IsolatedBrowserSession | null;
  readonly isRunning: boolean;
  inspectBrowser: () => Promise<string>;
  recoverOrphanedSession: () => Promise<void>;
  start: (pacUrl: string, initialUrl: string, mode?: SplitRoutingMode) => Promise<IsolatedBrowserSession>;
  stop: () => Promise<void>;
}

interface SplitRoutingOperations {
  inspectDedicatedRouting: typeof inspectDedicatedRouting;
  verifyBrowserRouting: typeof verifyBrowserRouting;
  assertFlClashMixedPortIsLoopbackOnly: typeof assertFlClashMixedPortIsLoopbackOnly;
  captureSystemNetworkFingerprint: typeof captureSystemNetworkFingerprint;
  defaultFlClashConfigPath: typeof defaultFlClashConfigPath;
  flClashControllerIsAlive: typeof flClashControllerIsAlive;
  inspectFlClashRuntimeReadOnly: typeof inspectFlClashRuntimeReadOnly;
  restoreFlClashRuntime: typeof restoreFlClashRuntime;
  restoreWinInetPac: typeof restoreWinInetPac;
  restoreWinInetSnapshot: typeof restoreWinInetSnapshot;
  restoreWindowsNetworkIsolation: typeof restoreWindowsNetworkIsolation;
  verifySplitRoutingPaths: typeof verifySplitRoutingPaths;
  verifyWindowsNetworkRestored: typeof verifyWindowsNetworkRestored;
  waitForFlClashMixedPort: typeof waitForFlClashMixedPort;
}

interface PreparedSafeSession {
  browserPath: string;
  fingerprint: SystemNetworkFingerprint;
  primary: NetworkAdapter & { interfaceIndex: number };
  proxy: NetworkAdapter & { interfaceIndex: number };
  runtime: FlClashReadOnlyRuntime;
  settings: SplitRoutingSettings;
  dedicated: DedicatedPreparation;
}

const DEFAULT_OPERATIONS: SplitRoutingOperations = {
  inspectDedicatedRouting,
  verifyBrowserRouting,
  assertFlClashMixedPortIsLoopbackOnly,
  captureSystemNetworkFingerprint,
  defaultFlClashConfigPath,
  flClashControllerIsAlive,
  inspectFlClashRuntimeReadOnly,
  restoreFlClashRuntime,
  restoreWinInetPac,
  restoreWinInetSnapshot,
  restoreWindowsNetworkIsolation,
  verifySplitRoutingPaths,
  verifyWindowsNetworkRestored,
  waitForFlClashMixedPort,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorHasCode(error: unknown, code: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (
      typeof current === 'object' &&
      current !== null &&
      'code' in current &&
      current.code === code
    ) {
      return true;
    }
    if (!(current instanceof Error) || !current.cause) return false;
    current = current.cause;
  }
  return false;
}

function requireAdapter(
  adapters: readonly NetworkAdapter[],
  id: string | null,
  label: string,
): NetworkAdapter & { interfaceIndex: number } {
  if (!id) throw new Error(`Choose the ${label} adapter.`);
  const adapter = adapters.find((candidate) => candidate.id === id);
  if (!adapter) throw new Error(`The ${label} adapter is unavailable.`);
  if (!Number.isInteger(adapter.interfaceIndex) || adapter.interfaceIndex === null) {
    throw new Error(`The ${label} adapter has no stable interface index.`);
  }
  if (adapter.enabled !== true || adapter.connected !== true) {
    throw new Error(`The ${label} adapter must already be enabled and connected.`);
  }
  return { ...adapter, interfaceIndex: adapter.interfaceIndex };
}

function publicPreflight(
  prepared: PreparedSafeSession,
): SplitRoutingPreflightResult {
  return {
    canonicalConfigPath: null,
    diagnostics: [
      'Safety mode: Windows proxy, WinHTTP, DNS, routes, interface metrics, and environment variables will not be changed.',
      prepared.settings.mode === 'chatgpt-web'
        ? 'ChatGPT web mode: every website request in this disposable browser uses the selected proxy. Desktop clients and ordinary browsers keep their existing network path.'
        : 'Website mode: ChatGPT and OpenAI remain on the protected primary path.',
      `Read-only FlClash controller: ${prepared.runtime.controller}`,
      'Dedicated proxy: selected node copied into a temporary, authenticated, loopback-only session; the shared FlClash instance is not used for forwarding.',
      prepared.settings.mode === 'chatgpt-web'
        ? `All isolated browser traffic: ${prepared.proxy.name}. No direct fallback. Login, cached files and downloads are removed when the session closes; voice is not enabled.`
        : `Ordinary and protected domains: ${prepared.primary.name}; selected domains: ${prepared.proxy.name}. Interface failure stops the session.`,
      'IPv4 and TCP website traffic only. QUIC, non-proxied WebRTC UDP, extensions and system DNS fallback are disabled.',
      `Isolated browser: ${prepared.browserPath}`,
      `System network fingerprint: ${prepared.fingerprint.hash.slice(0, 12)}…`,
    ],
    environmentProxyWarning: false,
    mixedPort: prepared.runtime.mixedPort,
    ready: true,
    routeEndpointCount: 0,
  };
}

export class SplitRoutingService {
  private readonly browser: SplitRoutingBrowser;
  private readonly dependencies: SplitRoutingDependencies;
  private readonly operations: SplitRoutingOperations;
  private readonly pacServer: SplitRoutingPacServer;
  private readonly routing: NonNullable<SplitRoutingDependencies['routing']>;
  private readonly lifecycle = new ComponentLifecycle();
  private recoveryBlocked = false;
  private originalSettings: SplitRoutingSettings = { ...DEFAULT_SPLIT_ROUTING_SETTINGS };
  private settingsValue: SplitRoutingSettings = {
    ...DEFAULT_SPLIT_ROUTING_SETTINGS,
  };
  private statusValue: SplitRoutingStatus = 'inactive';
  private diagnosticsValue: string[] = [];
  private lastErrorValue: string | null = null;
  private mixedPortValue: number | null = null;
  private controllerSecret = '';
  private monitor: NodeJS.Timeout | null = null;
  private monitorInFlight = false;
  private activeFingerprint: SystemNetworkFingerprint | null = null;
  private activeAdapters: SplitRoutingVerificationAdapters | null = null;

  constructor(dependencies: SplitRoutingDependencies) {
    this.dependencies = dependencies;
    this.operations = { ...DEFAULT_OPERATIONS, ...dependencies.operations };
    this.pacServer = dependencies.pacServer ?? new PacServer();
    this.routing = dependencies.routing ?? new DedicatedRouting(dependencies.dataDirectory);
    this.browser =
      dependencies.browserManager ??
      new IsolatedBrowserManager(dependencies.dataDirectory);
  }

  async initialize(): Promise<void> {
    this.settingsValue = await loadSplitRoutingSettings(
      this.dependencies.dataDirectory,
    );
    this.originalSettings = structuredClone(this.settingsValue);
    try {
      await cleanupAll([() => this.browser.recoverOrphanedSession(), () => this.routing.recover()]);
    } catch (error) {
      this.recoveryBlocked = true;
      this.statusValue = 'error';
      this.lastErrorValue =
        `An isolated browser from an interrupted session could not be cleaned up: ${errorMessage(error)}`;
      this.diagnosticsValue = [this.lastErrorValue];
    }
    if (this.dependencies.getRecoveryJournal()?.splitRouting) {
      this.statusValue = 'error';
      this.lastErrorValue =
        'Legacy global split-routing changes must be restored before safety mode can start.';
      this.diagnosticsValue = [this.lastErrorValue];
    }
    this.dependencies.stateChanged();
  }

  getState(): SplitRoutingState {
    const legacy = this.dependencies.getRecoveryJournal()?.splitRouting ?? null;
    return {
      activePacUrl: this.routing.url,
      diagnostics: [...this.diagnosticsValue],
      environmentProxyWarning: false,
      lastError: this.lastErrorValue,
      mixedPort: this.mixedPortValue,
      ownedRouteCount: legacy?.snapshot.ownedRoutes.length ?? 0,
      pendingRecovery: legacy !== null || this.recoveryBlocked,
      settings: {
        ...this.settingsValue,
        customDomains: [...this.settingsValue.customDomains],
      },
      status: this.statusValue,
    };
  }

  saveSettings(value: unknown): Promise<SplitRoutingSettings> { return this.lifecycle.run(() => this.saveSettingsInternal(value)); }
  private async saveSettingsInternal(value: unknown): Promise<SplitRoutingSettings> {
    if (this.statusValue === 'active' || this.statusValue === 'preparing') {
      throw new Error('Stop the isolated browser before changing its settings.');
    }
    this.settingsValue = parseSplitRoutingSettings(value);
    this.dependencies.stateChanged();
    return {
      ...this.settingsValue,
      customDomains: [...this.settingsValue.customDomains],
    };
  }

  private async prepare(
    value: unknown,
    secret: string,
    adapters: readonly NetworkAdapter[],
  ): Promise<PreparedSafeSession> {
    if (typeof secret !== 'string') {
      throw new Error('Invalid FlClash controller secret.');
    }
    const settings = parseSplitRoutingSettings(value);
    const domains = proxyDomainsForSettings(settings);
    if (settings.mode === 'sites' && domains.length === 0) {
      throw new Error('Select ipinfo.io or add at least one safe custom domain.');
    }
    const primary = requireAdapter(adapters, settings.primaryAdapterId, 'Ethernet');
    const proxy = requireAdapter(adapters, settings.proxyAdapterId, 'WLAN');
    if (primary.id === proxy.id) {
      throw new Error('The Ethernet and WLAN adapters must be different.');
    }
    const runtime = await this.operations.inspectFlClashRuntimeReadOnly({
      port: settings.controllerPort,
      secret,
    });
    await this.operations.waitForFlClashMixedPort(runtime.mixedPort);
    await this.operations.assertFlClashMixedPortIsLoopbackOnly(runtime.mixedPort);
    const browserPath = await this.browser.inspectBrowser();
    const fingerprint = await this.operations.captureSystemNetworkFingerprint(
      this.operations.defaultFlClashConfigPath(),
    );
    const dedicated = await this.operations.inspectDedicatedRouting(settings.controllerPort, secret);
    return { browserPath, fingerprint, primary, proxy, runtime, settings, dedicated };
  }

  async preflight(
    value: unknown,
    secret: string,
    adapters: readonly NetworkAdapter[],
  ): Promise<SplitRoutingPreflightResult> {
    if (this.dependencies.getRecoveryJournal()?.splitRouting) {
      throw new Error('Restore the legacy split-routing session first.');
    }
    return publicPreflight(await this.prepare(value, secret, adapters));
  }

  activate(value: unknown, secret: string, adapters: readonly NetworkAdapter[]): Promise<void> {
    return this.lifecycle.run(() => this.activateInternal(value, secret, adapters));
  }
  private async activateInternal(
    value: unknown,
    secret: string,
    adapters: readonly NetworkAdapter[],
  ): Promise<void> {
    if (this.recoveryBlocked) throw new Error('Retry cleanup of the interrupted session before starting a new one.');
    if (this.statusValue === 'preparing' || this.statusValue === 'restoring') {
      throw new Error('Another isolated-browser operation is still running.');
    }
    if (this.statusValue === 'active' || this.browser.activeSession) {
      throw new Error('The isolated browser is already active.');
    }
    if (this.dependencies.getRecoveryJournal()?.splitRouting) {
      throw new Error('Restore the legacy split-routing session first.');
    }
    this.stopMonitor();
    this.statusValue = 'preparing';
    this.lastErrorValue = null;
    this.diagnosticsValue = ['Running read-only safety checks…'];
    this.dependencies.stateChanged();

    let pacStarted = false;
    let browserStarted = false;
    try {
      const prepared = await this.prepare(value, secret, adapters);
      this.settingsValue = prepared.settings;
      const domains = proxyDomainsForSettings(prepared.settings);
      const pacUrl = await this.routing.start(prepared.dedicated, prepared.primary, prepared.proxy, domains, prepared.settings.mode);
      pacStarted = true;
      const initialUrl = prepared.settings.mode === 'chatgpt-web' ? 'https://chatgpt.com/' : prepared.settings.ipinfoEnabled
        ? 'https://ipinfo.io/'
        : `https://${domains[0] as string}/`;
      await this.browser.start(pacUrl, initialUrl, prepared.settings.mode);
      browserStarted = true;
      const after = await this.operations.captureSystemNetworkFingerprint(
        this.operations.defaultFlClashConfigPath(),
      );
      if (!systemNetworkFingerprintsMatch(prepared.fingerprint, after)) {
        throw new Error(
          'The global network fingerprint changed while starting the isolated browser. Safety mode stopped without accepting the session.',
        );
      }

      this.controllerSecret = secret;
      this.activeFingerprint = prepared.fingerprint;
      this.activeAdapters = {
        primary: {
          adapterName: prepared.primary.name,
          interfaceIndex: prepared.primary.interfaceIndex,
        },
        proxy: {
          adapterName: prepared.proxy.name,
          interfaceIndex: prepared.proxy.interfaceIndex,
        },
      };
      this.mixedPortValue = Number(new URL(pacUrl).port);
      this.diagnosticsValue = publicPreflight(prepared).diagnostics;
      this.statusValue = 'active';
      this.startMonitor();
      this.dependencies.stateChanged();
    } catch (error) {
      const cleanupErrors: Error[] = [];
      if (browserStarted || this.browser.activeSession) {
        try {
          await this.browser.stop();
        } catch (cleanupError) {
          cleanupErrors.push(
            cleanupError instanceof Error
              ? cleanupError
              : new Error(String(cleanupError)),
          );
        }
      }
      if (pacStarted) {
        try {
          await this.routing.stop();
        } catch (cleanupError) {
          cleanupErrors.push(
            cleanupError instanceof Error
              ? cleanupError
              : new Error(String(cleanupError)),
          );
        }
      }
      this.statusValue = cleanupErrors.length > 0 ? 'error' : 'inactive';
      this.recoveryBlocked = cleanupErrors.length > 0;
      this.lastErrorValue = errorMessage(error);
      this.diagnosticsValue = [this.lastErrorValue];
      this.dependencies.stateChanged();
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          `${errorMessage(error)} Cleanup also failed: ${cleanupErrors.map(errorMessage).join(' ')}`,
        );
      }
      throw error;
    }
  }

  async verifyPaths(): Promise<SplitRoutingVerificationResult> {
    if (
      this.statusValue !== 'active' ||
      !this.activeFingerprint ||
      !this.activeAdapters ||
      !this.mixedPortValue
    ) {
      throw new Error('Start the isolated browser before verifying traffic paths.');
    }
    const current = await this.operations.captureSystemNetworkFingerprint(
      this.operations.defaultFlClashConfigPath(),
    );
    const unchanged = systemNetworkFingerprintsMatch(
      this.activeFingerprint,
      current,
    );
    const session = this.browser.activeSession;
    if (!session) throw new Error('The isolated browser is unavailable.');
    if (this.settingsValue.mode === 'sites' && (!this.settingsValue.ipinfoEnabled || proxyDomainsForSettings(this.settingsValue).some(domain => domain === 'ipify.org' || domain === 'api.ipify.org'))) throw new Error('Browser verification requires ipinfo.io enabled and api.ipify.org on the direct path.');
    try {
      const result = await this.operations.verifyBrowserRouting(session, this.activeAdapters, this.routing, unchanged, this.settingsValue.mode);
      if (!result.passed) {
        await this.restore();
        this.statusValue = 'error';
        this.lastErrorValue = 'Browser routing could not be verified. The isolated session was stopped.';
        this.diagnosticsValue = [this.lastErrorValue];
        this.dependencies.stateChanged();
      }
      return result;
    } catch (error) {
      try { await this.restore(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Browser verification failed and session cleanup remains pending.'); }
      this.statusValue = 'error';
      this.lastErrorValue = `Browser verification failed; the isolated session was stopped: ${errorMessage(error)}`;
      this.diagnosticsValue = [this.lastErrorValue];
      this.dependencies.stateChanged();
      throw error;
    }
  }

  private async storeLegacyRecovery(
    record: SplitRoutingRecoveryRecord | null,
  ): Promise<void> {
    await this.dependencies.replaceRecoveryJournal(
      setSplitRoutingRecovery(
        this.dependencies.getRecoveryJournal(),
        record,
        this.dependencies.sessionId,
      ),
    );
  }

  private async updateLegacyPhase(
    phase: SplitRoutingRecoveryPhase,
  ): Promise<SplitRoutingRecoveryRecord> {
    const current = this.dependencies.getRecoveryJournal()?.splitRouting;
    if (!current) throw new Error('The legacy recovery record is missing.');
    const next = {
      ...current,
      phase,
      updatedAt: new Date().toISOString(),
    };
    await this.storeLegacyRecovery(next);
    return next;
  }

  private async restoreLegacy(secret: string): Promise<void> {
    const existing = this.dependencies.getRecoveryJournal()?.splitRouting;
    if (!existing) return;
    const record = await this.updateLegacyPhase('restoring');
    const errors: Error[] = [];
    if (record.pacUrl) {
      try {
        await this.operations.restoreWinInetPac(
          record.snapshot.registryValues,
          record.pacUrl,
        );
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (record.temporaryConfigApplied) {
      try {
        await this.operations.restoreFlClashRuntime(
          record.canonicalConfigPath,
          { port: record.settings.controllerPort, secret },
          record.selectorChoices,
        );
      } catch (error) {
        if (!errorHasCode(error, 'ECONNREFUSED')) {
          errors.push(error instanceof Error ? error : new Error(String(error)));
        }
      }
    }
    if (record.networkIsolationApplied !== false) {
      try {
        await this.operations.restoreWindowsNetworkIsolation(record.snapshot);
        await this.operations.verifyWindowsNetworkRestored(record.snapshot);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    try {
      await this.operations.restoreWinInetSnapshot(record.snapshot.registryValues);
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
    try {
      await this.pacServer.stop();
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, errors.map(errorMessage).join(' '));
    }
    await this.storeLegacyRecovery(null);
  }

  restore(secret = ''): Promise<void> { return this.lifecycle.stop(() => this.restoreInternal(secret)); }
  private async restoreInternal(secret: string): Promise<void> {
    this.stopMonitor();
    this.statusValue = 'restoring';
    this.lastErrorValue = null;
    this.dependencies.stateChanged();
    const errors: Error[] = [];
    try {
      await this.restoreLegacy(secret || this.controllerSecret);
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
    try {
      await this.browser.stop();
      await this.browser.recoverOrphanedSession();
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
    try {
      await this.pacServer.stop();
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
    try { await this.routing.stop(); } catch (error) { errors.push(error instanceof Error ? error : new Error(String(error))); }

    let networkUnchanged = true;
    if (this.activeFingerprint) {
      try {
        const current = await this.operations.captureSystemNetworkFingerprint(
          this.operations.defaultFlClashConfigPath(),
        );
        networkUnchanged = systemNetworkFingerprintsMatch(
          this.activeFingerprint,
          current,
        );
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (errors.length > 0) {
      this.recoveryBlocked = true;
      this.statusValue = 'error';
      this.lastErrorValue = errors.map(errorMessage).join(' ');
      this.diagnosticsValue = [this.lastErrorValue];
      this.dependencies.stateChanged();
      throw new AggregateError(errors, this.lastErrorValue);
    }
    this.controllerSecret = '';
    this.activeFingerprint = null;
    this.activeAdapters = null;
    this.mixedPortValue = null;
    this.settingsValue = structuredClone(this.originalSettings);
    this.recoveryBlocked = false;
    this.statusValue = 'inactive';
    this.lastErrorValue = networkUnchanged
      ? null
      : 'The system network fingerprint changed externally during the isolated session. Cherry Toolbox made no global network writes and did not overwrite the external change.';
    this.diagnosticsValue = this.lastErrorValue ? [this.lastErrorValue] : [];
    this.dependencies.stateChanged();
  }

  private startMonitor(): void {
    this.stopMonitor();
    this.monitor = setInterval(() => {
      void this.monitorOnce();
    }, MONITOR_INTERVAL_MS);
    this.monitor.unref();
  }

  private stopMonitor(): void {
    if (this.monitor) clearInterval(this.monitor);
    this.monitor = null;
  }

  private async monitorOnce(): Promise<void> {
    if (this.statusValue !== 'active' || this.monitorInFlight) return;
    this.monitorInFlight = true;
    try {
      const alive = this.routing.isRunning;
      if (alive && this.browser.isRunning) return;
      const reason = alive
        ? 'The isolated browser exited; its dedicated proxy session was stopped.'
        : 'An interface or dedicated proxy stopped; the isolated browser session was stopped.';
      await this.restore();
      this.statusValue = 'error';
      this.lastErrorValue = reason;
      this.diagnosticsValue = [reason];
      this.dependencies.stateChanged();
    } catch (error) {
      try { await this.restore(); } catch { this.recoveryBlocked = true; }
      this.stopMonitor();
      this.statusValue = 'error';
      this.lastErrorValue =
        `The isolated-session safety monitor failed: ${errorMessage(error)}`;
      this.diagnosticsValue = [this.lastErrorValue];
      this.dependencies.stateChanged();
    } finally {
      this.monitorInFlight = false;
    }
  }

  async shutdown(): Promise<void> {
    this.stopMonitor();
    await this.restore();
  }
}
