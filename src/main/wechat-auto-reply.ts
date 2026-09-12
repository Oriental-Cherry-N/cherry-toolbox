import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { ComponentLifecycle } from './lifecycle';
import { startNativeHelper } from './native-helper';

import {
  loadWeChatAutoReplySettings,
  normalizeWeChatAutoReplyInput,
} from './wechat-auto-reply-settings';
import {
  loadWeChatAutoReplyRateLimitState,
  localDateKey,
  type WeChatAutoReplyRateLimitState,
} from './wechat-auto-reply-rate-limit';

export const PYWECHAT_UPSTREAM_COMMIT =
  '109724b7b9d50b0914d33b778caf220415f10360';
const SUPPORTED_WECHAT_VERSION = '4.1.12.26' as const;

interface ServiceOptions {
  dataDirectory: string;
  projectRoot: string;
  sourceMode: boolean;
  stateChanged: (state: WeChatAutoReplyState) => void;
}

interface WorkerEvent {
  contact?: unknown;
  message?: unknown;
  reason?: unknown;
  timestamp?: unknown;
  type?: unknown;
}

function copySettings(
  settings: WeChatAutoReplySettings,
): WeChatAutoReplySettings {
  return { ...settings, allowlist: [...settings.allowlist] };
}

function isWorkerEvent(value: unknown): value is WorkerEvent {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class WeChatAutoReplyService {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly lifecycle = new ComponentLifecycle();
  private stoppingWorker: Promise<void> | null = null;
  private workerStopTimeoutMs = 5000;
  private readonly dataDirectory: string;
  private readonly environmentPath: string;
  private readonly projectRoot: string;
  private readonly sourceMode: boolean;
  private readonly stateChanged: (state: WeChatAutoReplyState) => void;
  private rateLimitState: WeChatAutoReplyRateLimitState;
  private state: WeChatAutoReplyState;
  private originalSettings: WeChatAutoReplySettings | null = null;

  constructor(options: ServiceOptions) {
    this.dataDirectory = options.dataDirectory;
    this.projectRoot = options.projectRoot;
    this.sourceMode = options.sourceMode;
    this.stateChanged = options.stateChanged;
    this.environmentPath = path.join(
      options.projectRoot,
      '.python-envs',
      'wechat-auto-reply',
      'python.exe',
    );
    this.rateLimitState = {
      dailyCount: 0,
      date: localDateKey(),
      lastReplyAtByContact: {},
      version: 1,
    };
    this.state = {
      environmentPath: this.environmentPath,
      environmentReady: false,
      lastError: null,
      lastEventAt: null,
      lastEventContact: null,
      lastEventType: null,
      lastSkipReason: null,
      settings: {
        allowlist: [],
        cooldownMinutes: 30,
        dailyLimit: 20,
        dryRun: true,
        enabled: false,
        replyText: '',
        version: 2,
      },
      status: 'stopped',
      upstreamCommit: PYWECHAT_UPSTREAM_COMMIT,
      wechatVersion: SUPPORTED_WECHAT_VERSION,
    };
  }

  async initialize(): Promise<void> {
    const [settings, environmentReady, rateLimitState] = await Promise.all([
      loadWeChatAutoReplySettings(this.dataDirectory),
      this.checkEnvironment(),
      loadWeChatAutoReplyRateLimitState(this.dataDirectory),
    ]);
    this.rateLimitState = rateLimitState;
    this.originalSettings = copySettings({ ...settings, enabled: false });
    this.state = {
      ...this.state,
      environmentReady,
      settings: { ...settings, enabled: false },
    };
    this.emitState();
  }

  getState(): WeChatAutoReplyState {
    return {
      ...this.state,
      settings: copySettings(this.state.settings),
    };
  }

  get pendingRecovery(): boolean {
    return this.lifecycle.recoveryError !== null ||
      (this.child !== null && this.state.status === 'error');
  }

  saveSettings(value: unknown): Promise<WeChatAutoReplyState> {
    return this.lifecycle.run(() => this.saveSettingsInternal(value));
  }

  private async saveSettingsInternal(value: unknown): Promise<WeChatAutoReplyState> {
    const input = normalizeWeChatAutoReplyInput(value);
    const shouldRestart = this.state.settings.enabled;
    this.state = {
      ...this.state,
      lastError: null,
      settings: {
        ...input,
        enabled: shouldRestart,
        version: 2,
      },
    };
    if (shouldRestart) {
      try {
        await this.startWorker();
      } catch (error) {
        this.setError(error);
        throw error;
      }
    }
    this.emitState();
    return this.getState();
  }

  start(value: unknown): Promise<WeChatAutoReplyState> {
    return this.lifecycle.run(() => this.startInternal(value));
  }

  private async startInternal(value: unknown): Promise<WeChatAutoReplyState> {
    const input = normalizeWeChatAutoReplyInput(value);
    this.state = {
      ...this.state,
      lastError: null,
      settings: { ...input, enabled: true, version: 2 },
    };
    try {
      await this.startWorker();
    } catch (error) {
      this.setError(error);
      throw error;
    }
    return this.getState();
  }

  async stop(): Promise<WeChatAutoReplyState> {
    await this.shutdown();
    return this.getState();
  }

  async stopForSafety(reason: string): Promise<WeChatAutoReplyState> {
    await this.shutdown();
    this.state = { ...this.state, lastError: reason };
    this.emitState();
    return this.getState();
  }

  shutdown(): Promise<void> {
    return this.lifecycle.stop(async () => {
      this.state = { ...this.state, settings: { ...this.state.settings, enabled: false } };
      try {
        await this.stopWorker();
        if (this.originalSettings) this.state.settings = copySettings(this.originalSettings);
        this.state = { ...this.state, lastError: null, status: 'stopped' };
      } catch (error) {
        this.state = { ...this.state, lastError: error instanceof Error ? error.message : String(error), status: 'error' };
        throw error;
      }
    }).finally(() => { this.emitState(); });
  }

  private async checkEnvironment(): Promise<boolean> {
    if (!this.sourceMode) return false;
    try {
      await access(this.environmentPath);
      return true;
    } catch {
      return false;
    }
  }

  private async startWorker(): Promise<void> {
    await this.stopWorker(false);
    const environmentReady = await this.checkEnvironment();
    if (!this.sourceMode) {
      throw new Error(
        'WeChat Auto Reply is currently available from the source launcher only.',
      );
    }
    if (!environmentReady) {
      throw new Error(
        'The WeChat Python environment is missing. Run scripts/setup-wechat-auto-reply.ps1 first.',
      );
    }

    const workerPath = path.join(
      this.projectRoot,
      'python',
      'wechat_auto_reply_worker.py',
    );
    this.state = {
      ...this.state,
      environmentReady: true,
      lastError: null,
      status: 'starting',
    };
    this.emitState();

    const { child } = await startNativeHelper('job', {
      executable: this.environmentPath,
      arguments: ['-X', 'utf8', '-u', workerPath], workingDirectory: this.projectRoot, forwardOutput: true,
      initialInput: { ...this.state.settings, rateState: this.rateLimitState },
    }, value => { if (!this.lifecycle.stopping && this.state.settings.enabled) this.handleWorkerLine(JSON.stringify(value)); });
    this.child = child;
    let lastStandardError = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      lastStandardError = `${lastStandardError}${chunk}`.slice(-2000);
    });
    child.once('error', (error) => {
      if (this.child !== child) return;
      if (!child.pid) this.child = null;
      if (!this.stoppingWorker) this.setError(error);
    });
    child.once('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.stoppingWorker || this.state.status === 'error') return;
      const detail = lastStandardError.trim();
      this.setError(
        new Error(
          `The WeChat auto-reply worker exited unexpectedly (code ${code ?? 'unknown'})${detail ? `: ${detail}` : '.'}`,
        ),
      );
    });

  }

  private stopWorker(graceful = true): Promise<void> {
    if (this.stoppingWorker) return this.stoppingWorker;
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode != null) {
      if (this.child === child) this.child = null;
      return Promise.resolve();
    }
    const result = new Promise<void>((resolve, reject) => {
      let settled = false;
      let forceTimer: NodeJS.Timeout | undefined;
      let failureTimer: NodeJS.Timeout | undefined;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(forceTimer); clearTimeout(failureTimer);
        child.removeListener('exit', onExit);
        child.removeListener('error', onError);
        child.stdin.removeListener?.('error', onError);
        if (error) reject(error);
        else { if (this.child === child) this.child = null; resolve(); }
      };
      const onExit = (): void => finish();
      const onError = (_error: Error): void => {
        // A broken control pipe is not proof of process exit. Force the owned
        // process down, then wait for its exit event or preserve it for retry.
        try { child.kill(); } catch { /* The timeout keeps the recovery handle. */ }
      };
      child.once('exit', onExit);
      child.once('error', onError);
      child.stdin.once?.('error', onError);
      forceTimer = setTimeout(() => { try { child.kill(); } catch { /* retain handle */ } }, Math.min(2000, this.workerStopTimeoutMs / 2));
      failureTimer = setTimeout(() => finish(new Error('The WeChat dry-run worker did not exit within the safety timeout. Recovery remains pending.')), this.workerStopTimeoutMs);
      try {
        if (graceful && child.stdin.writable) child.stdin.end(JSON.stringify({ type: 'stop' }) + '\n');
        else child.kill();
      } catch (error) { onError(error instanceof Error ? error : new Error(String(error))); }
    });
    this.stoppingWorker = result.finally(() => { this.stoppingWorker = null; });
    return this.stoppingWorker;
  }

  private handleWorkerLine(line: string): void {
    if (line.trim().length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      return;
    }
    if (!isWorkerEvent(parsed) || typeof parsed.type !== 'string') return;

    if (parsed.type === 'ready') {
      if (this.lifecycle.stopping || !this.state.settings.enabled) return;
      this.state = { ...this.state, lastError: null, status: 'running' };
      this.emitState();
      return;
    }
    if (
      parsed.type === 'detected' &&
      typeof parsed.contact === 'string' &&
      this.state.settings.allowlist.includes(parsed.contact)
    ) {
      const timestamp =
        typeof parsed.timestamp === 'string'
          ? parsed.timestamp
          : new Date().toISOString();
      this.state = {
        ...this.state,
        lastEventAt: timestamp,
        lastEventContact: parsed.contact,
        lastEventType: parsed.type,
        lastSkipReason: null,
      };
      this.emitState();
      return;
    }
    if (
      parsed.type === 'skipped' &&
      typeof parsed.contact === 'string' &&
      this.state.settings.allowlist.includes(parsed.contact) &&
      (parsed.reason === 'cooldown' ||
        parsed.reason === 'daily-limit' ||
        parsed.reason === 'draft-present' ||
        parsed.reason === 'system-message' ||
        parsed.reason === 'outgoing-message')
    ) {
      this.state = {
        ...this.state,
        lastEventAt:
          typeof parsed.timestamp === 'string'
            ? parsed.timestamp
            : new Date().toISOString(),
        lastEventContact: parsed.contact,
        lastEventType: 'skipped',
        lastSkipReason: parsed.reason,
      };
      this.emitState();
      return;
    }
    if (parsed.type === 'error' && typeof parsed.message === 'string') {
      this.setError(new Error(parsed.message));
    }
  }

  private setError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    void this.stopWorker(false).catch((stopError: unknown) => {
      console.warn('Unable to stop the WeChat dry-run worker:', stopError);
    }).finally(() => { this.emitState(); });
    this.state = {
      ...this.state,
      lastError: message,
      settings: { ...this.state.settings, enabled: false },
      status: 'error',
    };
    this.emitState();
  }

  private emitState(): void {
    this.stateChanged(this.getState());
  }
}
