const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');

async function projectFile(...segments) {
  return readFile(path.join(projectRoot, ...segments), 'utf8');
}

test('renderer modules are browser ESM without CommonJS globals', async () => {
  for (const moduleName of [
    'i18n.js',
    'network-switcher.js',
    'renderer.js',
    'tools.js',
  ]) {
    const renderer = await projectFile('dist', 'renderer', moduleName);

    assert.doesNotMatch(renderer, /\brequire\s*\(/u);
    assert.doesNotMatch(renderer, /\bexports\b/u);
    assert.doesNotMatch(renderer, /\bmodule\.exports\b/u);
  }
});

test('sandboxed preload is self-contained and only requires Electron', async () => {
  const preload = await projectFile('dist', 'common', 'preload.js');
  const requiredModules = [
    ...preload.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu),
  ].map((match) => match[1]);

  assert.deepEqual([...new Set(requiredModules)], ['electron']);

  const { IPC_CHANNELS } = require('../dist/common/channels.js');
  for (const channel of Object.values(IPC_CHANNELS)) {
    assert.match(
      preload,
      new RegExp(channel.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
    );
  }
});

test('HTML security policy permits only packaged resources', async () => {
  const html = await projectFile('static', 'index.html');
  const csp = html.match(
    /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/u,
  )?.[1];

  assert.ok(csp, 'Content-Security-Policy meta tag must exist.');
  assert.match(csp, /default-src 'self'/u);
  assert.match(csp, /connect-src 'none'/u);
  assert.doesNotMatch(csp, /'unsafe-inline'|'unsafe-eval'|https?:/u);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/iu);
  assert.match(
    html,
    /<script\s+type="module"\s+src="\.\.\/dist\/renderer\/renderer\.js"><\/script>/u,
  );
});

test('toolbox shell exposes home and Network Switcher as separate views', async () => {
  const html = await projectFile('static', 'index.html');
  const preload = await projectFile('dist', 'common', 'preload.js');

  for (const id of [
    'nav-home',
    'nav-network-switcher',
    'view-home',
    'view-network-switcher',
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`, 'u'));
  }
  assert.match(preload, /exposeInMainWorld\(["']cherryToolbox["']/u);
  assert.doesNotMatch(preload, /exposeInMainWorld\(["']connectionSwitcher["']/u);
});

test('custom protocol exposes only the expected renderer assets', async () => {
  const main = await projectFile('dist', 'main', 'main.js');

  for (const resource of [
    '/static/index.html',
    '/static/styles.css',
    '/static/assets/cherry-toolbox.ico',
    '/static/assets/cherry-toolbox.png',
    '/dist/renderer/i18n.js',
    '/dist/renderer/network-switcher.js',
    '/dist/renderer/renderer.js',
    '/dist/renderer/tools.js',
  ]) {
    assert.match(
      main,
      new RegExp(resource.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
    );
  }
  assert.match(main, /new Response\(["']Not found["'], \{ status: 404 \}\)/u);
});

test('package metadata and main process use the independent toolbox identity', async () => {
  const packageJson = JSON.parse(await projectFile('package.json'));
  const main = await projectFile('dist', 'main', 'main.js');

  assert.equal(packageJson.name, 'cherry-toolbox');
  assert.equal(packageJson.productName, 'Cherry Toolbox');
  assert.equal(packageJson.version, '0.1.0');
  assert.equal(
    packageJson.repository.url,
    'git+https://github.com/Oriental-Cherry-N/cherry-toolbox.git',
  );
  assert.match(main, /setName\(["']Cherry Toolbox["']\)/u);
  assert.match(main, /io\.github\.orientalcherryn\.cherrytoolbox/u);
});

test('Windows icon contains the expected multi-resolution PNG images', async () => {
  const icon = await readFile(
    path.join(projectRoot, 'static', 'assets', 'cherry-toolbox.ico'),
  );

  assert.equal(icon.readUInt16LE(0), 0);
  assert.equal(icon.readUInt16LE(2), 1);
  const imageCount = icon.readUInt16LE(4);
  assert.equal(imageCount, 9);

  const dimensions = [];
  for (let index = 0; index < imageCount; index += 1) {
    const entryOffset = 6 + index * 16;
    const widthByte = icon.readUInt8(entryOffset);
    const heightByte = icon.readUInt8(entryOffset + 1);
    const width = widthByte === 0 ? 256 : widthByte;
    const height = heightByte === 0 ? 256 : heightByte;
    const imageSize = icon.readUInt32LE(entryOffset + 8);
    const imageOffset = icon.readUInt32LE(entryOffset + 12);

    assert.equal(width, height);
    assert.deepEqual(
      [...icon.subarray(imageOffset, imageOffset + 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
    );
    assert.ok(imageOffset + imageSize <= icon.length);
    dimensions.push(width);
  }

  assert.deepEqual(dimensions, [16, 20, 24, 32, 40, 48, 64, 128, 256]);
});
