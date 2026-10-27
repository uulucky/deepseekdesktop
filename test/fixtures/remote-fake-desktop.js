'use strict';
// A stand-in DeepSeek Desktop for developing and testing the dmuse phone app: the real
// RemoteControl, sidecar and gateway, with scripted sessions instead of the Harness kernel.
//
//   DMUSE_SIDECAR=… DMUSE_SERVER=http://127.0.0.1:18080 DMUSE_CONTROL_KEY=… \
//     node test/fixtures/remote-fake-desktop.js [computer-name]
//
// It prints the pairing invite (QR text and code) and keeps running. A message containing
// "删除"/"delete" raises the safety-guard confirmation; "权限"/"permission" a tool approval; anything else
// gets a streamed answer after a tool call.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dmuse-fake-desktop-'));
process.env.DEEPSEEK_DESKTOP_HOME = process.env.DEEPSEEK_DESKTOP_HOME || home;
const { RemoteControl } = require('../../src/main/remote');

const workdir = path.join(home, 'work');
fs.mkdirSync(workdir, { recursive: true });
fs.writeFileSync(path.join(workdir, '周报.md'), '# 本周进展\n\n- 完成手机连接阶段 2\n- 修复冷启动重连\n');
fs.writeFileSync(path.join(workdir, 'data.csv'), 'day,tasks\nMon,3\nTue,5\n');

const ui = new Map([['remoteEnabled', true], ['remoteMaxPermission', 'workspace-write']]);
const sessions = new Map();
const permissions = new Map();
let seq = 0;
let control;

class FakeTranscript {
  constructor(sessionId, title) {
    Object.assign(this, { sessionId, title, running: false, items: [], approvals: new Map(), questions: new Map(), updatedAt: Date.now() });
  }
  snapshot() {
    return {
      sessionId: this.sessionId, title: this.title, running: this.running, lastSeq: seq, items: this.items,
      approvals: [...this.approvals.values()], questions: [...this.questions.values()],
      context: { pressure: { projectedTokens: 12000 + this.items.length * 900, contextWindow: 128000 } },
    };
  }
}

function changed(t, event) {
  t.updatedAt = Date.now();
  control?.onTranscript({ sessionId: t.sessionId, event: { type: event }, transcript: t.snapshot() });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function answer(t, text) {
  const tool = { kind: 'tool', seq: ++seq, time: Date.now(), callId: `c${seq}`, name: 'bash', summary: 'ls -la ~/work', arguments: '{"command":"ls -la ~/work"}', output: null, running: true };
  t.items.push(tool);
  changed(t, 'tool/call');
  await wait(800);
  Object.assign(tool, { running: false, output: '周报.md\ndata.csv' });
  changed(t, 'tool/result');
  const reply = { kind: 'assistant', seq: ++seq, time: Date.now(), streaming: true, parts: [{ kind: 'reasoning', text: '先看看工作目录里有什么。' }, { kind: 'text', text: '' }] };
  t.items.push(reply);
  const full = `好的，已经处理「${text}」。工作目录里有 周报.md 和 data.csv，周报已更新，可以在「文件」里查看。`;
  for (let i = 0; i < full.length; i += 6) {
    reply.parts[1].text = full.slice(0, i + 6);
    changed(t, 'assistant/chunk');
    await wait(120);
  }
  reply.streaming = false;
  t.running = false;
  t.items.push({ kind: 'turn-end', seq: ++seq, time: Date.now(), reason: 'completed' });
  changed(t, 'turn/end');
}

async function send(id, text) {
  const t = sessions.get(id);
  t.items.push({ kind: 'user', seq: ++seq, time: Date.now(), text, parts: [{ kind: 'text', text }] });
  if (!t.title) t.title = text.slice(0, 20);
  t.running = true;
  changed(t, 'turn/start');
  await wait(600);
  if (text.includes('删除') || /delete/i.test(text)) {
    const eventId = `q${++seq}`;
    t.questions.set(eventId, { eventId, questions: [{
      id: 'desktop-safety-guard', header: '高风险操作确认',
      question: 'DeepSeek 想执行一个高风险操作：会递归删除系统目录、用户主目录或当前目录下的全部内容。允许执行吗？',
      detail: 'rm -rf ~/work/*',
      options: [{ label: '允许这一次', description: '只放行这一条命令' }, { label: '不允许', description: '拦下这条命令，让 DeepSeek 换个做法' }],
    }] });
    changed(t, 'question/request');
    t.continueAfter = () => answer(t, text);
    return;
  }
  if (text.includes('权限') || /permission/i.test(text)) {
    const eventId = `a${++seq}`;
    t.approvals.set(eventId, { eventId, toolName: 'write_file', reason: '要写入工作目录以外的文件 ~/Desktop/汇总.xlsx' });
    changed(t, 'approval/request');
    t.continueAfter = () => answer(t, text);
    return;
  }
  await answer(t, text);
}

const chat = {
  transcripts: sessions,
  createSession: async () => {
    const id = `s${Date.now().toString(36)}`;
    sessions.set(id, new FakeTranscript(id, null));
    permissions.set(id, 'workspace-write');
    return { sessionId: id };
  },
  open: async (id) => sessions.get(id).snapshot(),
  cancel: async (id) => { const t = sessions.get(id); t.running = false; t.items.push({ kind: 'turn-end', seq: ++seq, reason: 'cancelled' }); changed(t, 'cancelled'); },
  answerApproval: async (id, eventId, outcome) => {
    const t = sessions.get(id);
    t.approvals.delete(eventId);
    changed(t, 'approval/answered');
    if (outcome === 'allowed-once') t.continueAfter?.(); else { t.running = false; changed(t, 'turn/end'); }
  },
  answerQuestion: async (id, eventId, answers) => {
    const t = sessions.get(id);
    t.questions.delete(eventId);
    changed(t, 'question/answered');
    if (JSON.stringify(answers ?? null).includes('允许这一次')) t.continueAfter?.();
    else { t.items.push({ kind: 'assistant', seq: ++seq, parts: [{ kind: 'text', text: '好的，没有执行删除。' }] }); t.running = false; changed(t, 'turn/end'); }
  },
};

const ctx = {
  uiStore: { get: (key, fallback) => (ui.has(key) ? ui.get(key) : fallback), set: (key, value) => ui.set(key, value) },
  defaultSessionOptions: () => ({ cwd: workdir }),
  chat,
  client: {
    permissions: async (id) => ({ currentValue: permissions.get(id) }),
    sessionModels: async () => ({ current: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' }, routable: true }),
    selectModel: async () => ({ selected: true }),
    listModels: async () => ({ groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [
      { id: 'deepseek-v4-pro', name: 'V4 Pro', reasoning: { efforts: [{ id: 'high', label: '高' }, { id: 'max', label: '最高' }], defaultEffort: 'high' } },
      { id: 'deepseek-v4-flash', name: 'V4 Flash', reasoning: { efforts: [] } },
    ] }] }),
  },
};

const sessionOps = {
  sessionRows: async () => [...sessions.values()].map((t) => ({ sessionId: t.sessionId, title: t.title, cwd: workdir, running: t.running, updatedAt: t.updatedAt, turns: t.items.filter((i) => i.kind === 'user').length, archived: false })),
  restorePermission: async () => {},
  selectPermission: async (id, preset) => { permissions.set(id, preset); return { currentValue: preset }; },
  prompt: async (id, text) => {
    if (!sessions.has(id)) throw Object.assign(new Error('没有这个对话'), { status: 404, code: 'not-found' });
    send(id, text);
    return {};
  },
};

(async () => {
  control = new RemoteControl({ getContext: () => ctx, sessions: sessionOps, version: 'fake', log: (...a) => console.error(...a),
    onState: (s) => {
      if (s.invite && control.inviteText && control.lastPrinted !== control.inviteText) {
        control.lastPrinted = control.inviteText;
        fs.writeFileSync(path.join(home, 'invite.txt'), control.inviteText);
        console.log(JSON.stringify({ invite: control.inviteText, code: s.invite.code, kind: s.invite.kind, file: path.join(home, 'invite.txt') }));
      }
      console.log(JSON.stringify({ status: s.status, phones: s.phones, connected: s.connected.map((c) => `${c.phone}:${c.connected}`) }));
    } });
  if (process.argv[2]) control.state.name = process.argv[2];
  await control.start();
  const timer = setInterval(() => {
    if (control.state.status === 'ready' || control.state.status === 'online') { clearInterval(timer); control.pair(); }
  }, 200);
  process.stdin.on('data', (line) => { if (String(line).trim() === 'pair') control.pair(); });
})();
