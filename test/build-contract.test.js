const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');

async function projectFile(...segments) {
  return readFile(path.join(projectRoot, ...segments), 'utf8');
}

test('renderer build is a browser script without CommonJS globals', async () => {
  const renderer = await projectFile('dist', 'renderer', 'renderer.js');

  assert.doesNotMatch(renderer, /\brequire\s*\(/u);
  assert.doesNotMatch(renderer, /\bexports\b/u);
  assert.doesNotMatch(renderer, /\bmodule\.exports\b/u);
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
});

test('custom protocol exposes only the expected renderer assets', async () => {
  const main = await projectFile('dist', 'main', 'main.js');

  for (const resource of [
    '/static/index.html',
    '/static/styles.css',
    '/static/assets/icon.ico',
    '/dist/renderer/renderer.js',
  ]) {
    assert.match(
      main,
      new RegExp(resource.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
    );
  }
  assert.match(main, /new Response\(["']Not found["'], \{ status: 404 \}\)/u);
});
