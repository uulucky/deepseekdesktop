'use strict';
const assert = require('node:assert/strict');
const { eventually } = require('./model-server');

// Runs against a loopback website in the real sandboxed WebContentsView. No official traffic.
async function webRecoveryUi(page, application, provider) {
  const remote = async expression => application.evaluate(async ({ webContents }, code) => {
    const view = webContents.getAllWebContents().find(item => !item.isDestroyed() && item.getURL().includes('/web-fixture'));
    return view?.executeJavaScript(code);
  }, expression);
  await page.locator('#surface-web').click();
  await page.waitForFunction(() => state.webSurface.status === 'ready');
  await eventually(() => remote('window.fixtureIdentity'), 'Official fixture mounts');
  const identity = await remote('window.fixtureIdentity');
  await remote('localStorage.setItem("web-login-fixture", "preserved")');
  assert.doesNotMatch(await remote('navigator.userAgent'), /Electron\/|deepseek-?desktop\//i);

  provider.webResponses.push({ status: 429, retryAfter: '3' }, { status: 200 });
  const before = provider.webRequests.length;
  await page.locator('#surface-reload').click();
  await page.locator('#surface-fallback').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#surface-fallback-retry').isDisabled(), true);
  assert.equal(await page.locator('#surface-reload').isDisabled(), true);
  assert.equal(await page.locator('#surface-fallback-browser').count(), 0);
  // Even a direct IPC call cannot accidentally issue an early duplicate request.
  await page.evaluate(() => api.surface.reload());
  assert.equal(provider.webRequests.length, before + 1);
  await page.waitForFunction(() => state.webSurface.status === 'ready', { timeout: 15000 });
  await page.locator('#surface-fallback').waitFor({ state: 'hidden' });
  assert.equal(provider.webRequests.length, before + 2);
  assert(provider.webRequests[before + 1].time - provider.webRequests[before].time >= 2900);
  await eventually(async () => await remote('window.fixtureIdentity') === identity, 'Recovery preserves the live page session');
  assert.equal(await remote('localStorage.getItem("web-login-fixture")'), 'preserved');

  provider.webResponses.push({ status: 429, retryAfter: '1' }, { status: 429, retryAfter: '1' });
  await page.locator('#surface-reload').click();
  await page.waitForFunction(() => state.webSurface.status === 'blocked' && !state.webSurface.autoRetry);
  const refused = provider.webRequests.length;
  await page.waitForTimeout(1500);
  assert.equal(provider.webRequests.length, refused, 'Second refusal cannot start a refresh loop');
  await page.locator('#surface-fallback-retry').click();
  await page.waitForFunction(() => state.webSurface.status === 'ready');

  provider.webResponses.push({ status: 403 });
  await page.locator('#surface-reload').click();
  await page.waitForFunction(() => state.webSurface.status === 'verification');
  assert.equal(await page.locator('#surface-fallback').isVisible(), false);
  assert.equal(await remote('!!document.getElementById("verify")'), true);
  const visible = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
    .find(win => win.webContents.getURL().endsWith('/index.html'))?.contentView.children.some(view => view.getVisible()));
  assert(visible, 'An official 403 verification document stays visible in the embedded view');
  await remote('document.querySelector("a").click()');
  await page.waitForFunction(() => state.webSurface.status === 'ready');
  assert.equal(await remote('localStorage.getItem("web-login-fixture")'), 'preserved');
  await page.locator('#surface-workbench').click();
  console.log('PASS native web recovery: real 429/cooldown/one retry, login storage, manual reconnect and in-app 403 verification');
}
module.exports = { webRecoveryUi };
