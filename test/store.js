'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PortableUpdater } = require('../src/main/modules/updater');
const { manifest } = require('../build/store-stage');
const product = require('../build/store-product.json');
assert.match(manifest(), /runFullTrust/);
assert.match(manifest(), /packagedClassicApp/);
assert.ok(manifest().includes(`Name="${product.identityName}"`));
assert.ok(manifest().includes(`Publisher="${product.publisher}"`));
assert.match(product.packageVersion, /^\d+\.\d+\.\d+\.0$/);
const script = `Object.defineProperty(process,'platform',{value:'win32'}); process.windowsStore=true;
process.env.LOCALAPPDATA='C:/Users/Test/AppData/Local'; process.env.DEEPSEEK_DESKTOP_PORTABLE_ROOT='C:/portable'; delete process.env.DEEPSEEK_DESKTOP_HOME;
const assert=require('node:assert/strict'); const d=require('./src/main/modules/distribution'); const u=require('./src/main/modules/util');
assert.equal(d.isStoreBuild(),true); assert.equal(u.isPortable(),false); assert.equal(u.portableDataDir(),null);
assert.equal(u.dataRoot(),require('node:path').join(process.env.LOCALAPPDATA,'Packages',d.STORE_FAMILY,'LocalState','DeepSeek Desktop'));
delete process.windowsStore; assert.equal(d.isStoreBuild(),false); assert.equal(d.storeDataDir(),null);`;
const result = spawnSync(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);
(async () => {
  let opened;
  const updater = new PortableUpdater({ storeManaged: true, platform: 'win32', currentVersion: '0.3.5',
    portable: true, fetch: () => assert.fail('Store must never request external updates'),
    spawn: () => assert.fail('Store must never launch an EXE updater'), quit: () => assert.fail('Store must never quit for external updates'),
    openExternal: async url => { opened = url; },
  });
  assert.equal(updater.get().status, 'store');
  assert.equal((await updater.check({ manual: true })).status, 'store');
  await updater.install();
  assert.equal(opened, 'ms-windows-store://downloadsandupdates');
  assert.equal(updater.package, null);
  console.log('PASS Store identity, isolated writable data and no external updater');
})().catch(error => { console.error(error); process.exit(1); });
