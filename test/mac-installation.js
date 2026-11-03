'use strict';
// Actual Installer execution only on disposable GitHub-hosted Macs, never a developer Mac.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const { eventually } = require('./fixtures/model-server');
const { version } = require('../package.json');
assert.equal(process.platform, 'darwin');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
assert.equal(process.env.DEEPSEEK_DESKTOP_TEST_SYSTEM_INSTALL, '1');
const app = '/Applications/DeepSeek Desktop.app';
assert(!fs.existsSync(app), 'refuse to replace an existing non-fixture system app');
const pkg = path.resolve(__dirname, `../dist/DeepSeekDesktop-${version}-mac-${process.arch}.pkg`);
const binary = app + '/Contents/MacOS/DeepSeek Desktop';
const uid = Number(execFileSync('/usr/bin/stat', ['-f', '%u', '/dev/console'], { encoding: 'utf8' }).trim());
assert(uid >= 500, 'CI must have a console user to verify automatic launch');
function pids() {
  const found = spawnSync('/usr/bin/pgrep', ['-u', String(uid), '-f', '/Contents/MacOS/DeepSeek Desktop'], { encoding: 'utf8' }).stdout || '';
  return found.trim().split(/\s+/).filter(Boolean).filter(pid =>
    spawnSync('/bin/ps', ['-ww', '-p', pid, '-o', 'comm='], { encoding: 'utf8' }).stdout.trim() === binary).map(Number);
}
const install = () => execFileSync('/usr/bin/sudo', ['-n', '/usr/sbin/installer', '-pkg', pkg, '-target', '/'], { stdio: 'inherit', timeout: 240000 });
async function main() {
  install();
  await eventually(() => pids().length === 1, 'Installer did not launch the new app as the console user', 45000);
  const original = pids()[0];
  const home = execFileSync('/usr/bin/dscl', ['.', '-read', `/Users/${os.userInfo().username}`, 'NFSHomeDirectory'], { encoding: 'utf8' }).trim().replace(/^NFSHomeDirectory:\s*/, '');
  assert.equal(path.resolve(home), path.resolve(os.homedir()));
  const profiles = ['DeepSeek Desktop', 'deepseek-desktop'].map(name => path.join(home, 'Library/Application Support', name));
  await eventually(() => profiles.some(dir => fs.existsSync(path.join(dir, 'logs'))), 'Installed app did not initialize its normal user profile');
  const profile = profiles.find(dir => fs.existsSync(path.join(dir, 'logs')));
  const marker = path.join(profile, 'installer-retention-fixture.json');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(marker, '{"fixture":"preserve-login-and-history-storage"}\n');
  install();
  await eventually(() => pids().length === 1 && pids()[0] !== original, 'Upgrade failed to replace the old running instance', 45000);
  assert.equal(fs.readFileSync(marker, 'utf8'), '{"fixture":"preserve-login-and-history-storage"}\n');
  assert.equal(execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', app + '/Contents/Info.plist'], { encoding: 'utf8' }).trim(), version);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  for (const pid of pids()) process.kill(pid, 'SIGTERM');
  await eventually(() => pids().length === 0, 'Installed app did not exit normally', 30000);
  console.log('PASS actual Mac Installer: first install, close old instance, relaunch new version, retained profile marker, graceful TERM');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
