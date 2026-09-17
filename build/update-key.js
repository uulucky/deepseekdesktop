'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const target = process.argv[2];
if (!target || !path.isAbsolute(target)) throw new Error('Usage: node build/update-key.js /private/location/update-signing.pem');
if (path.resolve(target).startsWith(path.resolve(__dirname, '..') + path.sep)) throw new Error('Private key must be OUTSIDE the repository');
fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
let privateKey;
if (fs.existsSync(target)) privateKey = crypto.createPrivateKey(fs.readFileSync(target));
else {
  privateKey = crypto.generateKeyPairSync('ed25519').privateKey;
  fs.writeFileSync(target, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
}
if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Expected Ed25519');
const publicKey = crypto.createPublicKey(privateKey);
const pem = publicKey.export({ type: 'spki', format: 'pem' });
const keyId = crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 24);
const filename = path.join(__dirname, '../src/main/modules/update-keys.json');
const keys = JSON.parse(fs.readFileSync(filename, 'utf8'));
keys[keyId] = pem;
fs.writeFileSync(filename, JSON.stringify(keys, null, 2) + '\n');
console.log('Public signing key ID:', keyId);
console.log('Private key stored outside repository:', target);
