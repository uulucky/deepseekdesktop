'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { TranscriptDispatcher } = require('../src/main/modules/transcript-dispatcher');
const { attachWindowRecovery } = require('../src/main/modules/window-recovery');

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function dispatcherContract() {
  const sent = [];
  const dispatcher = new TranscriptDispatcher(payload => sent.push(payload), { intervalMs: 15 });
  for (let index = 0; index < 200; index += 1) {
    dispatcher.push({ sessionId: 'long-task', transcript: { sessionId: 'long-task', running: true, index } });
  }
  assert.equal(sent.length, 0, 'stream chunks wait for the coalescing window');
  await wait(30);
  assert.equal(sent.length, 1, 'a token burst crosses IPC once');
  assert.equal(sent[0].transcript.index, 199, 'the newest snapshot wins');
  dispatcher.push({ sessionId: 'long-task', event: { type: 'turn/end' },
    transcript: { sessionId: 'long-task', running: false, index: 200 } });
  assert.equal(sent.length, 2, 'terminal state is delivered without delay');
  dispatcher.dispose();
}

async function recoveryContract() {
  class FakeWindow extends EventEmitter {
    constructor() {
      super();
      this.webContents = new EventEmitter();
      this.webContents.reloadIgnoringCache = () => { this.reloads += 1; };
      this.reloads = 0;
    }
    isDestroyed() { return false; }
  }
  const win = new FakeWindow();
  const events = [];
  const recovery = attachWindowRecovery(win, {
    crashDelayMs: 2,
    unresponsiveDelayMs: 8,
    onRecovery: event => events.push(event),
  });
  win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 9 });
  await wait(15);
  assert.equal(win.reloads, 1, 'a crashed renderer reloads automatically');
  assert.equal(events[0].kind, 'crashed');
  win.emit('unresponsive');
  win.emit('responsive');
  await wait(15);
  assert.equal(win.reloads, 1, 'a renderer that recovers before the deadline is not reloaded');
  win.emit('unresponsive');
  await wait(20);
  assert.equal(win.reloads, 2, 'a persistently unresponsive renderer is reloaded');
  recovery.dispose();
}

function chatRenderBudgetContract() {
  const inner = { innerHTML: '' };
  const stream = { scrollHeight: 1000, scrollTop: 0, clientHeight: 800 };
  const context = vm.createContext({
    window: { Markdown: { render: String, escapeHtml: value => String(value).replaceAll('<', '&lt;') } },
    document: {
      getElementById(id) { return id === 'stream-inner' ? inner : stream; },
      addEventListener() {},
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/scripts/chat-view.js'), 'utf8'), context);
  const items = Array.from({ length: 300 }, (_, index) => ({
    kind: 'assistant', parts: [{ kind: 'text', text: index === 299 ? `row-${index}\n${'x'.repeat(90_000)}` : `row-${index}` }],
  }));
  context.window.ChatView.render({ items, approvals: [] });
  assert.match(inner.innerHTML, /当前显示最近 240 条记录/);
  assert(!inner.innerHTML.includes('row-0'), 'old rows are not mounted into the live DOM');
  assert(inner.innerHTML.includes('row-299'));
  assert.match(inner.innerHTML, /超长内容已折叠/);
  assert(inner.innerHTML.length < 120_000, 'one oversized response cannot create an unbounded DOM');
}

async function main() {
  await dispatcherContract();
  await recoveryContract();
  chatRenderBudgetContract();
  console.log('PASS renderer resilience: IPC coalescing, bounded transcript DOM and automatic crash/hang recovery');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
