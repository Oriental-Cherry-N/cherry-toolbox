export type ConnectionWatchResult =
  'aborted' | 'connected' | 'missing' | 'timeout';

interface ConnectionWatchOptions {
  attempts?: number;
  intervalMs?: number;
  onError?: (error: unknown) => void;
  signal?: AbortSignal;
  sleep?: (milliseconds: number) => Promise<void>;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function watchAdapterConnection(
  adapterId: string,
  readState: () => Promise<AppState>,
  onState: (state: AppState) => void,
  options: ConnectionWatchOptions = {},
): Promise<ConnectionWatchResult> {
  const attempts = options.attempts ?? 45;
  const intervalMs = options.intervalMs ?? 1_000;
  const sleep = options.sleep ?? defaultSleep;
  if (!Number.isInteger(attempts) || attempts <= 0)
    throw new Error('Invalid watch attempt count.');
  if (!Number.isFinite(intervalMs) || intervalMs < 0)
    throw new Error('Invalid watch interval.');

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await sleep(intervalMs);
    if (options.signal?.aborted === true) return 'aborted';

    try {
      const state = await readState();
      onState(state);
      const adapter = state.adapters.find(
        (candidate) => candidate.id === adapterId,
      );
      if (!adapter) return 'missing';
      if (adapter.connected === true) return 'connected';
    } catch (error) {
      options.onError?.(error);
    }
  }

  return options.signal?.aborted === true ? 'aborted' : 'timeout';
}
