'use strict';
// Native Harness plugin: before a shell or file-read tool runs, recognise a small set of
// destructive or secret-reading commands and ask the human through the desktop's inline
// question card. It never changes the permission preset: Full Access stays Full Access, and
// everything that is not on this short list runs exactly as before. No dependencies; copied
// outside app.asar for the bundled Node process like desktop-presentation.cjs.
const fs = require('node:fs');

const HOME = String.raw`(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE)`;
// A target that wipes a whole system, home or drive rather than a project folder.
const BROAD_TARGET = String.raw`(?:\/|\/\*|${HOME}\/?\*?|\.\.?\/?\*?|\*|\/(?:Users|home|System|Library|Applications|usr|etc|var|bin|sbin|opt|private)\/?\*?|[A-Za-z]:\\?\*?|[A-Za-z]:\\(?:Windows|Users|Program Files[^"']*)\\?\*?)`;
const END = String.raw`(?=\s*(?:$|[;&|)]|\s))`;

const RULES = [
  { id: 'rm-broad', tools: ['bash'], reason: '会递归删除系统目录、用户主目录或当前目录下的全部内容',
    test: new RegExp(String.raw`\brm\s+(?:-[A-Za-z]*\s+)*-(?:[A-Za-z]*r[A-Za-z]*f|[A-Za-z]*f[A-Za-z]*r)[A-Za-z]*\s+(?:-[A-Za-z-]+\s+)*["']?${BROAD_TARGET}["']?${END}`, 'i') },
  { id: 'rm-broad-split', tools: ['bash'], reason: '会递归删除系统目录、用户主目录或当前目录下的全部内容',
    test: new RegExp(String.raw`\brm\s+(?:-[A-Za-z]*r[A-Za-z]*\s+-[A-Za-z]*f[A-Za-z]*|-[A-Za-z]*f[A-Za-z]*\s+-[A-Za-z]*r[A-Za-z]*|--recursive\s+--force|--force\s+--recursive)\s+["']?${BROAD_TARGET}["']?${END}`, 'i') },
  { id: 'git-reset-hard', tools: ['bash', 'pwsh'], reason: '会丢弃所有未提交的修改', test: /\bgit\s+(?:-C\s+\S+\s+)?reset\s+(?:\S+\s+)*--hard\b/ },
  { id: 'git-clean', tools: ['bash', 'pwsh'], reason: '会永久删除未被 Git 跟踪的文件', test: /\bgit\s+(?:-C\s+\S+\s+)?clean\s+(?:-\w*\s+)*-\w*f/ },
  { id: 'git-discard', tools: ['bash', 'pwsh'], reason: '会丢弃工作区里的全部修改', test: /\bgit\s+(?:-C\s+\S+\s+)?(?:checkout\s+--\s+\.|restore\s+(?:--worktree\s+)?\.)(?=\s*(?:$|[;&|]))/ },
  { id: 'git-force-push', tools: ['bash', 'pwsh'], reason: '会强制覆盖远程分支的历史', test: /\bgit\s+(?:-C\s+\S+\s+)?push\s+(?:\S+\s+)*(?:--force(?!-with-lease)\b|-f\b)/ },
  { id: 'disk-wipe', tools: ['bash', 'pwsh'], reason: '会格式化或直接写入磁盘设备',
    test: /\b(?:mkfs(?:\.\w+)?\s|dd\s+[^|;&]*\bof=\/dev\/|diskutil\s+(?:eraseDisk|eraseVolume|zeroDisk|secureErase|partitionDisk)\b|Format-Volume\b|Clear-Disk\b|format\s+[A-Za-z]:)/i },
  { id: 'fork-bomb', tools: ['bash'], reason: '会无限创建进程拖垮系统', test: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/ },
  { id: 'chmod-root', tools: ['bash'], reason: '会递归修改系统或主目录的权限/属主',
    test: new RegExp(String.raw`\b(?:chmod|chown)\s+(?:-\w+\s+)*-R\w*\s+\S+\s+["']?${BROAD_TARGET}["']?${END}`, 'i') },
  { id: 'pipe-to-shell', tools: ['bash', 'pwsh'], reason: '会下载远程脚本并直接执行',
    test: /\b(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b|\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|;]*\|\s*(?:iex|Invoke-Expression)\b/i },
  { id: 'pwsh-remove-broad', tools: ['pwsh', 'bash'], reason: '会递归删除系统目录、用户主目录或整个磁盘',
    test: new RegExp(String.raw`\b(?:Remove-Item|rm|ri|del|rd|rmdir)\b(?=[^;|]*-(?:Recurse|r)\b)[^;|]*?\s["']?(?:${BROAD_TARGET}|\$HOME|~)["']?${END}`, 'i') },
  { id: 'cmd-remove-broad', tools: ['pwsh', 'bash'], reason: '会递归删除整个磁盘或系统目录',
    test: /\b(?:rd|rmdir|del)\s+(?:\/[sq]\s+)+["']?[A-Za-z]:\\?(?:Windows|Users)?\\?["']?(?=\s*(?:$|[;&|]))/i },
  { id: 'shadow-copies', tools: ['pwsh', 'bash'], reason: '会删除系统还原点/卷影副本', test: /\bvssadmin\s+delete\s+shadows\b|\bwmic\s+shadowcopy\s+delete\b/i },
  { id: 'registry-machine', tools: ['pwsh', 'bash'], reason: '会删除系统级注册表项', test: /\breg\s+delete\s+HK(?:LM|EY_LOCAL_MACHINE)\\|Remove-Item\s+(?:-Path\s+)?["']?HKLM:/i },
  { id: 'shutdown', tools: ['bash', 'pwsh'], reason: '会关机或重启电脑', test: /(?:^|[;&|]\s*|\bsudo\s+)(?:shutdown|reboot|halt|poweroff)\b|\b(?:Stop-Computer|Restart-Computer)\b/i },
  { id: 'secret-keychain', tools: ['bash'], reason: '会读取钥匙串中保存的密码', test: /\bsecurity\s+find-(?:generic|internet)-password\b[^;|&]*\s-w\b/ },
];

// Credential files are worth a confirmation whichever tool touches them.
const SECRET_PATH = /(?:^|[\s"'=/\\])(?:\.ssh[\\/](?:id_[A-Za-z0-9_]+|[^\s"'\\/]*\.pem)(?!\.pub)\b|\.aws[\\/]credentials\b|\.kube[\\/]config\b|\.docker[\\/]config\.json\b|\.netrc\b|\.git-credentials\b|\.credentials\.yaml\b|\.config[\\/]gcloud[\\/](?:credentials\.db|application_default_credentials\.json)\b|Login Data\b|key4\.db\b|logins\.json\b)/i;

/** Tool family the rules are written for, or null for tools this guard ignores. */
function family(toolName) {
  if (toolName === 'bash') return 'bash';
  if (toolName === 'pwsh' || toolName === 'powershell') return 'pwsh';
  if (toolName === 'read' || toolName === 'read_image' || toolName === 'grep') return 'read';
  return null;
}

/** First matching risk for a tool call, or null. Exported for the contract test. */
function classify(toolName, args) {
  const kind = family(toolName);
  if (!kind || !args || typeof args !== 'object') return null;
  if (kind === 'read') {
    const target = String(args.path ?? args.file_path ?? args.file ?? '');
    return SECRET_PATH.test(target) ? { id: 'secret-file', reason: '会读取密钥或登录凭据文件', subject: target } : null;
  }
  const command = String(args.command ?? args.script ?? '');
  if (!command) return null;
  for (const rule of RULES) {
    if (rule.tools.includes(kind) && rule.test.test(command)) return { id: rule.id, reason: rule.reason, subject: command };
  }
  if (SECRET_PATH.test(command)) return { id: 'secret-file', reason: '会读取密钥或登录凭据文件', subject: command };
  return null;
}

function excerpt(text) {
  const oneLine = String(text).replace(/\s+/g, ' ').trim();
  return oneLine.length > 240 ? `${oneLine.slice(0, 237)}…` : oneLine;
}

/** The guard is on unless the desktop's settings file explicitly turns it off. */
function enabled(settingsFile) {
  if (!settingsFile) return true;
  try {
    return JSON.parse(fs.readFileSync(settingsFile, 'utf8'))?.enabled !== false;
  } catch {
    return true;
  }
}

const ALLOW = '允许这一次';
const DENY = '不允许';

exports.name = 'desktop-safety-guard';
exports.classify = classify;
exports.apply = (ctx, config = {}) => {
  ctx.on('tools/pre-execute', async (exec, next) => {
    const risk = enabled(config.settingsFile) ? classify(exec.name, exec.arguments) : null;
    if (!risk) return next();
    const denied = (why) => ({
      kind: 'deny',
      reason: `DeepSeek Desktop safety guard blocked this ${exec.name} call: ${why}. Do not retry it or work around it with another command; explain the risk to the user and let them run it themselves if they really want it.`,
    });
    const questions = ctx.get('userQuestions');
    if (!questions || !exec.agent) return denied(`${risk.reason} (no human confirmation available)`);
    try {
      const answer = await questions.ask({
        agent: exec.agent,
        signal: exec.signal,
        questions: [{
          id: 'desktop-safety-guard',
          header: '高风险操作确认',
          question: `DeepSeek 想执行一个高风险操作：${risk.reason}。\n\n${excerpt(risk.subject)}\n\n允许执行吗？（可在 设置 → 通用 → 安全护栏 中关闭此确认）`,
          options: [
            { label: ALLOW, description: '只放行这一条命令' },
            { label: DENY, description: '拦下这条命令，让 DeepSeek 换个做法' },
          ],
        }],
      });
      const selected = answer?.answers?.[0]?.selected ?? [];
      if (selected.includes(ALLOW)) return next();
      return denied(`the user declined: ${risk.reason}`);
    } catch (error) {
      return denied(`${risk.reason} (confirmation unavailable: ${error?.code ?? error?.message ?? 'unknown'})`);
    }
  });
};
