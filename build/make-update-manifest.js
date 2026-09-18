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
    '支持多任务：运行中可以新建并发送其他会话，后台回复持续接收。',
    '会话草稿、模型、权限和运行状态互相独立，停止只取消当前会话。',
    '侧栏显示运行中、待批准和未读完成状态，修复旧回复覆盖新会话、长任务误报结束。',
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
