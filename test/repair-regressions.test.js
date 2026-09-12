const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { mkdtemp, readFile, readdir, writeFile, rm, access } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ComponentLifecycle, cleanupAll } = require('../dist/main/lifecycle');
const { saveRecoveryJournal, loadRecoveryJournal, recoveryJournalHealth, trackAdapterChange } = require('../dist/main/recovery');
const { parseSplitRoutingSettings, PROTECTED_OPENAI_DOMAINS } = require('../dist/main/split-routing-settings');
const { buildPacScript } = require('../dist/main/pac-server');
const { startNativeHelper, stopNativeHelper, nativeHelperPath } = require('../dist/main/native-helper');
const { buildDedicatedConfig } = require('../dist/main/dedicated-routing');
const { WeChatAutoReplyService } = require('../dist/main/wechat-auto-reply');
const vm = require('node:vm');
const { createRequire } = require('node:module');

async function temporary(prefix, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 3 }); }
}

async function mainHarness(moduleOverrides = {}) {
  const filename = path.resolve(__dirname, '../dist/main/main.js');
  const localRequire = createRequire(filename);
  const context = vm.createContext({
    exports: {}, __dirname: path.dirname(filename), process, console,
    setTimeout, clearTimeout, setInterval, clearInterval, URL,
    require(name) {
      if (name === 'electron-squirrel-startup') return false;
      if (name === 'electron') return moduleOverrides[name] ?? {
        app: { setName() {}, requestSingleInstanceLock() { return false; }, quit() {} },
        protocol: { registerSchemesAsPrivileged() {} },
      };
      return moduleOverrides[name] ?? localRequire(name);
    },
  });
  vm.runInContext(await readFile(filename, 'utf8'), context, { filename });
  return context;
}

function navigationHarness(adapters, onQuery = () => {}, overrides = {}) {
  return mainHarness({
    './network': {
      ...require('../dist/main/network'),
      async listNetworkAdapters() { onQuery('adapters'); return adapters; },
      async setNetworkAdapterStates() { throw new Error('Unexpected OS mutation in navigation test.'); },
    },
    './safety-guard': {
      ...require('../dist/main/safety-guard'),
      async inspectProtectedNetworkClients() { onQuery('clients'); return { checked: true, running: [] }; },
    },
    ...overrides,
  });
}

const navigationAdapters = [1, 2].map(value => ({
  id: `guid:00000000-0000-0000-0000-00000000000${value}`, name: `Adapter ${value}`,
  description: '', interfaceIndex: value, enabled: true, connected: true,
}));

test('leaving an unchanged adapter page checks recovery and restores selection without Windows queries', async () => {
  await temporary('cherry-navigation-idle-', async directory => {
    const queries = [], calls = [];
    const context = await navigationHarness(navigationAdapters, name => queries.push(name));
    await require('../dist/main/settings').saveSelectedAdapterId(directory, navigationAdapters[1].id);
    Object.assign(context, { directory, calls, adapters: navigationAdapters });
    vm.runInContext(`
      userDataDirectory = directory;
      currentState = {...currentState, adapters, selectedAdapterId: adapters[0].id};
      adapterRecoveryBroker = {cancelPendingStart() {}, isActive: false, async restore() {calls.push('broker-check'); return false;}};
    `, context);
    const result = await vm.runInContext('restoreTrackedAdapterStates(false)', context);
    assert.deepEqual(calls, ['broker-check']);
    assert.deepEqual(queries, []);
    assert.equal(result.selectedAdapterId, navigationAdapters[1].id);
    assert.equal(result.pendingRestoreCount, 0);
    assert.equal(vm.runInContext('recoveryHealth', context), 'healthy');
    assert.deepEqual((await readdir(directory)).sort(), ['settings.json']);
  });
});

test('page exit waits for actual adapter restoration and verifies the result before clearing recovery', async () => {
  await temporary('cherry-navigation-pending-', async directory => {
    const queries = [];
    const context = await navigationHarness(navigationAdapters, name => queries.push(name));
    const journal = trackAdapterChange(null, navigationAdapters[0], false, 'navigation');
    await saveRecoveryJournal(directory, journal);
    let release;
    const brokerGate = new Promise(resolve => { release = resolve; });
    Object.assign(context, { directory, brokerGate, journal, adapters: navigationAdapters });
    vm.runInContext(`
      userDataDirectory = directory; recoveryJournal = journal;
      currentState = {...currentState, adapters};
      adapterRecoveryBroker = {cancelPendingStart() {}, isActive: true, async restore() {await brokerGate; return true;}};
    `, context);
    let settled = false;
    const result = vm.runInContext('restoreTrackedAdapterStates(false)', context).finally(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(queries.length, 0, 'Do not treat an unacknowledged restore as complete.');
    release();
    assert.equal((await result).pendingRestoreCount, 0);
    assert.ok(queries.filter(name => name === 'adapters').length >= 2);
    assert.ok(queries.includes('clients'));
    assert.equal(await loadRecoveryJournal(directory), null);
  });
});

test('idle-page optimization preserves damaged recovery evidence and refuses successful exit', async () => {
  await temporary('cherry-navigation-damaged-', async directory => {
    const context = await navigationHarness(navigationAdapters);
    const files = ['recovery.v4.json', 'recovery.v4.backup.json', 'recovery.v4.previous.json'];
    for (const name of files) await writeFile(path.join(directory, name), '{damaged');
    Object.assign(context, { directory, adapters: navigationAdapters });
    vm.runInContext(`
      userDataDirectory = directory; currentState = {...currentState, adapters};
      adapterRecoveryBroker = {cancelPendingStart() {}, isActive:false, async restore() {return false;}};
    `, context);
    await assert.rejects(vm.runInContext('restoreTrackedAdapterStates(false)', context), /damaged/);
    for (const name of files) assert.equal(await readFile(path.join(directory, name), 'utf8'), '{damaged');
    assert.equal(vm.runInContext('recoveryHealth', context), 'blocked');
  });
});

for (const legacy of [false, true]) {
  test(`${legacy ? 'legacy global' : 'isolated browser'} page exit waits for cleanup and ${legacy ? 'refreshes' : 'reuses'} adapter state`, async () => {
    await temporary('cherry-navigation-browser-', async directory => {
      const queries = [];
      const context = await navigationHarness(navigationAdapters, name => queries.push(name));
      let release;
      const cleanupGate = new Promise(resolve => { release = resolve; });
      Object.assign(context, { directory, cleanupGate, legacy, adapters: navigationAdapters });
      vm.runInContext(`
        userDataDirectory = directory; currentState = {...currentState, adapters};
        recoveryJournal = legacy ? {adapters: [], splitRouting: {phase:'active'}} : null;
        let splitState = {...currentState.splitRouting, status: 'active'};
        splitRoutingService = {
          getState() {return splitState;},
          async restore() {await cleanupGate; recoveryJournal = null; splitState = {...splitState, status:'inactive'};},
        };
      `, context);
      let settled = false;
      const result = vm.runInContext("deactivateSplitRouting('')", context).finally(() => { settled = true; });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false);
      release();
      assert.equal((await result).splitRouting.status, 'inactive');
      assert.deepEqual(queries, legacy ? ['adapters', 'clients'] : []);
    });
  });
}

for (const confirmed of [true, false]) {
  test(`exit after a broker error ${confirmed ? 'succeeds with verified recovery' : 'retains evidence while independent recovery is unresolved'}`, async () => {
    await temporary('cherry-exit-broker-', async directory => {
      let quitCalls = 0, dialogs = 0;
      const context = await navigationHarness(navigationAdapters, () => {}, {
        electron: {
          app: { setName() {}, requestSingleInstanceLock() { return false; }, quit() { quitCalls++; }, getLocale() { return 'zh-CN'; } },
          protocol: { registerSchemesAsPrivileged() {} },
          dialog: { async showMessageBox() { dialogs++; return { response: 1 }; }, showErrorBox() { throw new Error('Unexpected error dialog'); } },
        },
      });
      quitCalls = 0;
      const journal = trackAdapterChange(null, navigationAdapters[0], false, 'exit-regression');
      await saveRecoveryJournal(directory, journal);
      Object.assign(context, { directory, journal, confirmed, adapters: navigationAdapters });
      vm.runInContext(`
        userDataDirectory = directory; recoveryJournal = journal;
        currentState = {...currentState, adapters};
        adapterRecoveryBrokerError = new Error('old handshake failure');
        adapterRecoveryBroker = {
          isActive:false, cancelPendingStart() {},
          async restore() {throw new Error('lost restore acknowledgement');},
          async confirmRestored() {return confirmed;},
        };
      `, context);
      await vm.runInContext('requestApplicationQuit()', context);
      assert.equal(quitCalls, confirmed ? 1 : 0);
      assert.equal(dialogs, confirmed ? 0 : 1);
      assert.equal(vm.runInContext('quitApproved', context), confirmed);
      assert.equal((await loadRecoveryJournal(directory)) === null, confirmed);
      if (confirmed) assert.equal(vm.runInContext('adapterRecoveryBrokerError', context), null);
    });
  });
}

test('one-shot fallback restoration can complete after broker failure and verified independent cleanup', async () => {
  await temporary('cherry-exit-fallback-', async directory => {
    const adapters = navigationAdapters.map(adapter => ({ ...adapter }));
    const journal = trackAdapterChange(null, adapters[0], false, 'fallback-regression');
    adapters[0].enabled = false; adapters[0].connected = false;
    const changes = [];
    const context = await navigationHarness(adapters, () => {}, {
      './network': {
        ...require('../dist/main/network'),
        async listNetworkAdapters() { return adapters; },
        async setNetworkAdapterStates(requested) {
          changes.push(...requested);
          adapters[0].enabled = true;
        },
      },
    });
    await saveRecoveryJournal(directory, journal);
    Object.assign(context, { directory, journal, adapters });
    vm.runInContext(`
      userDataDirectory = directory; recoveryJournal = journal; quitInProgress = true;
      currentState = {...currentState, adapters};
      adapterRecoveryBroker = {
        isActive:false, cancelPendingStart() {},
        async restore() {throw new Error('broker connection lost');},
        async confirmRestored() {return true;},
      };
    `, context);
    assert.equal((await vm.runInContext('restoreTrackedAdapterStates(false)', context)).pendingRestoreCount, 0);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].action, 'enable');
    assert.equal(await loadRecoveryJournal(directory), null);
  });
});

test('an apply handshake failure reconciles unexecuted intent and permits subsequent cleanup', async () => {
  await temporary('cherry-apply-handshake-', async directory => {
    const context = await navigationHarness(navigationAdapters);
    Object.assign(context, { directory, adapters: navigationAdapters });
    vm.runInContext(`
      userDataDirectory = directory; recoveryHealth = 'healthy';
      currentState = {...currentState, adapters};
      adapterRecoveryBroker = {
        isActive:false, cancelPendingStart() {},
        async apply() {throw new Error('handshake failed before dispatch');},
        async prepare() {},
        async restore() {return false;},
      };
    `, context);
    await assert.rejects(vm.runInContext("changeAdapterState(adapters[0].id, 'disable')", context), /handshake failed/);
    assert.equal(await loadRecoveryJournal(directory), null);
    assert.equal(vm.runInContext('adapterRecoveryBrokerError', context), null);
    await vm.runInContext('cleanupApplicationComponents()', context);
  });
});

test('helper preflight fails before creating an adapter intent and exit remains available', async () => {
  await temporary('cherry-helper-preflight-', async directory => {
    const context = await navigationHarness(navigationAdapters);
    Object.assign(context, { directory, adapters: navigationAdapters });
    vm.runInContext(`
      userDataDirectory = directory; recoveryHealth = 'healthy';
      currentState = {...currentState, adapters};
      adapterRecoveryBroker = {
        isActive:false, cancelPendingStart() {},
        async prepare() {throw new Error('helper integrity mismatch');},
        async apply() {throw new Error('unwanted dispatch');},
        async restore() {return false;},
      };
    `, context);
    await assert.rejects(vm.runInContext("changeAdapterState(adapters[0].id, 'disable')", context), /integrity mismatch/);
    assert.equal((await readdir(directory)).length, 0, 'No intent or recovery files should be written by preflight');
    assert.equal(vm.runInContext('adapterRecoveryBrokerError', context), null);
    await vm.runInContext('cleanupApplicationComponents()', context);
  });
});

test('preflight failure preserves older adapter recovery records byte for byte', async () => {
  await temporary('cherry-helper-prior-intent-', async directory => {
    const journal = trackAdapterChange(null, navigationAdapters[1], false, 'prior-operation');
    await saveRecoveryJournal(directory, journal);
    const before = await readFile(path.join(directory, 'recovery.v4.json'), 'utf8');
    const context = await navigationHarness(navigationAdapters);
    Object.assign(context, { directory, journal, adapters: navigationAdapters });
    vm.runInContext(`
      userDataDirectory = directory; recoveryJournal = journal; recoveryHealth = 'healthy';
      currentState = {...currentState, adapters};
      adapterRecoveryBroker = {isActive:true, hasDispatchedChanges:true,
        async prepare() {throw new Error('helper integrity mismatch');}
      };
    `, context);
    await assert.rejects(vm.runInContext("changeAdapterState(adapters[0].id, 'disable')", context), /integrity mismatch/);
    assert.equal(await readFile(path.join(directory, 'recovery.v4.json'), 'utf8'), before);
  });
});

test('application cleanup attempts independent resources despite damaged evidence and reports unresolved components', async () => {
  const context = await mainHarness();
  context.calls = [];
  vm.runInContext(`
    recoveryJournalLoadError = new Error('damaged journal fixture');
    refreshState = async () => currentState;
    splitRoutingService = {
      async restore() { calls.push('split'); throw new Error('profile locked'); },
      getState() { return { ...currentState.splitRouting, pendingRecovery: true }; },
    };
    weChatAutoReplyService = {
      pendingRecovery: true,
      getState() { return { status: 'error' }; },
      async shutdown() { calls.push('wechat'); throw new Error('worker did not exit'); },
    };
    adapterRecoveryBroker = { cancelPendingStart() {}, isActive: false, async restore() { calls.push('broker'); return false; } };
  `, context);
  await assert.rejects(vm.runInContext('cleanupApplicationComponents()', context), /damaged recovery journal/);
  assert.deepEqual(context.calls, ['wechat', 'split', 'broker']);
  const safety = vm.runInContext('safetyState()', context);
  assert.equal(safety.pendingRecoveryCount, 2);
  assert.equal(safety.adapterMutationsBlocked, true);
  assert.equal(safety.wechatRecoveryPending, true);
  vm.runInContext("recoveryJournalLoadError = null; recoveryHealth = 'healthy'", context);
  assert.throws(() => vm.runInContext('assertMutationAdmission()', context), /pending cleanup/);
});

test('cleanup waits for admitted work, rejects new work and attempts all resources', async () => {
  const lifecycle = new ComponentLifecycle();
  let release;
  const admitted = lifecycle.run(() => new Promise(resolve => { release = resolve; }));
  await Promise.resolve();
  const calls = [];
  const cleanup = lifecycle.stop(() => cleanupAll([async () => { calls.push(1); throw new Error('first failed'); }, async () => { calls.push(2); }]));
  assert.equal(lifecycle.stop(async () => {}), cleanup);
  await assert.rejects(lifecycle.run(async () => calls.push('unwanted')), /stopping|cleanup/i);
  release(); await admitted;
  await assert.rejects(cleanup, /first failed/);
  assert.deepEqual(calls, [1, 2]);
  await assert.rejects(lifecycle.run(async () => {}), /first failed|recovery/i);
  await lifecycle.stop(async () => {});
  assert.equal(await lifecycle.run(async () => 42), 42);
});

test('each v4 mirror contains the latest two adapter records and tombstones cannot resurrect them', async () => {
  await temporary('cherry-journal-regression-', async directory => {
    const adapter = id => ({ id, name: id, enabled: true });
    let journal = trackAdapterChange(null, adapter('guid:00000000-0000-0000-0000-000000000001'), false, 'regression');
    await saveRecoveryJournal(directory, journal);
    journal = trackAdapterChange(journal, adapter('guid:00000000-0000-0000-0000-000000000002'), false, 'regression');
    await saveRecoveryJournal(directory, journal);
    const files = ['recovery.v4.json', 'recovery.v4.backup.json', 'recovery.v4.previous.json'];
    const bytes = await Promise.all(files.map(name => readFile(path.join(directory, name), 'utf8')));
    assert.equal(new Set(bytes).size, 1);
    await writeFile(path.join(directory, files[0]), '{broken');
    assert.equal((await loadRecoveryJournal(directory)).adapters.length, 2);
    assert.equal(await recoveryJournalHealth(directory), 'degraded');
    await saveRecoveryJournal(directory, null);
    await writeFile(path.join(directory, files[2]), bytes[2]);
    assert.equal(await loadRecoveryJournal(directory), null);
    assert.equal(await recoveryJournalHealth(directory), 'degraded');
    await saveRecoveryJournal(directory, null);
    assert.equal(await recoveryJournalHealth(directory), 'healthy');
    assert.equal((await readdir(directory)).filter(name => name.endsWith('.tmp')).length, 0);
  });
});

test('protected suffix ancestors and PAC rule priority cannot capture OpenAI', () => {
  const settings = { chatgptEnabled: false, controllerPort: 9090, customDomains: [], ipinfoEnabled: true, primaryAdapterId: null, proxyAdapterId: null };
  for (const domain of ['com', 'workos.com', 'sendgrid.net', 'api.openai.com']) assert.throws(() => parseSplitRoutingSettings({ ...settings, customDomains: [domain] }));
  const context = { isPlainHostName: host => !host.includes('.'), Number };
  vm.runInNewContext(buildPacScript(['com', 'workos.com', 'sendgrid.net'], 7890), context);
  for (const domain of PROTECTED_OPENAI_DOMAINS) assert.equal(context.FindProxyForURL(`https://${domain}/`, domain), 'DIRECT');
});

test('a worker stop timeout keeps its process handle and remains retryable', async () => {
  await temporary('cherry-worker-regression-', async directory => {
    const service = new WeChatAutoReplyService({ dataDirectory: directory, projectRoot: directory, sourceMode: false, stateChanged() {} });
    await service.initialize();
    const child = new EventEmitter(); child.exitCode = null; child.signalCode = null; child.pid = 123;
    child.stdin = new EventEmitter(); child.stdin.writable = true; child.stdin.end = () => {};
    child.kill = () => false;
    service.child = child; service.workerStopTimeoutMs = 40;
    await assert.rejects(service.shutdown(), /did not exit/);
    assert.equal(service.child, child);
    assert.equal(service.pendingRecovery, true);
    await assert.rejects(service.shutdown(), /did not exit/);
    child.exitCode = 0;
    await service.shutdown();
    assert.equal(service.child, null);
    assert.equal(service.pendingRecovery, false);
    assert.equal(service.getState().status, 'stopped');
  });
});

test('native policy self-tests execute compiled restoration and domain logic', async () => {
  const helper = await nativeHelperPath();
  const output = await new Promise((resolve, reject) => {
    const child = spawn(helper, ['self-test'], { windowsHide: true }); let text = '';
    child.stdout.on('data', bytes => { text += bytes; }); child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(text) : reject(new Error(text)));
    child.stdin.end('{}\n');
  });
  assert.equal(JSON.parse(output).type, 'passed');
});

test('a real Windows Job stops its child and deletes its owned temporary profile', async () => {
  await temporary('cherry-toolbox-isolated-browser-', async directory => {
    await writeFile(path.join(directory, 'owned.txt'), 'session data');
    const { child, ready } = await startNativeHelper('job', { executable: process.execPath, arguments: ['-e', 'setInterval(()=>{},1000)'], workingDirectory: directory, cleanupDirectory: directory });
    assert.ok(Number.isInteger(ready.pid));
    try { await stopNativeHelper(child); } finally { if (child.exitCode === null) child.kill(); }
    assert.throws(() => process.kill(ready.pid, 0));
    await assert.rejects(access(directory), { code: 'ENOENT' });
  });
});

test('loss of the parent input pipe stops a real managed child', async () => {
  const { child, ready } = await startNativeHelper('job', { executable: process.execPath, arguments: ['-e', 'setInterval(()=>{},1000)'], workingDirectory: process.cwd() });
  const exited = new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill(); reject(new Error('Orphan guardian did not stop')); }, 5000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
  child.stdin.end(); await exited;
  assert.throws(() => process.kill(ready.pid, 0));
});

test('killing the independent supervisor closes its Job and kills the child', async () => {
  const { child, ready } = await startNativeHelper('job', { executable: process.execPath, arguments: ['-e', 'setInterval(()=>{},1000)'], workingDirectory: process.cwd() });
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill(); await exited;
  let gone = false;
  for (let i = 0; i < 30; i++) { try { process.kill(ready.pid, 0); } catch { gone = true; break; } await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.equal(gone, true, 'Closing the last Job handle must terminate its child');
});

test('component settings are restored in memory without overwriting original files', async () => {
  await temporary('cherry-settings-regression-', async directory => {
    const { saveWeChatAutoReplySettings } = require('../dist/main/wechat-auto-reply-settings');
    const original = { version: 2, allowlist: ['Original'], replyText: 'Original', cooldownMinutes: 30, dailyLimit: 20, dryRun: true, enabled: false };
    await saveWeChatAutoReplySettings(directory, original);
    const before = await Promise.all((await readdir(directory)).map(async name => [name, await readFile(path.join(directory, name), 'utf8')]));
    const service = new WeChatAutoReplyService({ dataDirectory: directory, projectRoot: directory, sourceMode: false, stateChanged() {} });
    await service.initialize();
    await service.saveSettings({ ...original, allowlist: ['Changed'] });
    await service.shutdown();
    assert.deepEqual(service.getState().settings, original);
    for (const [name, bytes] of before) assert.equal(await readFile(path.join(directory, name), 'utf8'), bytes);
  });
});

test('dedicated configuration has only the selected node, bound DNS and no global listeners', () => {
  const config = buildDedicatedConfig({ name: 'CHERRY-SELECTED', type: 'ss', server: 'node.example', port: 443, cipher: 'aes-128-gcm', password: 'fixture' }, { id: 'test', interfaceIndex: 17, name: 'WLAN' }, '203.0.113.2', ['192.0.2.53'], 32123, 'fixture', 'secret');
  assert.equal(config.proxies[0]['interface-name'], 'WLAN');
  assert.equal(config.proxies[0].server, '203.0.113.2');
  assert.equal(config.proxies[0].servername, 'node.example');
  assert.equal(config.rules.at(-1), 'MATCH,CHERRY-SELECTED');
  assert.ok(config.rules.includes('IP-CIDR,127.0.0.0/8,REJECT'));
  assert.ok(config.rules.every(rule => !rule.includes('DIRECT')));
  assert.deepEqual(config.dns.nameserver, ['tcp://192.0.2.53#WLAN']);
  assert.equal(config.tun.enable, false);
  assert.equal(config['allow-lan'], false);
  assert.equal(config['external-controller'], '');
  assert.deepEqual(config.authentication, ['fixture:secret']);
});
