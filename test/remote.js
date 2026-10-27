'use strict';
// Phone remote: the loopback gateway, the rules a phone is held to, and the QR encoder.
// The sidecar is not started here; requests arrive the way it delivers them, after the
// "DMUSE/1 <secret> <phone>" line.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dsdesk-remote-'));
process.env.DEEPSEEK_DESKTOP_HOME = temporary;
const { DIRS } = require('../src/main/modules/util');
const { RemoteControl } = require('../src/main/remote');
const { RemoteGateway, parsePreamble } = require('../src/main/remote/gateway');
const rules = require('../src/main/remote/rules');
const qr = require('../src/main/remote/qr');

fs.mkdirSync(DIRS.config, { recursive: true });
const guardFile = path.join(DIRS.config, 'safety-guard.json');
const setGuard = (enabled) => fs.writeFileSync(guardFile, JSON.stringify({ enabled }));

// ----------------------------------------------------------------- rules + QR
assert.deepEqual(rules.capPermission('danger-full-access', 'danger-full-access'), { preset: 'workspace-write', capped: true });
assert.deepEqual(rules.capPermission('danger-full-access', 'danger-full-access', { elevated: true }), { preset: 'danger-full-access', capped: false });
assert.deepEqual(rules.capPermission('workspace-write', 'read-only'), { preset: 'read-only', capped: true });
assert.deepEqual(rules.capPermission('bogus', 'workspace-write'), { preset: 'workspace-write', capped: true });
assert.equal(rules.maxPermission('nonsense'), 'workspace-write');
assert.equal(qr.encode('x'.repeat(200)).length, 57, 'a 200-byte invite fits version 10');
assert.match(qr.toSvg('dmuse:1:abc'), /^<svg [^>]*viewBox="0 0 29 29"/);
assert.equal(parsePreamble(`DMUSE/1 ${'a'.repeat(64)} "pixel"`, 'a'.repeat(64)), 'pixel');
assert.equal(parsePreamble(`DMUSE/1 ${'b'.repeat(64)} "pixel"`, 'a'.repeat(64)), null);
assert.throws(() => new RemoteGateway({ secret: 'short', api: {} }), /strong secret/);

// ------------------------------------------------------------- fake desktop
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsdesk-remote-cwd-'));
fs.writeFileSync(path.join(workdir, 'report.txt'), 'done');
fs.writeFileSync(path.join(temporary, 'secret.txt'), 'nope');
fs.symlinkSync(path.join(temporary, 'secret.txt'), path.join(workdir, 'link.txt'));

const permissions = new Map([['s1', 'danger-full-access']]);
const prompts = [];
const answered = [];
const ui = new Map();
const transcript = {
  sessionId: 's1', title: '整理报告', running: false,
  approvals: new Map(),
  questions: new Map([['q1', { eventId: 'q1', questions: [{ id: 'desktop-safety-guard', header: '高风险操作确认' }] }]]),
};
const ctx = {
  uiStore: { get: (key, fallback) => (ui.has(key) ? ui.get(key) : fallback), set: (key, value) => ui.set(key, value) },
  defaultSessionOptions: () => ({ cwd: workdir }),
  client: {
    permissions: async (id) => ({ currentValue: permissions.get(id) }),
    sessionModels: async () => ({ current: { provider: 'deepseek', model: 'v4' }, routable: [] }),
    selectModel: async () => ({ selected: true }),
    listModels: async () => ({ groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'v4', name: 'V4', reasoning: { efforts: [{ id: 'high', label: '高' }, 'max'], defaultEffort: 'high' } }] }] }),
  },
  chat: {
    transcripts: new Map([['s1', transcript]]),
    createSession: async () => { permissions.set('s2', 'danger-full-access'); return { sessionId: 's2' }; },
    open: async (id) => ({ sessionId: id, items: Array.from({ length: 300 }, (_, i) => ({ kind: 'user', text: `m${i}` })) }),
    cancel: async () => {},
    answerApproval: async () => {},
    answerQuestion: async (id, eventId, answers) => answered.push({ id, eventId, answers }),
  },
};
const sessions = {
  sessionRows: async () => [{ sessionId: 's1', cwd: workdir, archived: false }, { sessionId: 'old', archived: true }],
  restorePermission: async () => {},
  selectPermission: async (id, preset) => { permissions.set(id, preset); return { currentValue: preset }; },
  prompt: async (id, text, attachments) => { prompts.push({ id, text, attachments, permission: permissions.get(id) }); },
};

function request(port, secret, phone, method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      method, path: route, headers: { 'content-type': 'application/json', ...headers },
      createConnection: () => {
        const socket = net.connect(port, '127.0.0.1');
        socket.write(`DMUSE/1 ${secret} ${JSON.stringify(phone)}\n`);
        return socket;
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* file bodies */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function rawConnection(port, firstLine) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(firstLine));
    let data = '';
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('close', () => resolve(data));
    socket.on('error', () => resolve(data));
    setTimeout(() => socket.write('GET /v1/info HTTP/1.1\r\nHost: x\r\n\r\n'), 50);
  });
}

(async () => {
  setGuard(true);
  const control = new RemoteControl({ getContext: () => ctx, sessions, version: '9.9.9' });
  const secret = 'f'.repeat(64);
  let connected = [];
  const gateway = new RemoteGateway({ secret, api: control.api(), onPhones: (list) => { connected = list; } });
  control.gateway = gateway;
  const port = await gateway.listen();
  const call = (...args) => request(port, secret, 'pixel', ...args);

  // Only the sidecar's secret opens the API.
  assert.equal(await rawConnection(port, 'GET /v1/info HTTP/1.1\r\nHost: x\r\n\r\n'), '');
  assert.equal(await rawConnection(port, `DMUSE/1 ${'e'.repeat(64)} "pixel"\n`), '');
  const info = await call('GET', '/v1/info');
  assert.equal(info.status, 200);
  assert.deepEqual(info.json, { desktop: os.hostname(), version: '9.9.9', platform: process.platform, maxPermission: 'workspace-write', guard: true, keepAwake: false, phone: 'pixel' });
  assert.equal(connected.find((entry) => entry.phone === 'pixel')?.phone, 'pixel');

  // Lists hide archived sessions; transcripts are trimmed for a phone.
  assert.deepEqual((await call('GET', '/v1/sessions')).json.items.map((row) => row.sessionId), ['s1']);
  const opened = (await call('GET', '/v1/sessions/s1?limit=50')).json;
  assert.equal(opened.items.length, 50);
  assert.equal(opened.items[49].text, 'm299');
  assert.equal(opened.truncated, true);

  // A Full Access session is brought down to the ceiling before the phone's prompt runs.
  const sent = await call('POST', '/v1/sessions/s1/messages', { text: '整理一下', attachments: [{ name: 'a.txt', mediaType: 'text/plain', data: Buffer.from('hi').toString('base64') }] });
  assert.equal(sent.status, 200);
  assert.equal(prompts[0].permission, 'workspace-write');
  assert.equal(prompts[0].attachments[0].bytes.toString(), 'hi');
  // Full Access needs the phone's fresh verification and a ceiling that allows it.
  control.setMaxPermission('danger-full-access');
  const elevated = await call('POST', '/v1/sessions/s1/permission', { preset: 'danger-full-access' }, { 'x-dmuse-elevated': '1' });
  assert.deepEqual(elevated.json, { current: 'danger-full-access', capped: false });
  const plain = await call('POST', '/v1/sessions/s1/permission', { preset: 'danger-full-access' });
  assert.deepEqual(plain.json, { current: 'workspace-write', capped: true });
  control.setMaxPermission('read-only');
  await call('POST', '/v1/sessions/s1/messages', { text: '再看看' });
  assert.equal(prompts[1].permission, 'read-only');
  const created = (await call('POST', '/v1/sessions', {})).json;
  assert.deepEqual([created.sessionId, created.permission, permissions.get('s2')], ['s2', 'read-only', 'read-only']);
  control.setMaxPermission('workspace-write');

  // With the guard off on the computer, the phone can neither start work nor approve.
  setGuard(false);
  const blocked = await call('POST', '/v1/sessions/s1/messages', { text: 'rm -rf' });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.error.code, 'guard-off');
  assert.equal((await call('POST', '/v1/sessions/s1/approvals/a1', { outcome: 'allow' })).status, 403);
  setGuard(true);

  // Allowing a risky command needs the phone to have just verified its owner.
  const allow = { answers: [{ selected: ['允许这一次'] }] };
  const unverified = await call('POST', '/v1/sessions/s1/questions/q1', allow);
  assert.equal(unverified.json.error.code, 'needs-verification');
  assert.equal(answered.length, 0);
  assert.equal((await call('POST', '/v1/sessions/s1/questions/q1', { answers: [{ selected: ['不允许'] }] })).status, 200);
  assert.equal((await call('POST', '/v1/sessions/s1/questions/q1', allow, { 'x-dmuse-elevated': '1' })).status, 200);
  assert.equal(answered.length, 2);
  const pending = (await call('GET', '/v1/pending')).json.items;
  assert.equal(pending[0].risky, true);

  // Files: only inside the session's working directory, symlinks included.
  const file = await call('GET', '/v1/sessions/s1/files?path=report.txt');
  assert.deepEqual([file.status, file.text], [200, 'done']);
  const outside = encodeURIComponent(path.relative(workdir, path.join(temporary, 'secret.txt')));
  assert.equal((await call('GET', `/v1/sessions/s1/files?path=${outside}`)).status, 403);
  assert.equal((await call('GET', '/v1/sessions/s1/files?path=missing.txt')).status, 404);
  const absolute = await call("GET", `/v1/sessions/s1/files?path=${encodeURIComponent(path.join(temporary, "secret.txt"))}`);
  assert.equal(absolute.status, 403, absolute.text);
  assert.equal((await call('GET', '/v1/sessions/s1/files?path=link.txt')).status, 403);
  assert.equal((await call('GET', '/v1/settings')).status, 404, 'no settings endpoint exists');
  fs.mkdirSync(path.join(workdir, 'node_modules'));
  fs.writeFileSync(path.join(workdir, 'node_modules', 'dep.js'), 'x');
  const listed = (await call('GET', '/v1/sessions/s1/files')).json.items.map((item) => item.path);
  assert.ok(listed.includes('report.txt') && !listed.some((p) => p.startsWith('node_modules')), JSON.stringify(listed));

  // The event stream carries compact session summaries.
  const events = await new Promise((resolve) => {
    const req = http.request({
      path: '/v1/events',
      createConnection: () => { const s = net.connect(port, '127.0.0.1'); s.write(`DMUSE/1 ${secret} "pixel"\n`); return s; },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
        if (data.includes('event: hello')) {
          control.onTranscript({ sessionId: 's1', event: { type: 'turn/end' }, transcript: { title: '整理报告', running: false, approvals: [], questions: [{}], lastSeq: 7, items: [{ kind: 'assistant', parts: [{ kind: 'text', text: '报告已生成' }] }] } });
        }
        if (data.includes('event: session')) { req.destroy(); resolve(data); }
      });
    });
    req.end();
  });
  const frame = JSON.parse(events.split('event: session\ndata: ')[1].split('\n')[0]);
  assert.deepEqual(frame, { sessionId: 's1', title: '整理报告', running: false, approvals: 0, questions: 1, lastSeq: 7, last: { kind: 'assistant', text: '报告已生成', streaming: false } });

  // Keep-awake: the one setting a phone may change, held only while the remote runs.
  const held = [];
  control.power = { start: (type) => { held.push(type); return 7; }, stop: (id) => held.push(`stop:${id}`) };
  control.child = { stdin: { write() {}, end() {} } };
  ui.set('remoteEnabled', true);
  const awake = await call('POST', '/v1/keep-awake', { on: true });
  assert.deepEqual([awake.json.keepAwake, awake.json.awake, held], [true, true, ['prevent-app-suspension']]);
  assert.equal((await call('GET', '/v1/info')).json.keepAwake, true);
  assert.equal((await call('POST', '/v1/keep-awake', { on: false })).json.awake, false);
  assert.deepEqual(held, ['prevent-app-suspension', 'stop:7']);
  control.setKeepAwake(true);
  control.child = null;
  control.applyKeepAwake();
  assert.equal(control.snapshot().awake, false, 'released when the remote stops');
  ui.delete('remoteEnabled');

  const catalog = (await call('GET', '/v1/catalog')).json;
  assert.deepEqual(catalog.groups[0].models[0].efforts, [{ id: 'high', label: '高' }, { id: 'max', label: 'max' }]);

  // A phone can ask to be forgotten.
  const revoked = [];
  control.command = (op, extra) => revoked.push([op, extra]);
  assert.equal((await request(port, secret, 'old-phone', 'POST', '/v1/unpair', {})).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(revoked, [['revoke', { phone: 'old-phone' }]]);

  // Revoking on the desktop drops the phone's live connections.
  const hanging = net.connect(port, '127.0.0.1');
  hanging.write(`DMUSE/1 ${secret} "lost-phone"\n`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const closed = new Promise((resolve) => hanging.on('close', resolve));
  gateway.disconnect('lost-phone');
  await closed;
  assert.equal(connected.some((entry) => entry.phone === 'lost-phone'), false);

  gateway.close();
  fs.rmSync(temporary, { recursive: true, force: true });
  fs.rmSync(workdir, { recursive: true, force: true });
  console.log('PASS phone remote: sidecar secret, permission ceiling, guard, risky confirmations, file containment, events, revoke, QR');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
