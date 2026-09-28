'use strict';
/** Build the public auto-update manifest for the portable Windows ZIP. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const fileName = `DeepSeekDesktop-${pkg.version}-update.zip`;
const archive = path.join(root, 'dist', fileName);
const bootstrapName = `DeepSeekDesktop-${pkg.version}-update-bootstrap.exe`;
const bootstrapFile = path.join(root, 'dist', bootstrapName);
if (!fs.existsSync(archive) || !fs.existsSync(bootstrapFile)) {
  console.error(`${fileName} not found — run npm run dist:portable first`);
  process.exit(1);
}
const bytes = fs.readFileSync(archive);
const bootstrapBytes = fs.readFileSync(bootstrapFile);
const manifest = {
  schemaVersion: 2,
  version: pkg.version,
  publishedAt: new Date().toISOString(),
  notes: [
    '修复 Windows 关闭客户端时账号子窗口聚焦已销毁的主窗口，引发主进程 JavaScript 错误弹窗。',
    '关闭阶段停止账号刷新，并保护窗口聚焦与后台状态推送，避免访问正在销毁的 WebContents。',
    'Windows、Apple 芯片与 Intel Mac 同版本构建；Mac 功能保持不变。',
    'Windows、Apple 芯片与 Intel Mac 同步发布；Mac 版未使用 Apple Developer ID 签名或公证，需按说明手动信任。',
  ],
  platforms: {
    'win32-x64': {
      format: 'portable-zip',
      url: `https://img.uulucky.com/han/deepseek/${fileName}`,
      manualUrl: `https://img.uulucky.com/han/deepseek/DeepSeekDesktop-${pkg.version}-portable.zip`,
      size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      bootstrap: {
        format: 'bootstrap-exe',
        url: `https://img.uulucky.com/han/deepseek/${bootstrapName}`,
        size: bootstrapBytes.length,
        sha256: crypto.createHash('sha256').update(bootstrapBytes).digest('hex'),
      },
    },
  },
};
// Never publish an unsigned descriptor as latest.json. A maintainer signs this file
// using the offline key after verifying the public workflow / release artifacts.
const target = path.join(root, 'dist', 'unsigned-update.json');
fs.writeFileSync(target, JSON.stringify(manifest, null, 2) + '\n');
console.log(`update manifest: ${target}`);
console.log(`sha256        : ${manifest.platforms['win32-x64'].sha256}`);
