'use strict';
/**
 * Test build: copy the app tree into build/app so the UI harness and packaging runs always
 * work from a clean, self-contained directory.
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const out = path.join(__dirname, 'app');

fs.rmSync(out, { recursive: true, force: true });
for (const entry of ['src', 'package.json']) {
  fs.cpSync(path.join(root, entry), path.join(out, entry), { recursive: true });
}
// The harnesses run from inside the copied tree, so they ship with it — always refreshed,
// otherwise a probe can silently execute a stale copy of the modules it is testing.
for (const harness of ['test-main.js', 'portable-probe.js', 'run-ui.js']) {
  const from = path.join(__dirname, harness);
  if (fs.existsSync(from)) fs.cpSync(from, path.join(out, harness));
}
fs.rmSync(path.join(out, 'portable-probe.js'), { force: true });
for (const harness of ['portable-probe.js']) {
  const from = path.join(__dirname, harness);
  if (fs.existsSync(from)) fs.cpSync(from, path.join(out, harness));
}
console.log('test build ready at', out);
