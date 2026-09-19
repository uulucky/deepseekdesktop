'use strict';
// Only called after all three native test jobs pass; do not sign in CI.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const dist = path.resolve(__dirname, '../dist');
const { version } = require('../package.json');
const read = name => JSON.parse(fs.readFileSync(path.join(dist, name), 'utf8'));
const hash = name => crypto.createHash('sha256').update(fs.readFileSync(path.join(dist, name))).digest('hex');
const combined = read('unsigned-update.json');
assert.equal(combined.version, version);
for (const arch of ['arm64', 'x64']) {
  const prefix = `mac-${arch}-`;
  const info = read(prefix + 'build-info.json');
  assert.equal(info.sourceCommit, process.env.GITHUB_SHA);
  assert.equal(info.version, version);
  assert.equal(info.arch, arch);
  for (const line of fs.readFileSync(path.join(dist, prefix + 'SHA256SUMS.txt'), 'utf8').trim().split('\n')) {
    const [sha, name] = line.split(/\s+/);
    assert.equal(path.basename(name), name);
    assert.equal(hash(name), sha);
  }
  const descriptor = read(prefix + 'unsigned-update.json');
  assert.equal(descriptor.version, version);
  const target = descriptor.platforms[`darwin-${arch}`];
  const expectedName = `DeepSeekDesktop-${version}-mac-${arch}.dmg`;
  assert.equal(target.url, `https://img.uulucky.com/han/deepseek/${expectedName}`);
  assert.equal(target.sha256, hash(expectedName));
  assert.equal(target.size, fs.statSync(path.join(dist, expectedName)).size);
  assert.equal(target.format, 'manual-dmg');
  combined.platforms[`darwin-${arch}`] = target;
}
fs.writeFileSync(path.join(dist, 'unsigned-update.json'), JSON.stringify(combined, null, 2) + '\n');
const names = fs.readdirSync(dist).filter(name => name !== 'SHA256SUMS.txt' && fs.statSync(path.join(dist, name)).isFile());
fs.writeFileSync(path.join(dist, 'SHA256SUMS.txt'), names.sort().map(name => `${hash(name)}  ${name}`).join('\n') + '\n');
console.log('Combined Windows + Apple Silicon + Intel descriptors and checksums');
