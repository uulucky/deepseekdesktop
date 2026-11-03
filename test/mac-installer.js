'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { distribution } = require('../build/mac-installer');
for (const arch of ['arm64', 'x64']) {
  const xml = distribution('0.6.1', arch, 'application.pkg');
  assert(xml.includes('enable_currentUserHome="false"'));
  assert(xml.includes(`hostArchitectures="${arch === 'x64' ? 'x86_64' : 'arm64'}"`));
  assert(xml.includes('com.deepseek.desktop.pkg'));
}
assert.throws(() => distribution('1.2.3<script>', 'arm64', 'application.pkg'));
assert.throws(() => distribution('1.2.3', 'arm', 'application.pkg'));
assert.throws(() => distribution('1.2.3', 'arm64', '../bad.pkg'));
const pre = fs.readFileSync(path.join(__dirname, '../build/mac-installer/preinstall'), 'utf8');
const post = fs.readFileSync(path.join(__dirname, '../build/mac-installer/postinstall'), 'utf8');
assert(pre.includes('CFBundleIdentifier') && pre.includes('pgrep -u "$uid"'));
assert(pre.includes('kill -TERM') && !pre.includes('kill -9'));
assert(pre.includes('exit 1;') && pre.includes('did not close'));
assert(post.includes('launchctl asuser "$uid"') && post.includes('sudo -n -H -u "$user"'));
assert(post.includes('codesign --verify --deep --strict'));
assert(!/rm\s+-rf|quarantine|Application Support/.test(pre + post), 'installer cannot erase profiles or bypass Gatekeeper');
console.log('PASS Mac installer input bounds, platform selection and process/data boundaries');
