const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { promisify } = require('node:util');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { createInterface } = require('node:readline');
const { mkdtemp, readFile, writeFile, rm, access } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { nativeHelperPath } = require('../dist/main/native-helper');

const protocol = 'cherry-adapter-v2';
const records = [{ adapterId: 'guid:00000000-0000-0000-0000-000000000001', originalEnabled: true, requestedEnabled: false }];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('helper integrity failure before launch creates no marker and does not trap cleanup', async t => {
  let broken = false;
  const h = await harness(t, { helper: async () => { if (broken) throw new Error('integrity fixture'); return 'fixture'; } });
  await h.broker.recoverOrphanedSession();
  broken = true;
  await assert.rejects(h.broker.prepare(), /integrity/);
  await assert.rejects(h.broker.apply(records), /integrity/);
  assert.equal(h.broker.hasDispatchedChanges, false);
  assert.equal(h.launches, 0);
  await assert.rejects(access(h.marker), { code: 'ENOENT' });
  assert.equal(await h.broker.restore(), false);
  assert.equal(h.broker.progress.phase, 'idle');
});

test('a failed initial recovery check remains unresolved even when no local marker exists', async t => {
  const h = await harness(t, { helper: async () => { throw new Error('missing helper fixture'); } });
  await assert.rejects(h.broker.recoverOrphanedSession(), /missing helper/);
  await assert.rejects(h.broker.restore(), /missing helper/);
  assert.equal(h.broker.progress.phase, 'error');
});

test('integrity failure after dispatch retains recovery evidence and refuses cleanup', async t => {
  let broken = false;
  const h = await harness(t, { helper: async () => { if (broken) throw new Error('integrity fixture'); return 'fixture'; } });
  await h.broker.apply(records);
  broken = true;
  h.broker.disconnect(new Error('lost pipe'));
  await assert.rejects(h.broker.restore(), /integrity/);
  assert.equal(h.broker.hasDispatchedChanges, true);
  await access(h.marker);
});

async function harness(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cherry-broker-test-'));
  const marker = path.join(directory, 'structured-adapter-session.json');
  const h = { directory, marker, launches: 0, messages: [], phases: [], sockets: [], servers: [], children: [], status: { pending: false, active: false } };
  const filename = path.resolve(__dirname, '../dist/main/structured-adapter-broker.js');
  const localRequire = createRequire(filename);
  const execFile = function () {};
  execFile[promisify.custom] = async (_file, args, execution) => {
    if (args[0] === '--adapter-recovery-status') return { stdout: JSON.stringify(h.status), stderr: '' };
    assert.equal(args[0], 'elevate'); h.launches++;
    if (options.launch) return options.launch(h, args, execution);
    const server = createServer(socket => {
      h.sockets.push(socket); socket.on('error', () => {});
      const lines = createInterface({ input: socket });
      lines.on('line', line => {
        const message = JSON.parse(line); h.messages.push(message);
        if (options.message) { options.message(h, socket, message); return; }
        if (message.type === 'hello') socket.write(JSON.stringify({ type: 'ready', protocol }) + '\n');
        else if (message.type === 'apply') {
          h.status = { pending: true, active: true };
          socket.write(JSON.stringify({ type: 'result', id: message.id }) + '\n');
        } else if (message.type === 'restore') {
          h.status = { pending: false, active: false };
          socket.end(JSON.stringify({ type: 'result', id: message.id }) + '\n');
        }
      });
    });
    h.servers.push(server);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen('\\\\.\\pipe\\' + args[1], resolve); });
    return { stdout: '', stderr: '' };
  };
  const context = vm.createContext({
    exports: {}, process, console, Error, AbortController,
    setTimeout, clearTimeout, setInterval, clearInterval,
    require(name) {
      if (name === 'node:child_process') return { execFile };
      if (name === './native-helper') return { nativeHelperPath: options.helper ?? (async () => 'fixture-only-no-elevation') };
      if (name === './adapter-recovery-broker') return { AdapterRecoveryBroker: class { async recoverOrphanedSession() {} } };
      return localRequire(name);
    },
  });
  vm.runInContext(await readFile(filename, 'utf8'), context, { filename });
  h.broker = new context.exports.AdapterRecoveryBroker(directory, () => h.phases.push(h.broker.progress.phase));
  Object.assign(h.broker.timeouts, { connect: 1000, handshake: 1000, apply: 1000, restore: 1000, settle: 40, poll: 5 });
  t.after(async () => {
    h.broker.cancelPendingStart(); h.broker.disconnect();
    for (const socket of h.sockets) socket.destroy();
    for (const server of h.servers) await new Promise(resolve => server.close(resolve));
    for (const child of h.children) {
      if (child.exitCode === null) child.kill();
      await child.done;
    }
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^cherry-broker-test-/);
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  });
  return h;
}

async function nativeLaunch(h, args, parentOffset = 0, rejectAccount = false) {
  const child = spawn(await nativeHelperPath(), ['self-test'], { windowsHide: true });
  h.children.push(child);
  child.done = new Promise(resolve => child.once('exit', code => resolve(code)));
  const listening = new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    child.once('error', reject);
    child.once('exit', code => reject(new Error('Native handshake fixture exited: ' + code)));
    lines.on('line', line => {
      const message = JSON.parse(line);
      if (message.type === 'adapter-test-listening') resolve();
      else if (message.type === 'error') reject(new Error(message.message));
    });
  });
  child.stdin.end(JSON.stringify({ adapterHandshakeFixture: true, pipeName: args[1], parentPid: Number(args[2]) + parentOffset, rejectAccount }) + '\n');
  await listening;
  return { stdout: '', stderr: '' };
}

test('real Windows pipe authenticates the Node client, resets heartbeat, and closes without NIC changes', { timeout: 15000 }, async t => {
  const h = await harness(t, { launch: (h, args) => nativeLaunch(h, args) });
  await h.broker.open();
  assert.equal(h.broker.isActive, true);
  assert.ok(h.phases.includes('handshaking'));
  assert.equal(await h.broker.restore(), true);
  assert.equal(h.broker.isActive, false);
  assert.equal(await h.children[0].done, 0);
  await assert.rejects(access(h.marker), { code: 'ENOENT' });
});

test('real Windows authentication still rejects a different client PID', { timeout: 15000 }, async t => {
  const h = await harness(t, { launch: (h, args) => nativeLaunch(h, args, 1) });
  await assert.rejects(h.broker.open(), /different client process/);
  assert.equal(h.broker.isActive, false);
  assert.equal(await h.children[0].done, 1);
  await h.broker.restore();
});

test('EOF during authentication fails immediately and leaves no reusable connection', async t => {
  const h = await harness(t, { message: (_h, socket) => socket.end() });
  const start = Date.now();
  await assert.rejects(h.broker.apply(records), /disconnected during authentication/);
  assert.ok(Date.now() - start < 900);
  assert.equal(h.broker.isActive, false);
  assert.equal(h.broker.socket, null);
  assert.deepEqual(h.messages.map(message => message.type), ['hello']);
  await access(h.marker);
  assert.equal(await h.broker.restore(), false);
  assert.equal(h.launches, 1, 'Empty recovery must not relaunch the failed helper');
  await assert.rejects(access(h.marker), { code: 'ENOENT' });
});

test('real Windows authentication still rejects a different Windows account', { timeout: 15000 }, async t => {
  const h = await harness(t, { launch: (h, args) => nativeLaunch(h, args, 0, true) });
  await assert.rejects(h.broker.open(), /different account/);
  assert.equal(h.broker.isActive, false);
  assert.equal(await h.children[0].done, 1);
  await h.broker.restore();
});

test('an incompatible helper cannot receive adapter commands', async t => {
  const h = await harness(t, { message: (_h, socket) => socket.write('{"type":"ready"}\n') });
  await assert.rejects(h.broker.apply(records), /incompatible handshake/);
  assert.deepEqual(h.messages.map(message => message.type), ['hello']);
  await h.broker.restore();
});

test('privileged recovery records trigger restore even when the user marker is absent', async t => {
  const h = await harness(t);
  h.status = { pending: true, active: false };
  await h.broker.recoverOrphanedSession();
  assert.equal(h.launches, 1);
  assert.deepEqual(h.messages.map(message => message.type), ['hello', 'restore']);
  await assert.rejects(access(h.marker), { code: 'ENOENT' });
});

test('denied administrator permission does not cause repeated elevation during cleanup', async t => {
  const h = await harness(t, { launch: async () => { throw new Error('Administrator permission was cancelled'); } });
  await assert.rejects(h.broker.apply(records), /permission was cancelled/);
  await h.broker.restore();
  assert.equal(h.launches, 1);
  await assert.rejects(access(h.marker), { code: 'ENOENT' });
});

test('a silent handshake times out, destroys its pipe, and is recoverable without elevation', async t => {
  const h = await harness(t, { message() {} });
  h.broker.timeouts.handshake = 40;
  await assert.rejects(h.broker.apply(records), /authentication in time/);
  assert.equal(h.broker.isActive, false);
  assert.equal(h.broker.socket, null);
  assert.equal(h.broker.heartbeat, null);
  await h.broker.restore();
  assert.equal(h.launches, 1);
  assert.equal(h.broker.progress.phase, 'idle');
});

test('startup removes a stale marker only after checking the independent recovery status', async t => {
  const h = await harness(t);
  await writeFile(h.marker, JSON.stringify({ version: 1, pending: true }));
  await h.broker.recoverOrphanedSession();
  assert.equal(h.launches, 0);
  await assert.rejects(access(h.marker), { code: 'ENOENT' });
});

test('an active independent broker prevents clearing even an empty recovery record', async t => {
  const h = await harness(t);
  await writeFile(h.marker, JSON.stringify({ version: 1, pending: true }));
  h.status = { pending: false, active: true };
  await assert.rejects(h.broker.restore(), /still running/);
  await access(h.marker);
  assert.equal(h.launches, 0, 'Do not compete with the active recovery helper');
  h.status = { pending: false, active: false };
  assert.equal(await h.broker.restore(), false);
  await assert.rejects(access(h.marker), { code: 'ENOENT' });
});

test('unreadable or incompatible privileged status preserves recovery evidence', async t => {
  const h = await harness(t);
  await writeFile(h.marker, JSON.stringify({ version: 1, pending: true }));
  h.status = { pending: false };
  await assert.rejects(h.broker.restore(), /status is invalid/);
  await access(h.marker);
});

test('an authenticated apply remains tracked until restore is acknowledged and the broker is idle', async t => {
  const h = await harness(t);
  await h.broker.apply(records);
  assert.equal(h.broker.isActive, true);
  await access(h.marker);
  assert.deepEqual(h.messages.map(message => message.type), ['hello', 'apply']);
  assert.equal(await h.broker.restore(), true);
  assert.equal(h.broker.isActive, false);
  await assert.rejects(access(h.marker), { code: 'ENOENT' });
});

test('a lost apply acknowledgement retains recovery until the independent broker finishes', async t => {
  const h = await harness(t, { message(h, socket, message) {
    if (message.type === 'hello') socket.write(JSON.stringify({ type: 'ready', protocol }) + '\n');
    else if (message.type === 'apply') { h.status = { pending: true, active: true }; socket.end(); }
  } });
  await assert.rejects(h.broker.apply(records), /independent recovery must be verified/);
  await assert.rejects(h.broker.restore(), /still running/);
  await access(h.marker);
  h.status = { pending: false, active: false };
  assert.equal(await h.broker.restore(), true);
  await assert.rejects(access(h.marker), { code: 'ENOENT' });
});

test('an apply timeout closes the session and never forgets an uncertain mutation', async t => {
  const h = await harness(t, { message(h, socket, message) {
    if (message.type === 'hello') socket.write(JSON.stringify({ type: 'ready', protocol }) + '\n');
    else if (message.type === 'apply') h.status = { pending: true, active: true };
  } });
  h.broker.timeouts.apply = 40;
  await assert.rejects(h.broker.apply(records), /has not been verified/);
  assert.equal(h.broker.isActive, false);
  await assert.rejects(h.broker.confirmRestored(), /still active/);
  await access(h.marker);
  h.status = { pending: false, active: false };
  await h.broker.confirmRestored();
});

test('a lost restore acknowledgement allows cleanup when independent recovery is proven complete', async t => {
  const h = await harness(t, { message(h, socket, message) {
    if (message.type === 'hello') socket.write(JSON.stringify({ type: 'ready', protocol }) + '\n');
    else if (message.type === 'apply') {
      h.status = { pending: true, active: true };
      socket.write(JSON.stringify({ type: 'result', id: message.id }) + '\n');
    } else if (message.type === 'restore') { h.status = { pending: false, active: false }; socket.end(); }
  } });
  await h.broker.apply(records);
  assert.equal(await h.broker.restore(), true);
  await assert.rejects(access(h.marker), { code: 'ENOENT' });
});

test('cancelling administrator startup settles admitted work without dispatching an apply', async t => {
  const h = await harness(t, { launch: async (_h, _args, execution) => {
    await new Promise((_resolve, reject) => execution.signal.addEventListener('abort', () => reject(new Error('cancelled launch')), { once: true }));
  } });
  const applying = assert.rejects(h.broker.apply(records), /cancelled before a command/);
  while (h.launches === 0) await delay(5);
  h.broker.cancelPendingStart();
  await applying;
  assert.equal(await h.broker.restore(), false);
  assert.equal(h.launches, 1);
  assert.deepEqual(h.messages, []);
});

test('cleanup cancels an in-progress handshake instead of waiting for its timeout', async t => {
  const h = await harness(t, { message() {} });
  const applying = assert.rejects(h.broker.apply(records), /cancelled before a command/);
  while (!h.messages.length) await delay(5);
  const start = Date.now();
  assert.equal(await h.broker.restore(), false);
  await applying;
  assert.ok(Date.now() - start < 900);
  assert.deepEqual(h.messages.map(message => message.type), ['hello']);
});
