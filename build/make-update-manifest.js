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
    '中文问题的行动摘要会在本地稳定显示为中文，模型偶尔输出英文时保留折叠原文供核对。',
    '网页版补全 Chrome 兼容标识，并按 Retry-After 倒计时、限次重试，避免 429 时连续刷新。',
    '网页版恢复会保留 Cookie 与站点存储；403 验证页和连接失败都可在客户端内继续处理。',
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
