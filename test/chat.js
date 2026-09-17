'use strict';
/** Regression contracts for chronological hydration, model selection and the live follow mux. */
const WebSocket = require('ws');
const { DeepSeekHarnessClient } = require('../src/main/modules/api');
const { ChatController } = require('../src/main/modules/chat');

let failures = 0;
function check(name, condition, detail) {
  if (!condition) failures += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' — ' + detail}`);
}

async function hydrationContract() {
  let page = 0;
  const listeners = new Set();
  const client = {
    onFrame(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    onHostFrame() { return () => {}; },
    followSession() {},
    unfollowSession() {},
    async history() {
      page += 1;
      if (page === 1) return {
        events: [
          { event: { type: 'assistant/message', seq: 2, time: 3, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '完成' }] } } } },
          { event: { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: 'complete' } } },
        ],
        hasMore: true,
      };
      return {
        events: [
          { event: { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } } },
          { event: { type: 'user/message', seq: 1, time: 2, data: { content: [{ type: 'text', text: '开始' }] } } },
        ],
        hasMore: false,
      };
    },
  };
  const chat = new ChatController(client);
  const snapshot = await chat.open('session-order');
  check('newest-first history is folded chronologically', snapshot.running === false, `running=${snapshot.running}`);
  check('hydrated answer is visible', snapshot.items.some((item) => item.kind === 'assistant'));
  chat.dispose();
}

async function toolLifecycleContract() {
  const transcript = new (require('../src/main/modules/chat').Transcript)('session-tools');
  transcript.apply({
    type: 'tool/call', seq: 1, time: 1,
    data: { turn: 1, step: 1, callId: 'call-pwsh', name: 'pwsh', arguments: '{"command":"Get-Date"}' },
  });
  transcript.apply({
    type: 'tool/result', seq: 2, time: 2,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'user',
        source: { kind: 'tool', callId: 'call-pwsh' },
        content: [{
          type: 'tool-result', toolCallId: 'call-pwsh', isError: false,
          content: [{ type: 'text', text: 'Thursday' }],
        }],
      },
    },
  });
  const tools = transcript.snapshot().items.filter((item) => item.kind === 'tool');
  check('current Harness tool result joins its original call card', tools.length === 1, `cards=${tools.length}`);
  check('joined tool result clears running state and keeps output', tools[0]?.running === false && tools[0]?.output === 'Thursday', JSON.stringify(tools[0]));

  transcript.apply({
    type: 'tool/call', seq: 3, time: 3,
    data: { turn: 1, step: 2, callId: 'call-orphan', name: 'pwsh', arguments: '{}' },
  });
  transcript.apply({ type: 'turn/end', seq: 4, time: 4, data: { turn: 1, reason: 'completed' } });
  const orphan = transcript.snapshot().items.find((item) => item.callId === 'call-orphan');
  check('turn end retires an unmatched historical tool call', orphan?.running === false, JSON.stringify(orphan));

  const legacy = new (require('../src/main/modules/chat').Transcript)('session-legacy-tools');
  legacy.apply({
    type: 'tool/call', seq: 1, time: 1,
    data: { callId: 'call-legacy', name: 'read', arguments: '{"path":"README.md"}' },
  });
  legacy.apply({
    type: 'tool/result', seq: 2, time: 2,
    data: { message: { callId: 'call-legacy', content: [{ type: 'text', text: 'legacy output' }] } },
  });
  const legacyTools = legacy.snapshot().items.filter((item) => item.kind === 'tool');
  check('legacy message.callId tool results remain compatible', legacyTools.length === 1 && legacyTools[0].running === false);
}

async function muxContract() {
  const client = new DeepSeekHarnessClient('http://127.0.0.1:1');
  const writes = [];
  client.mux = { readyState: WebSocket.OPEN, send: (text) => writes.push(JSON.parse(text)) };
  const frames = [];
  client.onFrame((frame) => frames.push(frame));
  client.followSession('session-live');
  const opened = writes[0];
  check('follow opens the registered session/follow endpoint', opened?.type === 'open' && opened.endpoint === 'session/follow', JSON.stringify(opened));
  check('follow request opts into assistant streaming', opened?.payload?.args?.request?.assistantStream === true);

  client.handleMuxFrame({ type: 'item', streamId: opened.streamId, value: {
    type: 'snapshot', cursor: -1, records: [], projections: { asOfSeq: -1, values: {} },
    assistantStream: { revision: 0 },
  } });
  client.handleMuxFrame({ type: 'item', streamId: opened.streamId, value: {
    type: 'assistant-stream', frame: { type: 'start', attemptId: 'attempt-1', turn: 1, step: 1 },
  } });
  client.handleMuxFrame({ type: 'item', streamId: opened.streamId, value: {
    type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'attempt-1', time: 10, chunk: { type: 'text-delta', index: 0, text: '实时回答' } },
  } });
  check('assistant chunks are normalized into transcript events', frames.some((frame) => frame.event?.type === 'assistant/chunk' && frame.event.data.chunk.text === '实时回答'));
  client.dispose();
}

async function optimisticEchoContract() {
  let frameListener;
  let promptRequestId;
  let latest;
  const client = {
    onFrame(listener) { frameListener = listener; return () => {}; },
    onHostFrame() { return () => {}; },
    followSession() {},
    unfollowSession() {},
    async prompt(_sessionId, _text, _mode, _zone, requestId) { promptRequestId = requestId; return { accepted: true }; },
    async listSessions() { return []; },
    async history() { return { events: [], hasMore: false }; },
  };
  const chat = new ChatController(client, { onUpdate: (update) => { latest = update.transcript; } });
  await chat.send('session-echo', '查看本机磁盘还剩多少空间');
  frameListener({
    type: 'session/event',
    sessionId: 'session-echo',
    event: {
      type: 'user/message', seq: 1, time: Date.now(),
      data: {
        source: { kind: 'user', rpcId: promptRequestId },
        content: [{ type: 'text', text: '查看本机磁盘还剩多少空间' }],
      },
    },
  });
  const userItems = latest.items.filter((item) => item.kind === 'user');
  check('durable user message replaces its optimistic echo', userItems.length === 1, `count=${userItems.length}`);
  check('object-shaped user source is not mislabeled as system injection', userItems[0]?.synthetic === false);
  chat.dispose();
}

async function approvalContract() {
  const client = new DeepSeekHarnessClient('http://127.0.0.1:1');
  const writes = [];
  const calls = [];
  const hostFrames = [];
  client.mux = { readyState: WebSocket.OPEN, send: (text) => writes.push(JSON.parse(text)) };
  client.call = async (method, args) => { calls.push({ method, args }); return { accepted: true }; };
  client.onHostFrame((frame) => hostFrames.push(frame));
  client.openRemoteEventStream();
  const opened = writes[0];
  check('approval stream opens the Host remote-event endpoint', opened?.endpoint === '$events', JSON.stringify(opened));
  client.handleMuxFrame({ type: 'item', streamId: opened.streamId, value: {
    type: 'ready', clientId: 'client-approval', host: { home: 'C:\\Users\\Administrator' },
  } });
  client.handleMuxFrame({ type: 'item', streamId: opened.streamId, value: {
    type: 'waterfall', event: 'approval/request', eventId: 'approval-1', agentId: 'session-live',
    request: { toolName: 'pwsh', callId: 'call-1', reason: '查看磁盘空间需要运行只读命令' },
  } });
  check('Host approval is exposed to the desktop UI', hostFrames.some((frame) => (
    frame.type === 'approval/request' && frame.approval?.toolName === 'pwsh'
  )));
  check('pending approval is associated with its session', client.pendingApprovalsFor('session-live').length === 1);
  await client.answerApproval('approval-1', 'allowed-once');
  check('allow-once returns through the remote-event result RPC', calls.some(({ method, args }) => (
    method === '$events/result'
      && args.clientId === 'client-approval'
      && args.eventId === 'approval-1'
      && args.outcome?.kind === 'result'
      && args.outcome?.value === 'allowed-once'
  )), JSON.stringify(calls));
  client.dispose();
}

async function modelContract() {
  const client = new DeepSeekHarnessClient('http://127.0.0.1:1');
  let request;
  client.call = async (method, args) => { request = { method, args }; return { selected: args.request }; };
  await client.selectModel('session-1', 'deepseek-official', 'deepseek-v4-pro', 'max');
  check('model selection uses the exact request wire field', request?.method === 'session/selectModel'
    && request.args.request.sessionId === 'session-1'
    && request.args.request.provider === 'deepseek-official'
    && request.args.request.model === 'deepseek-v4-pro'
    && request.args.request.reasoningEffort === 'max', JSON.stringify(request));
  let invalid = null;
  try { await client.selectModel(null, 'deepseek-official', 'deepseek-flash', 'high'); } catch (error) { invalid = error; }
  check('model selection rejects a missing session before RPC', invalid?.code === 'arguments-invalid', invalid?.message);
  client.dispose();
}

async function permissionContract() {
  const client = new DeepSeekHarnessClient('http://127.0.0.1:1');
  const calls = [];
  client.call = async (method, args) => {
    calls.push({ method, args });
    if (method === 'commands/execute') {
      return { commandId: 'command-1', result: { kind: 'success', text: 'preset read-only' } };
    }
    if (method === 'session/list') {
      return { items: [{
        sessionId: 'session-permission',
        projections: {
          asOfSeq: 3,
          values: {
            permissions: {
              currentValue: 'read-only',
              options: [
                { value: 'read-only', name: 'read-only' },
                { value: 'workspace-write', name: 'workspace-write' },
                { value: 'danger-full-access', name: 'danger-full-access' },
              ],
            },
          },
        },
      }] };
    }
    throw new Error(`unexpected method ${method}`);
  };
  const selected = await client.selectPermission('session-permission', 'read-only');
  check('permission selection executes the Harness command', calls.some(({ method, args }) => (
    method === 'commands/execute'
      && args.agentId === 'session-permission'
      && args.line === '/permission read-only'
      && Array.isArray(args.submittedAttachments)
      && args.submittedAttachments.length === 0
  )), JSON.stringify(calls));
  check('permission selection is confirmed through the session projection', selected.currentValue === 'read-only');
  let invalid = null;
  try { await client.selectPermission('session-permission', 'unconfined'); } catch (error) { invalid = error; }
  check('permission selection rejects unknown modes before RPC', invalid?.code === 'arguments-invalid', invalid?.message);
  client.dispose();
}

async function main() {
  await hydrationContract();
  await toolLifecycleContract();
  await muxContract();
  await optimisticEchoContract();
  await approvalContract();
  await modelContract();
  await permissionContract();
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('chat contract crashed:', error);
  process.exit(2);
});
