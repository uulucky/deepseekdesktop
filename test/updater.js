'use strict';
/** Updater contracts: trusted manifests, native handoff acknowledgement and data preservation. */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { signManifest, verifySignedManifest } = require('../src/main/modules/update-trust');
const signing = crypto.generateKeyPairSync('ed25519');
const trustedKeys = { test: signing.publicKey.export({ format: 'pem', type: 'spki' }) };
const signed = (value) => signManifest(value, signing.privateKey, 'test');
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
    trustedKeys,
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
  updater.manifest = signed({ version: '0.2.12', platforms: { 'win32-x64': { ...target, bootstrap: direct } } });
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

async function signatureContract() {
  const good = signed({ version: '0.2.19', notes: ['signed'], platforms: { 'win32-x64': { ...target, bootstrap } } });
  verifySignedManifest(good, trustedKeys);
  for (const mutate of [
    (x) => { delete x.signature; },
    (x) => { x.signature.keyId = 'unknown'; },
    (x) => { x.version = '9.9.9'; },
    (x) => { x.platforms['win32-x64'].bootstrap.sha256 = 'c'.repeat(64); },
    (x) => { x.platforms['win32-x64'].bootstrap.url = 'https://img.uulucky.com/evil.exe'; },
    (x) => { x.notes = ['tampered']; },
  ]) {
    const value = structuredClone(good); mutate(value);
    assert.throws(() => verifySignedManifest(value, trustedKeys));
    let executed = false;
    const updater = new PortableUpdater({
      trustedKeys, currentVersion: '0.2.18',
      fetch: async () => new Response(JSON.stringify(value)),
      spawn: () => { executed = true; },
    });
    assert.equal((await updater.check()).status, 'error');
    assert.equal(updater.package, null);
    assert.equal(executed, false);
  }
  const valid = new PortableUpdater({ trustedKeys, currentVersion: '0.2.18', platform: 'win32', arch: 'x64', fetch: async () => new Response(JSON.stringify(good)) });
  assert.equal((await valid.check()).status, 'available');
  const replay = new PortableUpdater({ trustedKeys, currentVersion: '0.2.20', platform: 'win32', arch: 'x64', fetch: async () => new Response(JSON.stringify(good)) });
  assert.equal((await replay.check()).status, 'current');
  console.log('PASS signed updates — tampering, unknown keys, unsigned manifests and rollback rejected');
}

async function macManualContract() {
  for (const arch of ['arm64', 'x64']) {
    const dmg = { ...target, format: 'manual-dmg', url: `https://img.uulucky.com/han/deepseek/DeepSeekDesktop-0.2.25-mac-${arch}.dmg` };
    const manifest = signed({ version: '0.2.25', platforms: { [`darwin-${arch}`]: dmg, 'win32-x64': target } });
    let opened;
    const mac = new PortableUpdater({ platform: 'darwin', arch, currentVersion: '0.2.24', trustedKeys,
      fetch: async () => new Response(JSON.stringify(manifest)),
      openExternal: async url => { opened = url; },
      spawn: () => assert.fail('Mac must not launch the Windows updater'),
      quit: () => assert.fail('Manual download must not close the app'),
    });
    assert.equal(mac.get().manual, true);
    assert.equal((await mac.check()).status, 'available');
    await mac.install();
    assert.equal(opened, dmg.url);
    mac.manifest.platforms[`darwin-${arch}`].url = 'https://evil.test/app.dmg';
    await assert.rejects(mac.install(), /签名/);
    const wrong = new PortableUpdater({ platform: 'darwin', arch, currentVersion: '0.2.24', trustedKeys,
      fetch: async () => new Response(JSON.stringify(signed({ version: '0.2.25', platforms: { 'win32-x64': target } }))),
    });
    assert.equal((await wrong.check()).status, 'error', 'Never offer Windows or the other CPU package');
  }
  console.log('PASS signed Mac manual updates, CPU selection, no quit, no executable handoff');
}

signatureContract().then(nativeHandoffContract).then(macManualContract).then(() => {
  console.log('PASS updater contracts — trusted manifests, acknowledged native handoff and data preservation');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
