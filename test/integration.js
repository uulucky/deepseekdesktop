'use strict';
// Starts a private, pinned Harness; never probes an existing user's port or credentials.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const net = require('node:net');
const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dsdesk-isolated-'));
process.env.DEEPSEEK_DESKTOP_HOME = temporary;
process.env.DEEPSEEK_DESKTOP_NODE_BIN = process.execPath;
delete process.env.DEEPSEEK_API_KEY;
delete process.env.DSH_HOME;
const { Bootstrap } = require('../src/main/modules/bootstrap');
const { DeepSeekHarnessClient } = require('../src/main/modules/api');
const { applyHarnessCredential } = require('../src/main/modules/credentials');
const { ChatController } = require('../src/main/modules/chat');
const { startModelServer, eventually } = require('./fixtures/model-server');
const pins = require('../build/runtime-pins.json');
const entry = process.env.DSH_TEST_KERNEL_ENTRY || [
  path.join(root, 'vendor/kernel/node_modules/@deepseek-ai/dsh/lib/bin.js'),
  path.join(root, 'build/kernel/node_modules/@deepseek-ai/dsh/lib/bin.js'),
].find(fs.existsSync);
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  assert(entry, 'Stage the runtime first: npm run runtime:stage (Windows), or npm ci --prefix build/kernel (native)');
  assert.equal(require(path.resolve(entry, '../../package.json')).version, pins.kernelVersion);
  const port = await freePort();
  const provider = await startModelServer();
  process.env.DEEPSEEK_BASE_URL = provider.baseUrl;
  const boot = new Bootstrap({ port, emit: () => {} });
  let client, chat;
  try {
    boot.dshBin = entry;
    await boot.spawnServer(port);
    await boot.awaitReady(port);
    assert(boot.authCookie, 'Launch-token authentication is required');
    client = new DeepSeekHarnessClient(`http://127.0.0.1:${port}`, { cookie: boot.authCookie });
    assert.deepEqual(await client.listSessions(), [], 'Fresh test home has no user conversations');
    await assert.rejects(new DeepSeekHarnessClient(client.baseUrl).ping(), /认证|unauthorized/i);
    const created = await client.createSession({ agentPreset: 'standard', cwd: path.join(temporary, 'workspace') });
    assert(created.sessionId);
    for (const permission of ['read-only', 'workspace-write', 'danger-full-access', 'read-only']) {
      assert.equal((await client.selectPermission(created.sessionId, permission)).currentValue, permission);
    }
    assert(Array.isArray((await client.history(created.sessionId)).events));
    const catalog = await client.listModels();
    assert(catalog.groups.some(group => group.models.length > 0), 'Pinned kernel exposes models without a paid request');
    const configured = await applyHarnessCredential(client, 'DEEPSEEK_API_KEY', 'sk-isolated-fixture-not-a-real-key');
    assert(configured.configured, 'Credential compatibility path saves a fixture key');
    let ready = false;
    client.onHostFrame(frame => { if (frame.type === 'remote-events/ready') ready = true; });
    client.connect();
    for (let count = 0; count < 100 && !ready; count += 1) await delay(100);
    assert(ready, 'Authenticated approval event stream becomes ready');
    chat = new ChatController(client);
    const options = { agentPreset: 'standard', cwd: path.join(temporary, 'workspace') };
    fs.mkdirSync(options.cwd, { recursive: true });
    const a = (await chat.createSession(options)).sessionId;
    const group = catalog.groups.find(item => item.id === 'deepseek-official');
    assert(group, 'Pinned official provider is available');
    const model = group.models[0].id;
    await client.selectModel(a, group.id, model, 'off');
    await chat.send(a, 'multitask-fixture-A');
    const responseA = await provider.waitFor('multitask-fixture-A');
    responseA.delta('A partial');
    await eventually(() => chat.transcripts.get(a)?.items.some(item => item.parts?.some(part => part.text === 'A partial')), 'A streams live');
    // A remains deliberately unfinished while we create and send B through the real kernel.
    const b = (await chat.createSession(options)).sessionId;
    await client.selectModel(b, group.id, model, 'off');
    await chat.send(b, 'multitask-fixture-B');
    const responseB = await provider.waitFor('multitask-fixture-B');
    responseB.delta('B partial');
    assert(chat.transcripts.get(a).running && chat.transcripts.get(b).running, 'Both sessions run concurrently');
    assert(client.followedSessions.has(a) && client.followedSessions.has(b));
    await chat.open(a);
    await chat.cancel(a);
    await eventually(() => responseA.closed, 'Cancelling A aborts only its provider stream');
    assert.equal(responseB.closed, false, 'B stream survives A cancellation');
    responseB.finish(' B final');
    await eventually(() => !chat.transcripts.get(b).running, 'Background B settles without reopening the session');
    assert(chat.transcripts.get(b).items.some(item => item.parts?.some(part => part.text === 'B partial B final')));
    assert.equal((await client.listSessions()).find(item => item.sessionId === b).running, false);
    await client.renameSession(b, '可搜索的多任务对话');
    const renamed = (await client.listSessions()).find(item => item.sessionId === b);
    assert.equal(renamed.projections?.values?.title, '可搜索的多任务对话');
    const searched = await client.searchSessions('multitask-fixture-B');
    assert(searched.items.some(item => item.sessionId === b), 'Harness full-text search finds durable user content');
    const forked = await client.forkSession(b);
    const forkSummary = (await client.listSessions()).find(item => item.sessionId === forked.sessionId);
    assert.equal(forkSummary.parentSessionId, b, 'Copied conversation records its source without altering it');
    assert((await client.history(forked.sessionId, undefined, 8)).events.length > 0, 'Copied conversation retains completed history');

    await client.listWorkspaces();
    const registered = await client.createWorkspace(options.cwd);
    const inWorkspace = await client.createSession({ agentPreset: 'standard', workspaceId: registered.workspace.workspaceId });
    await eventually(async () => (await client.listWorkspaces()).items
      .find(item => item.workspaceId === registered.workspace.workspaceId)?.sessionIds.includes(inWorkspace.sessionId),
    'Workspace stream reflects a newly attached conversation');
    await client.archiveSession(b);
    assert((await client.listWorkspaces()).archivedSessionIds.includes(b), 'Archive state is durable and non-destructive');
    assert((await client.listSessions()).some(item => item.sessionId === b), 'Archived conversation remains in persistence');
    console.log('PASS isolated real Harness: authentication, permissions, credentials, models, approvals, concurrent tasks, search, rename, workspace, conversation copy and archive; no paid prompts');
  } finally {
    chat?.dispose();
    client?.dispose();
    await boot.stop();
    await provider.close();
    await delay(500);
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
