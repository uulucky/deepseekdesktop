'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { runWorkflow, normalize, parseReport, evidenceOf } = require('../src/main/modules/desktop-task-workflow.cjs');
const { Transcript } = require('../src/main/modules/chat');
const { statusOf } = require('../src/main/modules/companion');
const { taskState } = require('../src/main/remote/task-state');

const plan = {
  goal: '实现两个模块并验证完整流程',
  tasks: ['a', 'b'].map((id, i) => ({ id, title: `模块${id}`, brief: `实现${id}`, dependsOn: i ? ['a'] : [], acceptance: [{ id, text: `模块${id}可运行` }] })),
  acceptance: [{ id: 'all', text: '两个模块衔接正常' }],
};
const report = (id, over = {}) => ({ status: 'done', summary: '已实际检查', deliverables: ['output.txt'], issues: [],
  checks: [{ criterionId: id, passed: true, evidence: '读取实际产物并核对内容', toolCallIds: ['read-1'] }], ...over });
const toolEvents = [
  { type: 'tool/call', data: { callId: 'read-1', name: 'read' } },
  { type: 'tool/result', data: { message: { source: { callId: 'read-1' }, content: [{ type: 'tool-result', toolCallId: 'read-1', content: [{ type: 'text', text: '实际产物' }] }] } } },
];

function fixture(decide = (_request, id) => report(id)) {
  const events = [];
  const parent = { id: 'parent', options: {}, session: { id: 'parent', header: {},
    snapshotEvents: () => events, append(type, data) { events.push({ type, data: structuredClone(data), seq: events.length, time: 1 }); } } };
  const calls = [];
  const disposed = [];
  const controller = new AbortController();
  const ctx = { tools: { schemas: () => ['read', 'bash', 'subagent', 'desktop_run_workflow'].map(name => ({ name })) }, subagents: {
    async start(provider, request) {
      assert.equal(provider, 'spawn');
      assert.equal(request.parent, parent);
      assert.equal(request.signal, controller.signal);
      assert.deepEqual(request.toolFilter.allow, ['read', 'bash']);
      const marker = request.prompt[0].text.split('\n')[0];
      calls.push(marker);
      const criterion = marker.endsWith('whole-task') ? 'all' : marker.slice(-1);
      const value = await decide(request, criterion, calls.length, controller);
      return { id: `child-${calls.length}`, localAgent: { session: { snapshotEvents: () => toolEvents } },
        result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] }),
        async dispose() { disposed.push(marker); } };
    },
  } };
  return { ctx, parent, events, calls, disposed, controller, exec: { agent: parent, signal: controller.signal } };
}

async function main() {
  assert.throws(() => normalize({ ...plan, tasks: [{ ...plan.tasks[0], dependsOn: ['b'] }, plan.tasks[1]] }), /依赖/);
  assert.throws(() => normalize({ ...plan, tasks: [plan.tasks[0], plan.tasks[0]] }), /重复/);
  assert.throws(() => parseReport([ { type: 'text', text: JSON.stringify(report('a', { checks: [{ criterionId: 'a', passed: true, evidence: '声称通过', toolCallIds: ['invented'] }] })) } ], plan.tasks[0].acceptance, evidenceOf(toolEvents)), /不存在/);
  assert.equal(evidenceOf(toolEvents.map(event => event.type === 'tool/result' ? { ...event, data: { ...event.data, error: { message: '失败' } } } : event)).size, 0);
  assert.equal(evidenceOf([
    { type: 'tool/call', data: { callId: 'bad-shell', name: 'bash' } },
    { type: 'tool/result', data: { message: { source: { callId: 'bad-shell' }, content: [{ type: 'text', text: 'test failed\n[exit code: 1]' }] } } },
  ]).size, 0, 'A non-zero shell exit is not successful evidence even without isError');
  const ok = fixture();
  const completed = await runWorkflow(ok.ctx, plan, ok.exec);
  assert.equal(completed.status, 'completed');
  assert.deepEqual(ok.calls.map(marker => marker.split(' · ')[1]), ['execute', 'task-review', 'execute', 'task-review', 'integrate', 'final-review']);
  assert.equal(ok.disposed.length, 6);
  assert.equal((await runWorkflow(ok.ctx, plan, ok.exec)).runId, completed.runId);
  assert.equal(ok.calls.length, 6, 'completed plan does not run twice');
  await assert.rejects(runWorkflow(ok.ctx, { ...plan, goal: '不同目标', resumeRunId: completed.runId }, ok.exec), /计划已改变/);

  const repair = fixture((request, id, count) => report(id, count === 2 ? { issues: ['接口缺失'], checks: [{ criterionId: id, passed: false, evidence: '接口缺失', toolCallIds: ['read-1'] }] } : {}));
  assert.equal((await runWorkflow(repair.ctx, plan, repair.exec)).status, 'completed');
  assert.equal(repair.calls.filter(marker => marker.includes('execute · a')).length, 2, 'failed review reruns only the failed task');
  assert.equal(repair.calls.length, 8);

  const invalid = fixture(() => '声称都完成了');
  const blocked = await runWorkflow(invalid.ctx, plan, invalid.exec);
  assert.equal(blocked.status, 'blocked');
  assert.equal(invalid.calls.length, 3, 'malformed reports cannot cause unbounded retries');
  assert(!invalid.calls.some(marker => marker.endsWith('b')), 'failed dependencies prevent subsequent work');
  const limitCalls = invalid.calls.length;
  await runWorkflow(invalid.ctx, { ...plan, resumeRunId: blocked.runId }, invalid.exec);
  assert.equal(invalid.calls.length, limitCalls, 'resume does not reset retry budget');

  const denied = fixture((_request, id) => report(id, { status: 'blocked', summary: '需要用户批准' }));
  assert.equal((await runWorkflow(denied.ctx, plan, denied.exec)).status, 'blocked');
  assert.equal(denied.calls.length, 1, 'permission blocks are not retried');

  const final = fixture((request, id) => report(id, request.prompt[0].text.includes('· final-review ·') ? { issues: ['整体需求未完成'] } : {}));
  assert.equal((await runWorkflow(final.ctx, plan, final.exec)).status, 'blocked');
  assert.equal(final.calls.length, 10, 'whole-task review retries integration, never repeats accepted tasks');

  const stopped = fixture((_request, id, count, controller) => {
    if (count === 3) controller.abort(new Error('用户停止'));
    return report(id);
  });
  const cancelled = await runWorkflow(stopped.ctx, plan, stopped.exec);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.tasks[0].status, 'completed');
  assert.equal(stopped.calls.length, 3);
  // Use a fresh context, as after a restart; keep only the durable session checkpoint.
  const fresh = fixture();
  fresh.parent.session.snapshotEvents = () => stopped.events;
  fresh.parent.session.append = stopped.parent.session.append.bind(stopped.parent.session);
  const resumedResult = await runWorkflow(fresh.ctx, { ...plan, resumeRunId: cancelled.runId }, fresh.exec);
  assert.equal(resumedResult.status, 'completed');
  assert(!fresh.calls.some(marker => marker.endsWith(' a')), 'accepted task is not repeated on cold resume');
  assert.equal(resumedResult.tasks[1].attempts, 2);

  for (const [interruption, firstStage, callsAfter] of [[2, 'task-review · a', 5], [6, 'final-review · whole-task', 1]]) {
    const paused = fixture((_request, id, count, controller) => {
      if (count === interruption) controller.abort(new Error('停止审查'));
      return report(id);
    });
    const stoppedAtReview = await runWorkflow(paused.ctx, plan, paused.exec);
    assert.equal(stoppedAtReview.status, 'cancelled');
    const resumedReview = fixture();
    resumedReview.parent.session.snapshotEvents = () => paused.events;
    const outcome = await runWorkflow(resumedReview.ctx, { ...plan, resumeRunId: stoppedAtReview.runId }, resumedReview.exec);
    assert.equal(outcome.status, 'completed');
    assert(resumedReview.calls[0].endsWith(firstStage), 'Resume enters review instead of replaying accepted execution/integration');
    assert.equal(resumedReview.calls.length, callsAfter);
  }

  let releaseFirst, announceFirst;
  const entered = new Promise(resolve => { announceFirst = resolve; });
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  const concurrent = fixture(async (_request, id, count) => {
    if (count === 1) { announceFirst(); await gate; }
    return report(id);
  });
  const firstRun = runWorkflow(concurrent.ctx, plan, concurrent.exec);
  await entered;
  await assert.rejects(runWorkflow(concurrent.ctx, plan, concurrent.exec), /已有任务流程/);
  releaseFirst();
  assert.equal((await firstRun).status, 'completed');

  const transcript = new Transcript('parent');
  for (const event of ok.events) transcript.apply(event);
  const cards = transcript.snapshot().items.filter(item => item.kind === 'workflow');
  assert.equal(cards.length, 1, 'streamed checkpoints replace the progress card');
  assert.equal(cards[0].status, 'completed');
  assert.equal(cards[0].checks.length, 1);
  const failedSnapshot = { running: false, items: [{ kind: 'user' }, { kind: 'workflow', status: 'blocked' }, { kind: 'turn-end', reason: 'completed' }] };
  assert.equal(statusOf(failedSnapshot, {}), 'failed', 'companion cannot call an unaccepted workflow completed');
  assert.equal(taskState(failedSnapshot), 'failed', 'phone cannot call an unaccepted workflow completed');
  const context = vm.createContext({ window: {}, esc: value => String(value).replaceAll('<', '&lt;'), document: {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/scripts/chat-view.js'), 'utf8'), context);
  const html = context.renderItem({ ...cards[0], goal: '<script>unsafe</script>' });
  assert.match(html, /整|自动任务/);
  assert.match(html, /&lt;script>/);
  assert(!html.includes('<script>'));
  console.log('PASS task workflow: sequential dependency gates, independent review, evidence validation, bounded repair, cancellation, durable resume and progress UI');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
