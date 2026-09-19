'use strict';
/**
 * Typed-enough client for the local DeepSeek Harness HTTP/WebSocket API.
 *
 * Wire facts for the bundled DSH 0.1.5 runtime:
 *   - unary call: POST http://127.0.0.1:<port>/api/<namespace>/<method>
 *       body { type:'client-request', rpcId, method:'namespace/method', payload:{args} }
 *       reply { type:'server-response', rpcId, result:{ ok:true, value } | { ok:false, error } }
 *   - stream carrier: WebSocket /api/remote.mux. Session follow and Host approval events share
 *     this authenticated carrier; approval decisions return through $events/result.
 */
const { log, rid } = require('./util');
const WebSocketClient = require('ws');

class RpcError extends Error {
  constructor(method, error) {
    super(`${method}: ${error?.message ?? 'request failed'}`);
    this.name = 'RpcError';
    this.method = method;
    this.code = error?.code ?? 'unknown';
    this.details = error?.details;
  }
}

class DeepSeekHarnessClient {
  constructor(baseUrl, options = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    /** Signed local-service cookie obtained from the launch-token exchange. */
    this.cookie = options.cookie ?? null;
    /** @type {import('ws')|null} */
    this.mux = null;
    /** Sessions whose durable + assistant streams should stay open across reconnects. */
    this.followedSessions = new Set();
    /** Logical stream id -> { sessionId, attempt? }. */
    this.logicalStreams = new Map();
    this.sessionStreamIds = new Map();
    this.remoteEventStreamId = null;
    /** One persistent Workspace projection shared by list, archive and create commands. */
    this.workspaceStreamId = null;
    this.workspaceReady = false;
    this.workspaceItems = [];
    this.archivedSessionIds = [];
    this.workspaceWaiters = new Set();
    /** Host-wide projection stream: context pressure, image limits and other live UI facts. */
    this.controlStreamId = null;
    this.sessionProjectionValues = new Map();
    /** Remote approval event id -> answerable request for the current stream generation. */
    this.pendingApprovals = new Map();
    this.frameListeners = new Set();
    this.hostListeners = new Set();
    this.stateListeners = new Set();
    this.connectionState = 'idle';
    this.closed = false;
    this.reconnectDelay = 500;
    this.lastError = null;
    /** Latest inclusive session cursor observed through session/list. */
    this.sessionCursors = new Map();
    /** Latest session summaries, used to project per-session model selection. */
    this.sessionSummaries = new Map();
    this.sessionSelections = new Map();
    this.sessionPermissions = new Map();
  }

  setBaseUrl(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  /** Fire one unary RPC; resolves with the business value, rejects with RpcError. */
  async call(method, args = {}, { timeoutMs = 60000, signal } = {}) {
    const endpoint = String(method).includes('/') ? String(method) : String(method).replace('.', '/');
    const rpcId = rid('rpc');
    const body = JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await fetch(`${this.baseUrl}/api/${endpoint}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.cookie ? { cookie: this.cookie } : {}),
        },
        body,
        signal: controller.signal,
      });
      if (response.status === 401) throw new RpcError(method, { code: 'unauthorized', message: '本地服务认证已失效，请重启应用' });
      if (response.status === 403) throw new RpcError(method, { code: 'forbidden', message: '该操作仅允许本机调用' });
      const text = await response.text();
      let envelope;
      try {
        envelope = JSON.parse(text);
      } catch {
        throw new RpcError(method, { code: 'transport', message: `invalid reply (HTTP ${response.status}, ${endpoint})` });
      }
      const result = envelope?.result;
      if (!result) throw new RpcError(method, { code: 'transport', message: 'missing result envelope' });
      if (result.ok) return result.value;
      throw new RpcError(method, result.error ?? {});
    } catch (error) {
      if (error instanceof RpcError) throw error;
      if (error?.name === 'AbortError') throw new RpcError(method, { code: 'timeout', message: '请求超时' });
      throw new RpcError(method, { code: 'transport', message: String(error?.message ?? error) });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  // -------------------------------------------------------------- event streams

  onFrame(listener) { this.frameListeners.add(listener); return () => this.frameListeners.delete(listener); }
  onHostFrame(listener) { this.hostListeners.add(listener); return () => this.hostListeners.delete(listener); }
  onState(listener) { this.stateListeners.add(listener); return () => this.stateListeners.delete(listener); }

  setState(state) {
    if (this.connectionState === state) return;
    this.connectionState = state;
    for (const listener of this.stateListeners) {
      try { listener(state); } catch (error) { log('api', 'state listener failed', String(error)); }
    }
  }

  /** Open the authenticated stream carrier; reconnect with backoff when it drops. */
  connect() {
    this.closed = false;
    this.openSocket();
  }

  openSocket() {
    if (this.closed) return;
    const url = this.baseUrl.replace(/^http/, 'ws') + '/api/remote.mux';
    let socket;
    try {
      socket = new WebSocketClient(url, this.cookie ? { headers: { Cookie: this.cookie } } : undefined);
    } catch (error) {
      this.scheduleReconnect(String(error));
      return;
    }
    this.mux = socket;
    socket.onopen = () => {
      this.reconnectDelay = 500;
      this.setState('connected');
      log('api', 'remote stream carrier open');
      this.openRemoteEventStream();
      this.openWorkspaceStream();
      this.openControlStream();
      for (const sessionId of this.followedSessions) this.openSessionStream(sessionId);
    };
    socket.onmessage = (event) => {
      let full;
      try { full = JSON.parse(String(event.data)); } catch { return; }
      this.handleMuxFrame(full);
    };
    socket.onerror = () => { this.lastError = 'remote stream socket error'; };
    socket.onclose = () => {
      this.mux = null;
      this.clearRemoteApprovals('connection-closed');
      this.logicalStreams.clear();
      this.sessionStreamIds.clear();
      this.remoteEventStreamId = null;
      this.workspaceStreamId = null;
      this.workspaceReady = false;
      this.controlStreamId = null;
      if (this.closed) return;
      this.setState('reconnecting');
      this.scheduleReconnect();
    };
  }

  scheduleReconnect() {
    if (this.closed) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(8000, Math.round(this.reconnectDelay * 1.7));
    setTimeout(() => this.openSocket(), delay);
  }

  dispose() {
    this.closed = true;
    try { this.mux?.close(); } catch { /* ignore */ }
    this.mux = null;
    this.followedSessions.clear();
    this.logicalStreams.clear();
    this.sessionStreamIds.clear();
    this.remoteEventStreamId = null;
    this.workspaceStreamId = null;
    this.workspaceReady = false;
    this.controlStreamId = null;
    for (const waiter of this.workspaceWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new RpcError('workspace/follow', { code: 'disposed', message: '本地服务连接已关闭' }));
    }
    this.workspaceWaiters.clear();
    this.clearRemoteApprovals('disposed');
    this.frameListeners.clear();
    this.hostListeners.clear();
    this.stateListeners.clear();
  }

  /** Emit one normalized session frame to the transcript controller. */
  emitFrame(frame, wire) {
    for (const listener of this.frameListeners) {
      try { listener(frame, wire); } catch (error) { log('api', 'frame listener failed', String(error)); }
    }
  }

  emitHostFrame(frame, wire) {
    for (const listener of this.hostListeners) {
      try { listener(frame, wire); } catch (error) { log('api', 'host frame listener failed', String(error)); }
    }
  }

  /** Subscribe to Host waterfalls such as approval/request on the shared mux carrier. */
  openRemoteEventStream() {
    if (this.remoteEventStreamId || !this.mux || this.mux.readyState !== WebSocketClient.OPEN) return;
    const streamId = rid('events');
    this.remoteEventStreamId = streamId;
    this.logicalStreams.set(streamId, { kind: 'remote-events', streamId, clientId: null });
    this.mux.send(JSON.stringify({ type: 'open', streamId, endpoint: '$events', payload: { args: {} } }));
  }

  retryRemoteEventStream() {
    if (this.closed) return;
    setTimeout(() => this.openRemoteEventStream(), 500);
  }

  /** Keep the Harness Workspace registry and global archive set current. */
  openWorkspaceStream() {
    if (this.workspaceStreamId || !this.mux || this.mux.readyState !== WebSocketClient.OPEN) return;
    const streamId = rid('workspaces');
    this.workspaceStreamId = streamId;
    this.logicalStreams.set(streamId, { kind: 'workspaces', streamId });
    this.mux.send(JSON.stringify({ type: 'open', streamId, endpoint: 'workspace/follow', payload: { args: {} } }));
  }

  retryWorkspaceStream() {
    if (this.closed) return;
    setTimeout(() => this.openWorkspaceStream(), 500);
  }

  /** Follow the authoritative live Session projections used by the official Harness UI. */
  openControlStream() {
    if (this.controlStreamId || !this.mux || this.mux.readyState !== WebSocketClient.OPEN) return;
    const streamId = rid('control');
    this.controlStreamId = streamId;
    this.logicalStreams.set(streamId, { kind: 'control', streamId });
    this.mux.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/control', payload: { args: {} } }));
  }

  retryControlStream() {
    if (this.closed) return;
    setTimeout(() => this.openControlStream(), 500);
  }

  handleControlFrame(full, stream) {
    if (full.type === 'error' || full.type === 'end') {
      this.logicalStreams.delete(stream.streamId);
      if (this.controlStreamId === stream.streamId) this.controlStreamId = null;
      if (full.type === 'error') log('api', 'session control stream failed', {
        code: full.error?.code ?? 'unknown', message: full.error?.message ?? 'stream error',
      });
      this.retryControlStream();
      return;
    }
    if (full.type !== 'item' || !full.value) return;
    const frame = full.value;
    if (frame.type === 'baseline') {
      for (const [sessionId, projection] of Object.entries(frame.value?.projections ?? {})) {
        const values = { ...(projection?.values ?? {}) };
        this.sessionProjectionValues.set(sessionId, values);
        this.emitFrame({ type: 'session/projections', sessionId, values }, full);
      }
      return;
    }
    if (frame.type !== 'projection' || !frame.sessionId || typeof frame.key !== 'string') return;
    const values = { ...(this.sessionProjectionValues.get(frame.sessionId) ?? {}), [frame.key]: frame.value };
    this.sessionProjectionValues.set(frame.sessionId, values);
    this.emitFrame({
      type: 'session/projection', sessionId: frame.sessionId, key: frame.key, value: frame.value,
    }, full);
  }

  projectionsFor(sessionId) {
    return { ...(this.sessionProjectionValues.get(sessionId) ?? {}) };
  }

  workspaceSnapshot() {
    return {
      items: this.workspaceItems.map((item) => ({ ...item, sessionIds: [...(item.sessionIds ?? [])] })),
      archivedSessionIds: [...this.archivedSessionIds],
    };
  }

  resolveWorkspaceWaiters() {
    if (!this.workspaceReady) return;
    const value = this.workspaceSnapshot();
    for (const waiter of this.workspaceWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(value);
    }
    this.workspaceWaiters.clear();
  }

  handleWorkspaceFrame(full, stream) {
    if (full.type === 'error' || full.type === 'end') {
      this.logicalStreams.delete(stream.streamId);
      if (this.workspaceStreamId === stream.streamId) this.workspaceStreamId = null;
      this.workspaceReady = false;
      if (full.type === 'error') log('api', 'workspace follow stream failed', {
        code: full.error?.code ?? 'unknown', message: full.error?.message ?? 'stream error',
      });
      this.retryWorkspaceStream();
      return;
    }
    if (full.type !== 'item' || !full.value) return;
    const frame = full.value;
    if (frame.type === 'baseline') {
      this.workspaceItems = [...(frame.value?.items ?? [])];
      this.archivedSessionIds = [...(frame.value?.archivedSessionIds ?? [])];
      this.workspaceReady = true;
      this.resolveWorkspaceWaiters();
      return;
    }
    if (!this.workspaceReady) return;
    if (frame.type === 'upsert') {
      const index = this.workspaceItems.findIndex((item) => item.workspaceId === frame.workspace?.workspaceId);
      this.workspaceItems = index < 0
        ? [frame.workspace, ...this.workspaceItems]
        : this.workspaceItems.map((item, at) => at === index ? frame.workspace : item);
    } else if (frame.type === 'remove') {
      this.workspaceItems = this.workspaceItems.filter((item) => item.workspaceId !== frame.workspaceId);
    } else if (frame.type === 'order') {
      const rank = new Map((frame.workspaceIds ?? []).map((id, index) => [id, index]));
      this.workspaceItems = [...this.workspaceItems].sort((left, right) => (
        (rank.get(left.workspaceId) ?? Number.MAX_SAFE_INTEGER)
        - (rank.get(right.workspaceId) ?? Number.MAX_SAFE_INTEGER)
      ));
    } else if (frame.type === 'archived') {
      this.archivedSessionIds = [...(frame.archivedSessionIds ?? [])];
    }
  }

  /** Drop UI state owned by a dead Remote-event generation. Pending Host asks are redelivered. */
  clearRemoteApprovals(reason) {
    for (const approval of this.pendingApprovals.values()) {
      this.emitHostFrame({ type: 'approval/cancel', sessionId: approval.sessionId, eventId: approval.eventId, reason });
    }
    this.pendingApprovals.clear();
  }

  handleRemoteEventFrame(full, stream) {
    if (full.type === 'error' || full.type === 'end') {
      this.logicalStreams.delete(stream.streamId);
      if (this.remoteEventStreamId === stream.streamId) this.remoteEventStreamId = null;
      this.clearRemoteApprovals(full.type);
      if (full.type === 'error') log('api', 'remote event stream failed', {
        code: full.error?.code ?? 'unknown', message: full.error?.message ?? 'stream error',
      });
      this.retryRemoteEventStream();
      return;
    }
    if (full.type !== 'item' || !full.value) return;
    const value = full.value;
    if (value.type === 'ready') {
      stream.clientId = value.clientId;
      this.emitHostFrame({ type: 'remote-events/ready', home: value.host?.home ?? null });
      return;
    }
    if (value.type === 'cancel') {
      const approval = this.pendingApprovals.get(value.eventId);
      if (approval) {
        this.pendingApprovals.delete(value.eventId);
        this.emitHostFrame({ type: 'approval/cancel', sessionId: approval.sessionId, eventId: value.eventId });
      }
      return;
    }
    if (value.type === 'emit') {
      this.emitHostFrame({ type: value.event, args: value.args ?? [] }, full);
      return;
    }
    if (value.type !== 'waterfall' || !stream.clientId) return;
    if (value.event !== 'approval/request') {
      // This shell does not own other interactive waterfalls. Delegate immediately so an
      // official/third-party Client can answer without this connection holding the Host open.
      this.answerRemoteEvent(stream.clientId, value.eventId, { kind: 'next' })
        .catch((error) => log('api', 'remote event delegation failed', String(error)));
      return;
    }
    const approval = {
      eventId: value.eventId,
      clientId: stream.clientId,
      sessionId: value.agentId,
      toolName: value.request?.toolName ?? '工具',
      callId: value.request?.callId ?? null,
      reason: value.request?.reason ?? null,
    };
    this.pendingApprovals.set(approval.eventId, approval);
    this.emitHostFrame({ type: 'approval/request', sessionId: approval.sessionId, approval }, full);
  }

  answerRemoteEvent(clientId, eventId, outcome) {
    return this.call('$events/result', { clientId, eventId, outcome }, { timeoutMs: 30000 });
  }

  pendingApprovalsFor(sessionId) {
    return [...this.pendingApprovals.values()].filter((approval) => approval.sessionId === sessionId);
  }

  async answerApproval(eventId, outcome) {
    if (!['allowed-once', 'rejected'].includes(outcome)) {
      throw new RpcError('$events/result', { code: 'arguments-invalid', message: '无效的权限选择' });
    }
    const approval = this.pendingApprovals.get(eventId);
    if (!approval) throw new RpcError('$events/result', { code: 'not-found', message: '该权限请求已经结束' });
    await this.answerRemoteEvent(approval.clientId, eventId, { kind: 'result', value: outcome });
    this.pendingApprovals.delete(eventId);
    this.emitHostFrame({ type: 'approval/answered', sessionId: approval.sessionId, eventId, outcome });
    return { accepted: true, outcome };
  }

  /** Open the DSH session/follow logical stream on the already-authenticated mux carrier. */
  openSessionStream(sessionId) {
    if (!this.followedSessions.has(sessionId) || this.sessionStreamIds.has(sessionId)) return;
    if (!this.mux || this.mux.readyState !== WebSocketClient.OPEN) return;
    const streamId = rid('follow');
    const stream = { streamId, sessionId, attempt: null };
    this.logicalStreams.set(streamId, stream);
    this.sessionStreamIds.set(sessionId, streamId);
    this.mux.send(JSON.stringify({
      type: 'open',
      streamId,
      endpoint: 'session/follow',
      payload: { args: { request: {
        address: { kind: 'session', sessionId },
        maxMessages: 16,
        assistantStream: true,
      } } },
    }));
  }

  followSession(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    this.followedSessions.add(sessionId);
    this.openSessionStream(sessionId);
    return true;
  }

  unfollowSession(sessionId) {
    this.followedSessions.delete(sessionId);
    const streamId = this.sessionStreamIds.get(sessionId);
    this.sessionStreamIds.delete(sessionId);
    if (!streamId) return;
    this.logicalStreams.delete(streamId);
    if (this.mux?.readyState === WebSocketClient.OPEN) {
      this.mux.send(JSON.stringify({ type: 'cancel', streamId }));
    }
  }

  retrySessionStream(sessionId) {
    if (!this.followedSessions.has(sessionId) || this.closed) return;
    setTimeout(() => this.openSessionStream(sessionId), 500);
  }

  /** Convert mux protocol frames into the small session event contract used by ChatController. */
  handleMuxFrame(full) {
    const stream = this.logicalStreams.get(full?.streamId);
    if (!stream) return;
    if (stream.kind === 'remote-events') {
      this.handleRemoteEventFrame(full, stream);
      return;
    }
    if (stream.kind === 'workspaces') {
      this.handleWorkspaceFrame(full, stream);
      return;
    }
    if (stream.kind === 'control') {
      this.handleControlFrame(full, stream);
      return;
    }
    if (full.type === 'error' || full.type === 'end') {
      this.logicalStreams.delete(stream.streamId);
      this.sessionStreamIds.delete(stream.sessionId);
      if (full.type === 'error') log('api', 'session follow stream failed', {
        sessionId: stream.sessionId,
        code: full.error?.code ?? 'unknown',
        message: full.error?.message ?? 'stream error',
      });
      this.retrySessionStream(stream.sessionId);
      return;
    }
    if (full.type !== 'item' || !full.value) return;
    const value = full.value;
    if (value.type === 'snapshot') {
      const active = value.assistantStream?.activeAttempt;
      stream.attempt = active ? {
        attemptId: active.attemptId,
        turn: active.turn,
        step: active.step,
      } : null;
      this.emitFrame({
        type: 'session/snapshot',
        sessionId: stream.sessionId,
        records: value.records ?? [],
        lastSeq: value.cursor,
        projections: value.projections ?? null,
        running: Boolean(active),
      }, full);
      return;
    }
    if (value.type === 'event') {
      this.emitFrame({ type: 'session/event', sessionId: stream.sessionId, event: value.event }, full);
      return;
    }
    if (value.type !== 'assistant-stream') return;
    const frame = value.frame;
    if (frame?.type === 'start') {
      stream.attempt = { attemptId: frame.attemptId, turn: frame.turn, step: frame.step };
      this.emitFrame({ type: 'session/streaming', sessionId: stream.sessionId, running: true }, full);
      return;
    }
    if (frame?.type === 'chunk') {
      const attempt = stream.attempt;
      if (!attempt || attempt.attemptId !== frame.attemptId) return;
      this.emitFrame({
        type: 'session/event',
        sessionId: stream.sessionId,
        event: {
          type: 'assistant/chunk',
          time: frame.time,
          data: { turn: attempt.turn, step: attempt.step, chunk: frame.chunk },
        },
      }, full);
      return;
    }
    if (frame?.type === 'end') {
      stream.attempt = null;
      this.emitFrame({ type: 'session/streaming', sessionId: stream.sessionId, running: false }, full);
    }
  }

  // ------------------------------------------------------------------- surface

  /** Host identity: product name, cwd, capabilities. */
  describeHost() { return Promise.resolve({ name: 'DeepSeek Harness', available: true }); }
  /** Cheap liveness probe used by the readiness gate. */
  async ping() { await this.call('session/list', { _request: {} }, { timeoutMs: 8000 }); return true; }

  async listSessions() {
    const value = await this.call('session/list', { _request: {} });
    const items = value.items ?? [];
    for (const item of items) {
      this.sessionSummaries.set(item.sessionId, item);
      const projected = item.projections?.values?.modelSelection;
      const selection = projected?.next ?? projected?.lastUsed;
      if (selection) this.sessionSelections.set(item.sessionId, selection);
      const permissions = item.projections?.values?.permissions;
      if (permissions) this.sessionPermissions.set(item.sessionId, permissions);
      if (item.projections?.values) {
        this.sessionProjectionValues.set(item.sessionId, {
          ...(this.sessionProjectionValues.get(item.sessionId) ?? {}),
          ...item.projections.values,
        });
      }
      const cursor = item.projections?.asOfSeq;
      if (Number.isSafeInteger(cursor)) this.sessionCursors.set(item.sessionId, cursor);
    }
    return items;
  }
  async searchSessions(query) {
    const text = typeof query === 'string' ? query.trim() : '';
    if (!text) return { items: [], hasMore: false };
    try {
      return await this.call('session/search', { request: { query: text } });
    } catch (error) {
      // The pinned `dsh web` currently exposes session/search while its optional query index
      // may be configured with openAt="never". Keep search useful by reading local history;
      // this never sends conversation content off the machine.
      if (['unauthorized', 'forbidden'].includes(error?.code)) throw error;
      log('api', 'indexed session search unavailable; using local history scan', {
        code: error?.code ?? 'unknown', message: error?.message ?? String(error),
      });
      return this.searchSessionHistory(text);
    }
  }

  async searchSessionHistory(query) {
    const summaries = (await this.listSessions()).filter((item) => !item.blank);
    const items = [];
    let hasMore = false;
    for (const summary of summaries) {
      const snippet = await this.findInSession(summary.sessionId, query);
      if (snippet === null) continue;
      if (items.length < 20) items.push({ sessionId: summary.sessionId, snippet });
      else { hasMore = true; break; }
    }
    return { items, hasMore };
  }

  async findInSession(sessionId, query) {
    const needle = query.toLocaleLowerCase('zh-CN');
    let beforeSeq;
    // Bound one query so a corrupt or enormous transcript cannot hold the renderer forever.
    for (let page = 0; page < 25; page += 1) {
      const value = await this.history(sessionId, beforeSeq, 40);
      const records = value.events ?? [];
      for (const record of records) {
        const strings = [];
        const visit = (entry) => {
          if (typeof entry === 'string') strings.push(entry);
          else if (Array.isArray(entry)) entry.forEach(visit);
          else if (entry && typeof entry === 'object') Object.values(entry).forEach(visit);
        };
        visit(record?.event?.data);
        const content = strings.join(' ').replace(/\s+/g, ' ').trim();
        const index = content.toLocaleLowerCase('zh-CN').indexOf(needle);
        if (index >= 0) {
          const start = Math.max(0, index - 80);
          const end = Math.min(content.length, index + query.length + 120);
          return `${start > 0 ? '…' : ''}${content.slice(start, end)}${end < content.length ? '…' : ''}`;
        }
      }
      if (!value.hasMore || !records.length) break;
      beforeSeq = records[0]?.event?.seq;
      if (!Number.isSafeInteger(beforeSeq)) break;
    }
    return null;
  }
  createSession(payload) { return this.call('session/create', { request: payload }); }
  async history(sessionId, beforeSeq, maxMessages = 1) {
    if (beforeSeq === undefined || !this.sessionCursors.has(sessionId)) await this.listSessions();
    const throughSeq = this.sessionCursors.get(sessionId) ?? -1;
    if (throughSeq < 0) return { events: [], hasMore: false };
    const value = await this.call('session/page', {
      request: {
        address: { kind: 'session', sessionId },
        throughSeq,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
        maxMessages,
      },
    }, { timeoutMs: 120000 });
    return { events: value.records ?? [], hasMore: Boolean(value.hasMore) };
  }
  async sessionModels(sessionId) {
    const catalog = await this.listModels();
    let summary = this.sessionSummaries.get(sessionId);
    if (!summary) {
      await this.listSessions();
      summary = this.sessionSummaries.get(sessionId);
    }
    const projected = summary?.projections?.values?.modelSelection;
    return {
      current: this.sessionSelections.get(sessionId) ?? projected?.next ?? projected?.lastUsed ?? catalog.default ?? null,
      routable: catalog.routableProviders?.length > 0,
      groups: catalog.groups ?? [],
      failures: catalog.failures ?? [],
    };
  }
  async selectModel(sessionId, provider, model, reasoningEffort) {
    const request = { sessionId, provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) };
    for (const field of ['sessionId', 'provider', 'model']) {
      if (typeof request[field] !== 'string' || !request[field]) {
        throw new RpcError('session/selectModel', { code: 'arguments-invalid', message: `缺少有效的 ${field}` });
      }
    }
    log('api', 'selecting model', request);
    const result = await this.call('session/selectModel', { request });
    if (result?.selected) this.sessionSelections.set(sessionId, result.selected);
    return result;
  }
  async permissions(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new RpcError('session/permissions', { code: 'arguments-invalid', message: '缺少有效的 sessionId' });
    }
    await this.listSessions();
    const value = this.sessionPermissions.get(sessionId);
    if (!value) {
      throw new RpcError('session/permissions', { code: 'unavailable', message: '当前内核没有提供权限模式' });
    }
    return value;
  }
  async selectPermission(sessionId, preset) {
    const allowed = ['read-only', 'workspace-write', 'danger-full-access'];
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new RpcError('commands/execute', { code: 'arguments-invalid', message: '缺少有效的 sessionId' });
    }
    if (!allowed.includes(preset)) {
      throw new RpcError('commands/execute', { code: 'arguments-invalid', message: '无效的权限模式' });
    }
    log('api', 'selecting permission preset', { sessionId, preset });
    const executed = await this.call('commands/execute', {
      agentId: sessionId,
      line: `/permission ${preset}`,
      submittedAttachments: [],
    });
    if (!executed) {
      throw new RpcError('commands/execute', { code: 'unavailable', message: '当前内核没有提供 /permission 命令' });
    }
    if (executed.result?.kind !== 'success') {
      throw new RpcError('commands/execute', { code: 'command-failed', message: executed.result?.text ?? '权限切换失败' });
    }
    await this.listSessions();
    const value = this.sessionPermissions.get(sessionId);
    if (!value || value.currentValue !== preset) {
      throw new RpcError('commands/execute', { code: 'not-applied', message: '内核没有确认新的权限模式' });
    }
    return value;
  }
  renameSession(sessionId, title) { return this.call('session/rename', { request: { sessionId, title } }); }
  forkSession(sessionId, atSeq) { return this.call('session/fork', { request: { sessionId, ...(atSeq === undefined ? {} : { atSeq }) } }); }
  async uploadFile(sessionId, bytes, name) {
    const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const query = new URLSearchParams({ sessionId });
    if (name) query.set('name', name);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
      const response = await fetch(`${this.baseUrl}/api/session/uploadFileBinary?${query}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          ...(this.cookie ? { cookie: this.cookie } : {}),
        },
        body: data,
        signal: controller.signal,
      });
      const text = await response.text();
      let result;
      try { result = JSON.parse(text); } catch {
        throw new RpcError('session/uploadFileBinary', {
          code: 'transport', message: `invalid reply (HTTP ${response.status})`,
        });
      }
      if (result?.ok) return result.value;
      throw new RpcError('session/uploadFileBinary', result?.error ?? {
        code: 'transport', message: `HTTP ${response.status}`,
      });
    } catch (error) {
      if (error instanceof RpcError) throw error;
      if (error?.name === 'AbortError') {
        throw new RpcError('session/uploadFileBinary', { code: 'timeout', message: '文件上传超时' });
      }
      throw new RpcError('session/uploadFileBinary', { code: 'transport', message: String(error?.message ?? error) });
    } finally {
      clearTimeout(timer);
    }
  }

  prompt(sessionId, text, mode = 'queue', clientTimeZone, requestId = rid('prompt'), attachments = []) {
    const content = [...attachments, ...(text ? [{ type: 'text', text }] : [])];
    return this.call('session/prompt', { request: {
      requestId,
      sessionId,
      mode,
      content,
      clientTimeZone: clientTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    } }, { timeoutMs: 120000 });
  }
  cancel(sessionId) { return this.call('session/cancel', { request: { sessionId } }); }
  attachment(sessionId, attachmentId) {
    return this.call('session/attachment', { request: { sessionId, attachmentId } });
  }

  async listWorkspaces({ timeoutMs = 10000 } = {}) {
    if (this.workspaceReady) return this.workspaceSnapshot();
    this.openWorkspaceStream();
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.workspaceWaiters.delete(waiter);
        reject(new RpcError('workspace/follow', { code: 'timeout', message: '读取工作区超时' }));
      }, timeoutMs);
      this.workspaceWaiters.add(waiter);
      this.resolveWorkspaceWaiters();
    });
  }
  async createWorkspace(path) {
    const value = await this.call('workspace/create', { request: { path } });
    const workspace = value.workspace;
    if (workspace) {
      const index = this.workspaceItems.findIndex((item) => item.workspaceId === workspace.workspaceId);
      this.workspaceItems = index < 0
        ? [workspace, ...this.workspaceItems]
        : this.workspaceItems.map((item, at) => at === index ? workspace : item);
    }
    return value;
  }
  async archiveSession(sessionId) {
    const value = await this.call('workspace/archiveSession', { request: { sessionId } });
    this.archivedSessionIds = [...(value.archivedSessionIds ?? [])];
    return value;
  }
  listAgentPresets() { return this.call('agentPresets/list', {}); }
  listSkills(sessionId) {
    return this.call('skills/list', { request: {
      address: { kind: 'session', sessionId },
    } });
  }

  listProviders() { return this.call('llm/listProviders', {}); }
  listModels() { return this.call('session/modelCatalog', {}); }
  credentialsDescribe(refs) { return this.call('credentials/describe', { refs }); }
  credentialsSet(ref, value) { return this.call('credentials/set', { ref, value }); }
  credentialsUnset(ref) { return this.call('credentials/unset', { ref }); }
  settingsDescribe() { return this.call('settings/describe', {}); }
  settingsUpdate(ns, patch) { return this.call('settings/update', { ns, patch }); }

  respond(message) { return Promise.resolve(message); }
}

module.exports = { DeepSeekHarnessClient, RpcError };
