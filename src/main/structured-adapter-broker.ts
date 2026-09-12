import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

import { AdapterRecoveryBroker as LegacyBroker } from './adapter-recovery-broker';
import { writeJsonAtomically } from './file-store';
import { ComponentLifecycle, cleanupAll } from './lifecycle';
import { nativeHelperPath } from './native-helper';
import type { AdapterRecoveryRecord } from './recovery';

const execFileAsync = promisify(execFile);
const PROTOCOL = 'cherry-adapter-v2';
const cancellation = (): Error => new Error('Adapter startup was cancelled before a command was sent.');
const asError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));

/** A narrow adapter-only protocol. Executable code never comes from the journal. */
export class AdapterRecoveryBroker {
  private socket: Socket | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private detach: (() => void) | null = null;
  private opening: AbortController | null = null;
  private authenticated = false;
  private mayHaveApplied = false;
  private recoveryCheckRequired = false;
  private readonly lifecycle = new ComponentLifecycle();
  private readonly pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  private readonly marker: string;
  private failure: Error | null = null;
  private phase: AdapterBrokerPhase = 'idle';
  private readonly timeouts = { connect: 15000, handshake: 10000, apply: 30000, restore: 120000, settle: 10000, poll: 200 };

  constructor(private readonly dataDirectory: string, private readonly stateChanged: () => void = () => undefined) {
    this.marker = path.join(dataDirectory, 'structured-adapter-session.json');
  }
  get isActive(): boolean { return this.authenticated && this.socket !== null && !this.socket.destroyed; }
  get hasDispatchedChanges(): boolean { return this.mayHaveApplied; }

  /** Validate the pinned executable before the caller records a new change intent. */
  async prepare(): Promise<void> { await nativeHelperPath(); }
  get progress(): AdapterBrokerProgress {
    return { phase: this.phase, detail: this.failure?.message ?? null, canCancel: this.opening !== null && !this.mayHaveApplied };
  }
  private setPhase(phase: AdapterBrokerPhase): void { this.phase = phase; this.stateChanged(); }

  cancelPendingStart(): void {
    if (!this.mayHaveApplied) this.opening?.abort();
  }

  private disconnect(error?: Error): void {
    const socket = this.socket; this.socket = null; this.authenticated = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null; this.detach?.(); this.detach = null;
    socket?.destroy();
    for (const item of this.pending.values()) item.reject(error ?? new Error('The adapter session closed.'));
    this.pending.clear();
    if (error) { this.failure = error; this.setPhase('error'); }
  }

  private async connectPipe(name: string, signal: AbortSignal): Promise<Socket> {
    const deadline = Date.now() + this.timeouts.connect;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const socket = await new Promise<Socket | null>((resolve, reject) => {
        const candidate = connect('\\\\.\\pipe\\' + name);
        let settled = false;
        const finish = (connected: boolean, error?: Error): void => {
          if (settled) return; settled = true;
          clearTimeout(timer); signal.removeEventListener('abort', abort);
          candidate.off('connect', ready); candidate.off('error', failed);
          if (!connected) candidate.destroy();
          error ? reject(error) : resolve(connected ? candidate : null);
        };
        const ready = (): void => finish(true);
        const failed = (): void => finish(false);
        const abort = (): void => finish(false, cancellation());
        // Errors can arrive during destroy or promise handoff.
        candidate.on('error', () => undefined);
        const timer = setTimeout(failed, Math.min(1000, Math.max(1, deadline - Date.now())));
        candidate.once('connect', ready); candidate.once('error', failed);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      if (socket) return socket;
      await new Promise(resolve => setTimeout(resolve, this.timeouts.poll));
    }
    throw new Error('The administrator helper did not open its adapter connection. Check recovery status and retry.');
  }

  private async open(): Promise<void> {
    if (this.isActive) return;
    if (this.failure) throw this.failure;
    const controller = new AbortController(); this.opening = controller;
    const signal = controller.signal;
    try {
      this.setPhase('authorizing');
      const helper = await nativeHelperPath(); signal.throwIfAborted();
      const name = 'cherry-adapter-' + randomUUID().replaceAll('-', '');
      // Once launch evidence may exist, failure cannot be dismissed as an unexecuted request.
      this.recoveryCheckRequired = true;
      await writeJsonAtomically(this.marker, { version: 1, pending: true });
      signal.throwIfAborted();
      await execFileAsync(helper, ['elevate', name, String(process.pid)], { windowsHide: true, timeout: 120000, signal });
      signal.throwIfAborted(); this.setPhase('connecting');
      const socket = await this.connectPipe(name, signal); this.socket = socket;
      signal.throwIfAborted(); this.setPhase('handshaking');
      await new Promise<void>((resolve, reject) => {
        let ready = false;
        const lines = createInterface({ input: socket });
        const timer = setTimeout(() => fail(new Error('The adapter helper did not finish authentication in time.')), this.timeouts.handshake);
        const abort = (): void => fail(cancellation());
        const fail = (error: Error): void => {
          clearTimeout(timer); reject(error);
          if (this.socket === socket) this.disconnect(error);
        };
        const closed = (): void => fail(new Error(ready
          ? 'The adapter helper disconnected; independent recovery must be verified.'
          : 'The adapter helper disconnected during authentication. No adapter command was sent.'));
        const line = (text: string): void => {
          try {
            if (text.length > 1048576) throw new Error('Oversized adapter response.');
            const value = JSON.parse(text) as { type?: string; protocol?: string; id?: string; message?: string; code?: number };
            if (value.type === 'error') throw new Error(`${value.message ?? 'The adapter helper failed.'}${value.code ? ` (Windows ${value.code})` : ''}`);
            if (!ready) {
              if (value.type !== 'ready' || value.protocol !== PROTOCOL) throw new Error('The adapter helper used an incompatible handshake. Restart the updated application.');
              ready = true; this.authenticated = true;
              clearTimeout(timer); signal.removeEventListener('abort', abort); resolve();
            } else if (value.type === 'result' && value.id) {
              this.pending.get(value.id)?.resolve(); this.pending.delete(value.id);
            } else if (value.type === 'recovering') this.setPhase('restoring');
          } catch (error) { fail(asError(error)); }
        };
        this.detach = () => {
          clearTimeout(timer); signal.removeEventListener('abort', abort);
          socket.off('error', fail); socket.off('close', closed); lines.off('line', line); lines.close();
        };
        socket.on('error', fail); socket.on('close', closed); lines.on('line', line);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) { abort(); return; }
        socket.write(JSON.stringify({ type: 'hello', protocol: PROTOCOL }) + '\n', error => { if (error) fail(error); });
      });
      signal.throwIfAborted();
      if (!this.isActive) throw this.failure ?? new Error('The adapter helper closed after authentication.');
      this.heartbeat = setInterval(() => {
        socket.write('{"type":"heartbeat"}\n', error => { if (error && this.socket === socket) this.disconnect(error); });
      }, 1000);
      this.heartbeat.unref(); this.setPhase('ready');
    } catch (error) {
      const failure = signal.aborted ? cancellation() : asError(error);
      this.disconnect(failure); throw failure;
    } finally { this.opening = null; this.stateChanged(); }
  }

  private command(type: 'apply' | 'restore', records: readonly AdapterRecoveryRecord[] = []): Promise<void> {
    if (!this.isActive || this.failure) return Promise.reject(this.failure ?? new Error('The adapter broker is unavailable.'));
    const socket = this.socket as Socket, id = randomUUID();
    this.setPhase(type === 'apply' ? 'applying' : 'restoring');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.disconnect(new Error('The adapter operation has not been verified; independent recovery remains pending.')), this.timeouts[type]);
      this.pending.set(id, { resolve: () => { clearTimeout(timer); resolve(); }, reject: error => { clearTimeout(timer); reject(error); } });
      if (type === 'apply') this.mayHaveApplied = true;
      try { socket.write(JSON.stringify({ type, id, records }) + '\n', error => { if (error && this.socket === socket) this.disconnect(error); }); }
      catch (error) { this.disconnect(asError(error)); }
    });
  }

  apply(records: readonly AdapterRecoveryRecord[]): Promise<void> {
    return this.lifecycle.run(async () => {
      if (records.length < 1 || records.length > 64 || records.some(record => !/^guid:[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(record.adapterId))) throw new Error('Adapter changes require stable GUIDs and durable recovery records.');
      await this.open(); await this.command('apply', records); this.setPhase('ready');
    });
  }

  private async markerExists(): Promise<boolean> {
    try {
      const value: unknown = JSON.parse(await readFile(this.marker, 'utf8'));
      if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== 1 || !('pending' in value) || value.pending !== true) throw new Error('Invalid adapter recovery marker.');
      return true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }

  private async recoveryStatus(): Promise<{ pending: boolean; active: boolean }> {
    const helper = await nativeHelperPath();
    const result = await execFileAsync(helper, ['--adapter-recovery-status'], { windowsHide: true, timeout: 10000 });
    const value: unknown = JSON.parse(result.stdout);
    if (typeof value !== 'object' || value === null || !('pending' in value) || typeof value.pending !== 'boolean' || !('active' in value) || typeof value.active !== 'boolean') throw new Error('The privileged recovery status is invalid.');
    return { pending: value.pending, active: value.active };
  }

  private async settledStatus(): Promise<{ pending: boolean; active: boolean }> {
    const deadline = Date.now() + this.timeouts.settle;
    let status = await this.recoveryStatus();
    while (status.active && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, this.timeouts.poll));
      status = await this.recoveryStatus();
    }
    return status;
  }

  private async clearIfRestored(): Promise<boolean> {
    this.disconnect();
    const status = await this.settledStatus();
    if (status.active || status.pending) return false;
    await rm(this.marker, { force: true });
    this.failure = null; this.mayHaveApplied = false; this.recoveryCheckRequired = false; this.setPhase('idle');
    return true;
  }

  /** After fallback, an empty journal is insufficient while a broker can still apply queued work. */
  async confirmRestored(): Promise<boolean> {
    await this.lifecycle.stop(async () => {
      if (!await this.clearIfRestored()) throw new Error('The independent adapter recovery is still active or has pending records.');
    });
    return true;
  }

  async recoverOrphanedSession(): Promise<void> {
    this.recoveryCheckRequired = true;
    await cleanupAll([() => new LegacyBroker(this.dataDirectory).recoverOrphanedSession(), async () => {
      const status = await this.recoveryStatus();
      if (status.pending || status.active) await writeJsonAtomically(this.marker, { version: 1, pending: true });
      else this.recoveryCheckRequired = false;
      await this.restore();
    }]);
  }

  async restore(): Promise<boolean> {
    this.cancelPendingStart();
    let restored = this.mayHaveApplied;
    await this.lifecycle.stop(async () => {
      if (!this.socket && !this.mayHaveApplied && !this.recoveryCheckRequired && !await this.markerExists()) {
        // No helper was launched, no command was sent, and startup recovery was confirmed.
        // An integrity failure here needs no second invocation of the broken executable.
        this.failure = null; this.setPhase('idle'); return;
      }
      this.setPhase('restoring');
      try {
        if (!this.isActive) {
          this.disconnect();
          const status = await this.settledStatus();
          if (status.active) throw new Error('An independent adapter recovery is still running. Retry after it finishes.');
          if (!status.pending) {
            await rm(this.marker, { force: true });
            this.failure = null; this.mayHaveApplied = false; this.recoveryCheckRequired = false; this.setPhase('idle'); return;
          }
          this.failure = null; await this.open();
        }
        restored = true; await this.command('restore');
        if (!await this.clearIfRestored()) throw new Error('The adapter helper has not finished its independent recovery.');
      } catch (error) {
        this.disconnect(asError(error));
        if (!await this.clearIfRestored()) throw error;
      }
    });
    return restored;
  }
  async shutdown(): Promise<void> { await this.restore(); }
}
