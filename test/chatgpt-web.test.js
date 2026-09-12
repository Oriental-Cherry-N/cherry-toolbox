const assert = require('node:assert/strict');
const test = require('node:test');
const { spawn } = require('node:child_process');
const { createConnection } = require('node:net');
const { createInterface } = require('node:readline');
const { randomBytes } = require('node:crypto');
const { nativeHelperPath } = require('../dist/main/native-helper');
const { parseSplitRoutingSettings, DEFAULT_SPLIT_ROUTING_SETTINGS } = require('../dist/main/split-routing-settings');
const { evaluateBrowserEgress, confirmChatGptDocument } = require('../dist/main/browser-routing-verification');

test('ChatGPT web is an explicit mode and old desktop flags cannot enable it', () => {
  assert.equal(parseSplitRoutingSettings({ ...DEFAULT_SPLIT_ROUTING_SETTINGS, chatgptEnabled: true }).mode, 'sites');
  assert.equal(parseSplitRoutingSettings({ ...DEFAULT_SPLIT_ROUTING_SETTINGS, mode: 'chatgpt-web', ipinfoEnabled: false }).mode, 'chatgpt-web');
  assert.throws(() => parseSplitRoutingSettings({ ...DEFAULT_SPLIT_ROUTING_SETTINGS, mode: 'desktop' }));
  assert.throws(() => parseSplitRoutingSettings({ ...DEFAULT_SPLIT_ROUTING_SETTINGS, customDomains: ['chatgpt.com'] }));
});

test('web verification needs the ChatGPT document, its proxy connection and matching core sockets', () => {
  const network = { addresses: ['192.0.2.2'], sockets: ['192.0.2.2'] };
  const observations = ['chatgpt.com', 'ipinfo.io'].map(host => ({ host, lane: 'proxy', at: new Date().toISOString() }));
  const check = (addresses = network, events = observations, document = true) => evaluateBrowserEgress(addresses, events, 'chatgpt-web', 0, document).confirmed;
  assert.equal(check(), true);
  assert.equal(check({ ...network, sockets: [] }), false);
  assert.equal(check({ ...network, sockets: ['192.0.2.3'] }), false);
  assert.equal(check(network, observations.slice(1)), false);
  assert.equal(check(network, observations, false), false);
  assert.equal(check(network, [...observations, { host: 'unexpected.example', lane: 'primary' }]), false);
});

test('ChatGPT document verification reads only origin/readiness/security and detaches', async () => {
  const calls = [];
  const browser = { async command(method, params) {
    calls.push([method, params]);
    if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'fixture', type: 'page', url: 'https://chatgpt.com/c/private' }] };
    if (method === 'Target.attachToTarget') return { sessionId: 'private' };
    if (method === 'Runtime.evaluate') return { result: { value: { origin: 'https://chatgpt.com', ready: 'complete', secure: true } } };
    return {};
  } };
  assert.equal(await confirmChatGptDocument(browser), true);
  assert.doesNotMatch(calls.find(([method]) => method === 'Runtime.evaluate')[1].expression, /cookie|innerText|textContent|localStorage|input/);
  assert.equal(calls.at(-1)[0], 'Target.detachFromTarget');
});

const idleMs = Math.max(17000, Math.min(900000, Number(process.env.CHERRY_TUNNEL_IDLE_MS) || 17000));
test('native established tunnel survives idle and transfers data in both directions', { timeout: idleMs + 15000 }, async () => {
  const child = spawn(await nativeHelperPath(), ['self-test'], { windowsHide: true, stdio: 'pipe' });
  let socket;
  const childExit = new Promise(resolve => child.once('exit', resolve));
  try {
    const ready = new Promise((resolve, reject) => {
      const lines = createInterface({ input: child.stdout });
      child.once('error', reject);
      lines.on('line', line => { const value = JSON.parse(line); if (value.type === 'tunnel-ready') resolve(value); else reject(new Error('Tunnel fixture did not initialize.')); });
    });
    child.stdin.write('{"tunnelFixture":true}\n');
    const { port } = await ready;
    socket = createConnection({ host: '127.0.0.1', port });
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    let failure;
    socket.on('error', error => { failure = error; });
    const roundtrip = bytes => new Promise((resolve, reject) => {
      if (failure || socket.destroyed) { reject(failure ?? new Error('Tunnel closed while idle')); return; }
      let received = Buffer.alloc(0);
      const receive = chunk => { received = Buffer.concat([received, chunk]); if (received.length >= bytes.length) { socket.off('data', receive); try { assert.deepEqual(received, bytes); resolve(); } catch (error) { reject(error); } } };
      socket.on('data', receive); socket.write(bytes);
    });
    await roundtrip(Buffer.from('before idle'));
    await new Promise(resolve => setTimeout(resolve, idleMs));
    await roundtrip(randomBytes(256 * 1024));
    socket.end();
    assert.equal(await childExit, 0);
  } finally {
    socket?.destroy();
    if (child.exitCode === null) child.kill();
    await childExit;
  }
});
