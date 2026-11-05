'use strict';
const assert = require('node:assert/strict');
const { taskState, historyPage, RequestLedger } = require('../src/main/remote/task-state');
const { MobileWorkbench, nextRun, validateRule } = require('../src/main/remote/workbench');

(async () => {
  assert.equal(taskState({ running: true, approvals: [{}] }), 'waiting-approval');
  assert.equal(taskState({ items: [{ kind: 'turn-end', reason: 'error', error: 'model unavailable' }] }), 'failed');
  assert.equal(taskState({ items: [{ kind: 'turn-end', reason: 'cancelled' }] }), 'stopped');
  assert.equal(taskState({}), 'idle');
  assert.equal(taskState({ running: false, items: [{ kind: 'user', pending: true }] }), 'queued');
  const items = Array.from({ length: 420 }, (_, seq) => ({ seq, text: String(seq) }));
  const page = historyPage(items); assert.equal(page.items.length, 120);
  const earlier = historyPage([...items, { seq: 421 }], { before: page.before });
  assert.equal(earlier.items.at(-1).seq, 299); assert.equal(earlier.items[0].seq, 180);
  assert.throws(() => historyPage(items, { before: 'bad' }), /游标/);
  const map = new Map(), store = { get: (key, fallback) => map.get(key) ?? fallback, set: (key, value) => map.set(key, value) };
  const ledger = new RequestLedger(() => store); let sends = 0;
  const body = { requestId: 'send-123456', text: '你好' };
  const send = async () => { sends++; await new Promise((r) => setTimeout(r, 10)); return { ok: true }; };
  await Promise.all([ledger.once('phone', 'send:s', body, send), ledger.once('phone', 'send:s', body, send)]);
  assert.equal(sends, 1);
  await new RequestLedger(() => store).once('phone', 'send:s', body, send); assert.equal(sends, 1);
  await assert.rejects(ledger.once('phone', 'send:s', { ...body, text: '另一条' }, send), /不能用于不同内容/);
  await assert.rejects(ledger.once('phone', 'create', { requestId: 'create-123' }, async () => { throw Error('response lost'); }));
  await assert.rejects(new RequestLedger(() => store).once('phone', 'create', { requestId: 'create-123' }, send), /结果未知/);
  assert.equal(ledger.lookup('other-phone', 'create', 'create-123').status, 'not-found');

  let now = Date.parse('2026-11-04T01:00:00Z'), renamed, archived, created = 0;
  const snapshot = { items: [], lastSeq: 1, usage: { uncachedInputTokens: 1000000, outputTokens: 500000 } };
  const ctx = { uiStore: store, client: { sessionSelections: new Map([['s', { model: 'fixture-model' }]]), listWorkspaces: async () => ({ items: [{ workspaceId: 'w', path: '/tmp' }] }), renameSession: async (...args) => { renamed = args; }, archiveSession: async (id) => { archived = id; }, listSkills: async () => ({ skills: [{ id: 'doc', name: '文档', enabled: true }] }) },
    chat: { transcripts: new Map([['s', { snapshot: () => snapshot }]]), close() {} }, defaultSessionOptions: () => ({ cwd: '/tmp' }) };
  const remote = { getContext: () => ctx, state: { name: 'pc' }, enabled: () => true, gateway: { publish() {} }, sessions: { sessionRows: async () => [{ sessionId: 's', running: false }] },
    api: () => ({ createSession: async () => ({ sessionId: `scheduled-${++created}` }), sendMessage: async () => ({ ok: true }) }), log() {} };
  const work = new MobileWorkbench(remote, { now: () => now });
  assert.equal(work.billing('s').estimatedCost, null, 'missing prices never invent an amount');
  await work.action({ phone: 'p', body: { op: 'budget', model: 'fixture-model', taskLimit: 3, lowBalance: 5, rates: { input: 2, output: 4, cached: 1 } } });
  assert.equal(work.billing('s').estimatedCost, 4);
  assert.throws(() => work.beforeSend('s', {}, false), /预算/);
  work.beforeSend('s', { budgetOverride: true }, true);
  ctx.client.sessionSelections.set('s', { model: 'another-model' }); assert.equal(work.billing('s').estimatedCost, null, 'prices for a different model cannot be silently reused'); ctx.client.sessionSelections.set('s', { model: 'fixture-model' });
  await work.action({ phone: 'p', body: { op: 'rename', sessionId: 's', title: '新名称' } }); assert.deepEqual(renamed, ['s', '新名称']);
  await work.action({ phone: 'p', body: { op: 'pin', sessionId: 's', on: true } }); assert.equal(work.decorate({ sessionId: 's' }, 'p').pinned, true);
  await work.action({ phone: 'p', body: { op: 'project', workspaceId: 'w', name: '项目', description: '每次先运行测试', output: '中文' } });
  assert.match(work.prompt('s', '修改文件', { workspaceId: 'w' }), /每次先运行测试/);
  await assert.rejects(work.action({ body: { op: 'project', workspaceId: 'w', name: '项目', description: '密码:secret' } }), /不能保存密码/);
  assert.throws(() => validateRule({ kind: 'weekly', days: [9] }, now), /规则/);
  const daily = validateRule({ kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' }, now);
  assert.equal(nextRun(daily, now), now + 86400000);
  await assert.rejects(work.action({ elevated: false, body: { op: 'schedule-save', title: '周报', prompt: '整理周报' } }), /验证机主/);
  await work.action({ elevated: true, phone: 'p', body: { op: 'schedule-save', title: '周报', prompt: '整理周报', rule: { kind: 'interval', minutes: 15 } } });
  now += 16 * 60000; await work.tick(); assert.equal(created, 1);
  for (const status of ['queued', 'waiting-answer', 'waiting-approval']) {
    work.change((s) => { s.schedules[0].history[0].status = status; });
    ctx.chat.transcripts.set('scheduled-1', status === 'queued'
      ? { items: [{ kind: 'user', pending: true }] }
      : { running: true, [status === 'waiting-answer' ? 'questions' : 'approvals']: [{ eventId: 'pending' }] });
    await assert.rejects(work.runSchedule(work.state().schedules[0], false), /正在启动/);
    assert.equal(created, 1, `${status} must prevent overlapping scheduled tasks`);
  }
  ctx.chat.transcripts.delete('scheduled-1');
  await assert.rejects(new MobileWorkbench(remote, { now: () => now }).runSchedule(work.state().schedules[0], false), /正在启动/, 'restart must not forget an unresolved scheduled task');
  now += 30 * 60000; await work.tick(); assert.equal(created, 1, 'missed runs are recorded, never replayed');
  assert.equal(work.state().schedules[0].history.at(-1).status, 'missed');
  const scheduleId = work.state().schedules[0].id;
  await work.action({ body: { op: 'schedule-toggle', id: scheduleId, on: false } });
  now += 60 * 60000; await work.tick(); assert.equal(created, 1, 'paused schedules never execute');
  await work.action({ body: { op: 'schedule-toggle', id: scheduleId, on: true } });
  assert(work.state().schedules[0].nextRun > now, 'resume schedules a future run rather than replaying paused occurrences');
  await work.action({ elevated: true, body: { op: 'schedule-save', title: '独立计划', prompt: '其他计划仍可执行', rule: { kind: 'interval', minutes: 15 } } });
  now += 15 * 60000; await work.tick();
  assert.equal(created, 2, 'one waiting schedule must not block unrelated due schedules');
  assert.match(work.state().schedules[0].history.at(-1).error, /上次任务尚未结束/);
  await work.action({ body: { op: 'archive', sessionId: 's' } }); assert.equal(archived, 's');
  snapshot.items = [{ kind: 'turn-end', reason: 'completed' }]; work.onTranscript('s', snapshot);
  assert.equal(work.decorate({ sessionId: 's' }, 'p').unread, true);
  await work.action({ phone: 'p', body: { op: 'seen', sessionId: 's', seq: 1 } });
  assert.equal(work.decorate({ sessionId: 's' }, 'p').unread, false);
  await work.action({ phone: 'p', body: { op: 'budget', sessionId: 's', taskLimit: 8, lowBalance: 5 } });
  assert.equal(work.billing('s').taskLimit, 8); assert.equal(work.billing('other').taskLimit, 3);
  await work.action({ body: { op: 'template-save', name: '自定义', text: '检查测试，不修改文件' } });
  let template = (await work.snapshot('p')).templates.find((t) => t.custom); assert.equal(template.text, '检查测试，不修改文件');
  await work.action({ body: { op: 'template-save', id: template.id, name: '自定义修改', text: '先列计划' } });
  assert.equal((await work.snapshot('p')).templates.filter((t) => t.custom).length, 1);
  await work.action({ body: { op: 'template-delete', id: template.id } });
  assert.equal((await work.snapshot('p')).templates.some((t) => t.custom), false);
  const settings = await work.snapshot('p'); assert.equal(settings.push.configured, false);
  assert.equal(JSON.stringify(settings).includes('secret'), false);
  // App restart and unrelated transcript refreshes do not re-notify a settled task.
  const previousEventCount = work.state().events.length;
  const restored = new MobileWorkbench(remote, { now: () => now });
  restored.onTranscript('s', snapshot);
  assert.equal(restored.state().events.length, previousEventCount, 'restoring a finished task must not create a new unread notification');
  snapshot.lastSeq = 2; snapshot.items = [{ kind: 'turn-end', seq: 2, reason: 'completed' }];
  restored.onTranscript('s', snapshot);
  assert.equal(restored.state().events.length, previousEventCount + 1, 'a later completed turn must notify even if no running snapshot arrived');
  snapshot.running = true; snapshot.questions = [{ eventId: 'question-one' }]; snapshot.lastSeq = 3;
  restored.onTranscript('s', snapshot); const questionEvents = restored.state().events.length;
  snapshot.lastSeq = 4; restored.onTranscript('s', snapshot);
  assert.equal(restored.state().events.length, questionEvents, 'stream updates for the same pending question must not repeat notifications');
  snapshot.questions = [{ eventId: 'question-two' }]; restored.onTranscript('s', snapshot);
  assert.equal(restored.state().events.length, questionEvents + 1, 'a different pending question must notify');
  restored.stop();
  work.stop(); console.log('PASS mobile workbench: task outcomes, stable pages, uncertain/replayed POST isolation, projects, prices, schedules and read receipts');
})().catch((error) => { console.error(error); process.exitCode = 1; });
