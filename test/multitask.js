'use strict';
// Exercise the real controllers with deliberately reordered RPCs, not paid model calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ChatController } = require('../src/main/modules/chat');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const snapshot = (sessionId, running = false, text = sessionId) => ({
  sessionId, running, title: sessionId, usage: {}, approvals: [],
  items: [{ kind: 'assistant', parts: [{ kind: 'text', text }] }],
});

async function controllerContract() {
  let frame, hostFrame, count = 0;
  const followed = new Set(), cancelled = [], updates = [], prompts = new Map();
  const client = {
    onFrame(fn) { frame = fn; return () => {}; },
    onHostFrame(fn) { hostFrame = fn; return () => {}; },
    followSession(id) { followed.add(id); },
    unfollowSession(id) { followed.delete(id); },
    async history() { return { events: [], hasMore: false }; },
    async listSessions() { return []; },
    async createSession() { return { sessionId: `task-${++count}` }; },
    prompt(id) { const pending = deferred(); prompts.set(id, pending); return pending.promise; },
    async cancel(id) { cancelled.push(id); },
    async answerApproval() { return { accepted: true }; },
  };
  const chat = new ChatController(client, { onUpdate: update => updates.push(update) });
  try {
    const a = (await chat.createSession()).sessionId;
    const sendA = chat.send(a, 'task A');
    const b = (await chat.createSession()).sessionId;
    const sendB = chat.send(b, 'task B');
    assert.deepEqual([...followed], [a, b], 'Creating B keeps A subscribed while its prompt RPC is pending');
    await chat.open(a);
    await chat.refresh(b);
    assert.deepEqual([...followed], [a, b], 'Navigation and background refresh never unsubscribe other tasks');
    for (const id of [a, b]) frame({ type: 'session/event', sessionId: id,
      event: { type: 'turn/start', seq: 0, data: { turn: 1 } } });
    frame({ type: 'session/streaming', sessionId: a, running: false });
    assert(chat.transcripts.get(a).running, 'An assistant step ending does not end the agent turn');
    hostFrame({ type: 'approval/request', sessionId: a, approval: { eventId: 'allow-a' } });
    assert.equal(chat.transcripts.get(a).approvals.size, 1);
    assert.equal(chat.transcripts.get(b).approvals.size, 0);
    await chat.answerApproval(a, 'allow-a', 'allowed-once');
    await chat.cancel(a);
    assert.deepEqual(cancelled, [a]);
    assert.equal(chat.transcripts.get(a).running, false);
    assert.equal(chat.transcripts.get(b).running, true, 'Stopping A does not stop B');
    const result = { type: 'assistant/message', seq: 1, time: 1,
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'B answer' }] }, usage: { outputTokens: 3 } } };
    frame({ type: 'session/event', sessionId: b, event: result });
    frame({ type: 'session/event', sessionId: b, event: result });
    frame({ type: 'session/event', sessionId: b, event: { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } } });
    assert.equal(chat.transcripts.get(b).items.at(-1).reason, 'completed', 'Structured turn endings have a usable status');
    assert.equal(chat.transcripts.get(b).usage.outputTokens, 3, 'Replayed events are folded only once');
    prompts.get(b).resolve(); prompts.get(a).resolve();
    await Promise.all([sendA, sendB]);
    assert.equal(chat.pollers.size, 0, 'Settled tasks do not retain reconciliation timers');
    assert.equal(updates.at(-1).transcript.running, false);
  } finally { chat.dispose(); }
  assert.equal(followed.size, 0, 'Disposal releases all task subscriptions');
  console.log('PASS multi-task main controller: concurrent prompts, subscriptions, approvals, cancellation and replay');
}

function rendererFixture() {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      id, value: '', textContent: '', innerHTML: '', hidden: false, disabled: false,
      dataset: {}, style: {}, scrollHeight: 40, classList: { toggle() {} },
      setAttribute() {}, addEventListener() {}, focus() {}, contains() { return false; },
    });
    return elements.get(id);
  }
  const open = new Map(), prompt = new Map(), cancel = new Map(), selects = new Map(), permissions = new Map();
  let next = 0, createPending = null;
  const api = {
    sessions: {
      async list() { return []; },
      create() { return createPending?.promise ?? Promise.resolve({ sessionId: `new-${++next}` }); },
      open(id) { return open.get(id)?.promise ?? Promise.resolve(snapshot(id)); },
      prompt(id) { const result = deferred(); prompt.set(id, result); return result.promise; },
      cancel(id) { const result = deferred(); cancel.set(id, result); return result.promise; },
      async modelSelection(id) { return { current: selects.get(id) ?? { provider: 'fixture', model: id }, routable: true }; },
      async permissions(id) { return { currentValue: permissions.get(id) ?? 'read-only' }; },
      async selectPermission(id, mode) { permissions.set(id, mode); return { currentValue: mode }; },
    },
    llm: { async selectModel(id, provider, model, reasoningEffort) {
      const selected = { provider, model, reasoningEffort }; selects.set(id, selected); return selected;
    } },
    settings: { async setUi(patch) { return patch; } },
  };
  const timers = new Set();
  const context = vm.createContext({
    window: { deepseek: api, Markdown: { escapeHtml: String }, addEventListener() {} },
    document: { getElementById: element, addEventListener() {} },
    requestAnimationFrame: fn => fn(),
    setTimeout(fn, delay) { const timer = setTimeout(fn, delay); timers.add(timer); return timer; },
    clearTimeout,
    paintCount: 0,
    ChatView: { render(value) { context.painted = value; context.paintCount += 1; }, scrollToEnd() {} },
    Sidebar: { renderAll() {}, renderSessions() {}, renderChatHeader() {}, renderModelChip() {} },
    console,
  });
  for (const file of ['state.js', 'app.js']) vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../src/renderer/scripts', file), 'utf8'), context, { filename: file });
  vm.runInContext('globalThis.state = state; globalThis.App = App; globalThis.toast = () => {};', context);
  return { ...context, get paintCount() { return context.paintCount; }, element, api, open, prompt, cancel,
    delayCreate(value) { createPending = value; },
    dispose() { for (const timer of timers) clearTimeout(timer); } };
}

async function rendererContract() {
  const f = rendererFixture(), { App, state, element } = f;
  try {
    await App.openSession('a');
    element('input').value = 'A question';
    const sendA = App.send();
    App.receiveTranscript('a', snapshot('a', true, 'A streaming'));
    assert.equal(state.streaming, true);
    assert.equal(element('new-chat').disabled, false, 'Running tasks never disable New conversation');
    element('input').value = 'A draft';
    const b = (await App.newSession()).sessionId;
    assert.equal(state.activeSessionId, b);
    assert.equal(state.streaming, false);
    assert.equal(element('send-btn').disabled, false, 'B can send before A resolves');
    assert.equal(element('input').value, '', 'New session does not inherit A draft');
    element('input').value = 'B question';
    const sendB = App.send();
    App.receiveTranscript(b, snapshot(b, true, 'B streaming'));
    // A returns after B is selected: it must not overwrite B's transcript or buttons.
    f.prompt.get('a').resolve(snapshot('a', false, 'stale A RPC'));
    await sendA;
    assert.equal(state.transcript.sessionId, b);
    assert.equal(state.transcript.items[0].parts[0].text, 'B streaming');
    assert.equal(state.streaming, true);
    element('input').value = 'B draft';
    await App.openSession('a');
    assert.equal(element('input').value, 'A draft');
    // Opening should not substitute a late/stale RPC for frames received while awaiting it.
    App.receiveTranscript('a', snapshot('a', true));
    const stopA = App.stop();
    await App.openSession(b);
    App.receiveTranscript(b, snapshot(b, true));
    assert.equal(element('input').value, 'B draft');
    assert.equal(state.stopping, false, 'A stop request must not disable B stop button');
    f.cancel.get('a').resolve(true); await stopA;
    assert.equal(state.streaming, true);
    App.receiveTranscript(b, snapshot(b, false, 'B final'));
    f.prompt.get(b).resolve(snapshot(b, true, 'stale B RPC'));
    await sendB;
    assert.equal(state.streaming, false);
    assert.equal(state.transcript.items[0].parts[0].text, 'B final');

    // Fast navigation with out-of-order open/model/permission responses.
    const late = deferred(); f.open.set('slow', late);
    const opening = App.openSession('slow');
    await App.openSession('fast');
    App.receiveTranscript('fast', snapshot('fast', true, 'fast stream'));
    late.resolve(snapshot('slow', true)); await opening;
    assert.equal(state.activeSessionId, 'fast');
    assert.equal(state.transcript.sessionId, 'fast');
    assert.equal(state.selection.model, 'fast');
    assert.equal(state.permissionMode, 'read-only');
    // Duplicate clicks and navigation while creation waits must not steal focus.
    const creating = deferred(); f.delayCreate(creating);
    const newTask = App.newSession();
    assert.equal(await App.newSession(), null);
    await App.openSession('elsewhere');
    creating.resolve({ sessionId: 'created-in-background' }); await newTask;
    assert.equal(state.activeSessionId, 'elsewhere');
    assert(state.sessions.some(s => s.sessionId === 'created-in-background'));
    App.receiveTranscript('a', snapshot('a', true));
    App.receiveTranscript('a', snapshot('a', false));
    assert.equal(App.sessionView('a').unread, true, 'Background completions remain visible in the sidebar');
    await App.refreshSessions();
    assert(state.sessions.some(s => s.sessionId === b), 'A list refresh retains unsent drafts');
    await App.openSession('paint-budget');
    const paintsBeforeBurst = f.paintCount;
    for (let index = 0; index < 100; index += 1) {
      App.receiveTranscript('paint-budget', snapshot('paint-budget', true, `chunk-${index}`));
    }
    assert.equal(f.paintCount, paintsBeforeBurst, 'stream snapshots do not rebuild the DOM synchronously');
    await new Promise(resolve => setTimeout(resolve, 110));
    assert.equal(f.paintCount, paintsBeforeBurst + 1, 'a stream burst causes one renderer paint');
    console.log('PASS multi-task renderer: simultaneous sends, drafts, targeted stop, late replies, navigation races and background completion');
  } finally { f.dispose(); }
}

async function main() { await controllerContract(); await rendererContract(); }
main().catch(error => { console.error(error); process.exitCode = 1; });
