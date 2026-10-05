'use strict';
/** Convert the verified portable release, retaining its pinned native runtimes. */
const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');
const product = require('./store-product.json');
const root = path.resolve(__dirname, '..');
const xml = value => String(value).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
function manifest() {
  return `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10" xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10" xmlns:uap10="http://schemas.microsoft.com/appx/manifest/uap/windows10/10" xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities" IgnorableNamespaces="uap uap10 rescap">
  <Identity Name="${xml(product.identityName)}" Publisher="${xml(product.publisher)}" Version="${xml(product.packageVersion)}" ProcessorArchitecture="x64"/>
  <Properties><DisplayName>${xml(product.displayName)}</DisplayName><PublisherDisplayName>${xml(product.publisherDisplayName)}</PublisherDisplayName><Logo>Assets\\StoreLogo.png</Logo><Description>第三方 DeepSeek 桌面客户端：本地工作台、官方网页、余额与权限控制</Description></Properties>
  <Resources><Resource Language="zh-cn"/><Resource Language="en-us"/></Resources>
  <Dependencies><TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.26100.0"/></Dependencies>
  <Applications><Application Id="DeepSeekDesktop" Executable="app\\DeepSeek Desktop.exe" uap10:RuntimeBehavior="packagedClassicApp" uap10:TrustLevel="mediumIL">
    <uap:VisualElements DisplayName="${xml(product.displayName)}" Description="第三方 DeepSeek 客户端，非 DeepSeek 官方产品" BackgroundColor="transparent" Square150x150Logo="Assets\\Square150x150Logo.png" Square44x44Logo="Assets\\Square44x44Logo.png"/>
  </Application></Applications>
  <Capabilities><rescap:Capability Name="runFullTrust"/></Capabilities>
</Package>\n`;
}
async function stage(input, output, sourceCommit) {
  input = path.resolve(input); output = path.resolve(output);
  if (fs.existsSync(output)) throw new Error('Staging must be a fresh directory');
  if (!/^[a-f0-9]{40}$/.test(sourceCommit || '')) throw new Error('Exact source commit is required');
  const base = JSON.parse(fs.readFileSync(path.join(input, 'build-info.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (base.version !== product.baseVersion || base.sourceCommit !== product.baseSourceCommit || pkg.version !== product.baseVersion) throw new Error('Unexpected portable base/source version');
  fs.mkdirSync(output, { recursive: true });
  const appDir = path.join(output, 'app');
  const excluded = new Set(['data', 'portable.flag', 'Run-DeepSeek.cmd', 'README-portable.txt']);
  fs.cpSync(input, appDir, { recursive: true, filter: src => !excluded.has(path.relative(input, src).split(path.sep)[0]) });
  const scratch = path.join(path.dirname(output), 'asar-scratch');
  if (fs.existsSync(scratch)) throw new Error('ASAR scratch must be a fresh directory');
  const archive = path.join(appDir, 'resources', 'app.asar');
  asar.extractAll(archive, scratch);
  for (const file of ['src', 'package.json', 'LICENSE', 'PRIVACY.md', 'NETWORK.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md']) fs.cpSync(path.join(root, file), path.join(scratch, file), { recursive: true });
  await asar.createPackage(scratch, archive);
  fs.writeFileSync(path.join(output, 'AppxManifest.xml'), manifest(), 'utf8');
  fs.writeFileSync(path.join(appDir, 'build-info.json'), JSON.stringify({ ...base,
    distribution: 'microsoft-store', packageVersion: product.packageVersion, sourceCommit,
    baseSourceCommit: base.sourceCommit, basePortableSha256: product.basePortableSha256,
    convertedAt: new Date().toISOString(), signing: 'Store signs submitted MSIX; local test signature is separate',
  }, null, 2) + '\n');
  console.log(`Store staging complete: ${output}`);
}
if (require.main === module) stage(...process.argv.slice(2)).catch(error => { console.error(error); process.exit(1); });
module.exports = { manifest, stage };
