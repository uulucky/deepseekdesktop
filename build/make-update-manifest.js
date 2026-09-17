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
  schemaVersion: 1,
  version: pkg.version,
  publishedAt: new Date().toISOString(),
  notes: [
    '修复部分电脑生成新 API Key 后，旧版 Harness 无法自动配置的问题，并增加安全兼容回退。',
    '客户端不再误用 3080 端口上残留的旧内核；配置失败时保留完整 Key，支持直接重试。',
    '新增 GitHub 源码与最新版下载入口，软件包内附个人非商业使用许可。',
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
const target = path.join(root, 'dist', 'latest.json');
fs.writeFileSync(target, JSON.stringify(manifest, null, 2) + '\n');
console.log(`update manifest: ${target}`);
console.log(`sha256        : ${manifest.platforms['win32-x64'].sha256}`);
