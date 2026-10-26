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
  // A user-added MCP server must reach the kernel through the desktop's launch patch.
  require('../src/main/modules/mcp-servers').saveServer(path.join(temporary, 'config'), {
    name: 'fixture', transport: 'stdio', command: process.execPath, args: [path.join(__dirname, 'fixtures/mcp-server.js')],
  });
  process.env.DEEPSEEK_BASE_URL = provider.baseUrl;
  let boot = new Bootstrap({ port, emit: () => {} });
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
    // OCR fallback keys off declared input modalities; the official text models must declare them.
    // OCR fallback mirrors which official models the pinned kernel lets see images.
    const llmSource = fs.readFileSync(path.join(path.dirname(require.resolve('@deepseek-ai/dsh-llm-deepseek', { paths: [path.dirname(entry)] })), 'index.js'), 'utf8');
    const defaults = llmSource.slice(llmSource.indexOf('const DEFAULT_MODELS'), llmSource.indexOf('const MODEL_MODALITIES'));
    const imageModels = [...defaults.matchAll(/id: "([^"]+)"[^}]*?inputModalities: \["text", "image"\]/g)].map(match => match[1]);
    assert.deepEqual([...require('../src/main/modules/image-ocr').BUILTIN_IMAGE_MODELS].sort(), imageModels.sort(), 'OCR image-model list matches the pinned kernel');
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
    const offeredTools = (responseA.body.tools ?? []).map(tool => tool.function?.name ?? tool.name);
    assert(offeredTools.includes('mcp__fixture__echo'), `Configured MCP tool reaches the model: ${offeredTools.join(', ')}`);
    console.log('PASS real Harness MCP: a server saved in desktop settings is launched and its tool is offered to the model');
    assert.match(JSON.stringify(responseA.body.messages), /Media tools on this computer: ffmpeg (?:is installed at|is NOT installed)/,
      'Detected media tools reach the system prompt');

    // A Claude skill linked from Settings is discovered live by the running kernel.
    const fakeHome = path.join(temporary, 'fake-home');
    const fixtureSkill = path.join(fakeHome, '.claude', 'skills', 'fixture-skill');
    fs.mkdirSync(fixtureSkill, { recursive: true });
    fs.writeFileSync(path.join(fixtureSkill, 'SKILL.md'), '---\nname: fixture-skill\ndescription: Desktop integration fixture skill.\n---\n\nSay hello.\n');
    const bridge = require('../src/main/modules/skill-bridge');
    const listed = bridge.listSkills(temporary, fakeHome).skills.find(item => item.name === 'fixture-skill');
    assert(listed && !listed.enabled, 'Claude skill is offered for import');
    assert(bridge.setSkillEnabled(temporary, listed.id, true, fakeHome).skills.find(item => item.id === listed.id).enabled);
    const skillNames = async () => JSON.stringify(await client.listSkills(a).catch(error => String(error)));
    await eventually(async () => (await skillNames()).includes('fixture-skill'), 'Linked skill is discovered by the running kernel');
    bridge.setSkillEnabled(temporary, listed.id, false, fakeHome);
    assert(fs.existsSync(path.join(fixtureSkill, 'SKILL.md')), 'Disabling removes only the link, never the source skill');
    console.log('PASS real Harness skills: a Claude skill linked from desktop settings is discovered live and unlinks cleanly');
    assert(responseA.body.messages.some(message => message.role === 'system'
      && JSON.stringify(message.content).includes('<desktop-summary>')), 'Desktop action summary instruction reaches the actual model request');
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

    const attachmentSession = (await chat.createSession(options)).sessionId;
    await client.selectModel(attachmentSession, group.id, model, 'off');
    const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    await chat.send(attachmentSession, 'attachment-fixture', [
      { kind: 'image', name: 'pasted.png', mediaType: 'image/png', bytes: tinyPng },
      { kind: 'file', name: 'notes.txt', mediaType: 'text/plain', bytes: Buffer.from('Harness file upload fixture') },
    ]);
    const findAttachmentRequest = () => provider.requests.find((request) => (
      request.body.messages?.some((message) => message.role === 'user'
        && JSON.stringify(message.content).includes('attachment-fixture'))
      && request.body.messages?.some((message) => message.role === 'system'
        && JSON.stringify(message.content).includes('<desktop-summary>'))
    ));
    await eventually(findAttachmentRequest, 'Local provider did not receive the attachment task');
    const attachmentResponse = findAttachmentRequest();
    const requestJson = JSON.stringify(attachmentResponse.body.messages);
    assert(requestJson.includes('image_url'), 'Pasted image reaches the actual multimodal model request');
    assert(
      requestJson.includes('notes.txt') && requestJson.includes('sha256:')
        && requestJson.includes('verbatim read-only copy saved at'),
      'Selected file is staged and its platform-native readable Harness reference reaches the model context',
    );
    attachmentResponse.finish('attachment ok');
    await eventually(() => !chat.transcripts.get(attachmentSession)?.running, 'Attachment turn settles');
    await eventually(() => {
      const pressure = chat.transcripts.get(attachmentSession)?.snapshot().context.pressure;
      return Number.isFinite(pressure?.pressureTokens ?? pressure?.projectedTokens)
        && Number.isFinite(pressure?.contextWindow);
    }, 'Live context projection reaches the desktop transcript');

    await client.listWorkspaces();
    const registered = await client.createWorkspace(options.cwd);
    const inWorkspace = await client.createSession({ agentPreset: 'standard', workspaceId: registered.workspace.workspaceId });
    await eventually(async () => (await client.listWorkspaces()).items
      .find(item => item.workspaceId === registered.workspace.workspaceId)?.sessionIds.includes(inWorkspace.sessionId),
    'Workspace stream reflects a newly attached conversation');
    await client.archiveSession(b);
    assert((await client.listWorkspaces()).archivedSessionIds.includes(b), 'Archive state is durable and non-destructive');
    assert((await client.listSessions()).some(item => item.sessionId === b), 'Archived conversation remains in persistence');
    // Safety guard: a scripted destructive bash call under Full Access must stop at the inline
    // question card, and a refusal must reach the model as a blocked tool result.
    const guarded = (await chat.createSession(options)).sessionId;
    await client.selectModel(guarded, group.id, model, 'off');
    assert.equal((await client.selectPermission(guarded, 'danger-full-access')).currentValue, 'danger-full-access');
    let guardQuestion = null;
    const stopGuardWatch = client.onHostFrame(frame => {
      if (frame.type === 'question/request' && frame.sessionId === guarded) guardQuestion = frame.question;
    });
    const before = provider.requests.length;
    await chat.send(guarded, 'safety-guard-fixture');
    const guardTurn = await provider.waitFor('safety-guard-fixture');
    guardTurn.toolCall('call_guard_fixture', 'bash', { command: 'git reset --hard', description: 'fixture destructive command' });
    await eventually(() => guardQuestion, 'Safety guard asks before a destructive command');
    assert.match(JSON.stringify(guardQuestion.questions), /高风险操作确认/);
    assert.match(JSON.stringify(guardQuestion.questions), /git reset --hard/);
    await chat.answerQuestion(guarded, guardQuestion.eventId, [{ id: 'desktop-safety-guard', selected: ['不允许'] }]);
    const findBlocked = () => provider.requests.slice(before).find(request => request.body.messages?.some(message => (
      message.role === 'tool' && JSON.stringify(message.content).includes('safety guard blocked'))));
    await eventually(findBlocked, 'Refused command returns a blocked tool result to the model');
    findBlocked().finish('已按你的要求跳过这条命令');
    await eventually(async () => !(await client.listSessions()).find(item => item.sessionId === guarded)?.running,
      'Guarded turn finishes after the refusal');
    stopGuardWatch?.();
    console.log('PASS real Harness safety guard: Full Access destructive command waits for the inline confirmation and a refusal blocks it');

    // A renamed session with no prompt is still cold after a process restart. The
    // list endpoint must not be assumed to activate its Agent/permission projection.
    const coldSession = await client.createSession(options);
    await client.selectPermission(coldSession.sessionId, 'read-only');
    await client.renameSession(coldSession.sessionId, 'Cold permission restart fixture');
    const child = boot.child;
    chat.dispose();
    client.dispose();
    await boot.stop();
    await eventually(() => child.exitCode !== null || child.signalCode !== null, 'Private Harness exits before restart');
    const restartedPort = await freePort();
    boot = new Bootstrap({ port: restartedPort, emit: () => {} });
    boot.dshBin = entry;
    await boot.spawnServer(restartedPort);
    await boot.awaitReady(restartedPort);
    client = new DeepSeekHarnessClient(`http://127.0.0.1:${restartedPort}`, { cookie: boot.authCookie });
    const cold = (await client.listSessions()).find(item => item.sessionId === coldSession.sessionId);
    assert(cold, 'Renamed no-prompt session survives restart');
    const permission = await client.permissions(coldSession.sessionId);
    assert(permission.options.some(item => item.value === 'read-only'), 'Cold session exposes actual kernel permission choices');
    assert.equal((await client.selectPermission(coldSession.sessionId, 'read-only')).currentValue, 'read-only');
    await client.selectModel(coldSession.sessionId, group.id, model, 'off');
    await client.prompt(coldSession.sessionId, 'cold-restart-fixture');
    const resumedResponse = await provider.waitFor('cold-restart-fixture');
    resumedResponse.finish('Cold restart works');
    await eventually(async () => !(await client.listSessions()).find(item => item.sessionId === coldSession.sessionId)?.running,
      'Restarted cold session finishes a real fixture turn');
    console.log('PASS real Harness cold-session restart, permission discovery and confirmed read-only restoration');

    console.log('PASS isolated real Harness: authentication, permissions, credentials, models, context meter, image/file attachments, concurrent tasks, search, rename, workspace, conversation copy and archive; no paid prompts');
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
