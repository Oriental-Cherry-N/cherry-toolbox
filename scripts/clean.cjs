const { rmSync } = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const generatedDirectories = [
  'dist',
  'out',
  '.tmp',
  '.pnpm-store',
  path.join('node_modules', '.ignored'),
];

for (const directory of generatedDirectories) {
  rmSync(path.join(projectRoot, directory), { force: true, recursive: true });
}

console.log(`Removed generated directories: ${generatedDirectories.join(', ')}`);
