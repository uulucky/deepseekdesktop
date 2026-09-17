'use strict';
const fs = require('node:fs');
const { verifySignedManifest } = require('../src/main/modules/update-trust');
const file = process.argv[2];
if (!file) throw new Error('Usage: node build/verify-update.js latest.json');
const manifest = verifySignedManifest(JSON.parse(fs.readFileSync(file, 'utf8')));
console.log(`Verified update ${manifest.version}, key ${manifest.signature.keyId}`);
