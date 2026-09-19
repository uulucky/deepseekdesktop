'use strict';
// Native Windows and Mac packaged-app smoke. Model prompts go only to a loopback fixture.
const { _electron: electron } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { startModelServer } = require('./fixtures/model-server');
const { multitaskUi } = require('./fixtures/multitask-ui');
const { rendererRecovery } = require('./fixtures/renderer-recovery');
const { actionSummaryUi } = require('./fixtures/action-summary-ui');
const { spawnSync } = require('node:child_process');
const version = require('../package.json').version;
const root = path.resolve(__dirname, '..');
const results = path.join(root, 'test-results');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dsdesk-packaged-'));
const target = path.join(temporary, 'application');
const mac = process.platform === 'darwin';
const archive = path.join(root, 'dist', mac ? `DeepSeekDesktop-${version}-mac-${process.arch}.zip` : `DeepSeekDesktop-${version}-portable.zip`);
const bootstrap = path.join(root, 'dist', `DeepSeekDesktop-${version}-update-bootstrap.exe`);
const appBundle = path.join(target, 'DeepSeek Desktop.app');
const exe = mac ? path.join(appBundle, 'Contents/MacOS/DeepSeek Desktop') : path.join(target, 'DeepSeek Desktop.exe');
const dataRoot = mac ? path.join(temporary, 'profile') : path.join(target, 'data');
const env = { ...process.env };
delete env.DEEPSEEK_API_KEY;
delete env.DEEPSEEK_DESKTOP_HOME;
delete env.DEEPSEEK_DESKTOP_DSH_BIN;
delete env.DEEPSEEK_DESKTOP_NODE_BIN;
delete env.DEEPSEEK_DESKTOP_PORTABLE_ROOT;
delete env.DEEPSEEK_DESKTOP_PORTABLE;
delete env.ELECTRON_RUN_AS_NODE;
if (mac) env.DEEPSEEK_DESKTOP_HOME = dataRoot;
else env.DEEPSEEK_DESKTOP_PORTABLE_ROOT = target;
let application, provider;
let macExtractions = 0;
async function closeApplication({ allowForce = false } = {}) {
  if (!application) return;
  const current = application;
  const child = current.process();
  let stopped = false;
  let onExit;
  const exited = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else {
      onExit = resolve;
      child.once('exit', onExit);
    }
  });
  let timer;
  try {
    await Promise.race([
      current.evaluate(({ app, BrowserWindow }) => {
        // Exercise the same BrowserWindow path as a user clicking the main-window close button.
        // Its closed handler must then quit the hidden Harness windows and application process.
        const main = BrowserWindow.getAllWindows().find((win) => /\/index\.html$/.test(win.webContents.getURL()));
        if (!main) throw new Error('Main window not found while closing packaged app');
        setTimeout(() => { if (process.platform === 'darwin') app.quit(); else if (!main.isDestroyed()) main.close(); }, 100);
        return true;
      }).then(() => exited),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Electron app close timed out after 30 seconds')), 30_000);
      }),
    ]);
    stopped = true;
  } catch (error) {
    if (!allowForce) throw error;
    console.warn('Forcing test app exit after renderer recovery:', error.message);
    if (process.platform === 'win32' && child.pid) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true, encoding: 'utf8', timeout: 15_000,
      });
    } else {
      child.kill();
    }
    stopped = true;
  } finally {
    clearTimeout(timer);
    if (onExit) child.removeListener('exit', onExit);
    // Preserve the handle on a strict-close failure so main().finally can still terminate the
    // process tree and release fixture connections before the CI step reports the error.
    if (stopped) application = null;
  }
}
function extract() {
  if (mac) {
    // Simulate replacing only the app, never its separate profile directory.
    fs.rmSync(appBundle, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    let result;
    if (macExtractions++ === 0) {
      const mount = path.join(temporary, 'installer');
      fs.mkdirSync(mount);
      const dmg = archive.replace(/\.zip$/, '.dmg');
      const attached = spawnSync('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg], { encoding: 'utf8', timeout: 90000 });
      assert.equal(attached.status, 0, attached.stderr || attached.error?.message);
      try {
        assert.equal(fs.readlinkSync(path.join(mount, 'Applications')), '/Applications');
        result = spawnSync('ditto', [path.join(mount, 'DeepSeek Desktop.app'), appBundle], { encoding: 'utf8', timeout: 180000 });
      } finally {
        const detached = spawnSync('hdiutil', ['detach', mount], { encoding: 'utf8', timeout: 30000 });
        assert.equal(detached.status, 0, detached.stderr);
      }
    } else result = spawnSync('ditto', ['-x', '-k', archive, target], { encoding: 'utf8', timeout: 180000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert(fs.existsSync(exe));
    const signature = spawnSync('codesign', ['--verify', '--deep', '--strict', appBundle], { encoding: 'utf8', timeout: 90000 });
    assert.equal(signature.status, 0, signature.stderr || signature.error?.message);
    const resources = path.join(appBundle, 'Contents/Resources');
    const runtime = spawnSync(path.join(resources, 'vendor/node/bin/node'), ['-p', 'process.platform+"-"+process.arch'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(runtime.status, 0, runtime.stderr);
    assert.equal(runtime.stdout.trim(), `darwin-${process.arch}`);
    assert(!fs.existsSync(path.join(appBundle, 'Contents/MacOS/data')));
    return;
  }
  const result = spawnSync(bootstrap, ['--app-root', target, '--payload', archive, '--extract-only'], { encoding: 'utf8', timeout: 180000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert(fs.existsSync(exe));
}
async function launch() {
  const server = require('node:net').createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  env.DEEPSEEK_DESKTOP_PORT = String(server.address().port);
  await new Promise(resolve => server.close(resolve));
  application = await electron.launch({ executablePath: exe, env, timeout: 120000 });
  let page;
  for (let count = 0; count < 120; count += 1) {
    page = application.windows().find(window => /\/index\.html$/.test(window.url()));
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert(page, 'Packaged main window opens');
  page.setDefaultTimeout(30000);
  await page.locator('#input').waitFor();
  await page.waitForFunction(() => typeof App !== 'undefined' && App.ready === true);
  return page;
}

async function assertNoPackagedProcesses() {
  if (mac) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const result = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, 0);
      if (!result.stdout.split('\n').some(line => line.includes(target + path.sep))) {
        console.log('PASS no packaged Mac or Harness processes remain'); return;
      }
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    assert.fail('A process from the isolated Mac fixture survived normal application exit');
  }
  // Electron's main-process exit alone must not hide a leftover Harness/renderer.
  // Query only executables from this unique fixture directory, never user processes.
  const prefix = (target + path.sep).replace(/'/g, "''");
  const script = `$prefix = '${prefix}'; @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) } | Select-Object ProcessId, Name, ExecutablePath) | ConvertTo-Json -Compress`;
  let remaining = '';
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 20_000, windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    remaining = result.stdout.trim();
    if (!remaining || remaining === '[]') {
      console.log('PASS no packaged Electron, renderer, updater or Harness processes remain');
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  assert.fail(`Packaged processes survived normal application exit: ${remaining}`);
}
async function main() {
  assert(['win32', 'darwin'].includes(process.platform), 'Run packaged smoke natively on Windows or Mac');
  provider = await startModelServer();
  env.DEEPSEEK_BASE_URL = provider.baseUrl;
  env.DEEPSEEK_API_KEY = 'sk-local-ui-fixture-not-a-real-key';
  fs.mkdirSync(results, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  const sentinel = path.join(dataRoot, 'preserve-test.txt');
  fs.writeFileSync(sentinel, 'unchanged test data');
  extract();
  let page = await launch();
  assert.equal(await application.evaluate(({ app }) => app.getVersion()), version);
  if (mac) {
    assert.equal(await page.evaluate(() => state.world.portable), false);
    assert.equal(await page.evaluate(() => state.update.manual), true);
    assert.equal(await application.evaluate(({ app }) => app.getPath('userData')), path.join(dataRoot, 'chromium'));
    await application.evaluate(async ({ session, Menu }) => {
      if (!Menu.getApplicationMenu()) throw new Error('Mac native edit/quit menu missing');
      const partition = session.fromPartition('persist:deepseek-platform');
      await partition.cookies.set({ url: 'https://fixture.invalid', name: 'retention-test', value: 'fixture-only', expirationDate: Date.now() / 1000 + 3600 });
      await partition.cookies.flushStore();
    });
  }
  await page.locator('#input').fill('本地输入测试，不发送');
  assert.equal(await page.locator('#input').inputValue(), '本地输入测试，不发送');
  await page.locator('#input').fill('');
  assert.equal(await page.locator('#permission-slider').inputValue(), '2');
  await page.locator('#permission-warning').waitFor({ state: 'visible' });
  await page.locator('#model-chip').click();
  await page.locator('#model-popover').waitFor({ state: 'visible' });
  await page.locator('#input').click();
  await page.locator('#model-popover').waitFor({ state: 'hidden' });
  await page.locator('#permission-slider').focus();
  await page.locator('#permission-slider').press('Home');
  await page.locator('#permission-warning').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => !document.querySelector('#permission-slider').disabled);
  assert.equal(await page.locator('#permission-slider').inputValue(), '0');
  await page.locator('#permission-slider').press('End');
  await page.locator('#permission-warning').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('#permission-slider').disabled);
  assert.equal(await page.locator('#permission-slider').inputValue(), '2');
  assert.equal(await page.locator('[role="alertdialog"]').count(), 0, 'Reminder does not block the composer');
  await page.evaluate(() => App.newSession());
  const fullSession = await page.evaluate(() => state.activeSessionId);
  assert.equal(await page.evaluate(id => api.sessions.permissions(id).then(value => value.currentValue), fullSession), 'danger-full-access');
  await page.locator('#open-profile').click();
  await page.locator('#manual-key-input').fill('sk-ui-fixture-not-submitted');
  assert.equal(await page.locator('#manual-key-input').inputValue(), 'sk-ui-fixture-not-submitted');
  await page.locator('#modal-close').click();
  await page.screenshot({ path: path.join(results, 'packaged-windows.png') });
  await multitaskUi(page, provider);
  await page.screenshot({ path: path.join(results, 'packaged-multitask.png') });
  await actionSummaryUi(page, provider);
  await page.screenshot({ path: path.join(results, 'packaged-action-summary.png') });
  await closeApplication();
  extract(); // Real native updater replaces files but preserves a populated data folder.
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unchanged test data');
  page = await launch();
  if (mac) assert.equal(await application.evaluate(async ({ session }) =>
    (await session.fromPartition('persist:deepseek-platform').cookies.get({ name: 'retention-test' }))[0]?.value), 'fixture-only', 'Persisted partition cookies survive app replacement');
  assert.equal(await application.evaluate(({ app }) => app.getVersion()), version);
  await page.evaluate(id => App.openSession(id), fullSession);
  assert.equal(await page.locator('#permission-slider').inputValue(), '2');
  await page.locator('#permission-warning').waitFor({ state: 'visible' });
  // A saved lower permission must survive both creating a session and restarting.
  await page.locator('#permission-slider').focus();
  await page.locator('#permission-slider').press('Home');
  await page.locator('#permission-warning').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => !document.querySelector('#permission-slider').disabled);
  await page.evaluate(() => App.newSession());
  const readOnlySession = await page.evaluate(() => state.activeSessionId);
  assert.equal(await page.evaluate(() => api.sessions.permissions(state.activeSessionId).then(value => value.currentValue)), 'read-only');
  await page.evaluate(id => api.sessions.rename(id, 'Read-only restart fixture'), readOnlySession);
  // Harness persists on a tick. A just-created empty session can otherwise disappear.
  await page.waitForTimeout(1200);
  await closeApplication();
  page = await launch();
  assert.equal(await page.evaluate(() => state.ui.defaultPermission), 'read-only');
  await page.evaluate(id => App.openSession(id), readOnlySession);
  assert.equal(await page.locator('#permission-slider').inputValue(), '0');
  await page.locator('#permission-warning').waitFor({ state: 'hidden' });
  console.log('Starting final packaged renderer crash recovery check');
  page = await rendererRecovery(application, page, provider);
  await page.screenshot({ path: path.join(results, 'packaged-renderer-recovered.png') });
  console.log('PASS packaged renderer crash recovery returned to the selected conversation');
  await closeApplication();
  await assertNoPackagedProcesses();
  console.log(`PASS packaged ${process.platform}-${process.arch}: extraction, startup, input, model popover, Full Access default/reminder, kernel permissions, renderer crash recovery, restart, saved lower preferences and data preservation`);
}
main().catch(async error => {
  console.error(error);
  if (process.env.GITHUB_ACTIONS) {
    const annotation = String(error.stack || error).slice(0, 6000).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    console.log(`::error title=Packaged Windows smoke::${annotation}`);
  }
  const page = application?.windows().find(window => /index\.html/.test(window.url()));
  const logs = path.join(dataRoot, 'logs');
  if (fs.existsSync(logs)) fs.cpSync(logs, path.join(results, 'logs'), { recursive: true });
  await page?.screenshot({ path: path.join(results, 'failure.png'), timeout: 5000 }).catch(() => {});
  process.exitCode = 1;
}).finally(async () => {
  await closeApplication({ allowForce: true }).catch(() => {});
  await provider?.close();
  try {
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
  } catch (error) {
    // Windows sandbox/runner ACLs can deny deletion after every app process has exited.
    // This is disposable runner housekeeping, not a functional assertion. GitHub destroys
    // the hosted runner. Never weaken normal-exit, orphan-process or data-preservation checks.
    if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error.code)) throw error;
    console.warn(`Test-only directory cleanup deferred to hosted runner disposal (${error.code})`);
  }
}).catch(error => {
  // Cleanup failures previously escaped main().catch, leaving only an exit code in
  // public annotations. Keep the exact failure visible without weakening the gate.
  console.error('Packaged test cleanup failed:', error);
  if (process.env.GITHUB_ACTIONS) {
    const annotation = String(error.stack || error).slice(0, 6000).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    console.log(`::error title=Packaged cleanup::${annotation}`);
  }
  process.exitCode = 1;
});
