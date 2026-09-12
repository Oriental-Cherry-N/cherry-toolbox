import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { NativeEvent } from './native-helper';

/** CDP travels only over the owning supervisor's inherited anonymous pipes. */
export class BrowserControl {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 0;
  private closed = false;
  private readonly requests = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  private readonly listeners = new Set<(message: Record<string, unknown>) => void>();

  attach(child: ChildProcessWithoutNullStreams): void {
    this.child = child;
    child.once('exit', () => this.close());
  }
  accept(event: NativeEvent): void {
    if (this.closed || event.type !== 'browser-message' || typeof event.message !== 'object' || event.message === null) return;
    const message = event.message as Record<string, unknown>;
    if (typeof message.id === 'number') {
      const request = this.requests.get(message.id);
      this.requests.delete(message.id);
      // Response errors can contain page URLs. Keep diagnostics content-free.
      if (message.error) request?.reject(new Error('The browser rejected a control command.'));
      else request?.resolve((message.result ?? {}) as Record<string, unknown>);
    } else for (const listener of this.listeners) listener(message);
  }
  onEvent(listener: (message: Record<string, unknown>) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  command(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    if (this.closed || !this.child?.stdin.writable) return Promise.reject(new Error('The private browser control pipe is unavailable.'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(id); reject(new Error('A private browser control command timed out.')); }, 20000);
      this.requests.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      this.child!.stdin.write(JSON.stringify({ type: 'browser-command', message: JSON.stringify({ id, method, params, sessionId }) }) + '\n', error => {
        if (error) { this.requests.get(id)?.reject(new Error('The browser control pipe disconnected.')); this.requests.delete(id); }
      });
    });
  }
  close(): void {
    this.closed = true;
    for (const request of this.requests.values()) request.reject(new Error('The private browser control pipe closed.'));
    this.requests.clear(); this.listeners.clear(); this.child = null;
  }
}
