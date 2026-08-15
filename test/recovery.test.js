const assert = require('node:assert/strict');
const { mkdtemp, readdir, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildRecoveryPlan,
  loadRecoveryJournal,
  reconcileRecoveryJournal,
  saveRecoveryJournal,
  trackAdapterChange,
} = require('../dist/main/recovery.js');

const WIFI_ID = 'guid:F67053B5-6802-4989-9869-6105783C240B';
const ETHERNET_ID = 'guid:0CEB962B-5463-4B13-B939-0993E29BCBEF';
const NOW = '2026-08-09T12:00:00.000Z';

function adapter(id, name, enabled, connected = false) {
  return {
    id,
    name,
    description: name,
    interfaceIndex: 1,
    adminStatus: enabled ? 'Up' : 'Down',
    connectionStatus: connected ? 'Up' : 'Disconnected',
    enabled,
    connected,
  };
}

async function withTemporaryDirectory(run) {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'connection-switcher-recovery-'),
  );
  try {
    await run(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

test('first mutation captures the original state and later mutations preserve it', () => {
  const wifi = adapter(WIFI_ID, 'Wi-Fi', true, true);
  const first = trackAdapterChange(null, wifi, false, 'session-1', NOW);
  const second = trackAdapterChange(
    first,
    { ...wifi, enabled: false, connected: false },
    true,
    'session-1',
    '2026-08-09T12:00:01.000Z',
  );

  assert.equal(second.adapters.length, 1);
  assert.deepEqual(second.adapters[0], {
    adapterId: WIFI_ID,
    adapterName: 'Wi-Fi',
    originalEnabled: true,
    requestedEnabled: true,
  });
  assert.equal(reconcileRecoveryJournal(second, [wifi]), null);
});

test('recovery plan restores changed adapters and retains unavailable records', () => {
  let journal = trackAdapterChange(
    null,
    adapter(WIFI_ID, 'Wi-Fi', true),
    false,
    'session-1',
    NOW,
  );
  journal = trackAdapterChange(
    journal,
    adapter(ETHERNET_ID, 'Ethernet', false),
    true,
    'session-1',
    NOW,
  );

  const plan = buildRecoveryPlan(journal, [adapter(WIFI_ID, 'Wi-Fi', false)]);
  assert.deepEqual(
    plan.actions.map(({ action, adapter: current }) => [current.id, action]),
    [[WIFI_ID, 'enable']],
  );
  assert.deepEqual(
    plan.unavailable.map((record) => record.adapterId),
    [ETHERNET_ID],
  );
});

test('recovery journal is written atomically, validated on load, and removable', async () => {
  await withTemporaryDirectory(async (directory) => {
    const journal = trackAdapterChange(
      null,
      adapter(WIFI_ID, 'Wi-Fi', true),
      false,
      'session-1',
      NOW,
    );
    await saveRecoveryJournal(directory, journal);
    assert.deepEqual(await loadRecoveryJournal(directory), journal);
    assert.equal(
      (await readdir(directory)).some((name) => name.endsWith('.tmp')),
      false,
    );

    await saveRecoveryJournal(directory, {
      ...journal,
      updatedAt: '2026-08-09T12:00:02.000Z',
    });
    assert.equal(
      (await loadRecoveryJournal(directory)).updatedAt,
      '2026-08-09T12:00:02.000Z',
    );

    await saveRecoveryJournal(directory, null);
    assert.equal(await loadRecoveryJournal(directory), null);
  });
});

test('corrupt recovery data is rejected instead of silently discarded', async () => {
  await withTemporaryDirectory(async (directory) => {
    await writeFile(path.join(directory, 'recovery.json'), '{broken', 'utf8');
    await assert.rejects(loadRecoveryJournal(directory), /not valid JSON/);
  });
});

test('unknown initial adapter state cannot create an unsafe recovery point', () => {
  assert.throws(
    () =>
      trackAdapterChange(
        null,
        adapter(WIFI_ID, 'Wi-Fi', null),
        true,
        'session-1',
        NOW,
      ),
    /safe recovery point/,
  );
});
