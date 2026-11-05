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
const { Companion, statusOf, dispatchPermission, writePreset, companionPaths, profileText, PRESET_ID, MODEL, AUTO_MARKER, taskComplexity, taskEffort } = companionModule;
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

  // Complexity is assessed by the companion, with a fallback for old callers.
  assert.equal(taskComplexity({ title: '查电脑负载', brief: '查看 CPU、内存和磁盘' }), 'simple');
  assert.equal(taskComplexity({ title: '检查服务状态', brief: '排查内存泄漏并定位根因' }), 'complex');
  assert.equal(taskComplexity({ title: '整理文件', brief: '按月份分类' }), 'standard');
  assert.equal(taskComplexity({ complexity: 'complex', title: '查看文件' }), 'complex', 'semantic tool assessment wins');
  assert.equal(taskComplexity({ complexity: 'simple', brief: '说明'.repeat(2000) }), 'simple', 'long instructions do not imply complexity');
  assert.throws(() => taskComplexity({ complexity: 'ultra' }), /任务复杂度/);
  assert.equal(taskEffort('simple', [{ id: 'off' }, { id: 'high' }]), 'off');
  assert.equal(taskEffort('complex', [{ id: 'off' }, { id: 'high' }]), 'high');
  assert.equal(taskEffort('standard', [{ id: 'off' }, { id: 'low' }, { id: 'high' }]), 'low', 'use a supported moderate level');
  assert.equal(taskEffort('complex', []), undefined, 'no unsupported effort for non-reasoning models');

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
    'companion_cancel', 'companion_dispatch', 'companion_forget', 'companion_list_tasks', 'companion_list_workspaces',
    'companion_remember', 'companion_send', 'companion_set_profile', 'companion_task_result', 'companion_task_status',
  ]);
  assert.match(composition, /\{\{companion_profile\}\}/, 'persona takes the live profile');

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
    memoryFile: path.join(temporary, 'unit-memory.json'),
    profileFile: path.join(temporary, 'unit-profile.txt'),
  });
  await companion.startBridge();
  try {
    const bridge = JSON.parse(fs.readFileSync(companion.bridgeFile, 'utf8'));
    // Windows represents inherited ACL access as synthetic mode bits; it does
    // not implement POSIX 0600. Keep every token/role check on both platforms.
    if (process.platform !== 'win32') assert.equal((fs.statSync(companion.bridgeFile).mode & 0o777).toString(8), '600');
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

    // Name, what to call the user, and long-term memory, all local and fed to the persona.
    assert.equal(snapshot.name, '老朋友', 'default name');
    assert.match(fs.readFileSync(companion.profileFile, 'utf8'), /第一次聊天/);
    const named = await post(bridge.port, 'companion_set_profile', { sessionId: 'friend', args: { name: '阿鲸', userName: '老王' } }, bridge.token);
    assert.equal(named.body.name, '阿鲸');
    assert.equal((await companion.snapshot()).name, '阿鲸');
    const kept = await post(bridge.port, 'companion_remember', { sessionId: 'friend', args: { text: '在做 dmuse 手机端' } }, bridge.token);
    assert.equal(kept.body.id, 'm1');
    assert.equal((await post(bridge.port, 'companion_remember', { sessionId: 'friend', args: { text: '我的密码是 hunter2' } }, bridge.token)).body.code, 'sensitive');
    assert.equal((await post(bridge.port, 'companion_remember', { sessionId: 'friend', args: { text: 'key sk-abcdefghijklmnopqrstuv' } }, bridge.token)).body.code, 'sensitive');
    const profile = fs.readFileSync(companion.profileFile, 'utf8');
    assert.match(profile, /你的名字：阿鲸\n用户的称呼：老王/);
    assert.match(profile, /- \[m1\] 在做 dmuse 手机端/);
    assert.doesNotMatch(profile, /第一次聊天/, 'asks names only once');
    if (process.platform !== 'win32') assert.equal((fs.statSync(companion.memoryFile).mode & 0o777).toString(8), '600');
    assert.equal((await post(bridge.port, 'companion_forget', { sessionId: 'friend', args: { id: 'm1' } }, bridge.token)).body.ok, true);
    assert.match(fs.readFileSync(companion.profileFile, 'utf8'), /长期记忆：暂时还没有/);
    companion.setProfile({ name: '' });
    assert.equal(companion.name(), '老朋友', 'an empty name goes back to the default');
    assert.throws(() => companion.setProfile({ name: '一二三四五六七八九十一二三' }), /最多 12 个字/);
    assert.match(profileText({ name: '老朋友', named: false, userName: '', introduced: false, facts: [] }), /想叫你什么/);
  } finally {
    companion.stop();
  }
  assert(!fs.existsSync(companion.bridgeFile), 'bridge file removed on stop');

  // A finished task wakes the companion once; that turn cannot dispatch; a daily cap applies.
  {
    const sent = [];
    const tasks = new Map([['w1', transcript({ running: true, items: [{ kind: 'user' }] })]]);
    const store = memoryStore();
    store.set('companion', { sessionId: 'friend', dispatches: [{ taskId: 'w1', title: '整理发票', createdAt: 1 }], notified: {} });
    const auto = new Companion({
      getContext: () => ({
        uiStore: store,
        client: { sessionModels: async () => ({ current: { ...MODEL } }), listWorkspaces: async () => ({ items: [] }) },
        chat: { transcripts: tasks, send: async (id, text) => { sent.push({ id, text }); }, createSession: async () => assert.fail('no dispatch in an auto turn') },
        defaultSessionOptions: () => ({ cwd: temporary }),
      }),
      sessions: { sessionRows: async () => [{ sessionId: 'w1', title: '整理发票' }], selectPermission: async () => {}, prompt: async () => {} },
      bridgeFile: path.join(temporary, 'auto-bridge.json'), home: temporary,
      memoryFile: path.join(temporary, 'auto-memory.json'), profileFile: path.join(temporary, 'auto-profile.txt'),
    });
    assert.equal(await auto.autoReport(), false, 'nothing to report while running');
    tasks.set('w1', transcript({ items: [{ kind: 'user' }, { kind: 'assistant', parts: [{ kind: 'text', text: '归档好了' }] }, { kind: 'turn-end', reason: 'completed' }] }));
    tasks.set('friend', transcript({ running: true }));
    assert.equal(await auto.autoReport(), false, 'waits while the companion is answering');
    clearTimeout(auto.autoTimer);
    tasks.set('friend', transcript({}));
    assert.equal(await auto.autoReport(), true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].id, 'friend');
    assert.match(sent[0].text, /「整理发票」（w1）：已完成，最后一句：归档好了/);
    assert(sent[0].text.endsWith(AUTO_MARKER));
    assert.equal(await auto.autoReport(), false, 'one report per change');
    await assert.rejects(auto.dispatch({ title: 'x', brief: 'y' }), /自动进展通知/);
    await auto.beforePrompt('hi');
    store.set('companion', { ...store.get('companion'), autoReports: { day: new Date().toISOString().slice(0, 10), count: 20 }, notified: {} });
    assert.equal(await auto.autoReport(), false, 'daily cap');
    auto.setAutoReport(false);
    store.set('companion', { ...store.get('companion'), autoReports: { day: '', count: 0 }, notified: {} });
    assert.equal(await auto.autoReport(), false, 'switched off');
    auto.stop();
  }

  // Asked for from a phone: the phone's ceiling and the safety guard apply to the dispatch.
  {
    const store = memoryStore();
    store.set('companion', { sessionId: 'friend', dispatches: [], notified: {} });
    const guardFile = path.join(temporary, 'guard.json');
    const selected = [];
    const modelSelections = [];
    let remoteMax = 'read-only';
    const phoneCtx = {
      uiStore: store,
      remote: { maxPermission: () => remoteMax, guardFile: () => guardFile },
      client: { sessionModels: async () => ({ current: { ...MODEL } }), listWorkspaces: async () => ({ items: [] }), renameSession: async () => {},
        listModels: async () => ({ default: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'medium' }, groups: [{ id: 'deepseek-official', models: [{ id: 'deepseek-flash', reasoning: { efforts: [{ id: 'off' }, { id: 'medium' }, { id: 'high' }] } }] }] }),
        selectModel: async (...args) => { modelSelections.push(args); },
      },
      chat: { transcripts: new Map(), createSession: async () => ({ sessionId: `p${selected.length}` }) },
      defaultSessionOptions: () => ({ cwd: temporary }),
    };
    const phone = new Companion({
      getContext: () => phoneCtx,
      sessions: { sessionRows: async () => [], selectPermission: async (id, preset) => { selected.push(preset); }, prompt: async () => {} },
      bridgeFile: path.join(temporary, 'phone-bridge.json'), home: temporary,
      memoryFile: path.join(temporary, 'phone-memory.json'), profileFile: path.join(temporary, 'phone-profile.txt'),
    });
    store.set('defaultProvider', 'deepseek-official');
    store.set('defaultModel', 'deepseek-flash');
    store.set('defaultEffort', 'off');
    assert.equal(MODEL.reasoningEffort, 'off', 'only the main conversation is fixed to thinking off');
    await phone.beforePrompt('从手机', { origin: 'phone' });
    assert.equal((await phone.dispatch({ title: '手机派的', brief: '做点事', complexity: 'simple' })).permission, 'read-only');
    assert.equal(modelSelections.at(-1)[3], 'off', 'simple tasks turn reasoning off');
    fs.writeFileSync(guardFile, JSON.stringify({ enabled: false }));
    await assert.rejects(phone.dispatch({ title: '护栏关了', brief: '做点事' }), /安全护栏/);
    await phone.beforePrompt('从电脑');
    remoteMax = 'read-only';
    store.set('defaultEffort', 'high');
    assert.equal((await phone.dispatch({ title: '查电脑负载', brief: '查看 CPU、内存、磁盘和负载' })).permission, 'workspace-write');
    assert.equal(modelSelections.at(-1)[3], 'off', 'simple tasks ignore a saved high effort');
    assert.equal(store.get('defaultEffort'), 'high', 'automatic selection does not overwrite user preferences');
    await phone.beforePrompt('另一个明确任务');
    store.set('defaultEffort', 'off');
    await phone.dispatch({ title: '分析复杂问题', brief: '分析日志并定位根因', complexity: 'complex' });
    assert.equal(modelSelections.at(-1)[3], 'high', 'complex work raises reasoning despite a saved off effort');
    store.delete('defaultProvider');
    store.delete('defaultModel');
    store.delete('defaultEffort');
    await phone.beforePrompt('没有保存新对话偏好');
    await phone.dispatch({ title: '查电脑负载', brief: '查看 CPU、内存、磁盘和负载' });
    assert.equal(modelSelections.at(-1)[3], 'off', 'kernel default effort is not inherited either');
    await phone.beforePrompt('常规任务');
    const routine = await phone.dispatch({ title: '整理报告', brief: '整理多份报告并汇总', complexity: 'standard' });
    assert.equal(routine.complexity, 'standard');
    assert.equal(routine.reasoningEffort, 'medium');
    assert.equal(phone.ledger().dispatches.at(-1).reasoningEffort, 'medium');
    await phone.beforePrompt('模型选择失败');
    phoneCtx.client.selectModel = async () => { throw new Error('fixture selection failed'); };
    let prompted = false;
    phone.sessions.prompt = async () => { prompted = true; };
    await assert.rejects(phone.dispatch({ title: '复杂排错', brief: '排查根因', complexity: 'complex' }), /尚未开始执行/);
    assert.equal(prompted, false, 'selection failure must not execute using an inherited effort');
    phone.stop();
  }
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
    companion = new Companion({
      getContext: () => ctx, sessions, bridgeFile: paths.bridgeFile, home: paths.home,
      memoryFile: paths.memoryFile, profileFile: paths.profileFile,
    });
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
    assert.match(system, /你的名字：老朋友/, 'live profile in the persona');
    assert.match(system, /第一次聊天/, 'first chat asks for names');
    assert.match(system, /用户明确要求查看、检查、查询/, 'the running preset treats a concrete task as permission to dispatch');
    assert.match(system, /complexity/, 'the running persona assesses task complexity');
    assert.match(system, /查一下当前电脑的状态、负载情况/, 'computer status checks dispatch directly without a project-selection round trip');
    turn.toolCall('call_dispatch_fixture', 'companion_dispatch', {
      title: '整理发票', complexity: 'standard', brief: '把工作目录里的发票按月份归档，完成后列出每个月的文件数。', userQuote: '帮我把发票整理一下',
    });

    // The work conversation is an ordinary one: standard tools, the default model, workspace-write.
    const task = await provider.waitFor('老朋友派来的任务').catch(error => {
      console.error('companion fixture tool replies:', provider.requests.flatMap(request => request.body.messages.filter(message => message.role === 'tool')));
      console.error('companion fixture task events:', companion.ledger().dispatches.map(row => chat.transcripts.get(row.taskId)?.items));
      throw error;
    });
    const nativeShell = process.platform === 'win32' ? 'pwsh' : 'bash';
    assert((task.body.tools ?? []).some((tool) => (tool.function?.name ?? tool.name) === nativeShell), `work conversation has the native ${nativeShell} tool`);
    const dispatch = companion.ledger().dispatches[0];
    assert(dispatch?.taskId, 'dispatch recorded');
    assert.equal((await client.permissions(dispatch.taskId)).currentValue, 'workspace-write');
    assert(['low', 'medium', 'high'].includes((await client.sessionModels(dispatch.taskId)).current.reasoningEffort), 'real kernel receives a supported moderate effort, not the default off');
    assert.equal(task.body.thinking?.type, 'enabled', 'work request enables reasoning for routine multi-step work');
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
    const result = await companion.call('companion_task_result', { taskId: dispatch.taskId });
    assert.match(result.finalText, /<task-output>\n发票已经按月份整理好了/);

    // The finished task wakes the companion by itself, once, with the progress block.
    const report = await provider.waitFor(AUTO_MARKER);
    const reportText = JSON.stringify(report.body.messages);
    assert.match(reportText, /「整理发票」.*已完成/);
    report.finish('发票整理好了：9 月 4 个、10 月 7 个。');
    await eventually(async () => !(await companion.snapshot()).receipts.length, 'reported tasks leave the receipts');
    assert.equal(await companion.updatesBlock(), '', 'already reported');

    // A rename and a memory reach the next model step without restarting anything.
    companion.setProfile({ name: '阿鲸', userName: '老王' });
    companion.remember({ text: '喜欢简短的回答' });
    await chat.send(id, await companion.beforePrompt('companion-fixture-again'), []);
    const again = await provider.waitFor('companion-fixture-again');
    const againSystem = JSON.stringify(again.body.messages);
    assert.match(againSystem, /你的名字：阿鲸/);
    assert.match(againSystem, /\[m1\] 喜欢简短的回答/);
    again.finish('好的老王。');
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
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  process.exit(0);
}, (error) => {
  console.error(error);
  process.exit(1);
});
