const assert = require('node:assert/strict');
const test = require('node:test');

const {
  watchAdapterConnection,
} = require('../dist/main/connection-monitor.js');

const ADAPTER_ID = 'guid:F67053B5-6802-4989-9869-6105783C240B';

function state(connected) {
  return {
    adapters: [
      {
        id: ADAPTER_ID,
        name: 'Wi-Fi',
        description: '',
        interfaceIndex: 1,
        adminStatus: 'Up',
        connectionStatus: connected ? 'Up' : 'Disconnected',
        enabled: true,
        connected,
      },
    ],
    pendingRestoreCount: 1,
    platform: 'win32',
    selectedAdapterId: ADAPTER_ID,
    version: '1.0.0',
  };
}

test('connection watcher publishes delayed state changes until connected', async () => {
  const states = [state(false), state(true)];
  const published = [];
  const result = await watchAdapterConnection(
    ADAPTER_ID,
    async () => states.shift(),
    (nextState) => published.push(nextState),
    { attempts: 3, intervalMs: 0, sleep: async () => undefined },
  );

  assert.equal(result, 'connected');
  assert.equal(published.length, 2);
  assert.equal(published[1].adapters[0].connected, true);
});

test('connection watcher tolerates a transient refresh failure', async () => {
  let attempt = 0;
  const errors = [];
  const result = await watchAdapterConnection(
    ADAPTER_ID,
    async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('temporary query failure');
      return state(true);
    },
    () => undefined,
    {
      attempts: 2,
      intervalMs: 0,
      onError: (error) => errors.push(error),
      sleep: async () => undefined,
    },
  );

  assert.equal(result, 'connected');
  assert.equal(errors.length, 1);
});

test('connection watcher can be cancelled and has a bounded timeout', async () => {
  const controller = new AbortController();
  const cancelled = await watchAdapterConnection(
    ADAPTER_ID,
    async () => state(false),
    () => undefined,
    {
      attempts: 3,
      intervalMs: 0,
      signal: controller.signal,
      sleep: async () => controller.abort(),
    },
  );
  assert.equal(cancelled, 'aborted');

  const timedOut = await watchAdapterConnection(
    ADAPTER_ID,
    async () => state(false),
    () => undefined,
    { attempts: 2, intervalMs: 0, sleep: async () => undefined },
  );
  assert.equal(timedOut, 'timeout');
});
