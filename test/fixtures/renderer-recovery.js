'use strict';
const assert = require('node:assert/strict');

async function within(promise, label, ms = 30_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function replacementMainWindow(application, previous, timeout = 30_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const candidate = application.windows().find((window) => {
      if (window === previous) return false;
      try { return /\/index\.html$/.test(window.url()); } catch { return false; }
    });
    if (candidate) return candidate;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Replacement main window timed out after ${timeout}ms`);
}

/** Keep a real Harness task streaming while its UI process dies, then finish the same task. */
async function rendererRecovery(application, page, provider) {
  await page.locator('#input').fill('renderer-recovery-fixture');
  await page.locator('#send-btn').click();
  const response = await provider.waitFor('renderer-recovery-fixture');
  response.delta('恢复测试：前半段');
  await page.waitForFunction(() => state.streaming && document.getElementById('stream-inner').textContent.includes('前半段'));
  const activeSessionId = await page.evaluate(async () => {
    await api.settings.setUi({ activeSessionId: state.activeSessionId });
    return state.activeSessionId;
  });
  console.log('Recovery smoke: crashing renderer during a live response');
  // WebContentsView pages also appear in Playwright's Electron window inventory. Select only the
  // recovered local shell so an official-web child cannot be mistaken for the replacement UI.
  const replacement = replacementMainWindow(application, page);
  // Attach rejection handling before scheduling the crash, in case the driver disconnects.
  replacement.catch(() => {});
  await within(application.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(item => /\/index\.html$/.test(item.webContents.getURL()));
    if (!win) throw new Error('Main window not found for renderer recovery test');
    setTimeout(() => { if (!win.isDestroyed()) win.webContents.forcefullyCrashRenderer(); }, 100);
    return true;
  }), 'Crash dispatch');
  const recovered = await replacement;
  recovered.setDefaultTimeout(30_000);
  await recovered.waitForFunction(() => typeof App !== 'undefined' && App.ready === true, null, { timeout: 30_000 });
  assert.equal(await within(recovered.evaluate(() => state.activeSessionId), 'Recovered session'), activeSessionId);
  assert.equal(await within(recovered.evaluate(() => state.world?.rendererRecovery?.status), 'Recovery status'), 'recovering');
  assert.equal(response.closed, false, 'Renderer failure must not cancel the Harness/model stream');
  response.finish('，恢复后完整回答');
  await recovered.waitForFunction(() => !state.streaming
    && document.getElementById('stream-inner').textContent.includes('恢复后完整回答'), null, { timeout: 30_000 });
  assert.equal(await recovered.locator('#send-btn').isEnabled(), true);
  assert.equal(await recovered.locator('#stop-btn').isVisible(), false);
  console.log('PASS fresh renderer restored the active session and completed the uninterrupted live response');
  return recovered;
}

module.exports = { rendererRecovery };
