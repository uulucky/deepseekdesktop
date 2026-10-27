'use strict';
// 老友 (the main conversation): ledger rules and the loopback bridge without a kernel, then —
// when a pinned kernel is available — the real preset, fixed model and a dispatched task
// against a private kernel and a local fake model. Never contacts DeepSeek.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dsdesk-companion-'));
process.env.DEEPSEEK_DESKTOP_HOME = temporary;
process.env.DEEPSEEK_DESKTOP_NODE_BIN = process.execPath;
delete process.env.DEEPSEEK_API_KEY;
delete process.env.DSH_HOME;

const companionModule = require('../src/main/modules/companion');
const { Companion, statusOf, dispatchPermission, writePreset, companionPaths, PRESET_ID, MODEL } = companionModule;
const tools = require('../src/main/modules/companion/companion-tools.cjs');

const root = path.resolve(__dirname, '..');

function memoryStore() {
  const data = {};
  return { get: (key, fallback) => (key in data ? data[key] : fallback), set: (key, value) => { data[key] = value; return value; }, delete: (key) => { delete data[key]; } };
}

function post(port, tool, body, token) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const request = http.request({ host: '127.0.0.1', port, method: 'POST', path: `/tool/${tool}`, headers: {
      'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
    } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

async function unit() {
  // Status reads like the sidebar's.
  const transcript = (over) => ({ questions: new Map(), approvals: new Map(), running: false, items: [], ...over });
  assert.equal(statusOf(null, null), 'missing');
  assert.equal(statusOf(transcript({}), { archived: true }), 'archived');
  assert.equal(statusOf(transcript({ running: true, approvals: new Map([['a', {}]]) }), {}), 'waiting_approval');
  assert.equal(statusOf(transcript({ running: true, questions: new Map([['q', {}]]) }), {}), 'waiting_answer');
  assert.equal(statusOf(transcript({ running: true, items: [{ kind: 'user' }] }), {}), 'running');
  assert.equal(statusOf(transcript({ items: [] }), {}), 'idle');
  assert.equal(statusOf(transcript({ items: [{ kind: 'user' }, { kind: 'turn-end', reason: 'completed' }] }), {}), 'done');
  assert.equal(statusOf(transcript({ items: [{ kind: 'user' }, { kind: 'turn-end', reason: 'cancelled' }] }), {}), 'stopped');
  assert.equal(statusOf(transcript({ items: [{ kind: 'user' }, { kind: 'turn-end', reason: 'error', error: 'x' }] }), {}), 'failed');
  assert.equal(statusOf(null, { running: true }), 'running');

  // A dispatched task never gets Full Access.
  assert.equal(dispatchPermission(null), 'workspace-write');
  assert.equal(dispatchPermission('danger-full-access'), 'workspace-write');
  assert.equal(dispatchPermission('workspace-write'), 'workspace-write');
  assert.equal(dispatchPermission('read-only'), 'read-only');

  // The preset mounts the persona, compaction and our tools — no shell, files, web or subagents.
  const home = path.join(temporary, 'unit-harness');
  const dir = writePreset(home, '/x/companion-tools.cjs', '/x/bridge.json');
  const composition = fs.readFileSync(path.join(dir, 'agent.cordis.yml'), 'utf8');
  assert.equal(path.basename(dir), PRESET_ID);
  assert.match(composition, /@deepseek-ai\/dsh-persona/);
  assert.match(composition, /complete: true/);
  assert.match(composition, /"\/x\/companion-tools\.cjs"/);
  assert.doesNotMatch(composition, /dsh-tool-(bash|fs|web|subagent|pwsh|workflow)/);
  assert.deepEqual(tools.TOOLS.map((tool) => tool.name).sort(), [
    'companion_cancel', 'companion_dispatch', 'companion_list_tasks', 'companion_list_workspaces',
    'companion_send', 'companion_task_result', 'companion_task_status',
  ]);

  // Bridge: token, caller and tool name are all checked; limits refuse before creating anything.
  const uiStore = memoryStore();
  const created = [];
  const running = new Map(['t1', 't2', 't3'].map((id) => [id, transcript({ running: true, items: [{ kind: 'user' }] })]));
  const ctx = {
    uiStore,
    client: { listWorkspaces: async () => ({ items: [] }) },
    chat: { transcripts: running, createSession: async () => { created.push(1); return { sessionId: 'new' }; } },
    defaultSessionOptions: () => ({ agentPreset: 'standard', cwd: temporary }),
  };
  uiStore.set('companion', {
    sessionId: 'friend',
    dispatches: ['t1', 't2', 't3'].map((taskId) => ({ taskId, title: taskId, createdAt: 1 })),
    notified: {},
  });
  const rows = ['t1', 't2', 't3', 'mine'].map((sessionId) => ({ sessionId, title: sessionId, archived: false }));
  const companion = new Companion({
    getContext: () => ctx,
    sessions: { sessionRows: async () => rows, selectPermission: async () => {}, prompt: async () => {} },
    bridgeFile: path.join(temporary, 'unit-bridge.json'),
    home: path.join(temporary, 'unit-home'),
  });
  await companion.startBridge();
  try {
    const bridge = JSON.parse(fs.readFileSync(companion.bridgeFile, 'utf8'));
    assert.equal((fs.statSync(companion.bridgeFile).mode & 0o777).toString(8), '600');
    assert.equal((await post(bridge.port, 'companion_list_tasks', { sessionId: 'friend', args: {} })).status, 403, 'no token');
    assert.equal((await post(bridge.port, 'companion_list_tasks', { sessionId: 'friend', args: {} }, 'f'.repeat(64))).status, 403, 'wrong token');
    assert.equal((await post(bridge.port, 'companion_list_tasks', { sessionId: 'mine', args: {} }, bridge.token)).status, 403, 'not the companion');
    assert.equal((await post(bridge.port, 'companion_approve', { sessionId: 'friend', args: {} }, bridge.token)).body.code, 'unknown_tool');
    assert.equal((await post(bridge.port, 'select_permission', { sessionId: 'friend', args: {} }, bridge.token)).status, 404);
    const listed = await post(bridge.port, 'companion_list_tasks', { sessionId: 'friend', args: {} }, bridge.token);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.items.map((item) => item.status), ['running', 'running', 'running']);
    const refused = await post(bridge.port, 'companion_dispatch', { sessionId: 'friend', args: { title: '第四件', brief: '做点事' } }, bridge.token);
    assert.equal(refused.body.code, 'limit_reached');
    assert.equal(refused.body.running.length, 3);
    assert.equal(created.length, 0, 'nothing created over the limit');
    const foreign = await post(bridge.port, 'companion_send', { sessionId: 'friend', args: { taskId: 'mine', text: 'x' } }, bridge.token);
    assert.equal(foreign.body.code, 'not_dispatched');
    const stopForeign = await post(bridge.port, 'companion_cancel', { sessionId: 'friend', args: { taskId: 'mine' } }, bridge.token);
    assert.equal(stopForeign.body.code, 'not_dispatched');
    // Progress reaches the model once per change.
    running.set('t1', transcript({ items: [{ kind: 'user' }, { kind: 'assistant', parts: [{ kind: 'text', text: '整理好了' }] }, { kind: 'turn-end', reason: 'completed' }] }));
    const block = await companion.updatesBlock();
    assert.match(block, /^<desktop-task-updates>\n- 「t1」（t1）：已完成，最后一句：整理好了\n<\/desktop-task-updates>$/);
    assert.equal(await companion.updatesBlock(), '');
    const snapshot = await companion.snapshot();
    assert.equal(snapshot.receipts.length, 0, 'reported changes are not receipts any more');
    assert.equal(snapshot.counts.running, 2);
  } finally {
    companion.stop();
  }
  assert(!fs.existsSync(companion.bridgeFile), 'bridge file removed on stop');
  console.log('companion unit: ok');
}

async function endToEnd(entry) {
  const { Bootstrap } = require('../src/main/modules/bootstrap');
  const { DeepSeekHarnessClient } = require('../src/main/modules/api');
  const { applyHarnessCredential } = require('../src/main/modules/credentials');
  const { ChatController } = require('../src/main/modules/chat');
  const { startModelServer, eventually } = require('./fixtures/model-server');
  const net = require('node:net');
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const provider = await startModelServer();
  process.env.DEEPSEEK_BASE_URL = provider.baseUrl;
  const boot = new Bootstrap({ port, emit: () => {} });
  let client;
  let chat;
  let companion;
  try {
    boot.dshBin = entry;
    await boot.spawnServer(port);
    await boot.awaitReady(port);
    const paths = companionPaths();
    assert(fs.existsSync(path.join(paths.harnessHome, '.agent-presets', PRESET_ID, 'agent.cordis.yml')), 'preset staged at launch');
    client = new DeepSeekHarnessClient(`http://127.0.0.1:${port}`, { cookie: boot.authCookie });
    await applyHarnessCredential(client, 'DEEPSEEK_API_KEY', 'sk-isolated-fixture-not-a-real-key');
    client.connect();
    chat = new ChatController(client, { onUpdate: (payload) => companion?.onTranscript(payload) });
    const presets = await client.listAgentPresets();
    assert(presets.presets.some((preset) => preset.id === PRESET_ID), 'kernel lists the companion preset');

    const workspace = path.join(temporary, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const uiStore = memoryStore();
    const ctx = { client, chat, uiStore, defaultSessionOptions: () => ({ agentPreset: 'standard', cwd: workspace }) };
    const sessions = {
      sessionRows: async () => (await client.listSessions()).filter((item) => !item.blank).map((item) => ({
        sessionId: item.sessionId, title: item.projections?.values?.title ?? null, cwd: item.cwd, archived: false,
        running: Boolean(item.running), updatedAt: item.updatedAt, turns: item.projections?.values?.sessionStats?.turns ?? 0,
      })),
      selectPermission: (sessionId, preset) => client.selectPermission(sessionId, preset),
      prompt: (sessionId, text) => chat.send(sessionId, text, []),
    };
    companion = new Companion({ getContext: () => ctx, sessions, bridgeFile: paths.bridgeFile, home: paths.home });
    await companion.startBridge();

    // The conversation exists once, on its preset, with the fixed model and read-only permission.
    const id = await companion.ensure();
    assert.equal(await companion.ensure(), id, 'ensure is idempotent');
    const row = (await client.listSessions()).find((item) => item.sessionId === id);
    assert(row?.blank, 'listed as a blank conversation until the first message');
    const fixed = (await client.sessionModels(id)).current;
    assert.deepEqual({ provider: fixed.provider, model: fixed.model, reasoningEffort: fixed.reasoningEffort }, MODEL);
    assert.equal((await client.permissions(id)).currentValue, 'read-only');

    // Someone switches its model behind the desktop's back; the next message switches it back.
    await client.selectModel(id, 'deepseek-official', 'deepseek-v4-pro', 'high');
    const text = await companion.beforePrompt('companion-fixture-hello 帮我把发票整理一下');
    assert.equal((await client.sessionModels(id)).current.model, MODEL.model);
    await chat.send(id, text, []);
    const turn = await provider.waitFor('companion-fixture-hello');
    const toolNames = (turn.body.tools ?? []).map((tool) => tool.function?.name ?? tool.name).sort();
    assert.deepEqual(toolNames, tools.TOOLS.map((tool) => tool.name).sort(), `only companion tools: ${toolNames}`);
    assert.notEqual(turn.body.thinking?.type, 'enabled', 'thinking is off');
    const system = JSON.stringify(turn.body.messages.find((message) => message.role === 'system')?.content ?? '');
    assert.match(system, /老友/);
    turn.toolCall('call_dispatch_fixture', 'companion_dispatch', {
      title: '整理发票', brief: '把工作目录里的发票按月份归档，完成后列出每个月的文件数。', userQuote: '帮我把发票整理一下',
    });

    // The work conversation is an ordinary one: standard tools, the default model, workspace-write.
    const task = await provider.waitFor('老友派来的任务');
    assert((task.body.tools ?? []).some((tool) => (tool.function?.name ?? tool.name) === 'bash'), 'work conversation has the standard tools');
    const dispatch = companion.ledger().dispatches[0];
    assert(dispatch?.taskId, 'dispatch recorded');
    assert.equal((await client.permissions(dispatch.taskId)).currentValue, 'workspace-write');
    await eventually(async () => (await client.listSessions()).find((item) => item.sessionId === dispatch.taskId)?.projections?.values?.title === '整理发票', 'task renamed');
    await eventually(() => companion.describe(dispatch.taskId).status === 'running', 'task running');

    // The companion reads the tool result and answers; the task finishes.
    const followUp = await (async () => {
      await eventually(() => provider.requests.some((request) => JSON.stringify(request.body.messages).includes(dispatch.taskId)), 'companion got the dispatch result');
      return provider.requests.find((request) => JSON.stringify(request.body.messages).includes(dispatch.taskId));
    })();
    followUp.finish('好，我开了个工作对话去整理，弄好了告诉你。');
    task.finish('发票已经按月份整理好了：2026-09 有 4 个，2026-10 有 7 个。');
    await eventually(async () => { await companion.refreshRows(); return companion.describe(dispatch.taskId).status === 'done'; }, 'task done');
    const snapshot = await companion.snapshot();
    assert.equal(snapshot.receipts[0]?.taskId, dispatch.taskId, 'finished task shows as a receipt');
    const result = await companion.call('companion_task_result', { taskId: dispatch.taskId });
    assert.match(result.finalText, /<task-output>\n发票已经按月份整理好了/);
    const block = await companion.updatesBlock();
    assert.match(block, /「整理发票」.*已完成/);
    console.log('companion end-to-end: ok');
  } finally {
    companion?.stop();
    chat?.dispose?.();
    client?.dispose?.();
    await boot.stop().catch(() => {});
    await provider.close();
  }
}

async function main() {
  await unit();
  const entry = process.env.DSH_TEST_KERNEL_ENTRY || [
    path.join(root, 'vendor/kernel/node_modules/@deepseek-ai/dsh/lib/bin.js'),
    path.join(root, 'build/kernel/node_modules/@deepseek-ai/dsh/lib/bin.js'),
  ].find(fs.existsSync);
  if (entry) await endToEnd(entry);
  else console.log('companion end-to-end: skipped (no staged kernel; set DSH_TEST_KERNEL_ENTRY)');
}

main().then(() => {
  fs.rmSync(temporary, { recursive: true, force: true });
  process.exit(0);
}, (error) => {
  console.error(error);
  process.exit(1);
});
