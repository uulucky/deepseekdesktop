'use strict';
const assert = require('node:assert/strict');
const { isForeignRuntime } = require('../build/runtime-target');
for (const target of ['win32-x64', 'darwin-arm64', 'darwin-x64']) {
  assert(!isForeignRuntime(target, target));
  assert(!isForeignRuntime(target.replace('-', '_'), target));
  assert(!isForeignRuntime('koffi-' + target, target));
  assert(!isForeignRuntime('sharp-libvips-' + target, target));
  assert(!isForeignRuntime('runtime', target));
  for (const other of ['win32-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64']) {
    assert.equal(isForeignRuntime('koffi-' + other, target), other !== target);
    assert.equal(isForeignRuntime(other.replace('-', '_'), target), other !== target);
  }
}
console.log('PASS native runtime pruning preserves both target name spellings on Windows and Mac');
