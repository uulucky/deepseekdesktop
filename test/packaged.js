'use strict';
// Real Windows packaged-app smoke. Model prompts go only to a loopback SSE fixture.
const { _electron: electron } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { startModelServer } = require('./fixtures/model-server');
const { multitaskUi } = require('./fixtures/multitask-ui');
const { rendererRecovery } = require('./fixtures/renderer-recovery');
const { spawnSync } = require('node:child_process');
const version = require('../package.json').version;
const root = path.resolve(__dirname, '..');
const results = path.join(root, 'test-results');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dsdesk-packaged-'));
const target = path.join(temporary, 'application');
const archive = path.join(root, 'dist', `DeepSeekDesktop-${version}-portable.zip`);
const bootstrap = path.join(root, 'dist', `DeepSeekDesktop-${version}-update-bootstrap.exe`);
const exe = path.join(target, 'DeepSeek Desktop.exe');
const env = { ...process.env, DEEPSEEK_DESKTOP_PORTABLE_ROOT: target };
delete env.DEEPSEEK_API_KEY;
delete env.DEEPSEEK_DESKTOP_HOME;
delete env.DEEPSEEK_DESKTOP_DSH_BIN;
delete env.ELECTRON_RUN_AS_NODE;
let application, provider;
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
      current.evaluate(({ BrowserWindow }) => {
        // Exercise the same BrowserWindow path as a user clicking the main-window close button.
        // Its closed handler must then quit the hidden Harness windows and application process.
        const main = BrowserWindow.getAllWindows().find((win) => /\/index\.html$/.test(win.webContents.getURL()));
        if (!main) throw new Error('Main window not found while closing packaged app');
        setTimeout(() => { if (!main.isDestroyed()) main.close(); }, 100);
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
async function main() {
  assert.equal(process.platform, 'win32', 'Run packaged smoke on Windows');
  provider = await startModelServer();
  env.DEEPSEEK_BASE_URL = provider.baseUrl;
  env.DEEPSEEK_API_KEY = 'sk-local-ui-fixture-not-a-real-key';
  fs.mkdirSync(results, { recursive: true });
  fs.mkdirSync(path.join(target, 'data'), { recursive: true });
  const sentinel = path.join(target, 'data', 'preserve-test.txt');
  fs.writeFileSync(sentinel, 'unchanged test data');
  extract();
  let page = await launch();
  assert.equal(await application.evaluate(({ app }) => app.getVersion()), version);
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
  await closeApplication();
  extract(); // Real native updater replaces files but preserves a populated data folder.
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unchanged test data');
  page = await launch();
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
  console.log('PASS packaged Windows: extraction, startup, input, model popover, Full Access default/reminder, kernel permissions, renderer crash recovery, restart, saved lower preferences and data preservation');
}
main().catch(async error => {
  console.error(error);
  if (process.env.GITHUB_ACTIONS) {
    const annotation = String(error.stack || error).slice(0, 6000).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    console.log(`::error title=Packaged Windows smoke::${annotation}`);
  }
  const page = application?.windows().find(window => /index\.html/.test(window.url()));
  const logs = path.join(target, 'data/logs');
  if (fs.existsSync(logs)) fs.cpSync(logs, path.join(results, 'logs'), { recursive: true });
  await page?.screenshot({ path: path.join(results, 'failure.png'), timeout: 5000 }).catch(() => {});
  process.exitCode = 1;
}).finally(async () => {
  await closeApplication({ allowForce: true }).catch(() => {});
  await provider?.close();
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});
