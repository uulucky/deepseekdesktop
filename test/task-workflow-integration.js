'use strict';
// Real pinned kernel, real child tools and files, scripted loopback model. No paid calls,
// user profile, account, production service or existing application instance is accessed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dsdesk-task-workflow-'));
process.env.DEEPSEEK_DESKTOP_HOME = temporary;
process.env.DEEPSEEK_DESKTOP_NODE_BIN = process.execPath;
delete process.env.DEEPSEEK_API_KEY;
delete process.env.DSH_HOME;
const { Bootstrap } = require('../src/main/modules/bootstrap');
const { DeepSeekHarnessClient } = require('../src/main/modules/api');
const { ChatController } = require('../src/main/modules/chat');
const { applyHarnessCredential } = require('../src/main/modules/credentials');
const { startModelServer, eventually } = require('./fixtures/model-server');
const root = path.resolve(__dirname, '..');
const entry = process.env.DSH_TEST_KERNEL_ENTRY || ['vendor/kernel', 'build/kernel'].map(dir => path.join(root, dir, 'node_modules/@deepseek-ai/dsh/lib/bin.js')).find(fs.existsSync);

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function main() {
  assert(entry, 'Stage the pinned kernel before integration testing');
  const provider = await startModelServer();
  process.env.DEEPSEEK_BASE_URL = provider.baseUrl;
  const workspace = path.join(temporary, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'requirements.txt'), 'alpha\nbeta\n');
  const plan = {
    goal: 'workflow-fixture-goal: create a.txt and b.txt and integrate them into combined.txt; preserve requirements.txt.',
    tasks: ['a', 'b'].map((id, i) => ({ id, title: `fixture-${id}`, brief: `Create ${id}.txt with ${i ? 'beta' : 'alpha'}. Preserve existing files.`,
      dependsOn: i ? ['a'] : [], acceptance: [{ id, text: `${id}.txt contains ${i ? 'beta' : 'alpha'}` }] })),
    acceptance: [{ id: 'all', text: 'combined.txt contains alpha and beta, matching requirements.txt' }],
  };
  let boot, client, chat;
  async function launch() {
    const port = await freePort();
    boot = new Bootstrap({ port, emit: () => {} });
    boot.dshBin = entry;
    await boot.spawnServer(port);
    await boot.awaitReady(port);
    client = new DeepSeekHarnessClient(`http://127.0.0.1:${port}`, { cookie: boot.authCookie });
    client.connect();
    chat = new ChatController(client);
  }
  async function nextRequest(predicate, from) {
    let request;
    await eventually(() => (request = provider.requests.slice(from).find(predicate)), 'Expected workflow model request', 25000).catch(error => {
      console.error('Fixture request diagnostics:', provider.requests.slice(from).map(request => request.body.messages.filter(message => message.role === 'tool').slice(-1)));
      throw error;
    });
    return request;
  }
  const names = request => (request.body.tools ?? []).map(tool => tool.function?.name ?? tool.name);
  let cursor = 0;
  let number = 0;
  let targetWorkspace = workspace;
  async function completeStage(stage) {
    let child = await nextRequest(request => request.body.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes(`· ${stage}`)), cursor);
    cursor = provider.requests.length;
    assert(!names(child).some(name => /^(desktop_|subagent_fork|workflow|ralph)/.test(name)), 'Child does not inherit workflow tools');
    if (number === 0) {
      child.toolCall('forbidden-recursion', 'subagent', { description: 'forbidden child', prompt: 'Do not run this', run_in_background: false });
      child = await nextRequest(request => request.body.messages.some(message => message.role === 'tool' && message.tool_call_id === 'forbidden-recursion'), cursor);
      assert.match(JSON.stringify(child.body.messages), /Automatic workflow children cannot delegate/);
      cursor = provider.requests.length;
    }
    const id = stage.endsWith(' a') ? 'a' : stage.endsWith(' b') ? 'b' : 'all';
    const content = id === 'a' ? 'alpha' : id === 'b' ? 'beta' : 'alpha\nbeta';
    const file = path.join(targetWorkspace, id === 'all' ? 'combined.txt' : `${id}.txt`);
    const write = stage.startsWith('execute') || stage.startsWith('integrate');
    const callId = `evidence-${++number}`;
    child.toolCall(callId, write ? 'write' : 'read', write ? { file_path: file, content } : { file_path: file });
    const checked = await nextRequest(request => request.body.messages.some(message => message.role === 'tool' && message.tool_call_id === callId), cursor);
    cursor = provider.requests.length;
    if (!write) assert(JSON.stringify(checked.body.messages).includes(content.split('\n')[0]), 'Reviewer sees actual file contents');
    checked.finish(JSON.stringify({ status: 'done', summary: `verified ${stage}`, deliverables: [file], issues: [],
      checks: [{ criterionId: id, passed: true, evidence: write ? 'Created actual output file' : 'Read and checked actual output file', toolCallIds: [callId] }] }));
  }
  const toolResult = (request, id) => {
    const content = request.body.messages.find(message => message.role === 'tool' && message.tool_call_id === id).content;
    const value = JSON.parse(typeof content === 'string' ? content : content[0].text);
    return typeof value.result === 'string' ? JSON.parse(value.result) : value;
  };
  try {
    await launch();
    await applyHarnessCredential(client, 'DEEPSEEK_API_KEY', 'sk-isolated-fixture-not-a-real-key');
    const parent = (await chat.createSession({ cwd: workspace, agentPreset: 'standard' })).sessionId;
    await client.selectPermission(parent, 'workspace-write');
    await client.selectModel(parent, 'deepseek-official', 'deepseek-flash', 'off');
    await chat.send(parent, 'workflow-fixture-start');
    const first = await provider.waitFor('workflow-fixture-start');
    assert(names(first).includes('desktop_run_workflow'), 'Workflow capability reaches a normal work conversation');
    assert.match(JSON.stringify(first.body.messages), /automatically split/);
    cursor = provider.requests.length;
    first.toolCall('start-workflow', 'desktop_run_workflow', plan);
    const stages = ['execute · a', 'task-review · a', 'execute · b', 'task-review · b', 'integrate · whole-task', 'final-review · whole-task'];
    for (const stage of stages) {
      await completeStage(stage);
    }
    const parentReply = await nextRequest(request => request.body.messages.some(message => message.role === 'tool' && message.tool_call_id === 'start-workflow'), cursor);
    const result = toolResult(parentReply, 'start-workflow');
    assert.equal(result.status, 'completed');
    assert.equal(result.tasks.length, 2);
    assert.equal(result.acceptance.childId !== result.integration.childId, true, 'Final acceptance is independent from integration');
    assert.equal(fs.readFileSync(path.join(workspace, 'combined.txt'), 'utf8'), 'alpha\nbeta');
    assert.equal(fs.readFileSync(path.join(workspace, 'requirements.txt'), 'utf8'), 'alpha\nbeta\n');
    parentReply.finish('已完成两个子任务、整合和独立整体验收。');
    await eventually(() => !chat.transcripts.get(parent)?.running, 'Parent completes after workflow acceptance');
    assert.equal(chat.transcripts.get(parent).snapshot().items.filter(item => item.kind === 'workflow').length, 1);

    // Cancel a second real workflow after a has passed independent review, while b streams.
    const partialPlan = { ...plan, goal: `${plan.goal} cancellation-and-resume-fixture` };
    targetWorkspace = path.join(temporary, 'partial-workspace');
    fs.mkdirSync(targetWorkspace);
    fs.writeFileSync(path.join(targetWorkspace, 'requirements.txt'), 'alpha\nbeta\n');
    const partial = (await chat.createSession({ cwd: targetWorkspace, agentPreset: 'standard' })).sessionId;
    await client.selectPermission(partial, 'workspace-write');
    await client.selectModel(partial, 'deepseek-official', 'deepseek-flash', 'off');
    await chat.send(partial, 'workflow-fixture-partial');
    const partialStart = await provider.waitFor('workflow-fixture-partial');
    cursor = provider.requests.length;
    partialStart.toolCall('partial-workflow', 'desktop_run_workflow', partialPlan);
    for (const stage of stages.slice(0, 2)) await completeStage(stage);
    const interruptedChild = await nextRequest(request => request.body.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('· execute · b')), cursor);
    await chat.cancel(partial);
    await eventually(() => interruptedChild.closed, 'Stopping the parent cancels its active native child');
    let cancelled;
    await eventually(async () => {
      const history = await client.history(partial, undefined, 20);
      cancelled = history.events.map(row => (row.event ?? row).data?.desktopWorkflow).findLast(value => value?.status === 'cancelled');
      return Boolean(cancelled);
    }, 'Cancellation checkpoint is durable');
    assert.equal(cancelled.tasks[0].status, 'completed');

    // Stop and restart the real kernel. Unknown/custom event names would make this load fail.
    chat.dispose(); client.dispose();
    await boot.stop();
    await launch();
    await chat.open(parent);
    const card = chat.transcripts.get(parent).snapshot().items.find(item => item.kind === 'workflow');
    assert.equal(card?.status, 'completed', 'Workflow checkpoint and UI survive a real cold restart');
    await chat.send(parent, 'workflow-fixture-resume');
    const resume = await provider.waitFor('workflow-fixture-resume');
    cursor = provider.requests.length;
    resume.toolCall('resume-workflow', 'desktop_run_workflow', { ...plan, resumeRunId: result.runId });
    const reused = await nextRequest(request => request.body.messages.some(message => message.role === 'tool' && message.tool_call_id === 'resume-workflow'), cursor);
    assert.equal(provider.requests.slice(cursor).length, 1, 'Cold resume of completed plan starts no additional child or edit');
    reused.finish('已读取原验收结果，没有重复执行。');
    await eventually(() => !chat.transcripts.get(parent)?.running, 'Resume response completes');

    await chat.open(partial);
    // A cold session's first lightweight page may contain only permission projections;
    // followSession then delivers its hydrated snapshot asynchronously.
    await eventually(() => chat.transcripts.get(partial).snapshot().items.find(item => item.kind === 'workflow')?.status === 'cancelled', 'Cancelled progress is restored by the cold session follow stream');
    await chat.send(partial, 'workflow-fixture-continue-partial');
    const continuePartial = await provider.waitFor('workflow-fixture-continue-partial');
    cursor = provider.requests.length;
    continuePartial.toolCall('continue-partial', 'desktop_run_workflow', { ...partialPlan, resumeRunId: cancelled.runId });
    for (const stage of stages.slice(2)) await completeStage(stage);
    const continued = await nextRequest(request => request.body.messages.some(message => message.role === 'tool' && message.tool_call_id === 'continue-partial'), cursor);
    const continuedResult = toolResult(continued, 'continue-partial');
    assert.equal(continuedResult.status, 'completed');
    assert.equal(continuedResult.tasks[0].attempts, 1, 'Accepted task a was not replayed after a real cancellation and restart');
    assert.equal(continuedResult.tasks[1].attempts, 2);
    continued.finish('已从第二个子任务续跑并完成整体验收。');
    await eventually(() => !chat.transcripts.get(partial)?.running, 'Partial resume completes');
    console.log('PASS real Harness workflow: native tools, independent reviews, integration, recursion guard, real cancellation and cold resume without replay');
  } finally {
    chat?.dispose(); client?.dispose();
    await boot?.stop().catch(() => {});
    await provider.close();
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
