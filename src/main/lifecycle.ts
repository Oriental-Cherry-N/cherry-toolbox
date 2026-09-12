/** Serializes mutations and closes admission synchronously when cleanup begins. */
export class ComponentLifecycle {
  private tail: Promise<unknown> = Promise.resolve();
  private cleanup: Promise<void> | null = null;
  private blocked: Error | null = null;

  get stopping(): boolean { return this.cleanup !== null; }
  get recoveryError(): Error | null { return this.blocked; }

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.cleanup) return Promise.reject(new Error('The component is stopping.'));
    if (this.blocked) return Promise.reject(this.blocked);
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }

  stop(operation: () => Promise<void>): Promise<void> {
    if (this.cleanup) return this.cleanup;
    const result = this.tail.then(operation);
    this.cleanup = result.then(() => {
      this.blocked = null;
    }, (error: unknown) => {
      this.blocked = error instanceof Error ? error : new Error(String(error));
      throw this.blocked;
    }).finally(() => { this.cleanup = null; });
    this.tail = this.cleanup.catch(() => undefined);
    return this.cleanup;
  }
}

/** Attempt every independent cleanup, even if an earlier one fails. */
export async function cleanupAll(operations: readonly (() => Promise<unknown>)[]): Promise<void> {
  const errors: Error[] = [];
  for (const operation of operations) {
    try { await operation(); }
    catch (error) { errors.push(error instanceof Error ? error : new Error(String(error))); }
  }
  if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('\n'));
}
