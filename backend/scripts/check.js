const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
let files = 0;
function check(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) check(filename);
    else if (entry.name.endsWith('.js')) {
      new vm.Script(fs.readFileSync(filename, 'utf8'), { filename });
      files++;
    }
  }
}

for (const directory of ['src', 'scripts', 'test']) check(path.join(root, directory));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')).packages[''];
for (const field of ['name', 'version', 'dependencies', 'devDependencies', 'engines']) {
  assert.deepEqual(manifest[field], lock[field], `package-lock.json does not match package.json: ${field}`);
}
JSON.parse(fs.readFileSync(path.join(root, '../database/baseline.json'), 'utf8'));
console.log(`Syntax checked ${files} JavaScript files; package lock and baseline JSON are valid.`);
