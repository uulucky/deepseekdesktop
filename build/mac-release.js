'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const { version } = require('../package.json');
const pins = require('./runtime-pins.json');
assert.equal(process.platform, 'darwin', 'Build and test on a native Mac runner');
assert(['arm64', 'x64'].includes(process.arch));
const marker = require('../vendor/node/.deepseek-runtime.json');
assert.equal(marker.platform, 'darwin');
assert.equal(marker.arch, process.arch, 'Stage native dependencies on the matching architecture');
assert.equal(marker.nodeVersion, pins.nodeVersion);
const run = (file, args = []) => execFileSync(process.execPath, [file, ...args], {
  cwd: root, stdio: 'inherit', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
});
run('build/make-icon.js');
run('build/build-info.js', ['--mac']);
run('node_modules/electron-builder/cli.js', ['--mac', 'dmg', 'zip', '--' + process.arch, '--publish', 'never']);
const prefix = `mac-${process.arch}-`;
const names = ['dmg', 'zip'].map(ext => `DeepSeekDesktop-${version}-mac-${process.arch}.${ext}`);
const hash = name => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'dist', name))).digest('hex');
const dmg = names[0];
const descriptor = { version, platforms: { [`darwin-${process.arch}`]: {
  format: 'manual-dmg', url: `https://img.uulucky.com/han/deepseek/${dmg}`,
  size: fs.statSync(path.join(root, 'dist', dmg)).size, sha256: hash(dmg),
} } };
fs.writeFileSync(path.join(root, 'dist', prefix + 'unsigned-update.json'), JSON.stringify(descriptor, null, 2) + '\n');
names.push(prefix + 'build-info.json', prefix + 'sbom.cdx.json', prefix + 'unsigned-update.json');
fs.writeFileSync(path.join(root, 'dist', prefix + 'SHA256SUMS.txt'), names.sort().map(name => `${hash(name)}  ${name}`).join('\n') + '\n');
