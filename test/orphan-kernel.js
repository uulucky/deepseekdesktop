'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { isAppOrphan, reapOrphanKernels } = require('../src/main/modules/orphan-kernel');

async function main() {
  const root = '/Users/test/Library/Application Support/DeepSeek Desktop';
  const patch = path.join(root, 'runtime/desktop-presentation/cordis.patch.json');
  const bin = '/Applications/DeepSeek Desktop.app/Contents/Resources/vendor/kernel/node_modules/@deepseek-ai/dsh/lib/bin.js';
  const command = `/Applications/DeepSeek Desktop.app/Contents/Resources/vendor/node/bin/node ${bin} web --patch ${patch} --port 3085 --no-open`;
  const orphan = ` 1234 1 ${command}`;
  assert.equal(isAppOrphan(orphan, patch), 1234);
  assert.equal(isAppOrphan(` 1234 999 ${command}`, patch), null, 'live parent must be left alone');
  assert.equal(isAppOrphan(` 1234 1 ${command.replace(patch, '/tmp/foreign.patch.json')}`, patch), null, 'unrelated dsh must be left alone');
  assert.equal(isAppOrphan(` 1234 1 ${command.replace('/@deepseek-ai/dsh/lib/bin.js', '/other/bin.js')}`, patch), null, 'only the reviewed dsh entry can be reaped');
  assert.equal(isAppOrphan(` 1234 1 ${command.replace('--no-open', '--open')}`, patch), null, 'unexpected launch forms must be left alone');

  let table = `${orphan}\n 5678 999 ${command}\n`;
  const stopped = [];
  const result = await reapOrphanKernels(root, {
    platform: 'darwin', processTable: async () => table,
    terminate(pid) { stopped.push(pid); table = table.replace(orphan, ''); },
    isAlive: (pid) => !stopped.includes(pid), sleep: async () => {},
  });
  assert.deepEqual(result, { stopped: [1234], remaining: [] });
  assert.deepEqual(stopped, [1234]);

  let calls = 0;
  const raced = await reapOrphanKernels(root, {
    platform: 'darwin', processTable: async () => ++calls === 1 ? orphan : ` 1234 555 ${command}`,
    terminate() { throw new Error('reused PID must not be signalled'); },
  });
  assert.deepEqual(raced, { stopped: [], remaining: [] });
  const skipped = await reapOrphanKernels(root, {
    platform: 'win32', processTable() { throw new Error('must not scan on Windows'); },
  });
  assert.deepEqual(skipped, { stopped: [], remaining: [] });
  console.log('PASS orphaned Mac Harness recovery only signals verified app-owned children');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
