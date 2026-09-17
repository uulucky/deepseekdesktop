'use strict';
// Real Windows packaged-app smoke. No account login, payment or model prompts.
const { _electron: electron } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const version = require('../package.json').version;
const root = path.resolve(__dirname, '..');
const results = path.join(root, 'test-results');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dsdesk-packaged-'));
const target = path.join(temporary, 'application');
const archive = path.join(root, 'dist', `DeepSeekDesktop-${version}-portable.zip`);
const bootstrap = path.join(root, 'dist', `DeepSeekDesktop-${version}-update-bootstrap.exe`);
const exe = path.join(target, 'DeepSeek Desktop.exe');
const env = { ...process.env, DEEPSEEK_DESKTOP_PORTABLE_ROOT: target, DEEPSEEK_DESKTOP_PORT: '0' };
delete env.DEEPSEEK_API_KEY;
delete env.DEEPSEEK_DESKTOP_HOME;
delete env.DEEPSEEK_DESKTOP_DSH_BIN;
delete env.ELECTRON_RUN_AS_NODE;
let application;
function extract() {
  const result = spawnSync(bootstrap, ['--app-root', target, '--payload', archive, '--extract-only'], { encoding: 'utf8', timeout: 180000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert(fs.existsSync(exe));
}
async function launch() {
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
  return page;
}
async function main() {
  assert.equal(process.platform, 'win32', 'Run packaged smoke on Windows');
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
  assert.equal(await page.locator('#permission-slider').inputValue(), '0');
  await page.locator('#model-chip').click();
  await page.locator('#model-popover').waitFor({ state: 'visible' });
  await page.locator('#input').click();
  await page.locator('#model-popover').waitFor({ state: 'hidden' });
  await page.locator('#permission-slider').focus();
  await page.locator('#permission-slider').press('End');
  await page.locator('#permission-confirm-backdrop').waitFor({ state: 'visible' });
  await page.locator('#permission-confirm-cancel').click();
  assert.equal(await page.locator('#permission-slider').inputValue(), '0');
  await page.locator('#open-profile').click();
  await page.locator('#manual-key-input').fill('sk-ui-fixture-not-submitted');
  assert.equal(await page.locator('#manual-key-input').inputValue(), 'sk-ui-fixture-not-submitted');
  await page.locator('#modal-close').click();
  await page.screenshot({ path: path.join(results, 'packaged-windows.png') });
  await application.close(); application = null;
  extract(); // Real native updater replaces files but preserves a populated data folder.
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unchanged test data');
  page = await launch();
  assert.equal(await application.evaluate(({ app }) => app.getVersion()), version);
  assert.equal(await page.locator('#permission-slider').inputValue(), '0');
  await application.close(); application = null;
  console.log('PASS packaged Windows: native extraction, real startup, input, model popover, Full Access cancellation, restart and data preservation');
}
main().catch(async error => {
  console.error(error);
  const page = application?.windows().find(window => /index\.html/.test(window.url()));
  await page?.screenshot({ path: path.join(results, 'failure.png') }).catch(() => {});
  const logs = path.join(target, 'data/logs');
  if (fs.existsSync(logs)) fs.cpSync(logs, path.join(results, 'logs'), { recursive: true });
  process.exitCode = 1;
}).finally(async () => {
  await application?.close().catch(() => {});
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});
