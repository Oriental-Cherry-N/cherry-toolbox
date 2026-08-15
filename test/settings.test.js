const assert = require('node:assert/strict');
const { readFile, readdir, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { mkdtemp } = require('node:fs/promises');
const test = require('node:test');

const {
  loadSelectedAdapterId,
  saveSelectedAdapterId,
} = require('../dist/main/settings.js');

const ADAPTER_ID = 'guid:F67053B5-6802-4989-9869-6105783C240B';

async function withTemporaryDirectory(run) {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'connection-switcher-test-'),
  );
  try {
    await run(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

test('settings round-trip a validated adapter id', async () => {
  await withTemporaryDirectory(async (directory) => {
    assert.equal(await loadSelectedAdapterId(directory), null);
    await saveSelectedAdapterId(directory, ADAPTER_ID);
    assert.equal(await loadSelectedAdapterId(directory), ADAPTER_ID);

    const stored = JSON.parse(
      await readFile(path.join(directory, 'settings.json'), 'utf8'),
    );
    assert.deepEqual(stored, { selectedAdapterId: ADAPTER_ID, version: 1 });

    await saveSelectedAdapterId(directory, null);
    assert.equal(await loadSelectedAdapterId(directory), null);
    assert.equal(
      (await readdir(directory)).some((name) => name.endsWith('.tmp')),
      false,
    );
  });
});

test('corrupt or untrusted settings are ignored', async () => {
  await withTemporaryDirectory(async (directory) => {
    await writeFile(path.join(directory, 'settings.json'), '{broken', 'utf8');
    assert.equal(await loadSelectedAdapterId(directory), null);

    await writeFile(
      path.join(directory, 'settings.json'),
      JSON.stringify({
        selectedAdapterId: 'guid:x; Start-Process calc.exe',
        version: 1,
      }),
      'utf8',
    );
    assert.equal(await loadSelectedAdapterId(directory), null);
  });
});

test('invalid adapter ids are never persisted', async () => {
  await withTemporaryDirectory(async (directory) => {
    await assert.rejects(
      saveSelectedAdapterId(directory, '../outside.json'),
      /invalid network adapter identifier/,
    );
  });
});
