'use strict';
/** Updater contracts: trusted manifests, native handoff acknowledgement and data preservation. */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  PortableUpdater, compareVersions, validateManifest, updaterScript, waitForReadyFile,
} = require('../src/main/modules/updater');

assert.equal(compareVersions('0.2.6', '0.2.5'), 1);
assert.equal(compareVersions('0.2.6', '0.2.6'), 0);
assert.equal(compareVersions('0.2.5', '0.2.6'), -1);

const target = {
  url: 'https://img.uulucky.com/han/deepseek/DeepSeekDesktop-0.2.6-portable.zip',
  sha256: 'a'.repeat(64),
  size: 1024,
};
assert.doesNotThrow(() => validateManifest({ version: '0.2.6' }, target));
assert.throws(() => validateManifest({ version: '0.2.6' }, { ...target, url: 'https://example.com/update.zip' }), /未受信任/);
assert.throws(() => validateManifest({ version: 'next' }, target), /格式无效/);
const bootstrap = {
  format: 'bootstrap-exe',
  url: 'https://img.uulucky.com/han/deepseek/DeepSeekDesktop-0.2.12-update-bootstrap.exe',
  sha256: 'b'.repeat(64),
  size: 2048,
};
assert.doesNotThrow(() => validateManifest({ version: '0.2.12' }, { ...target, bootstrap }));
assert.throws(() => validateManifest({ version: '0.2.12' }, {
  ...target, bootstrap: { ...bootstrap, url: 'https://example.com/bootstrap.exe' },
}), /未受信任/);

const script = updaterScript();
assert.match(script, /if \(\$Item\.Name -ieq 'data'\) \{ continue \}/);
assert.match(script, /Wait-Process -Id \$ParentPid/);
assert.match(script, /Start-Process -FilePath/);
assert.match(script, /data\\logs/);
assert.match(script, /restarted the existing application after failure/);

async function nativeHandoffContract() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsdesk-update-contract-'));
  const dataRoot = path.join(root, 'data');
  const bytes = Buffer.from('native bootstrap fixture');
  const direct = {
    format: 'bootstrap-exe',
    url: 'https://img.uulucky.com/han/deepseek/bootstrap-fixture.exe',
    size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
  let spawnCall;
  let quitCalls = 0;
  const updater = new PortableUpdater({
    currentVersion: '0.2.11',
    platform: 'win32',
    arch: 'x64',
    portable: true,
    appRoot: root,
    executable: path.join(root, 'DeepSeek Desktop.exe'),
    dataRoot,
    fetch: async () => new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } }),
    spawn(command, args, options) {
      const child = new EventEmitter();
      child.pid = 4242;
      child.exitCode = null;
      child.unref = () => {};
      spawnCall = { command, args, options };
      process.nextTick(() => {
        child.emit('spawn');
        const readyIndex = args.indexOf('--ready-file');
        fs.writeFileSync(args[readyIndex + 1], 'ready\n');
      });
      return child;
    },
    quit: () => { quitCalls += 1; },
  });
  updater.manifest = { version: '0.2.12' };
  updater.package = { ...target, bootstrap: direct };
  await updater.install();
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.match(spawnCall.command, /update-bootstrap\.exe$/);
  assert.equal(spawnCall.options.shell, false);
  assert.equal(spawnCall.options.windowsHide, false, 'native transition window must stay visible');
  assert.equal(spawnCall.args[spawnCall.args.indexOf('--app-root') + 1], root);
  assert.equal(spawnCall.args[spawnCall.args.indexOf('--exe-name') + 1], 'DeepSeek Desktop.exe');
  assert.equal(quitCalls, 1, 'app quits only after the bootstrap ready acknowledgement');
  assert.match(fs.readFileSync(path.join(dataRoot, 'logs', 'update-handoff.log'), 'utf8'), /bootstrap acknowledged pid=4242/);
  const neverReady = new EventEmitter();
  neverReady.exitCode = null;
  await assert.rejects(
    waitForReadyFile(path.join(dataRoot, 'update', 'never.ready'), neverReady, 30),
    /软件将保持打开/,
  );
  fs.rmSync(root, { recursive: true, force: true });
}

nativeHandoffContract().then(() => {
  console.log('PASS updater contracts — trusted manifests, acknowledged native handoff and data preservation');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
