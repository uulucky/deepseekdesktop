'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { signManifest, verifySignedManifest } = require('../src/main/modules/update-trust');
const [file, privateFile, output] = process.argv.slice(2);
if (!file || !privateFile || !output) throw new Error('Usage: node build/sign-update.js unsigned-manifest.json /private/key.pem signed-manifest.json');
const key = crypto.createPrivateKey(fs.readFileSync(privateFile));
const pub = crypto.createPublicKey(key);
const keyId = crypto.createHash('sha256').update(pub.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 24);
const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
const signed = signManifest(payload, key, keyId);
verifySignedManifest(signed); // Refuse a key the shipped app does not trust.
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(signed, null, 2) + '\n');
console.log('Signed manifest:', output, 'key ID:', keyId);
