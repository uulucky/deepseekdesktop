'use strict';
const crypto = require('node:crypto');
const keys = require('./update-keys.json');

// Canonical JSON includes every field except the detached signature. Neither an OSS
// operator nor a CDN can change a download URL, hash, version or note without the key.
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('Invalid signed JSON');
  return JSON.stringify(value);
}

function manifestBytes(manifest) {
  const { signature, ...payload } = manifest;
  return Buffer.from('DeepSeekDesktop/update-manifest/v2\n' + canonical(payload), 'utf8');
}

function verifySignedManifest(manifest, trustedKeys = keys) {
  const sig = manifest?.signature;
  if (manifest?.schemaVersion !== 2 || sig?.algorithm !== 'Ed25519'
    || typeof sig.keyId !== 'string' || !Object.hasOwn(trustedKeys, sig.keyId)
    || typeof sig.value !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(sig.value)) {
    throw new Error('更新清单缺少可信数字签名，已拒绝更新');
  }
  if (!crypto.verify(null, manifestBytes(manifest), trustedKeys[sig.keyId], Buffer.from(sig.value, 'base64'))) {
    throw new Error('更新清单数字签名验证失败，已拒绝更新');
  }
  return manifest;
}

function signManifest(manifest, privateKey, keyId) {
  const signed = { ...manifest, schemaVersion: 2 };
  signed.signature = { algorithm: 'Ed25519', keyId, value: crypto.sign(null, manifestBytes(signed), privateKey).toString('base64') };
  return signed;
}

module.exports = { canonical, manifestBytes, verifySignedManifest, signManifest };
