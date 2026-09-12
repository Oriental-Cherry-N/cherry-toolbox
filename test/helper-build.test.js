const assert = require('node:assert/strict');
const test = require('node:test');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const root = path.resolve(__dirname, '..');
const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function run(directory, file, args = []) {
  const child = spawn(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(directory, 'scripts', file), ...args], {
    cwd: directory, windowsHide: true, env: { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH },
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  child.done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(output) : reject(new Error('Build exited ' + code + '\n' + output)));
  });
  child.done.catch(() => {});
  return child;
}

async function until(read, description, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await delay(100);
  }
  throw new Error('Timed out waiting for ' + description);
}

async function fixture(t) {
  await fs.mkdir(path.join(root, '.tmp'), { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, '.tmp/helper-build-'));
  for (const folder of ['scripts', 'native', 'src/main']) await fs.mkdir(path.join(directory, folder), { recursive: true });
  for (const name of ['build-native.ps1', 'build-lock.ps1', 'build-source.ps1', 'source-instance.cjs'])
    await fs.copyFile(path.join(root, 'scripts', name), path.join(directory, 'scripts', name));
  for (const name of (await fs.readdir(path.join(root, 'native'))).filter(name => name.endsWith('.cs')))
    await fs.copyFile(path.join(root, 'native', name), path.join(directory, 'native', name));
  await fs.copyFile(path.join(root, 'src/main/native-helper.ts'), path.join(directory, 'src/main/native-helper.ts'));
  await fs.writeFile(path.join(directory, 'native/BuildProbe.cs'), 'internal static class BuildProbe { public const string Version = "one"; }');
  // A build counter replaces dependency patching in this isolated fixture only.
  await fs.writeFile(path.join(directory, 'scripts/harden-build-dependencies.cjs'), "require('node:fs').appendFileSync('build-count.txt', 'build\\n');");
  await fs.symlink(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'junction');
  const config = { compilerOptions: { target: 'ES2022', module: 'Node16', rootDir: 'src', outDir: 'dist', types: ['node'], strict: true, esModuleInterop: true, skipLibCheck: true }, include: ['src/main/*.ts'] };
  await fs.writeFile(path.join(directory, 'tsconfig.json'), JSON.stringify(config));
  await fs.writeFile(path.join(directory, 'tsconfig.renderer.json'), JSON.stringify(config));
  const f = { directory, children: [] };
  t.after(async () => {
    await fs.writeFile(path.join(directory, 'stop-fixture'), '');
    for (const child of f.children) {
      if (child.exitCode === null) {
        await Promise.race([child.done.catch(() => {}), delay(10000)]);
        if (child.exitCode === null) child.kill();
      }
    }
    assert.equal(path.dirname(path.resolve(directory)), path.join(root, '.tmp'));
    assert.match(path.basename(directory), /^helper-build-/);
    await fs.rm(path.join(directory, 'node_modules'), { recursive: true, force: true });
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5 });
  });
  return f;
}

test('real builds and standalone typechecking preserve the helper pinned by a running module', { timeout: 90000 }, async t => {
  const { directory } = await fixture(t);
  await run(directory, 'build-source.ps1', ['-Mode', 'Main']).done;
  const localRequire = createRequire(path.join(directory, 'package.json'));
  const oldRuntime = localRequire('./dist/main/native-helper.js');
  const oldPath = await oldRuntime.nativeHelperPath();
  const oldBytes = await fs.readFile(oldPath);
  const oldCompiled = await fs.readFile(path.join(directory, 'dist/main/native-manifest.js'), 'utf8');
  await fs.writeFile(path.join(directory, 'native/BuildProbe.cs'), 'internal static class BuildProbe { public const string Version = "two"; }');
  await run(directory, 'build-source.ps1', ['-Mode', 'Check']).done;
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'native/bin/helper-manifest.json'), 'utf8'));
  assert.notEqual(manifest.sha256, hash(oldBytes));
  assert.equal(await fs.readFile(path.join(directory, 'dist/main/native-manifest.js'), 'utf8'), oldCompiled, 'Typechecking must not emit application modules');
  assert.equal(await oldRuntime.nativeHelperPath(), oldPath);
  assert.deepEqual(await fs.readFile(oldPath), oldBytes);

  await run(directory, 'build-source.ps1', ['-Mode', 'Main']).done;
  for (const name of ['native-helper', 'native-manifest']) delete require.cache[localRequire.resolve('./dist/main/' + name + '.js')];
  const newRuntime = localRequire('./dist/main/native-helper.js');
  const newPath = await newRuntime.nativeHelperPath();
  assert.notEqual(newPath, oldPath);
  assert.equal(await oldRuntime.nativeHelperPath(), oldPath, 'An already loaded module must not adopt the new disk manifest');
  const mtime = (await fs.stat(newPath)).mtimeMs;
  const generatedTime = (await fs.stat(path.join(directory, 'src/main/native-manifest.ts'))).mtimeMs;
  const outputs = await Promise.all([run(directory, 'build-native.ps1').done, run(directory, 'build-native.ps1').done]);
  assert.ok(outputs.every(output => output.includes('Reusing the verified')));
  assert.equal((await fs.stat(newPath)).mtimeMs, mtime);
  assert.equal((await fs.stat(path.join(directory, 'src/main/native-manifest.ts'))).mtimeMs, generatedTime);

  await fs.appendFile(newPath, 'tampered fixture');
  await assert.rejects(newRuntime.nativeHelperPath(), /完整性/);
  const diagnostics = newRuntime.nativeHelperDiagnostics();
  assert.ok(diagnostics.includes(newPath));
  assert.ok(diagnostics.includes('Expected SHA-256: ' + manifest.sha256));
  assert.ok(diagnostics.includes('Actual SHA-256: ' + hash(await fs.readFile(newPath))));
  await fs.unlink(newPath);
  await assert.rejects(newRuntime.nativeHelperPath(), /缺失/);
  assert.match(newRuntime.nativeHelperDiagnostics(), /Actual SHA-256: unreadable/);
  assert.equal(await oldRuntime.nativeHelperPath(), oldPath, 'Missing new version cannot damage the old pinned version');
});

test('simultaneous source launches build once, focus the existing instance, and survive rebuilds', { timeout: 120000 }, async t => {
  // This account cannot load Chromium's graphics dependencies. Launching anyway
  // produces a Windows crash dialog on the user's desktop, even with no window.
  const environmentMessage = 'Run Electron startup tests in the normal Windows user environment, not the restricted Codex sandbox account.';
  let windowsUser;
  try { windowsUser = os.userInfo().username; } catch { assert.fail(environmentMessage); }
  assert.doesNotMatch(windowsUser, /^CodexSandbox/iu, environmentMessage);
  const f = await fixture(t), { directory } = f;
  const identity = 'Cherry Build Fixture ' + path.basename(directory);
  const probePath = path.join(directory, 'scripts/source-instance.cjs');
  await fs.writeFile(probePath, (await fs.readFile(probePath, 'utf8')).replace("app.setName('Cherry Toolbox')", 'app.setName(' + JSON.stringify(identity) + ')'));
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'cherry-build-fixture', main: 'fixture-app.cjs' }));
  await fs.writeFile(path.join(directory, 'fixture-app.cjs'), [
    "const { app } = require('electron'); const fs = require('node:fs');",
    'app.setName(' + JSON.stringify(identity) + ');',
    "app.setPath('userData', require('node:path').join(__dirname, 'fixture-profile'));",
    "if (!app.requestSingleInstanceLock()) app.exit(1);",
    "const helper = require('./dist/main/native-helper');",
    "app.on('second-instance', (_e,_a,_d,data) => { if (data.focus) fs.appendFileSync('focus-count.txt','focus\\n'); });",
    "const initial = helper.nativeHelperPath().then(file => {fs.writeFileSync('fixture-ready.json',JSON.stringify({pid:process.pid,file}));});",
    "setInterval(() => { if(fs.existsSync('stop-fixture')) app.quit(); },100);",
    "setInterval(() => { if(fs.existsSync('verify-fixture')) {fs.unlinkSync('verify-fixture'); initial.then(()=>helper.nativeHelperPath()).then(file=>fs.writeFileSync('verified-fixture',file)).catch(e=>fs.writeFileSync('verified-fixture',String(e)));} },100);",
  ].join('\n'));
  // Both the probe and primary use a disposable profile; no real user app is activated.
  await fs.writeFile(probePath, (await fs.readFile(probePath, 'utf8')).replace('const ownsInstance', "app.setPath('userData', require('node:path').join(__dirname, '../fixture-profile'));\nconst ownsInstance"));
  const first = run(directory, 'build-source.ps1', ['-Mode', 'Launch', '-Hidden']);
  const second = run(directory, 'build-source.ps1', ['-Mode', 'Launch', '-Hidden']);
  f.children.push(first, second);
  const ready = await until(async () => {
    try { return JSON.parse(await fs.readFile(path.join(directory, 'fixture-ready.json'), 'utf8')); }
    catch { if (first.exitCode !== null && second.exitCode !== null) await Promise.all([first.done, second.done]); return false; }
  }, 'the isolated Electron instance');
  await until(async () => first.exitCode === 0 || second.exitCode === 0, 'the duplicate launcher to exit');
  assert.equal(await fs.readFile(path.join(directory, 'build-count.txt'), 'utf8'), 'build\n');
  const initialBytes = await fs.readFile(ready.file);
  const duplicate = await run(directory, 'build-source.ps1', ['-Mode', 'Launch']).done;
  assert.match(duplicate, /No files were rebuilt/);
  assert.equal(await fs.readFile(path.join(directory, 'build-count.txt'), 'utf8'), 'build\n');
  assert.ok((await fs.readFile(path.join(directory, 'focus-count.txt'), 'utf8')).length > 0);
  await fs.writeFile(path.join(directory, 'native/BuildProbe.cs'), 'internal static class BuildProbe { public const string Version = "live-rebuild"; }');
  await run(directory, 'build-source.ps1', ['-Mode', 'Check']).done;
  await run(directory, 'build-source.ps1', ['-Mode', 'Main']).done;
  await fs.writeFile(path.join(directory, 'verify-fixture'), '');
  const verified = await until(async () => {
    try { return await fs.readFile(path.join(directory, 'verified-fixture'), 'utf8'); } catch { return false; }
  }, 'the original running process to verify its original helper');
  assert.equal(verified, ready.file);
  assert.deepEqual(await fs.readFile(ready.file), initialBytes);
  await fs.writeFile(path.join(directory, 'stop-fixture'), '');
  await Promise.all([first.done, second.done]);
});
