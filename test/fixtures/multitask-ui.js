'use strict';
const assert = require('node:assert/strict');
const { eventually } = require('./model-server');

/** Real clicks, real IPC and real Harness; only the remote model is a loopback fixture. */
async function multitaskUi(page, provider) {
  const create = async () => {
    const previous = await page.evaluate(() => state.activeSessionId);
    await page.locator('#new-chat').click();
    await page.waitForFunction(previous => state.activeSessionId && state.activeSessionId !== previous
      && !state.creatingSession && !state.sessionLoading, previous);
    return page.evaluate(() => state.activeSessionId);
  };
  const open = async id => {
    await page.locator(`[data-session="${id}"]`).click();
    await page.waitForFunction(id => state.activeSessionId === id && !state.sessionLoading, id);
  };
  const a = await create();
  const permissionA = await page.locator('#permission-slider').inputValue();
  const effortA = await page.locator('#reasoning-slider').inputValue();
  await page.locator('#input').fill('multitask-ui-fixture-A');
  await page.locator('#send-btn').click();
  const responseA = await provider.waitFor('multitask-ui-fixture-A');
  responseA.delta('A 正在运行');
  await page.waitForFunction(() => state.streaming && state.transcript?.items.some(item => item.parts?.some(part => part.text?.includes('A 正在运行'))));
  assert.equal(await page.locator('#new-chat').isEnabled(), true);
  await page.locator('#input').fill('A 未发送草稿');
  const b = await create();
  assert.equal(await page.locator('#input').inputValue(), '');
  assert.equal(await page.locator('#send-btn').isEnabled(), true);
  await page.locator('#permission-slider').focus();
  await page.locator('#permission-slider').press('Home');
  await page.waitForFunction(() => state.permissionMode === 'read-only' && !state.permissionBusy);
  await page.locator('#reasoning-slider').focus();
  await page.locator('#reasoning-slider').press('Home');
  await page.waitForFunction(() => state.selection?.reasoningEffort === 'off'
    && !document.getElementById('reasoning-slider').disabled);
  await page.locator('#input').fill('multitask-ui-fixture-B');
  await page.locator('#send-btn').click();
  const responseB = await provider.waitFor('multitask-ui-fixture-B');
  responseB.delta('B 正在运行');
  await page.waitForFunction(() => document.getElementById('sessions-status').textContent.includes('2 个任务'));
  assert.equal(responseA.closed, false, 'Creating B did not cancel A');
  await page.locator('#input').fill('B 未发送草稿');
  await open(a);
  assert.equal(await page.locator('#input').inputValue(), 'A 未发送草稿');
  assert.equal(await page.locator('#permission-slider').inputValue(), permissionA, 'B permission change cannot alter A');
  assert.equal(await page.locator('#reasoning-slider').inputValue(), effortA, 'B effort change cannot alter A');
  await page.locator('#stop-btn').click();
  await page.waitForFunction(() => !state.streaming && !state.stopping);
  await eventually(() => responseA.closed, 'A stream was cancelled');
  assert.equal(responseB.closed, false, 'Stopping A leaves B running');
  responseB.finish('，B 已完成');
  await page.waitForFunction(id => document.querySelector(`[data-session="${id}"] .s-meta`)?.textContent === '已完成', b);
  assert.equal(await page.evaluate(() => state.activeSessionId), a, 'Background completion never changes the selected conversation');
  await open(b);
  assert.equal(await page.locator('#input').inputValue(), 'B 未发送草稿');
  assert.equal(await page.locator('#permission-slider').inputValue(), '0');
  assert.equal(await page.locator('#reasoning-slider').inputValue(), '0');
  await page.waitForFunction(() => !state.streaming && state.transcript?.items.some(item => item.parts?.some(part => part.text?.includes('B 已完成'))));
  assert.equal(await page.locator('#send-btn').isEnabled(), true);
  assert.equal(await page.locator('#stop-btn').isVisible(), false);
  console.log('PASS real multi-task UI: create/send while running, two tasks, draft restore, targeted Stop and background completion');
}
module.exports = { multitaskUi };
