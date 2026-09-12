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
    'safety.js',
    'tools.js',
    'wechat-auto-reply.js',
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

test('toolbox shell exposes adapter control and split routing as separate views', async () => {
  const html = await projectFile('static', 'index.html');
  const preload = await projectFile('dist', 'common', 'preload.js');

  for (const id of [
    'nav-home',
    'nav-network-switcher',
    'view-home',
    'view-network-switcher',
    'nav-split-routing',
    'view-split-routing',
    'nav-wechat-auto-reply',
    'view-wechat-auto-reply',
    'split-primary-adapter',
    'split-proxy-adapter',
    'split-ipinfo',
    'split-preflight-button',
    'split-activate-button',
    'split-deactivate-button',
    'split-verify-button',
    'safety-recovery',
    'safety-broker',
    'safety-website',
    'safety-chatgpt',
    'safety-wechat',
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`, 'u'));
  }
  assert.match(preload, /exposeInMainWorld\(["']cherryToolbox["']/u);
  assert.doesNotMatch(preload, /exposeInMainWorld\(["']connectionSwitcher["']/u);
  assert.doesNotMatch(html, /id=["']split-chatgpt["']/u);
});

test('split-routing secret stays session-only and target traffic has no direct fallback', async () => {
  const settings = await projectFile(
    'dist',
    'main',
    'split-routing-settings.js',
  );
  const recovery = await projectFile('dist', 'main', 'recovery.js');
  const pac = await projectFile('dist', 'main', 'pac-server.js');

  assert.doesNotMatch(settings, /controllerSecret/u);
  assert.doesNotMatch(recovery, /controllerSecret/u);
  assert.match(pac, /Matched traffic fails closed/u);
  assert.doesNotMatch(pac, /PROXY 127\.0\.0\.1:\$\{mixedPort\}; DIRECT/u);
});

test('safe website proxy cannot write global networking or FlClash configuration', async () => {
  const service = await projectFile('dist', 'main', 'split-routing.js');
  const settings = await projectFile(
    'dist',
    'main',
    'split-routing-settings.js',
  );

  assert.doesNotMatch(
    service,
    /applyWinInetPac|applyWindowsNetworkIsolation|applyFlClashRuntime|prepareFlClashRuntime/u,
  );
  assert.match(service, /IsolatedBrowserManager/u);
  assert.match(service, /captureSystemNetworkFingerprint/u);
  assert.match(settings, /PROTECTED_OPENAI_DOMAINS/u);
  assert.match(settings, /ChatGPT and OpenAI domains are protected/u);
});

test('component navigation and app quit wait for mandatory cleanup', async () => {
  const main = await projectFile('dist', 'main', 'main.js');
  const tools = await projectFile('dist', 'renderer', 'tools.js');

  assert.match(main, /componentLeave/u);
  assert.match(main, /await weChatAutoReplyService\?\.shutdown/u);
  assert.match(main, /await restoreTrackedAdapterStates/u);
  assert.match(main, /windowCloseCleanupInProgress/u);
  assert.match(tools, /await window\.cherryToolbox\.app\.leaveComponent/u);
  assert.doesNotMatch(main, /keep current state|discard recovery|保持现状并退出/iu);
});

test('adapter mutation has an elevated heartbeat recovery watchdog', async () => {
  const broker = await projectFile(
    'dist',
    'main',
    'adapter-recovery-broker.js',
  );
  const main = await projectFile('dist', 'main', 'main.js');

  assert.match(broker, /Restore-UntilSuccessful/u);
  assert.match(broker, /Test-ParentHealthy/u);
  assert.match(broker, /heartbeat\.txt/u);
  assert.match(broker, /Enable-NetAdapter/u);
  assert.match(broker, /Disable-NetAdapter/u);
  assert.match(main, /adapterRecoveryBroker\.apply/u);
  assert.match(main, /adapterRecoveryBroker\.restore/u);
});

test('legacy elevation executes bounded in-memory code without writable script files', async () => {
  const network = await projectFile('dist', 'main', 'network.js');

  assert.match(network, /child\.stdin\.end\(input/u);
  assert.match(network, /ScriptBlock\]::Create/u);
  assert.match(network, /cherry-toolbox-/u);
  assert.match(network, /\.result\.txt/u);
  assert.match(network, /ReadAllText\(\$resultPath\)/u);
  assert.match(network, /-Command/u);
  assert.match(network, /-EncodedCommand/u);
  assert.match(network, /arguments\.Length -gt 30000/u);
  assert.doesNotMatch(network, /\.payload\.ps1|\.runner\.ps1/u);
});

test('automatic interface metric recovery omits the incompatible manual metric', async () => {
  const splitRouting = await projectFile(
    'dist',
    'main',
    'windows-split-routing.js',
  );

  assert.match(
    splitRouting,
    /AutomaticMetric Enabled -IgnoreDefaultRoutes/u,
  );
  assert.match(
    splitRouting,
    /AutomaticMetric Disabled -InterfaceMetric/u,
  );
  assert.doesNotMatch(
    splitRouting,
    /AutomaticMetric \$automaticMetric -InterfaceMetric/u,
  );
  assert.match(splitRouting, /System32\\route\.exe/u);
  assert.match(splitRouting, /restoreWinInetSnapshot/u);
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
    '/dist/renderer/safety.js',
    '/dist/renderer/tools.js',
    '/dist/renderer/wechat-auto-reply.js',
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

test('packaging excludes local backups and source-only launch artifacts', async () => {
  const forgeConfig = await projectFile('forge.config.js');

  assert.match(forgeConfig, /\\\.implementation-backups/u);
  assert.match(forgeConfig, /\\\.codex-backups/u);
  assert.match(forgeConfig, /\\\.codex/u);
  assert.match(forgeConfig, /\\\.agents/u);
  assert.match(forgeConfig, /Cherry Toolbox\\\.lnk/u);
  assert.match(forgeConfig, /start-source/u);
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

test('WeChat worker uses fixed allowlisted windows and never scans all sessions', async () => {
  const worker = await projectFile('python', 'wechat_auto_reply_worker.py');
  assert.match(worker, /MAX_ALLOWLIST_ENTRIES = 10/u);
  assert.match(worker, /find_independent_contact_window/u);
  assert.match(worker, /window\.window_text\(\)\.strip\(\) == contact/u);
  assert.match(worker, /verify_exact_private_contact/u);
  assert.match(worker, /Tools\.is_group_chat/u);
  assert.match(worker, /dry_run is not True/u);
  assert.match(worker, /emit\("detected"/u);
  assert.match(worker, /reason="system-message"/u);
  assert.match(worker, /class_name\(\) != "mmui::ChatItemView"/u);
  assert.match(worker, /MESSAGE_STABILITY_SECONDS = 0\.75/u);
  assert.match(worker, /POLL_SECONDS = 0\.25/u);
  assert.match(worker, /def bind_watcher_without_focus/u);
  assert.match(worker, /last_reply_at_by_contact/u);
  assert.match(worker, /daily_count/u);
  assert.doesNotMatch(worker, /send_keys|\.set_text\(|emit\("reply"|ReplyLimiter/u);
  assert.doesNotMatch(worker, /auto_reply_messages/u);
  assert.doesNotMatch(worker, /open_seperate_dialog_window|set_focus|\.click\(|click_input|minimize\(|restore_foreground|ShowWindow|SetForegroundWindow/u);
  assert.doesNotMatch(worker, /new_message\.window_text/u);
  assert.doesNotMatch(
    worker,
    /ReadProcessMemory|WriteProcessMemory|CreateRemoteThread|VirtualAllocEx/u,
  );
});

test('WeChat setup pins upstream and hash-locks every Python dependency', async () => {
  const setup = await projectFile('scripts', 'setup-wechat-auto-reply.ps1');
  const lock = await projectFile(
    'python',
    'requirements-wechat-auto-reply.lock',
  );
  const requirements = lock.match(/^[A-Za-z][A-Za-z0-9_-]*==[^\s\\]+/gmu) ?? [];
  const hashes = lock.match(/--hash=sha256:[a-f0-9]{64}/gu) ?? [];

  assert.match(
    setup,
    /109724b7b9d50b0914d33b778caf220415f10360/u,
  );
  assert.match(setup, /--require-hashes/u);
  assert.match(setup, /--no-deps/u);
  assert.equal(requirements.length, 28);
  assert.equal(hashes.length, requirements.length);
});

test('Windows lock and suspend stop WeChat automation without auto-resume', async () => {
  const main = await projectFile('dist', 'main', 'main.js');
  assert.match(main, /powerMonitor\.on\(['"]lock-screen['"]/u);
  assert.match(main, /powerMonitor\.on\(['"]suspend['"]/u);
  assert.match(main, /cleanupApplicationComponents/u);
  assert.doesNotMatch(main, /powerMonitor\.on\(['"]resume['"]/u);
});

test('source shortcut uses the toolbox icon and hidden VBS launcher', async () => {
  const shortcutScript = await projectFile(
    'scripts',
    'create-source-shortcut.ps1',
  );
  assert.match(shortcutScript, /CreateShortcut/u);
  assert.match(shortcutScript, /start-source\.vbs/u);
  assert.match(shortcutScript, /cherry-toolbox\.ico/u);
  assert.match(shortcutScript, /System32[\\/]wscript\.exe/u);
});
