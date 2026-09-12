const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const {
  access,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} = require('node:fs/promises');
const { createServer } = require('node:http');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const YAML = require('yaml');

const {
  applyFlClashRuntime,
  defaultFlClashConfigPath,
  inspectFlClashRuntimeReadOnly,
  prepareFlClashRuntime,
  restoreFlClashRuntime,
  waitForFlClashMixedPort,
} = require('../dist/main/flclash.js');
const {
  IsolatedBrowserManager,
  safeProfilePath,
} = require('../dist/main/isolated-browser.js');
const { buildPacScript, PacServer } = require('../dist/main/pac-server.js');
const {
  loadRecoveryJournal,
  parseRecoveryJournal,
  pendingRecoveryCount,
  setSplitRoutingRecovery,
} = require('../dist/main/recovery.js');
const {
  IPINFO_DOMAIN_PRESET,
  PROTECTED_OPENAI_DOMAINS,
  loadSplitRoutingSettings,
  parseSplitRoutingSettings,
  proxyDomainsForSettings,
  saveSplitRoutingSettings,
} = require('../dist/main/split-routing-settings.js');
const { SplitRoutingService } = require('../dist/main/split-routing.js');
const {
  isRoutableEndpointAddress,
  planOwnedHostRoutes,
} = require('../dist/main/windows-split-routing.js');

const PRIMARY_ID = 'guid:0CEB962B-5463-4B13-B939-0993E29BCBEF';
const PROXY_ID = 'guid:F67053B5-6802-4989-9869-6105783C240B';
const NOW = '2026-08-26T12:00:00.000Z';

function settings(overrides = {}) {
  return {
    chatgptEnabled: false,
    controllerPort: 9090,
    customDomains: [],
    ipinfoEnabled: true,
    primaryAdapterId: PRIMARY_ID,
    proxyAdapterId: PROXY_ID,
    version: 1,
    ...overrides,
  };
}

function adapters() {
  return [
    {
      id: PRIMARY_ID,
      name: 'Ethernet',
      description: '',
      interfaceIndex: 4,
      adminStatus: 'Up',
      connectionStatus: 'Up',
      enabled: true,
      connected: true,
    },
    {
      id: PROXY_ID,
      name: 'WLAN',
      description: '',
      interfaceIndex: 17,
      adminStatus: 'Up',
      connectionStatus: 'Up',
      enabled: true,
      connected: true,
    },
  ];
}

function ipInterfaces(interfaceMetric) {
  return [
    {
      addressFamily: 'IPv4',
      automaticMetric: true,
      ignoreDefaultRoutes: false,
      interfaceMetric,
    },
  ];
}

function registrySnapshot() {
  return [
    { exists: false, kind: null, name: 'AutoConfigURL', value: null },
    { exists: false, kind: null, name: 'AutoDetect', value: null },
    { exists: false, kind: null, name: 'ProxyEnable', value: null },
    { exists: false, kind: null, name: 'ProxyOverride', value: null },
    { exists: false, kind: null, name: 'ProxyServer', value: null },
  ];
}

function legacySnapshot() {
  return {
    defaultRoutes: [
      {
        addressFamily: 'IPv4',
        destinationPrefix: '0.0.0.0/0',
        nextHop: '10.0.0.1',
        routeMetric: 30,
      },
    ],
    ownedRoutes: [],
    primary: {
      adapterId: PRIMARY_ID,
      adapterName: 'Ethernet',
      enabled: true,
      interfaceIndex: 4,
      ipInterfaces: ipInterfaces(25),
    },
    proxy: {
      adapterId: PROXY_ID,
      adapterName: 'WLAN',
      enabled: true,
      interfaceIndex: 17,
      ipInterfaces: ipInterfaces(35),
    },
    registryValues: registrySnapshot(),
  };
}

async function withTemporaryDirectory(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'split-routing-test-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function evaluatePac(script, url, host) {
  const context = {
    isPlainHostName: (value) => !String(value).includes('.'),
    Number,
  };
  vm.runInNewContext(script, context);
  return context.FindProxyForURL(url, host);
}

test('PAC proxies safe website targets but explicitly leaves OpenAI and lookalikes direct', () => {
  const domains = proxyDomainsForSettings(
    settings({ customDomains: ['example.com'] }),
  );
  const script = buildPacScript(domains, 7890);

  assert.equal(
    evaluatePac(script, 'https://chatgpt.com/', 'chatgpt.com'),
    'DIRECT',
  );
  assert.equal(
    evaluatePac(script, 'https://api.ipinfo.io/', 'api.ipinfo.io'),
    'PROXY 127.0.0.1:7890',
  );
  assert.equal(
    evaluatePac(script, 'https://sub.example.com/', 'sub.example.com'),
    'PROXY 127.0.0.1:7890',
  );
  assert.equal(
    evaluatePac(script, 'https://fakeipinfo.io/', 'fakeipinfo.io'),
    'DIRECT',
  );
  assert.equal(
    evaluatePac(script, 'http://192.168.1.1/', '192.168.1.1'),
    'DIRECT',
  );
  assert.doesNotMatch(script, /PROXY 127\.0\.0\.1:7890;\s*DIRECT/u);
  assert.deepEqual(IPINFO_DOMAIN_PRESET, ['ipinfo.io']);
  assert.ok(PROTECTED_OPENAI_DOMAINS.includes('chatgpt.com'));
});

test('PAC pause points at its own rejecting loopback server', async () => {
  const server = new PacServer();
  try {
    const url = await server.start(['ipinfo.io'], 7890);
    server.setFailClosed(['ipinfo.io']);
    const script = await (await fetch(url)).text();
    const pacPort = new URL(url).port;
    assert.equal(
      evaluatePac(script, 'https://ipinfo.io/', 'ipinfo.io'),
      `PROXY 127.0.0.1:${pacPort}`,
    );
    assert.ok(!script.includes('127.0.0.1:7890'));
  } finally {
    await server.stop();
  }
});

test('safe settings normalize domains and hard-block OpenAI targets', async () => {
  const parsed = parseSplitRoutingSettings(
    settings({
      chatgptEnabled: true,
      customDomains: ['*.Example.com.', 'example.com'],
    }),
  );
  assert.equal(parsed.chatgptEnabled, false);
  assert.deepEqual(parsed.customDomains, ['example.com']);
  assert.throws(
    () =>
      parseSplitRoutingSettings(
        settings({ customDomains: ['https://example.com/x'] }),
      ),
    /Invalid proxy domain/,
  );
  assert.throws(
    () =>
      parseSplitRoutingSettings(
        settings({ customDomains: ['chatgpt.com'] }),
      ),
    /ChatGPT and OpenAI domains are protected/,
  );
  assert.throws(
    () =>
      parseSplitRoutingSettings(
        settings({ customDomains: ['sub.api.openai.com'] }),
      ),
    /ChatGPT and OpenAI domains are protected/,
  );
  assert.throws(
    () => parseSplitRoutingSettings(settings({ proxyAdapterId: PRIMARY_ID })),
    /must be different/,
  );

  await withTemporaryDirectory(async (directory) => {
    await saveSplitRoutingSettings(directory, parsed);
    assert.deepEqual(await loadSplitRoutingSettings(directory), parsed);
    const stored = JSON.parse(
      await readFile(
        path.join(directory, 'split-routing-settings.json'),
        'utf8',
      ),
    );
    assert.equal(stored.version, 1);
    assert.equal(stored.chatgptEnabled, false);
  });
});

test('FlClash canonical config uses the current Windows application-support path', () => {
  assert.match(
    defaultFlClashConfigPath().replaceAll('\\', '/'),
    /\/com\.follow\/clash\/config\.yaml$/u,
  );
});

async function withFakeController(run, runtimeMixedPort = 7890) {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString('utf8'))
        : null;
      requests.push({ method: request.method, url: request.url, body });
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'GET' && request.url === '/configs') {
        response.end(
          JSON.stringify({
            'external-controller': `127.0.0.1:${server.address().port}`,
            'mixed-port': runtimeMixedPort,
          }),
        );
      } else if (request.method === 'GET' && request.url === '/proxies') {
        response.end(
          JSON.stringify({
            proxies: { Select: { type: 'Selector', now: 'Node A' } },
          }),
        );
      } else {
        response.end('{}');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(server.address().port, requests);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test('safe FlClash inspection is GET-only and requires an enabled mixed port', async () => {
  await withFakeController(async (port, requests) => {
    const runtime = await inspectFlClashRuntimeReadOnly({ port, secret: '' });
    assert.equal(runtime.mixedPort, 7890);
    assert.equal(runtime.controller, `127.0.0.1:${port}`);
    assert.deepEqual(
      requests.map((item) => [item.method, item.url]),
      [['GET', '/configs']],
    );
  });
  await withFakeController(
    async (port) => {
      await assert.rejects(
        inspectFlClashRuntimeReadOnly({ port, secret: '' }),
        /must already be enabled/,
      );
    },
    0,
  );
});

test('legacy FlClash transformation preserves canonical YAML', async () => {
  await withTemporaryDirectory(async (directory) => {
    const configPath = path.join(directory, 'config.yaml');
    const canonical = [
      'mixed-port: 7890',
      'external-controller: ""',
      'secret: ""',
      'proxies:',
      '  - name: Node A',
      '    type: ss',
      '    server: 203.0.113.10',
      '    port: 443',
      'proxy-groups:',
      '  - name: Select',
      '    type: select',
      '    proxies: [Node A]',
      'proxy-providers:',
      '  Inline Provider:',
      '    type: inline',
      '    payload:',
      '      - name: Node B',
      '        type: ss',
      '        server: 198.51.100.11',
      '        port: 443',
      'unknown-field:',
      '  preserved: true',
      '',
    ].join('\n');
    await writeFile(configPath, canonical, 'utf8');

    await withFakeController(async (port, requests) => {
      const prepared = await prepareFlClashRuntime(
        'WLAN',
        { port, secret: 'session-secret' },
        configPath,
      );
      const transformed = YAML.parse(prepared.temporaryPayload);
      assert.equal(transformed['interface-name'], 'WLAN');
      assert.equal(transformed.proxies[0]['interface-name'], 'WLAN');
      assert.equal(
        transformed['proxy-providers']['Inline Provider'].override[
          'interface-name'
        ],
        'WLAN',
      );
      assert.equal(transformed['external-controller'], `127.0.0.1:${port}`);
      assert.equal(transformed['unknown-field'].preserved, true);

      await applyFlClashRuntime(prepared, { port, secret: 'session-secret' });
      await restoreFlClashRuntime(
        configPath,
        { port, secret: 'session-secret' },
        prepared.selectorChoices,
      );
      assert.equal(
        requests.filter(
          (item) => item.method === 'PUT' && item.url === '/configs?force=true',
        ).length,
        2,
      );
      assert.equal(await readFile(configPath, 'utf8'), canonical);
    });
  });
});

test('FlClash mixed-port readiness waits for a real loopback listener', async () => {
  await withFakeController(async (port) => {
    await waitForFlClashMixedPort(port, 1_000);
  });
});

test('legacy route planner owns only absent routable host routes', () => {
  const proxy = {
    adapterId: PROXY_ID,
    adapterName: 'WLAN',
    enabled: true,
    interfaceIndex: 17,
    ipInterfaces: [],
  };
  const defaults = [
    {
      addressFamily: 'IPv4',
      destinationPrefix: '0.0.0.0/0',
      nextHop: '10.0.0.1',
      routeMetric: 30,
    },
    {
      addressFamily: 'IPv6',
      destinationPrefix: '::/0',
      nextHop: 'fe80::1',
      routeMetric: 30,
    },
  ];
  const existing = new Set(['203.0.113.10/32' + '\0' + '10.0.0.1']);
  const planned = planOwnedHostRoutes(
    [
      '127.0.0.1',
      '::1',
      '169.254.1.1',
      '203.0.113.10',
      '198.51.100.20',
      '2001:db8::20',
    ],
    proxy,
    defaults,
    existing,
  );
  assert.deepEqual(
    planned.map((route) => [route.destinationPrefix, route.nextHop]),
    [
      ['198.51.100.20/32', '10.0.0.1'],
      ['2001:db8::20/128', 'fe80::1'],
    ],
  );
  assert.equal(isRoutableEndpointAddress('127.0.0.1'), false);
  assert.equal(isRoutableEndpointAddress('198.51.100.20'), true);
});

test('recovery v1 and v2 migrate to redundant v3', () => {
  for (const version of [1, 2]) {
    const migrated = parseRecoveryJournal({
      adapters: [],
      createdAt: NOW,
      sessionId: 'legacy-session',
      splitRouting: null,
      updatedAt: NOW,
      version,
    });
    assert.equal(migrated.version, 3);
    assert.equal(migrated.splitRouting, null);
  }

  const migrated = parseRecoveryJournal({
    adapters: [],
    createdAt: NOW,
    sessionId: 'legacy-session',
    updatedAt: NOW,
    version: 1,
  });
  const configPath = path.join(
    process.env.APPDATA,
    'com.follow',
    'clash',
    'config.yaml',
  );
  const journal = setSplitRoutingRecovery(
    migrated,
    {
      canonicalConfigHash: 'a'.repeat(64),
      canonicalConfigPath: configPath,
      createdAt: NOW,
      networkIsolationApplied: true,
      pacUrl: null,
      phase: 'prepared',
      selectorChoices: {},
      settings: settings(),
      snapshot: legacySnapshot(),
      temporaryConfigApplied: false,
      updatedAt: NOW,
      watchedFiles: [configPath],
    },
    'session-2',
    NOW,
  );
  assert.equal(pendingRecoveryCount(journal), 1);
  assert.equal(parseRecoveryJournal(journal).splitRouting.phase, 'prepared');
});

function fakeBrowser(calls, overrides = {}) {
  let session = null;
  let running = false;
  return {
    get activeSession() {
      return session;
    },
    get isRunning() {
      return running;
    },
    async inspectBrowser() {
      calls.push('inspect-browser');
      return 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe';
    },
    async recoverOrphanedSession() {
      calls.push('recover-browser');
      if (overrides.recover) await overrides.recover();
    },
    async start(pacUrl, initialUrl, mode = 'sites') {
      calls.push(['start-browser', pacUrl, initialUrl]);
      if (overrides.start) await overrides.start({ mode, initialUrl });
      session = {
        browserPath: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        pid: 1234,
        profilePath: path.join(
          tmpdir(),
          'cherry-toolbox-isolated-browser-test',
        ),
      };
      running = true;
      return session;
    },
    async stop() {
      calls.push('stop-browser');
      if (overrides.stop) await overrides.stop();
      session = null;
      running = false;
    },
  };
}

function fakePac(calls, overrides = {}) {
  let url = null;
  return {
    get url() {
      return url;
    },
    async start(domains, mixedPort) {
      calls.push(['start-pac', [...domains], mixedPort]);
      if (overrides.start) await overrides.start();
      url = `http://127.0.0.1:32123/${'b'.repeat(48)}.pac`;
      return url;
    },
    async stop() {
      calls.push('stop-pac');
      if (overrides.stop) await overrides.stop();
      url = null;
    },
  };
}

function fakeRouting(calls, overrides = {}) {
  let url = null;
  return {
    get url() { return url; }, get isRunning() { return url !== null; }, corePid: 1234, evidence: [],
    async recover() { calls.push('recover-routing'); },
    async start(_prepared, primary, proxy, domains, mode = 'sites') {
      calls.push(['start-routing', [...domains], primary.interfaceIndex, proxy.interfaceIndex]);
      if (overrides.start) await overrides.start({ mode, domains, primary, proxy });
      url = 'http://127.0.0.1:32123'; return url;
    },
    async stop() { calls.push('stop-routing'); if (overrides.stop) await overrides.stop(); url = null; },
  };
}

function safeOperations(calls, hashes = ['a', 'a', 'a', 'a']) {
  let fingerprintIndex = 0;
  return {
    inspectDedicatedRouting: async () => ({ corePath: 'C:\\mihomo.exe', node: { name: 'CHERRY-SELECTED' } }),
    assertFlClashMixedPortIsLoopbackOnly: async (port) => {
      calls.push(['check-loopback', port]);
    },
    captureSystemNetworkFingerprint: async () => {
      const hash = hashes[Math.min(fingerprintIndex, hashes.length - 1)];
      fingerprintIndex += 1;
      calls.push(['fingerprint', hash]);
      return { capturedAt: NOW, hash: hash.repeat(64) };
    },
    defaultFlClashConfigPath: () => 'C:\\safe-read-only-config.yaml',
    flClashControllerIsAlive: async () => true,
    inspectFlClashRuntimeReadOnly: async () => {
      calls.push('inspect-flclash');
      return { controller: '127.0.0.1:9090', mixedPort: 7890 };
    },
    verifyBrowserRouting: async (_session, selectedAdapters, _routing, unchanged) => {
      calls.push([
        'verify',
        selectedAdapters,
        unchanged,
      ]);
      return {
        checkedAt: NOW,
        direct: {
          adapterName: 'Ethernet',
          localAddress: '192.0.2.10',
          publicIp: '198.51.100.1',
        },
        egressObservation: 'proxy',
        passed: unchanged,
        proxied: {
          adapterName: 'WLAN',
          localAddresses: ['192.0.2.20'],
          publicIp: '203.0.113.1',
        },
        publicIpsDiffer: true,
        systemRoutingUnchanged: unchanged,
      };
    },
    waitForFlClashMixedPort: async (port) => {
      calls.push(['wait-mixed', port]);
    },
  };
}

test('safe activation binds a dedicated proxy and isolated browser without global writes', async () => {
  await withTemporaryDirectory(async (directory) => {
    const calls = [];
    let journal = null;
    const service = new SplitRoutingService({
      browserManager: fakeBrowser(calls),
      dataDirectory: directory,
      getRecoveryJournal: () => journal,
      operations: safeOperations(calls),
      pacServer: fakePac(calls),
      routing: fakeRouting(calls),
      replaceRecoveryJournal: async (next) => {
        journal = next;
        calls.push('write-recovery-journal');
      },
      sessionId: 'safe-session',
      stateChanged() {},
    });
    await service.initialize();
    const preflight = await service.preflight(
      settings({ customDomains: ['example.com'] }),
      '',
      adapters(),
    );
    assert.equal(preflight.routeEndpointCount, 0);
    assert.equal(preflight.canonicalConfigPath, null);
    assert.match(preflight.diagnostics.join(' '), /will not be changed/);

    await service.activate(
      settings({ customDomains: ['example.com'] }),
      '',
      adapters(),
    );
    assert.equal(service.getState().status, 'active');
    assert.equal(journal, null);
    assert.ok(!calls.includes('write-recovery-journal'));
    assert.deepEqual(
      calls.find((entry) => Array.isArray(entry) && entry[0] === 'start-routing'),
      ['start-routing', ['example.com', 'ipinfo.io'], 4, 17],
    );
    await service.restore();
    assert.equal(service.getState().status, 'inactive');
    assert.ok(calls.includes('stop-browser'));
    assert.ok(calls.includes('stop-routing'));
  });
});

test('ChatGPT web activation uses the whole browser session and restores the original mode on exit', async () => {
  await withTemporaryDirectory(async directory => {
    const calls = [], modes = [];
    const operations = safeOperations(calls);
    const verify = operations.verifyBrowserRouting;
    operations.verifyBrowserRouting = async (...args) => {
      assert.equal(args[4], 'chatgpt-web');
      return { ...await verify(...args), mode: args[4], chatgptConnectionConfirmed: true };
    };
    const browser = fakeBrowser(calls, { start: async value => modes.push(['browser', value.mode, value.initialUrl]) });
    const routing = fakeRouting(calls, { start: async value => modes.push(['routing', value.mode, [...value.domains]]) });
    const service = new SplitRoutingService({
      browserManager: browser, routing, operations, dataDirectory: directory,
      getRecoveryJournal: () => null, replaceRecoveryJournal: async () => { throw new Error('No global recovery mutation is allowed.'); },
      sessionId: 'chatgpt-web-session', stateChanged() {},
    });
    await saveSplitRoutingSettings(directory, settings({ customDomains: ['example.com'] }));
    const before = await readFile(path.join(directory, 'split-routing-settings.json'));
    await service.initialize();
    const original = service.getState().settings;
    try {
      await service.activate(settings({ mode: 'chatgpt-web', ipinfoEnabled: false }), '', adapters());
      assert.deepEqual(modes, [['routing', 'chatgpt-web', []], ['browser', 'chatgpt-web', 'https://chatgpt.com/']]);
      assert.equal(service.getState().status, 'active');
      await assert.rejects(service.activate(settings(), '', adapters()), /already active/);
      assert.equal(modes.length, 2, 'The second mode must not create another browser or gateway.');
      assert.equal((await service.verifyPaths()).chatgptConnectionConfirmed, true);
    } finally { await service.restore(); }
    assert.equal(service.getState().status, 'inactive');
    assert.equal(browser.isRunning, false);
    assert.equal(routing.isRunning, false);
    assert.deepEqual(service.getState().settings, original);
    assert.deepEqual(await readFile(path.join(directory, 'split-routing-settings.json')), before);
  });
});

for (const format of [3, 4]) {
  test(`v${format} recovery checks the persisted legacy settings before adding a routing mode`, async () => {
    await withTemporaryDirectory(async directory => {
      const configPath = path.join(process.env.APPDATA, 'com.follow', 'clash', 'config.yaml');
      const journal = setSplitRoutingRecovery(null, {
        canonicalConfigHash: 'a'.repeat(64), canonicalConfigPath: configPath, createdAt: NOW,
        networkIsolationApplied: true, pacUrl: null, phase: 'prepared', selectorChoices: {},
        settings: settings(), snapshot: legacySnapshot(), temporaryConfigApplied: false,
        updatedAt: NOW, watchedFiles: [configPath],
      }, 'legacy-checksum', NOW);
      delete journal.splitRouting.settings.mode;
      const payload = { journal, sequence: 1, version: format === 4 ? 4 : 1 };
      const envelope = { ...payload, checksum: createHash('sha256').update(JSON.stringify(payload)).digest('hex') };
      const names = format === 4 ? ['recovery.v4.json', 'recovery.v4.backup.json', 'recovery.v4.previous.json'] : ['recovery.v3.json'];
      for (const name of names) await writeFile(path.join(directory, name), JSON.stringify(envelope));
      const restored = await loadRecoveryJournal(directory);
      assert.equal(restored.splitRouting.settings.mode, 'sites');
      assert.equal(restored.splitRouting.networkIsolationApplied, true);
      assert.equal(pendingRecoveryCount(restored), 1);
      envelope.journal.splitRouting.settings.controllerPort = 9091;
      for (const name of names) await writeFile(path.join(directory, name), JSON.stringify(envelope));
      await assert.rejects(loadRecoveryJournal(directory), /damaged|unavailable/);
    });
  });
}

test('every safe activation failure closes each started resource', async () => {
  await withTemporaryDirectory(async (directory) => {
    for (const failingStage of ['pac', 'browser', 'fingerprint']) {
      const calls = [];
      const browser = fakeBrowser(calls, {
        start:
          failingStage === 'browser'
            ? async () => {
                throw new Error('browser failed');
              }
            : undefined,
      });
      const pac = fakeRouting(calls, {
        start:
          failingStage === 'pac'
            ? async () => {
                throw new Error('pac failed');
              }
            : undefined,
      });
      const hashes = failingStage === 'fingerprint' ? ['a', 'b'] : ['a', 'a'];
      const service = new SplitRoutingService({
        browserManager: browser,
        dataDirectory: path.join(directory, failingStage),
        getRecoveryJournal: () => null,
        operations: safeOperations(calls, hashes),
        routing: pac,
        replaceRecoveryJournal: async () => {
          throw new Error('safe activation must not write recovery data');
        },
        sessionId: `failure-${failingStage}`,
        stateChanged() {},
      });
      await service.initialize();
      await assert.rejects(
        service.activate(settings(), '', adapters()),
        failingStage === 'fingerprint'
          ? /global network fingerprint changed/
          : new RegExp(`${failingStage} failed`),
      );
      assert.equal(service.getState().status, 'inactive');
      if (failingStage !== 'pac') assert.ok(calls.includes('stop-routing'));
      if (failingStage === 'fingerprint') {
        assert.ok(calls.includes('stop-browser'));
      }
    }
  });
});

test('traffic verification includes the unchanged global fingerprint', async () => {
  await withTemporaryDirectory(async (directory) => {
    const calls = [];
    const service = new SplitRoutingService({
      browserManager: fakeBrowser(calls),
      dataDirectory: directory,
      getRecoveryJournal: () => null,
      operations: safeOperations(calls),
      pacServer: fakePac(calls),
      routing: fakeRouting(calls),
      replaceRecoveryJournal: async () => {},
      sessionId: 'verification-session',
      stateChanged() {},
    });
    await service.initialize();
    await assert.rejects(
      service.verifyPaths(),
      /Start the isolated browser before verifying/,
    );
    await service.activate(settings(), '', adapters());
    const result = await service.verifyPaths();
    assert.equal(result.passed, true);
    assert.equal(result.systemRoutingUnchanged, true);
    assert.equal(result.egressObservation, 'proxy');
    await service.restore();
  });
});

test('orphan cleanup failure blocks activation until a successful retry', async () => {
  await withTemporaryDirectory(async directory => {
    let blocked = true;
    const calls = [];
    const service = new SplitRoutingService({
      browserManager: fakeBrowser(calls, { recover: async () => { if (blocked) throw new Error('orphan still owns its profile'); } }),
      dataDirectory: directory, getRecoveryJournal: () => null, operations: safeOperations(calls),
      routing: fakeRouting(calls), pacServer: fakePac(calls), replaceRecoveryJournal: async () => {}, sessionId: 'orphan-regression', stateChanged() {},
    });
    await service.initialize();
    assert.equal(service.getState().pendingRecovery, true);
    await assert.rejects(service.activate(settings(), '', adapters()), /cleanup/);
    assert.equal(calls.some(value => Array.isArray(value) && value[0] === 'start-browser'), false);
    blocked = false; await service.restore();
    await service.activate(settings(), '', adapters());
    assert.equal(service.getState().status, 'active');
    await service.restore();
  });
});

test('unproven browser egress stops the session instead of leaving traffic active', async () => {
  await withTemporaryDirectory(async directory => {
    const calls = [];
    const operations = safeOperations(calls);
    const verify = operations.verifyBrowserRouting;
    operations.verifyBrowserRouting = async (...args) => ({ ...await verify(...args), passed: false, egressObservation: 'unknown' });
    const browser = fakeBrowser(calls), routing = fakeRouting(calls);
    const service = new SplitRoutingService({ browserManager: browser, dataDirectory: directory, getRecoveryJournal: () => null, operations, routing, pacServer: fakePac(calls), replaceRecoveryJournal: async () => {}, sessionId: 'verification-failure', stateChanged() {} });
    await service.initialize(); await service.activate(settings(), '', adapters());
    assert.equal((await service.verifyPaths()).passed, false);
    assert.equal(browser.isRunning, false);
    assert.equal(routing.isRunning, false);
    assert.equal(service.getState().status, 'error');
  });
});

test('browser cleanup failure still stops routing and keeps recovery pending for retry', async () => {
  await withTemporaryDirectory(async directory => {
    let blocked = true; const calls = [];
    const service = new SplitRoutingService({
      browserManager: fakeBrowser(calls, { stop: async () => { if (blocked) throw new Error('browser stop failed'); } }),
      dataDirectory: directory, getRecoveryJournal: () => null, operations: safeOperations(calls), routing: fakeRouting(calls), pacServer: fakePac(calls),
      replaceRecoveryJournal: async () => {}, sessionId: 'stop-regression', stateChanged() {},
    });
    await service.initialize(); await service.activate(settings(), '', adapters());
    await assert.rejects(service.restore(), /browser stop failed/);
    assert.ok(calls.includes('stop-routing'));
    assert.equal(service.getState().pendingRecovery, true);
    await assert.rejects(service.activate(settings(), '', adapters()), /browser stop failed|cleanup/);
    blocked = false; await service.restore();
    assert.equal(service.getState().pendingRecovery, false);
  });
});

test('legacy global recovery is retained on failure and retryable', async () => {
  await withTemporaryDirectory(async (directory) => {
    const configPath = path.join(directory, 'config.yaml');
    let journal = {
      adapters: [],
      createdAt: NOW,
      sessionId: 'legacy-restore',
      splitRouting: {
        canonicalConfigHash: 'a'.repeat(64),
        canonicalConfigPath: configPath,
        createdAt: NOW,
        networkIsolationApplied: true,
        pacUrl: `http://127.0.0.1:32123/${'b'.repeat(48)}.pac`,
        phase: 'active',
        selectorChoices: {},
        settings: settings(),
        snapshot: legacySnapshot(),
        temporaryConfigApplied: false,
        updatedAt: NOW,
        watchedFiles: [configPath],
      },
      updatedAt: NOW,
      version: 3,
    };
    let shouldFail = true;
    const calls = [];
    const service = new SplitRoutingService({
      browserManager: fakeBrowser(calls),
      dataDirectory: directory,
      getRecoveryJournal: () => journal,
      operations: {
        restoreWinInetPac: async () => {
          calls.push('restore-wininet-pac');
          if (shouldFail) throw new Error('restore failed');
        },
        restoreWinInetSnapshot: async () => calls.push('restore-wininet-final'),
        restoreWindowsNetworkIsolation: async () => calls.push('restore-network'),
        verifyWindowsNetworkRestored: async () => calls.push('verify-network'),
      },
      pacServer: fakePac(calls),
      routing: fakeRouting(calls),
      replaceRecoveryJournal: async (next) => {
        journal = next;
      },
      sessionId: 'legacy-restore',
      stateChanged() {},
    });
    await service.initialize();
    await assert.rejects(service.restore(), /restore failed/);
    assert.notEqual(journal, null);
    assert.equal(service.getState().status, 'error');
    assert.ok(calls.includes('restore-wininet-final'));
    assert.ok(calls.includes('restore-network'));

    shouldFail = false;
    await service.restore();
    assert.equal(journal, null);
    assert.equal(service.getState().status, 'inactive');
  });
});

test('isolated browser erases only its safe temporary profile on stop', async () => {
  await withTemporaryDirectory(async (directory) => {
    const child = new EventEmitter();
    child.pid = 4321;
    child.exitCode = null;
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      return true;
    };
    let launchedArguments = [];
    let closedPid = null;
    const manager = new IsolatedBrowserManager(directory, {
      closeProcessTree: async (pid) => {
        closedPid = pid;
      },
      findBrowser: async () =>
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      launchBrowser: (_browserPath, arguments_) => {
        launchedArguments = [...arguments_];
        return child;
      },
      processOwnsProfile: async () => true,
      findProfileProcesses: async () => [],
      stopSupervisor: async () => { child.exitCode = 0; },
    });
    const pacUrl = 'http://127.0.0.1:32123';
    const session = await manager.start(pacUrl, 'https://ipinfo.io/');
    assert.equal(safeProfilePath(session.profilePath), true);
    assert.ok(launchedArguments.includes(`--proxy-server=${pacUrl}`));
    assert.ok(launchedArguments.includes('--disable-quic'));
    assert.ok(launchedArguments.includes('--remote-debugging-pipe'));
    assert.ok(!launchedArguments.some(value => value.startsWith('--remote-debugging-port')));
    assert.ok(launchedArguments.includes('--disable-http2'));
    assert.ok(!launchedArguments.some(value => value.startsWith('--proxy-pac-url')));
    assert.ok(
      launchedArguments.includes(`--user-data-dir=${session.profilePath}`),
    );
    await manager.stop();
    assert.equal(closedPid, 4321);
    await assert.rejects(access(session.profilePath), { code: 'ENOENT' });
    await assert.rejects(
      access(path.join(directory, 'isolated-browser-session.json')),
      { code: 'ENOENT' },
    );
    assert.equal(safeProfilePath(directory), false);
  });
});
