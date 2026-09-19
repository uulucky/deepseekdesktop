'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const inner = { innerHTML: '' };
const listeners = {};
const context = vm.createContext({
  window: { Markdown: { render: text => String(text).replaceAll('<', '&lt;') } },
  esc: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
  compact: String,
  document: {
    getElementById: id => id === 'stream-inner' ? inner : null,
    addEventListener: (event, fn) => { listeners[event] = fn; },
  },
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/scripts/chat-view.js'), 'utf8'), context);
const split = (text, streaming) => context.splitActionSummary(text, streaming);
const source = '<desktop-summary>先检查文件，再验证修改。</desktop-summary>最终回答';
assert.equal(split(source).summary, '先检查文件，再验证修改。');
assert.equal(split(source).text, '最终回答');
for (let index = 1; index < source.indexOf('最终回答'); index += 1) {
  const result = split(source.slice(0, index), true);
  assert(!result.text.includes('<desktop-'), 'partial protocol tags must not flash in the answer');
  assert(!result.summary.includes('</'), 'partial closing tags must not flash in the summary');
}
for (const plain of ['直接回答', '```xml\n<desktop-summary>示例</desktop-summary>\n```',
  '请参考 <desktop-summary>示例</desktop-summary>', '<desktop-summary>未闭合；最终回答不能丢失',
  `<desktop-summary>${'内容'.repeat(400)}`]) {
  assert.equal(split(plain).text, plain, 'malformed, quoted and oversized content is preserved');
}
const item = { kind: 'assistant', turn: 1, step: 0, streaming: true, parts: [
  { kind: 'reasoning', text: 'Inspect the project first.' },
  { kind: 'text', text: source },
  { kind: 'tool-call', name: 'read', arguments: '{"path":"README.md"}' },
] };
const tool = { kind: 'tool', callId: 'one', name: 'read', running: true, arguments: 'README.md' };
const render = (session = 'a') => context.window.ChatView.render({ sessionId: session, items: [item, tool], approvals: [] });
render();
assert.match(inner.innerHTML, /class="action-summary"/);
assert(!inner.innerHTML.includes('class="fold open"'), 'reasoning and running tools are collapsed by default');
assert.match(inner.innerHTML, /最终回答/);
assert(!inner.innerHTML.includes('<desktop-summary>'));
assert.match(inner.innerHTML, /运行中/);
// Manual fold choices survive stream snapshots and isolate separate sessions.
context.window.ChatView.install();
const key = JSON.stringify(['a', 'one:tool']);
const card = { classList: { toggle: () => true }, getAttribute: () => key };
const head = { parentElement: card, setAttribute() {} };
listeners.click({ target: { closest: selector => selector === '.fold-head' ? head : null } });
render();
assert.match(inner.innerHTML, /class="fold open"/);
render('b');
assert(!inner.innerHTML.includes('class="fold open"'));
tool.running = false;
render('a');
assert.match(inner.innerHTML, /class="fold open"/);
assert.match(inner.innerHTML, /完成/);
// Summary is escaped plain text, never markup supplied by the model.
item.parts = [{ kind: 'text', text: '<desktop-summary><img src=x onerror=alert(1)></desktop-summary>答复' }];
render();
assert(!inner.innerHTML.includes('<img'));
assert.match(inner.innerHTML, /&lt;img/);
item.parts = [{ kind: 'reasoning', text: 'analysis' }];
render();
assert.match(inner.innerHTML, /正在整理行动摘要/);
item.streaming = false;
render();
assert(!inner.innerHTML.includes('正在整理行动摘要'), 'completed historical reasoning is not labelled as live');
context.window.ChatView.render({ sessionId: 'a', items: [{ kind: 'user', synthetic: true, text: 'runtime details' }] });
assert.match(inner.innerHTML, /系统上下文/);
assert(!inner.innerHTML.includes('class="fold open"'), 'runtime context is also collapsed, not a second user bubble');
const sections = [];
require('../src/main/modules/desktop-presentation.cjs').apply({ systemPrompt: { section: value => sections.push(value) } });
assert.equal(sections.length, 1);
assert.match(sections[0].text, /never change permissions/);
assert(!sections[0].text.includes('{{'), 'Harness variable interpolation must not see unregistered variables');
console.log('PASS action summary: native prompt, streaming protocol, safe rendering, collapsed tools and per-session fold state');
