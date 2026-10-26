'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { splashStyle, resolveSplashArt, importSplashArt, removeStoredArt } = require('../src/main/modules/splash-art');

function memoryStore(data) {
  return { get: (key, fallback) => (key in data ? data[key] : fallback) };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsd-splash-'));
const source = path.join(root, '大肥鱼.PNG');
fs.writeFileSync(source, 'png');

assert.equal(splashStyle(undefined), 'whale');
assert.equal(splashStyle('custom'), 'custom');
assert.equal(splashStyle('../../etc'), 'whale');

// Default and incomplete custom choices keep the built-in whale.
assert.equal(resolveSplashArt(memoryStore({}), root), null);
assert.equal(resolveSplashArt(memoryStore({ splashStyle: 'custom' }), root), null);

const first = importSplashArt(source, root);
assert.equal(first.kind, 'image');
assert.equal(first.name, '大肥鱼.PNG');
assert.match(first.file, /^custom-\d+\.png$/);
const resolved = resolveSplashArt(memoryStore({ splashStyle: 'custom', splashArt: first.file }), root);
assert.equal(path.dirname(fileURLToPath(resolved.url)), path.join(root, 'splash'));
assert.equal(resolved.kind, 'image');
assert.equal(resolveSplashArt(memoryStore({ splashStyle: 'whale', splashArt: first.file }), root), null);

// Only generated names inside the splash folder are ever resolved.
for (const name of ['../大肥鱼.PNG', 'custom-1.png/../../x.png', 'custom-1.exe', source]) {
  assert.equal(resolveSplashArt(memoryStore({ splashStyle: 'custom', splashArt: name }), root), null, name);
}
assert.throws(() => importSplashArt(path.join(root, 'run.exe'), root), /仅支持/);

// A newer pick replaces the earlier copy; clearing removes every stored copy, and a missing
// file falls back to the whale instead of a blank splash.
const video = path.join(root, 'clip.webm');
fs.writeFileSync(video, 'webm');
const second = importSplashArt(video, root);
assert.equal(second.kind, 'video');
assert.deepEqual(fs.readdirSync(path.join(root, 'splash')), [second.file]);
removeStoredArt(root);
assert.deepEqual(fs.readdirSync(path.join(root, 'splash')), []);
assert.equal(resolveSplashArt(memoryStore({ splashStyle: 'custom', splashArt: second.file }), root), null);

fs.rmSync(root, { recursive: true, force: true });
console.log('PASS splash animation choice stays inside the data folder and falls back to the whale');
