'use strict';
// Actual ChatController decisions + remote API: grants are never model instructions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsdesk-session-approvals-'));
process.env.DEEPSEEK_DESKTOP_HOME = tmp;
const { DIRS } = require('../src/main/modules/util');
const { RemoteControl } = require('../src/main/remote');
const { ChatController, Transcript } = require('../src/main/modules/chat');
fs.mkdirSync(DIRS.config, { recursive: true });
const guardFile = path.join(DIRS.config, 'safety-guard.json');
const guard = (enabled) => fs.writeFileSync(guardFile, JSON.stringify({ enabled }));
const safe = (eventId) => ({ eventId, questions: [{ id: 'desktop-safety-guard', options: [{ label: '允许这一次' }, { label: '不允许' }] }] });
(async () => {
  guard(true);
  const decisions = [], permissions = new Map([['one', 'workspace-write'], ['two', 'workspace-write']]), store = new Map();
  let control, finish, fail = false;
  const client = {
    onFrame: () => () => {}, onHostFrame: () => () => {},
    permissions: async (id) => ({ currentValue: permissions.get(id) }),
    answerApproval: async (eventId, outcome) => {
      decisions.push({ eventId, outcome });
      if (finish) await new Promise((resolve) => { finish.resolve = resolve; });
      if (fail) throw new Error('lost connection');
      return { accepted: true };
    },
    answerQuestion: async (eventId, answers) => { decisions.push({ eventId, answers }); return { accepted: true }; },
  };
  const chat = new ChatController(client, { onUpdate: (p) => control?.onTranscript(p) });
  for (const id of ['one', 'two']) chat.transcripts.set(id, new Transcript(id));
  const one = chat.transcripts.get('one'), two = chat.transcripts.get('two');
  control = new RemoteControl({ getContext: () => ({ chat, client, uiStore: { get: (k, fallback) => store.get(k) ?? fallback, set: (k, v) => store.set(k, v) } }),
    sessions: { selectPermission: async (id, value) => permissions.set(id, value) } });
  control.gateway = { publish() {}, close() {}, disconnect() {} };
  const api = control.api();
  const approval = (eventId, sessionId = 'one') => chat.handleHostFrame({ type: 'approval/request', sessionId, approval: { eventId, toolName: 'bash' } });
  const question = (pending, sessionId = 'one') => chat.handleHostFrame({ type: 'question/request', sessionId, question: pending });
  const send = (eventId, outcome, elevated = true) => api.answerApproval({ params: ['one', eventId], body: { outcome }, elevated, phone: 'test-phone' });
  approval('first');
  await assert.rejects(send('first', 'allowed-session', false), /机主验证/);
  assert.equal(decisions.length, 0);
  await assert.rejects(send('missing', 'allowed-session'), /已经结束/);
  assert.equal((await control.approvalPolicy.status('one')).active, false);
  approval('queued');
  question(safe('guard-first'));
  question({ eventId: 'ordinary', questions: [{ id: 'destination', question: '保存到哪里？' }] });
  approval('other-session', 'two');
  await send('first', 'allowed-session');
  await control.approvalPolicy.drain('one');
  assert.deepEqual(decisions.map((v) => v.eventId), ['first', 'queued', 'guard-first']);
  assert(one.questions.has('ordinary'), 'ordinary questions still need the owner');
  assert(two.approvals.has('other-session'), 'no grant for another session or dispatched child');
  assert.equal(permissions.get('one'), 'workspace-write', 'grant does not change the global permission preset');
  approval('future'); await control.approvalPolicy.drain('one');
  assert.equal(decisions.at(-1).eventId, 'future');
  await api.revokeApprovalPolicy({ params: ['one'] });
  approval('after-revoke'); await control.approvalPolicy.drain('one');
  assert(one.approvals.has('after-revoke'));

  // Rapid repeated clicks settle once, conflicting answers cannot race the same request.
  finish = {};
  const first = send('after-revoke', 'allowed-once');
  await new Promise((resolve) => setImmediate(resolve));
  const duplicate = send('after-revoke', 'allowed-once');
  await assert.rejects(send('after-revoke', 'rejected'), /正在提交/);
  finish.resolve(); finish = null;
  await Promise.all([first, duplicate]);
  assert.equal(decisions.filter((v) => v.eventId === 'after-revoke').length, 1);
  assert.equal((await control.approvalPolicy.status('one')).active, false, 'once does not create a grant');

  question(safe('guard-session'));
  await api.answerQuestion({ params: ['one', 'guard-session'], body: { answers: [{ id: 'desktop-safety-guard', selected: ['允许这一次'], custom: '' }], approvalScope: 'session' }, elevated: true, phone: 'test-phone' });
  assert.equal((await control.approvalPolicy.status('one')).active, true);
  await assert.rejects(api.answerQuestion({ params: ['one', 'ordinary'], body: { answers: [{ id: 'destination', selected: [] }], approvalScope: 'session' }, elevated: true }), /只有安全护栏/);
  // Mixed question sets must not have business answers fabricated by the grant.
  question({ eventId: 'mixed', questions: [...safe('x').questions, { id: 'format', options: [] }] });
  await control.approvalPolicy.drain('one'); assert(one.questions.has('mixed'));
  control.approvalPolicy.revokePhone('test-phone');
  assert.equal((await control.approvalPolicy.status('one')).active, false);

  await control.approvalPolicy.allow('one', 'test-phone');
  control.setMaxPermission('read-only');
  assert.equal((await control.approvalPolicy.status('one')).active, false, 'desktop ceiling changes revoke grants');
  control.setMaxPermission('workspace-write');
  await control.approvalPolicy.allow('one', 'test-phone');
  permissions.set('one', 'read-only');
  approval('lowered'); await control.approvalPolicy.drain('one');
  assert(one.approvals.has('lowered'), 'permission change revokes before subsequent approval');
  permissions.set('one', 'workspace-write');
  await send('lowered', 'allowed-once');
  await control.approvalPolicy.allow('one', 'test-phone');
  guard(false); approval('guard-off'); await control.approvalPolicy.drain('one');
  assert(one.approvals.has('guard-off')); assert.equal(control.approvalPolicy.grants.size, 0);
  guard(true); one.approvals.delete('guard-off');

  // Failure stays visible and ends automatic approval without retrying the decision.
  await control.approvalPolicy.allow('one', 'test-phone'); fail = true;
  approval('error'); await control.approvalPolicy.drain('one').catch(() => {});
  await control.approvalPolicy.drain('one');
  assert(one.approvals.has('error')); assert.equal(decisions.filter((v) => v.eventId === 'error').length, 1);
  assert.equal((await control.approvalPolicy.status('one')).active, false); fail = false;
  one.approvals.delete('error');
  finish = {}; approval('shutdown-race');
  const delayedGrant = send('shutdown-race', 'allowed-session');
  await new Promise((resolve) => setImmediate(resolve));
  control.approvalPolicy.clear(); finish.resolve(); finish = null;
  await assert.rejects(delayedGrant, /授权已变化/);
  assert.equal((await control.approvalPolicy.status('one')).active, false, 'an in-flight reply cannot restore a revoked grant');
  await control.approvalPolicy.allow('one', 'test-phone');
  control.stop(); assert.equal(control.approvalPolicy.grants.size, 0, 'disconnect/restart requires a new owner grant');
  chat.dispose();
  console.log('PASS session approvals: future requests, guard/normal-question separation, deduplication, failure, revoke, ceiling, session/phone isolation');
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
