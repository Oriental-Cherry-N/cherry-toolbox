const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ADAPTER_RECOVERY_WATCHDOG_SCRIPT,
  AdapterRecoveryBroker,
  parseAdapterRecoveryBrokerState,
} = require('../dist/main/adapter-recovery-broker.js');
const {
  assertAdapterMutationIsSafe,
} = require('../dist/main/safety-guard.js');

const WIFI_ID = 'guid:F67053B5-6802-4989-9869-6105783C240B';
const ETHERNET_ID = 'guid:0CEB962B-5463-4B13-B939-0993E29BCBEF';

function adapter(id, name, enabled, connected) {
  return {
    id,
    name,
    description: '',
    interfaceIndex: 1,
    adminStatus: enabled ? 'Up' : 'Down',
    connectionStatus: connected ? 'Up' : 'Disconnected',
    enabled,
    connected,
  };
}

async function writeJsonAtomically(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value), 'utf8');
  await rename(temporary, filePath);
}

async function withTemporaryDirectory(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'safety-test-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

test('adapter guard refuses ChatGPT disruption and the last connected adapter', () => {
  const ethernet = adapter(ETHERNET_ID, 'Ethernet', true, true);
  const wifi = adapter(WIFI_ID, 'WLAN', true, true);
  assert.throws(
    () =>
      assertAdapterMutationIsSafe(
        [ethernet, wifi],
        wifi,
        'disable',
        { checked: true, running: ['ChatGPT'] },
      ),
    /protected ChatGPT client/,
  );
  assert.throws(
    () =>
      assertAdapterMutationIsSafe(
        [ethernet],
        ethernet,
        'disable',
        { checked: true, running: [] },
      ),
    /last connected network adapter/,
  );
  assert.doesNotThrow(() =>
    assertAdapterMutationIsSafe(
      [ethernet, wifi],
      wifi,
      'disable',
      { checked: true, running: [] },
    ),
  );
  assert.throws(
    () =>
      assertAdapterMutationIsSafe(
        [ethernet, wifi],
        wifi,
        'disable',
        { checked: false, running: [] },
      ),
    /Protected-client status could not be verified/,
  );
});

test('broker state parsing authenticates the exact session', () => {
  const session = {
    directory: path.join(tmpdir(), 'adapter-recovery-broker', 'session'),
    sessionId: '8b64fcb2-6e22-4d72-bae3-16f6f08b470a',
    token: 'a'.repeat(64),
    version: 1,
  };
  const state = {
    helperPid: 123,
    lastError: null,
    phase: 'active',
    sequence: 1,
    sessionId: session.sessionId,
    token: session.token,
    updatedAt: '2026-09-02T12:00:00.000Z',
    version: 1,
  };
  assert.deepEqual(parseAdapterRecoveryBrokerState(state, session), state);
  assert.throws(
    () =>
      parseAdapterRecoveryBrokerState(
        { ...state, token: 'b'.repeat(64) },
        session,
      ),
    /invalid state/,
  );
});

test('independent broker applies, acknowledges, restores, and removes only its session', async () => {
  await withTemporaryDirectory(async (directory) => {
    let helperTimer = null;
    let observedLaunch = '';
    let processedSequence = 0;
    const launch = async (script) => {
      observedLaunch = script;
      const currentPath = path.join(
        directory,
        'adapter-recovery-broker',
        'current.json',
      );
      const descriptor = JSON.parse(await readFile(currentPath, 'utf8'));
      const commandPath = path.join(descriptor.directory, 'command.json');
      const statePath = path.join(descriptor.directory, 'state.json');
      const tick = async () => {
        const command = JSON.parse(await readFile(commandPath, 'utf8'));
        if (command.sequence <= processedSequence) return;
        processedSequence = command.sequence;
        await writeJsonAtomically(statePath, {
          helperPid: process.pid,
          lastError: null,
          phase: command.action === 'restore' ? 'restored' : 'active',
          sequence: command.sequence,
          sessionId: descriptor.sessionId,
          token: descriptor.token,
          updatedAt: new Date().toISOString(),
          version: 1,
        });
        if (command.action === 'restore' && helperTimer) {
          clearInterval(helperTimer);
          helperTimer = null;
        }
      };
      await tick();
      helperTimer = setInterval(() => void tick(), 20);
    };
    const broker = new AdapterRecoveryBroker(directory, { launch });
    const record = {
      adapterId: WIFI_ID,
      adapterName: 'WLAN',
      originalEnabled: true,
      requestedEnabled: false,
    };
    await broker.apply([record]);
    assert.equal(broker.isActive, true);
    assert.match(observedLaunch, /Start-Process/u);

    await broker.apply([{ ...record, requestedEnabled: true }]);
    await broker.restore();
    assert.equal(broker.isActive, false);
    assert.deepEqual(
      await readdir(path.join(directory, 'adapter-recovery-broker')),
      [],
    );
  });
});

test('watchdog retries restoration after parent or heartbeat loss', () => {
  assert.match(ADAPTER_RECOVERY_WATCHDOG_SCRIPT, /Test-ParentHealthy/u);
  assert.match(ADAPTER_RECOVERY_WATCHDOG_SCRIPT, /Restore-UntilSuccessful/u);
  assert.match(ADAPTER_RECOVERY_WATCHDOG_SCRIPT, /while \(\$true\)/u);
  assert.match(ADAPTER_RECOVERY_WATCHDOG_SCRIPT, /Enable-NetAdapter/u);
  assert.match(ADAPTER_RECOVERY_WATCHDOG_SCRIPT, /Disable-NetAdapter/u);
  assert.match(ADAPTER_RECOVERY_WATCHDOG_SCRIPT, /failed authentication/u);
});

test('watchdog is valid Windows PowerShell syntax', async () => {
  await new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$source = [Console]::In.ReadToEnd(); [void][ScriptBlock]::Create($source)',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `PowerShell parser exited with ${code}.`));
    });
    child.stdin.end(ADAPTER_RECOVERY_WATCHDOG_SCRIPT, 'utf8');
  });
});
