const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtemp, writeFile, readFile, rm, access } = require('node:fs/promises');
const { crc32 } = require('node:zlib');
const os = require('node:os');
const path = require('node:path');
const extract = require('extract-zip');

// A minimal stored ZIP fixture avoids adding another archive dependency to the build.
function fixture(name, contents, mode) {
  const filename = Buffer.from(name), data = Buffer.from(contents), checksum = crc32(data);
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
  local.writeUInt32LE(checksum, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(checksum, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28);
  central.writeUInt32LE((mode * 65536) >>> 0, 38);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + filename.length, 12); end.writeUInt32LE(local.length + filename.length + data.length, 16);
  return Buffer.concat([local, filename, data, central, filename, end]);
}

test('build extractor rejects an escaping symlink and preserves existing destination files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cherry-archive-regression-'));
  const output = path.join(directory, 'output');
  try {
    const archive = path.join(directory, 'malicious.zip');
    await writeFile(archive, fixture('escape-link', '../../outside', 0o120777));
    await assert.rejects(extract(archive, { dir: output }), /Archive symlinks are forbidden/);
    await assert.rejects(access(path.join(output, 'escape-link')), { code: 'ENOENT' });
    await writeFile(path.join(output, 'preserved.txt'), 'original');
    await writeFile(archive, fixture('preserved.txt', 'replacement', 0o100644));
    await assert.rejects(extract(archive, { dir: output }), { code: 'EEXIST' });
    assert.equal(await readFile(path.join(output, 'preserved.txt'), 'utf8'), 'original');
    await writeFile(archive, fixture('new.txt', 'expected', 0o100644));
    await extract(archive, { dir: output });
    assert.equal(await readFile(path.join(output, 'new.txt'), 'utf8'), 'expected');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
