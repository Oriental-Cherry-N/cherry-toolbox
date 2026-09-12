const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const os = require('node:os');
const { createServer: createHttpServer } = require('node:http');
const { createServer: createTcpServer } = require('node:net');
const { mkdtemp, rm, access, readFile, writeFile } = require('node:fs/promises');
const { IsolatedBrowserManager, launchManagedBrowser } = require('../dist/main/isolated-browser');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function listen(server) { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); return server.address().port; }
async function close(server) { if (server.listening) await new Promise(resolve => server.close(resolve)); }

async function eventually(check, description) {
  const deadline = Date.now() + 10000;
  do {
    if (await check()) return;
    await delay(100);
  } while (Date.now() < deadline);
  assert.fail(description);
}

test('real headless browser uses the fixed proxy and cannot bypass it for loopback', { timeout: 45000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cherry-browser-test-'));
  let directConnections = 0;
  const canary = createTcpServer(socket => { directConnections++; socket.destroy(); });
  const proxy = createHttpServer((_request, response) => { response.writeHead(502); response.end(); });
  const requests = [];
  proxy.on('connect', (request, socket) => {
    // Chromium may reset the socket after this deliberately failed CONNECT.
    socket.on('error', () => {});
    requests.push(request.url);
    socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  const canaryPort = await listen(canary), proxyPort = await listen(proxy);
  let supervisor;
  const manager = new IsolatedBrowserManager(directory, {
    launchBrowser: async (browserPath, arguments_) => {
      const running = await launchManagedBrowser(browserPath, ['--headless=new', ...arguments_]);
      supervisor = running.child;
      return running;
    },
  });
  let browser;
  try {
    const session = await manager.start(`http://127.0.0.1:${proxyPort}`, `https://127.0.0.1:${canaryPort}/first`);
    for (let i = 0; i < 100 && !requests.includes(`127.0.0.1:${canaryPort}`); i++) await delay(100);
    assert.ok(requests.includes(`127.0.0.1:${canaryPort}`), 'Chromium must use the proxy even for loopback');
    assert.equal(directConnections, 0);
    await assert.rejects(access(path.join(session.profilePath, 'DevToolsActivePort')), { code: 'ENOENT' });
    browser = session.control;
    assert.equal(typeof (await browser.command('Browser.getVersion')).product, 'string');
    await close(proxy);
    const { targetId } = await browser.command('Target.createTarget', { url: `https://127.0.0.1:${canaryPort}/after-proxy-failure` });
    const attached = await browser.command('Target.attachToTarget', { targetId, flatten: true });
    await delay(1000);
    const result = await browser.command('Runtime.evaluate', { expression: 'location.protocol', returnByValue: true }, String(attached.sessionId));
    assert.notEqual(result.result.value, 'https:', 'Failed fixed proxy must produce a browser error page');
    assert.equal(directConnections, 0, 'A failed fixed proxy must never fall back to the local origin');
    await browser.command('Target.closeTarget', { targetId });
  } finally {
    browser?.close();
    try { await manager.stop(); } finally {
      if (supervisor && supervisor.exitCode === null) supervisor.kill();
      await Promise.all([close(proxy), close(canary)]);
      await rm(directory, { recursive: true, force: true, maxRetries: 3 });
    }
  }
});

test('ChatGPT browser mode confines real downloads and login storage to its disposable profile', { timeout: 45000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cherry-browser-files-test-'));
  const downloadContent = 'disposable download fixture';
  const uploadContent = 'explicitly selected upload fixture';
  const sourcePath = path.join(directory, 'upload.txt');
  await writeFile(sourcePath, uploadContent);
  let uploaded = '';
  // Serve only in-memory fixtures through a local proxy. No account, external
  // service, real user file or TLS certificate override is involved.
  const proxy = createHttpServer((request, response) => {
    const url = new URL(request.url);
    if (url.hostname !== 'files.cherry.test') { response.writeHead(502); response.end(); return; }
    if (url.pathname === '/download') {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="fixture.txt"' });
      response.end(downloadContent);
    } else if (url.pathname === '/upload' && request.method === 'POST') {
      request.setEncoding('utf8');
      request.on('data', chunk => { uploaded += chunk; });
      request.on('end', () => { response.writeHead(200, { 'Content-Type': 'text/plain' }); response.end('uploaded'); });
    } else {
      response.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'fixture_session=temporary; Path=/' });
      response.end('<!doctype html><a id="download" href="/download">Download</a><form action="/upload" method="post" enctype="multipart/form-data"><input id="file" type="file" name="file"><button>Upload</button></form>');
    }
  });
  proxy.on('connect', (_request, socket) => {
    socket.on('error', () => {});
    socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  const port = await listen(proxy);
  let supervisor;
  const manager = new IsolatedBrowserManager(directory, {
    launchBrowser: async (browserPath, arguments_) => {
      assert.ok(!arguments_.includes('--disable-http2'), 'The single-lane ChatGPT browser must keep HTTP/2 enabled.');
      const running = await launchManagedBrowser(browserPath, ['--headless=new', ...arguments_]);
      supervisor = running.child;
      return running;
    },
  });
  try {
    const session = await manager.start(`http://127.0.0.1:${port}`, 'https://files.cherry.test/', 'chatgpt-web');
    const browser = session.control;
    assert.ok(browser, 'Web mode must expose only its owned private pipe to the main process.');
    const { targetId } = await browser.command('Target.createTarget', { url: 'http://files.cherry.test/' });
    const { sessionId } = await browser.command('Target.attachToTarget', { targetId, flatten: true });
    const evaluate = expression => browser.command('Runtime.evaluate', { expression, returnByValue: true, userGesture: true }, sessionId);
    await eventually(async () => Boolean((await evaluate('Boolean(document.querySelector("#download"))')).result.value), 'Fixture page must load through the proxy.');
    assert.match((await evaluate('document.cookie')).result.value, /fixture_session=temporary/);
    await evaluate('localStorage.setItem("fixture", "temporary"); document.querySelector("#download").click()');
    const downloadPath = path.join(session.profilePath, 'Downloads', 'fixture.txt');
    await eventually(async () => {
      try { return await readFile(downloadPath, 'utf8') === downloadContent; }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    }, 'The real browser download must finish inside its disposable profile.');
    const { root } = await browser.command('DOM.getDocument', {}, sessionId);
    const { nodeId } = await browser.command('DOM.querySelector', { nodeId: root.nodeId, selector: '#file' }, sessionId);
    await browser.command('DOM.setFileInputFiles', { nodeId, files: [sourcePath] }, sessionId);
    await evaluate('document.querySelector("form").requestSubmit()');
    await eventually(async () => uploaded.includes(uploadContent), 'An explicitly selected fixture must upload through the proxy.');
    await manager.stop();
    await assert.rejects(access(session.profilePath), { code: 'ENOENT' });
    await assert.rejects(access(path.join(directory, 'isolated-browser-session.json')), { code: 'ENOENT' });
    assert.equal(await readFile(sourcePath, 'utf8'), uploadContent, 'Cleanup must preserve the user-selected source file.');
    await assert.rejects(browser.command('Browser.getVersion'), /unavailable/);
  } finally {
    try { await manager.stop(); } finally {
      if (supervisor && supervisor.exitCode === null) supervisor.kill();
      proxy.closeAllConnections();
      await close(proxy);
      await rm(directory, { recursive: true, force: true, maxRetries: 3 });
    }
  }
});
