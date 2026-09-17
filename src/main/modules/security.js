'use strict';
const path = require('node:path');
const { fileURLToPath } = require('node:url');

function isLocalShell(url) {
  try {
    const target = new URL(url);
    if (target.protocol !== 'file:' || target.host) return false;
    const file = path.resolve(fileURLToPath(target));
    const root = path.resolve(__dirname, '../../renderer');
    return ['index.html', 'splash.html'].some((name) => file === path.join(root, name));
  } catch { return false; }
}

function isTrustedIpc(event) {
  return Boolean(event?.senderFrame && event.senderFrame === event.sender?.mainFrame && isLocalShell(event.senderFrame.url));
}

function externalUrl(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

function isPlatformUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'platform.deepseek.com' && !url.username && !url.password;
  } catch { return false; }
}

function reusablePermission(value) {
  return ['read-only', 'workspace-write'].includes(value) ? value : 'read-only';
}

module.exports = { isLocalShell, isTrustedIpc, externalUrl, isPlatformUrl, reusablePermission };
