// Pinned official release; no FlClash state is written or reloaded.
const { mkdir, writeFile, readFile } = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const version = 'v1.19.30';
const filename = `mihomo-windows-amd64-compatible-${version}.zip`;
const sha256 = '289fde5e29d37a5b3326480590d8b3551c5bf7f8737290355c19bce74d57a563';
const root = path.resolve(__dirname, '..');
(async () => {
  const response = await fetch(`https://github.com/MetaCubeX/mihomo/releases/download/${version}/${filename}`);
  if (!response.ok) throw new Error(`Official release download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('The official archive checksum does not match the pinned release.');
  await mkdir(path.join(root, '.tmp'), { recursive: true });
  const archive = path.join(root, '.tmp', filename);
  await writeFile(archive, bytes);
  execFileSync('powershell.exe', ['-NoProfile', '-File', path.join(__dirname, 'unpack-routing-core.ps1'), '-Archive', archive], { cwd: root, windowsHide: true, stdio: 'inherit' });
  const binary = await readFile(path.join(root, 'native/bin/mihomo.exe'));
  await writeFile(path.join(root, 'native/core-manifest.json'), JSON.stringify({ version, archiveSha256: sha256, binarySha256: createHash('sha256').update(binary).digest('hex'), source: `https://github.com/MetaCubeX/mihomo/tree/${version}` }, null, 2) + '\n');
  console.log(`Dedicated routing core installed and verified: ${version}`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
