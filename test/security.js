'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { isLocalShell, isTrustedIpc, isPlatformUrl, externalUrl, reusablePermission } = require('../src/main/modules/security');
const { normalize } = require('../src/main/modules/ad');
const { redact } = require('../src/main/modules/util');
assert(!redact('sk-secret123 Bearer abc.def ?token=private {"password":"sensitive"}').includes('secret123'));
assert(!redact('sk-secret123 Bearer abc.def ?token=private {"password":"sensitive"}').includes('sensitive'));
const shell = pathToFileURL(path.resolve(__dirname, '../src/renderer/index.html')).href;
assert.equal(isLocalShell(shell), true);
for (const bad of ['https://platform.deepseek.com/', 'file:///tmp/index.html', 'https://127.0.0.1/', 'javascript:alert(1)']) assert.equal(isLocalShell(bad), false);
const frame = { url: shell };
assert.equal(isTrustedIpc({ senderFrame: frame, sender: { mainFrame: frame } }), true);
assert.equal(isTrustedIpc({ senderFrame: { url: shell }, sender: { mainFrame: frame } }), false);
assert.equal(isPlatformUrl('https://platform.deepseek.com/usage'), true);
for (const bad of ['https://deepseek.com.evil.test/', 'https://evil.test/?deepseek.com', 'https://platform.deepseek.com@evil.test/', 'http://platform.deepseek.com/']) assert.equal(isPlatformUrl(bad), false);
assert.equal(externalUrl('file:///C:/Windows/cmd.exe'), null);
assert.equal(externalUrl('ms-settings:privacy'), null);
assert.equal(reusablePermission('danger-full-access'), 'danger-full-access');
assert.equal(reusablePermission(undefined), 'danger-full-access');
assert.equal(reusablePermission(null), 'danger-full-access');
assert.equal(reusablePermission('read-only'), 'read-only');
assert.equal(reusablePermission('invalid'), 'read-only');
assert.equal(reusablePermission('workspace-write'), 'workspace-write');
const result = normalize({ ads: [
  { url: 'https://www.deepseek.com', pic: 'https://img.uulucky.com/han/ad.png' },
  { url: 'https://www.deepseek.com', pic: 'https://tracker.test/pixel.gif' },
  { url: 'javascript:alert(1)', pic: 'https://img.uulucky.com/a.png' },
] });
assert.equal(result.ads.length, 2);
assert.equal(result.ads[1].pic, null);
console.log('PASS renderer boundaries, exact platform origins, IPC sender checks, permission defaults and ad image allowlist');
