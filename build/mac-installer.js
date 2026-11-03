'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
function distribution(version, arch, component) {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert(['arm64', 'x64'].includes(arch));
  assert.match(component, /^[a-zA-Z0-9.-]+\.pkg$/);
  return `<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
<title>DeepSeek Desktop ${version}</title>
<organization>com.deepseek.desktop</organization>
<options customize="never" require-scripts="true" hostArchitectures="${arch === 'x64' ? 'x86_64' : 'arm64'}"/>
<domains enable_localSystem="true" enable_currentUserHome="false" enable_anywhere="false"/>
<welcome file="Welcome.html" mime-type="text/html"/>
<readme file="Readme.html" mime-type="text/html"/>
<choices-outline><line choice="default"/></choices-outline>
<choice id="default" visible="false"><pkg-ref id="com.deepseek.desktop.pkg"/></choice>
<pkg-ref id="com.deepseek.desktop.pkg" version="${version}" onConclusion="none">${component}</pkg-ref>
</installer-gui-script>\n`;
}
function makeMacInstaller({ app, arch, version, dist }) {
  assert.equal(process.platform, 'darwin');
  distribution(version, arch, 'application.pkg');
  assert(path.isAbsolute(app) && path.isAbsolute(dist));
  const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' });
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsdesk-installer-'));
  try {
    const stage = path.join(tmp, 'root');
    const scripts = path.join(tmp, 'scripts');
    const resources = path.join(tmp, 'resources');
    const image = path.join(tmp, 'image');
    for (const dir of [stage, scripts, resources, image]) fs.mkdirSync(dir);
    fs.mkdirSync(path.join(stage, 'Applications'));
    run('/usr/bin/ditto', [app, path.join(stage, 'Applications/DeepSeek Desktop.app')]);
    for (const name of ['preinstall', 'postinstall']) {
      const body = fs.readFileSync(path.join(__dirname, 'mac-installer', name), 'utf8')
        .replaceAll('@ARCH@', arch === 'x64' ? 'x86_64' : 'arm64').replaceAll('@VERSION@', version);
      fs.writeFileSync(path.join(scripts, name), body, { mode: 0o755 });
    }
    const componentPlist = path.join(tmp, 'components.plist');
    fs.writeFileSync(componentPlist, JSON.stringify([{ RootRelativeBundlePath: 'Applications/DeepSeek Desktop.app',
      BundleIsRelocatable: false, BundleIsVersionChecked: true, BundleHasStrictIdentifier: true, BundleOverwriteAction: 'upgrade' }]));
    run('/usr/bin/plutil', ['-convert', 'xml1', componentPlist]);
    run('/usr/bin/pkgbuild', ['--root', stage, '--component-plist', componentPlist, '--scripts', scripts, '--install-location', '/',
      '--identifier', 'com.deepseek.desktop.pkg', '--version', version, '--ownership', 'recommended', path.join(tmp, 'application.pkg')]);
    fs.writeFileSync(path.join(resources, 'Welcome.html'), `<html lang="zh-CN"><meta charset="utf-8"><body style="font:16px -apple-system;padding:20px"><h1>安装 DeepSeek Desktop ${version}</h1><p>按照步骤安装到“应用程序”。安装时会关闭当前用户正在运行的旧版，完成后启动新版。</p><p>请先保存任务中的文件。登录状态、本地对话和设置会保留。</p></body></html>`);
    fs.writeFileSync(path.join(resources, 'Readme.html'), '<html lang="zh-CN"><meta charset="utf-8"><body style="font:16px -apple-system;padding:20px"><h2>更新说明</h2><p>应用替换到 /Applications/DeepSeek Desktop.app。不会删除用户目录中的对话、登录和配置，也不会安装后台系统服务。</p><p>个人非商业免费，公司及工作用途需授权。当前没有 Developer ID 签名或 Apple 公证；请只从官方发布页下载并核对哈希。</p><p>如旧版不能正常关闭，安装将停止，请手动退出后重试。无人登录时安装完成后请自行启动应用。</p></body></html>');
    fs.writeFileSync(path.join(tmp, 'Distribution.xml'), distribution(version, arch, 'application.pkg'));
    const name = `DeepSeekDesktop-${version}-mac-${arch}`;
    const pkg = path.join(dist, name + '.pkg');
    run('/usr/bin/productbuild', ['--distribution', path.join(tmp, 'Distribution.xml'), '--resources', resources,
      '--package-path', tmp, pkg]);
    fs.copyFileSync(pkg, path.join(image, '安装 DeepSeek Desktop.pkg'));
    fs.writeFileSync(path.join(image, '安装说明.txt'), `DeepSeek Desktop ${version}\n双击“安装 DeepSeek Desktop.pkg”，按照步骤完成安装。旧版会关闭，新版会在安装后启动。对话、登录和配置保留。\n此安装包未获 Apple 公证。请从可信发布页下载，并由你确认信任。\n`);
    run('/usr/bin/hdiutil', ['create', '-volname', `DeepSeek Desktop ${version}`, '-srcfolder', image,
      '-format', 'UDZO', '-ov', path.join(dist, name + '.dmg')]);
    return pkg;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
module.exports = { distribution, makeMacInstaller };
