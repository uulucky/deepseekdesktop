'use strict';
const assert = require('node:assert/strict');

/** Real model wire, Harness transcript and renderer. All model content is loopback-only. */
async function actionSummaryUi(page, provider) {
  await page.evaluate(() => App.newSession());
  await page.locator('#input').fill('action-summary-ui-fixture');
  await page.locator('#send-btn').click();
  const response = await provider.waitFor('action-summary-ui-fixture');
  assert(response.body.messages.some(message => message.role === 'system'
    && JSON.stringify(message.content).includes('DeepSeek Desktop communication style')));
  response.reasoning('First inspect the project, then verify the change.');
  await page.locator('.action-summary.pending').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.fold-body:visible').count(), 0);
  response.delta('<desktop-sum');
  await page.waitForFunction(() => state.transcript?.items.some(item => item.parts?.some(part => part.text === '<desktop-sum')));
  assert(!(await page.locator('#stream-inner').innerText()).includes('<desktop-sum'));
  response.delta('mary>我先检查项目的启动配置，再验证修改后的结果。</desktop-summary>');
  const summary = page.locator('.action-summary:not(.pending)');
  await summary.waitFor({ state: 'visible' });
  assert((await summary.innerText()).includes('我先检查项目的启动配置'));
  assert.equal(await summary.locator('.fold-head').count(), 0, 'Summary is not collapsible');
  const reasoning = page.locator('.assistant .fold').first();
  await reasoning.locator('.fold-head').click();
  await reasoning.locator('.fold-body').waitFor({ state: 'visible' });
  response.finish('\n已验证启动配置，检查完成。');
  await page.waitForFunction(() => !state.streaming && document.getElementById('stream-inner').textContent.includes('检查完成'));
  assert.equal(await reasoning.locator('.fold-body').isVisible(), true, 'Manual detail choice survives durable assistant replacement');
  await reasoning.locator('.fold-head').click();
  assert.equal(await summary.isVisible(), true);

  // Tool/approval presentation only: do not execute a real command or ask the model for one.
  await page.evaluate(() => {
    const snapshot = structuredClone(state.transcript);
    snapshot.items.push({ kind: 'tool', callId: 'ui-fixture-read', name: 'read', summary: 'README.md', running: true, arguments: '{"path":"README.md"}' });
    snapshot.approvals = [{ eventId: 'ui-fixture-approval', callId: 'ui-fixture-read', toolName: 'read' }];
    ChatView.render(snapshot);
  });
  const tool = page.locator('.fold').last();
  assert.equal(await tool.locator('.fold-body').isVisible(), false, 'A running tool stays collapsed');
  assert.equal(await tool.locator('.badge').innerText(), '等待授权');
  assert.equal(await page.locator('.approval-panel [data-approval-action="allowed-once"]').isVisible(), true);
  await tool.locator('.fold-head').focus();
  await tool.locator('.fold-head').press('Enter');
  assert.equal(await tool.locator('.fold-body').isVisible(), true, 'Keyboard can expand tool details');
  await page.evaluate(() => ChatView.render(state.transcript));
  console.log('PASS real action-summary UI: Chinese public summary, private-detail folding, partial stream, keyboard and visible approvals');
}
module.exports = { actionSummaryUi };
