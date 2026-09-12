// Local mitigation for CVE-2026-56876. Upstream extract-zip 2.0.1 has no fixed release.
// This Windows-only build never needs archive symlinks or overwriting existing files.
const fs = require('node:fs');
const path = require('node:path');
const file = path.resolve(__dirname, '../node_modules/extract-zip/index.js');
let source = fs.readFileSync(file, 'utf8');
const version = require('../node_modules/extract-zip/package.json').version;
if (version !== '2.0.1') throw new Error('Review the extract-zip mitigation before changing its version.');
if (source.includes('// CHERRY: reject archive symlinks before creating any entry.')) {
  if (!source.includes("flags: 'wx'") || !source.includes("if (symlink) throw new Error('Archive symlinks are forbidden by the Windows build policy.')")) throw new Error('The extract-zip mitigation is incomplete.');
  process.exit(0);
}
const anchor = 'const symlink = (mode & IFMT) === IFLNK';
if (source.split(anchor).length !== 2 || !source.includes('createWriteStream(dest, { mode: procMode })')) throw new Error('The extract-zip implementation changed; review the security patch.');
source = source.replace(anchor, anchor + "\n    // CHERRY: reject archive symlinks before creating any entry.\n    if (symlink) throw new Error('Archive symlinks are forbidden by the Windows build policy.')");
source = source.replace('createWriteStream(dest, { mode: procMode })', "createWriteStream(dest, { mode: procMode, flags: 'wx' })");
fs.writeFileSync(file, source);
console.log('Build dependency mitigation applied: archive symlinks and file overwrites are rejected.');
