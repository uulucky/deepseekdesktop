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
    '安全护栏：Full Access 下少数高风险命令（破坏性删除、丢弃 Git 修改、强制推送、格式化、远程脚本、读取密钥）先确认再执行。',
    '设置新增“扩展”：复用 Claude/Codex 本机技能、添加 MCP 服务器，并可安装实测通过的免费多引擎联网搜索插件。',
    '只支持文字的模型收到图片时用系统文字识别在本机提取文字；自动找到 ffmpeg/ffprobe；新的胖鲸启动动画。',
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
