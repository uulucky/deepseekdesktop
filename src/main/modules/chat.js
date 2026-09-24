'use strict';
/**
 * Session/transcript controller.
 *
 * The harness session log is a high-fidelity event stream (thousands of chunk events for a
 * single answer), so this module folds it into the small, ordered list of *surface* items a
 * chat UI renders:
 *
 *   user/message      → user bubble (synthetic injections are flagged, not hidden)
 *   assistant/message → assistant bubble with text / reasoning / tool-call blocks + usage
 *   tool/call         → collapsible tool card (paired with its result by callId)
 *   tool/result       → fills the card's output, marks errors
 *
 * Live streaming arrives as assistant/chunk frames over the mux WebSocket and is merged into
 * the same shape, so the renderer only ever knows one model.
 */
const { log, rid } = require('./util');

/** Bound chunk-sized fields so a huge tool output cannot wedge the IPC channel. */
const MAX_TEXT = 60000;
const MAX_TOOL_OUTPUT = 8000;

function clip(text, limit = MAX_TEXT) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  return value.length > limit ? `${value.slice(0, limit)}\n…（已截断 ${value.length - limit} 字符）` : value;
}

/** Flatten a content block array into display parts. */
function blocksOf(content) {
  if (!Array.isArray(content)) return [];
  return content.map((block) => {
    if (!block || typeof block !== 'object') return { kind: 'text', text: String(block ?? '') };
    switch (block.type) {
      case 'text': return { kind: 'text', text: clip(block.text) };
      case 'reasoning': return { kind: 'reasoning', text: clip(block.text) };
      case 'image': return {
        kind: 'image',
        attachmentId: block.attachment?.id ?? block.attachment?.attachmentId ?? null,
        name: block.attachment?.name ?? block.name ?? null,
        mediaType: block.attachment?.mediaType ?? block.mediaType ?? null,
        bytes: block.attachment?.bytes ?? null,
      };
      case 'file': return {
        kind: 'file',
        attachmentId: block.attachment?.id ?? block.attachment?.attachmentId ?? null,
        name: block.attachment?.name ?? block.name ?? '文件',
        bytes: block.attachment?.bytes ?? null,
      };
      case 'tool-call': return { kind: 'tool-call', callId: block.callId, name: block.name, arguments: clip(block.arguments ?? '', 4000) };
      case 'tool-result': return {
        kind: 'tool-result',
        callId: block.toolCallId ?? block.callId,
        output: clip(block.output ?? textOfBlocks(block.content), MAX_TOOL_OUTPUT),
        isError: Boolean(block.isError),
      };
      default: return { kind: 'unknown', blockType: block.type ?? 'unknown' };
    }
  });
}

/** Human-readable text nested inside a ToolResultBlock. */
function textOfBlocks(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && typeof block === 'object' && block.type === 'text')
    .map((block) => String(block.text ?? ''))
    .join('\n');
}

/** A tool result message carries its identity in source.callId in current Harness logs. */
function toolResultParts(message) {
  const resultBlock = (message?.content ?? []).find((block) => block?.type === 'tool-result');
  const content = resultBlock?.content ?? message?.content ?? [];
  const parts = blocksOf(content);
  const text = parts.filter((part) => part.kind === 'text').map((part) => part.text).join('\n');
  return {
    callId: message?.source?.callId ?? resultBlock?.toolCallId ?? message?.callId ?? resultBlock?.callId,
    output: clip(text || JSON.stringify(content), MAX_TOOL_OUTPUT),
    isError: Boolean(message?.isError || resultBlock?.isError),
  };
}

/** Best-effort one-line summary of a tool call for the collapsed card header. */
function summarizeArguments(rawArguments) {
  if (!rawArguments) return '';
  try {
    const parsed = JSON.parse(rawArguments);
    const preferred = ['command', 'path', 'file_path', 'query', 'pattern', 'url', 'prompt', 'description'];
    for (const key of preferred) {
      if (typeof parsed?.[key] === 'string') return clip(parsed[key], 160);
    }
    const first = Object.entries(parsed ?? {}).find(([, value]) => typeof value === 'string');
    return first ? clip(first[1], 160) : clip(rawArguments, 160);
  } catch {
    return clip(rawArguments, 160);
  }
}

/** Harness 0.1.5 projects message sources as { kind, rpcId }; older logs used strings. */
function messageSource(source) {
  if (typeof source === 'string') return { kind: source, requestId: null };
  if (source && typeof source === 'object') {
    return {
      kind: typeof source.kind === 'string' ? source.kind : 'user',
      requestId: typeof source.rpcId === 'string' ? source.rpcId : null,
    };
  }
  return { kind: 'user', requestId: null };
}

class Transcript {
  constructor(sessionId) {
    this.sessionId = sessionId;
    /** @type {Array<object>} ordered renderable items */
    this.items = [];
    this.bySeq = new Map();
    this.toolCalls = new Map();
    /** @type {Map<string, object>} interactive Host approvals currently blocking this session */
    this.approvals = new Map();
    this.questions = new Map();
    /** @type {Map<number, {turn:number, step:number, index:number}>} live streaming state */
    this.streaming = new Map();
    this.lastSeq = -1;
    this.title = null;
    this.usage = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    this.projections = {};
    this.running = false;
  }

  applyProjections(values) {
    if (!values || typeof values !== 'object') return;
    this.projections = { ...this.projections, ...values };
  }

  /** Insert an item in sequence order and index it. */
  pushItem(seq, item) {
    if (seq !== undefined && this.bySeq.has(seq)) {
      const index = this.items.findIndex((entry) => entry.seq === seq);
      if (index >= 0) {
        this.items[index] = { ...this.items[index], ...item };
        return this.items[index];
      }
    }
    const entry = { seq, ...item };
    if (seq !== undefined) this.bySeq.set(seq, entry);
    this.items.push(entry);
    if (seq !== undefined) this.lastSeq = Math.max(this.lastSeq, seq);
    return entry;
  }

  /** Fold one raw session event (history or live) into the transcript. */
  apply(event) {
    if (!event || typeof event !== 'object') return null;
    const { type, seq, time, data } = event;
    // History reconciliation and the live stream can deliver the same durable event.
    if (typeof seq === 'number' && seq <= this.lastSeq) return null;
    if (typeof seq === 'number') this.lastSeq = Math.max(this.lastSeq, seq);
    switch (type) {
      case 'user/message': {
        const source = messageSource(data?.source);
        const text = clip((data?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n'));
        // Sending paints an immediate local bubble. Once its durable event arrives, replace
        // that echo instead of showing it a second time. rpcId is authoritative; matching
        // text is a compatibility fallback for histories written by older Harness builds.
        if (source.kind === 'user') {
          let index = source.requestId
            ? this.items.findIndex((item) => item.kind === 'user' && item.pending && item.requestId === source.requestId)
            : -1;
          if (index < 0) index = this.items.findIndex((item) => item.kind === 'user' && item.pending && item.text === text);
          if (index >= 0) this.items.splice(index, 1);
        }
        return this.pushItem(seq, {
          kind: 'user',
          time,
          source: source.kind,
          requestId: source.requestId,
          synthetic: source.kind !== 'user',
          pending: false,
          parts: blocksOf(data?.content),
          text,
        });
      }
      case 'assistant/message': {
        // Replace the transient streaming row with the durable answer. Keeping both made a
        // reconnect show duplicated answers and left stale "生成中" state in the shell.
        const liveKey = `${data?.turn}:${data?.step}`;
        const live = this.streaming.get(liveKey);
        if (live) {
          const liveIndex = this.items.indexOf(live);
          if (liveIndex >= 0) this.items.splice(liveIndex, 1);
          this.streaming.delete(liveKey);
        }
        const entry = this.pushItem(seq, {
          kind: 'assistant',
          time,
          turn: data?.turn,
          step: data?.step,
          interrupted: Boolean(data?.interrupted),
          parts: blocksOf(data?.message?.content),
          usage: data?.usage ?? null,
        });
        if (data?.usage) {
          this.usage = {
            uncachedInputTokens: this.usage.uncachedInputTokens + (data.usage.inputTokens ?? 0),
            outputTokens: this.usage.outputTokens + (data.usage.outputTokens ?? 0),
            cacheReadTokens: this.usage.cacheReadTokens + (data.usage.cacheReadTokens ?? 0),
            cacheWriteTokens: this.usage.cacheWriteTokens + (data.usage.cacheWriteTokens ?? 0),
          };
        }
        // A finished answer retires any live streaming buffer on the same step.
        return entry;
      }
      case 'assistant/chunk': {
        this.applyChunk(seq, time, data);
        return null;
      }
      case 'tool/call': {
        const entry = this.pushItem(seq, {
          kind: 'tool',
          time,
          callId: data?.callId,
          name: data?.name,
          summary: summarizeArguments(data?.arguments),
          arguments: clip(data?.arguments ?? '', 4000),
          output: null,
          isError: false,
          running: true,
        });
        if (data?.callId) this.toolCalls.set(data.callId, entry);
        return entry;
      }
      case 'tool/result': {
        const { callId, output, isError } = toolResultParts(data?.message);
        const call = callId ? this.toolCalls.get(callId) : undefined;
        if (call) {
          call.output = output;
          call.isError = isError || Boolean(data?.error);
          call.running = false;
          call.errorName = data?.error?.name;
          return call;
        }
        return this.pushItem(seq, {
          kind: 'tool', time, callId, name: data?.message?.name ?? 'tool',
          summary: '', output, isError: isError || Boolean(data?.error), running: false,
        });
      }
      case 'turn/start':
        this.running = true;
        return this.pushItem(seq, { kind: 'turn-start', time, turn: data?.turn });
      case 'turn/end': {
        const reason = typeof data?.reason === 'string' ? data.reason : data?.reason?.kind;
        this.running = false;
        this.finalizeStreaming();
        this.finalizeTools(reason);
        return this.pushItem(seq, { kind: 'turn-end', time, turn: data?.turn, reason,
          error: typeof data?.reason === 'object' ? clip(data.reason.error?.message ?? '', 2000) : '' });
      }
      case 'session/title': {
        this.title = typeof data === 'string' ? data : data?.title ?? null;
        return null;
      }
      default:
        return null;
    }
  }

  /** Merge streamed block deltas into a synthetic streaming item. */
  applyChunk(seq, time, data) {
    const chunk = data?.chunk;
    if (!chunk) return;
    const key = `${data.turn}:${data.step}`;
    let buffer = this.streaming.get(key);
    if (!buffer) {
      buffer = { kind: 'assistant', streaming: true, seq, time, turn: data.turn, step: data.step, parts: [], usage: null, interrupted: false };
      this.streaming.set(key, buffer);
      this.items.push(buffer);
    }
    const ensure = (index, kind) => {
      while (buffer.parts.length <= index) buffer.parts.push({ kind: 'text', text: '' });
      if (!buffer.parts[index] || buffer.parts[index].kind !== kind) buffer.parts[index] = { kind, text: '' };
      return buffer.parts[index];
    };
    switch (chunk.type) {
      case 'block-start':
        ensure(chunk.index, chunk.blockType === 'reasoning' ? 'reasoning' : chunk.blockType === 'tool-call' ? 'tool-call' : 'text');
        break;
      case 'text-delta':
        ensure(chunk.index, 'text').text = clip(ensure(chunk.index, 'text').text + chunk.text);
        break;
      case 'reasoning-delta':
        ensure(chunk.index, 'reasoning').text = clip(ensure(chunk.index, 'reasoning').text + chunk.text);
        break;
      case 'tool-call-delta': {
        const part = ensure(chunk.index, 'tool-call');
        part.callId = chunk.id;
        if (chunk.name) part.name = chunk.name;
        part.arguments = clip((part.arguments ?? '') + chunk.argumentsDelta, 4000);
        part.summary = summarizeArguments(part.arguments);
        break;
      }
      case 'block-end': {
        const part = ensure(chunk.index, 'text');
        const finished = blocksOf([chunk.block])[0];
        if (finished) Object.assign(part, finished);
        break;
      }
      case 'usage':
        buffer.usage = chunk.usage ?? buffer.usage;
        break;
      default:
        break;
    }
    buffer.time = time ?? buffer.time;
  }

  /** Drop streaming markers once a turn closes so the finished item is authoritative. */
  finalizeStreaming() {
    for (const [key, buffer] of [...this.streaming.entries()]) {
      buffer.streaming = false;
      this.streaming.delete(key);
    }
  }

  /** A closed turn cannot still own a running tool, even if an old/pruned log omitted its result. */
  finalizeTools(reason) {
    const completed = reason === undefined || reason === 'complete' || reason === 'completed';
    for (const call of this.toolCalls.values()) {
      if (!call.running) continue;
      call.running = false;
      if (!completed) call.interrupted = true;
    }
  }

  /** Load history pages backwards, keeping only surface events, until the transcript has enough. */
  async hydrate(client, { maxMessages = 12, maxPages = 6 } = {}) {
    let beforeSeq;
    let messages = 0;
    const collected = [];
    for (let page = 0; page < maxPages; page++) {
      // eslint-disable-next-line no-await-in-loop
      const result = await client.history(this.sessionId, beforeSeq, 4);
      const events = result?.events ?? [];
      for (const entry of events) {
        const event = entry?.event ?? entry;
        if (event && event.type !== 'assistant/chunk') collected.push(event);
      }
      messages += events.length;
      if (!result?.hasMore || messages >= maxMessages * 12) break;
      beforeSeq = events.length ? events[0].event?.seq : undefined;
      if (beforeSeq === undefined) break;
    }
    // Pages arrive newest first. Folding them immediately let an old turn/start overwrite a
    // newer turn/end, so the app reopened with the composer permanently marked as streaming.
    collected.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    for (const event of collected) this.apply(event);
    this.items.sort((a, b) => (a.time ?? 0) - (b.time ?? 0) || (a.seq ?? 0) - (b.seq ?? 0));
    return this.snapshot();
  }

  snapshot() {
    return {
      sessionId: this.sessionId,
      title: this.title,
      running: this.running,
      usage: this.usage,
      context: {
        pressure: this.projections.contextPressure ?? null,
        breakdown: this.projections.contextBreakdown ?? null,
        imageLimits: this.projections.imageLimits ?? null,
      },
      lastSeq: this.lastSeq,
      items: this.items.filter((item) => item.kind !== 'turn-start'),
      approvals: [...this.approvals.values()],
      questions: [...this.questions.values()],
    };
  }
}

/**
 * Owns every transcript the app has opened, plus the live mux subscription that keeps them
 * fresh. The renderer talks to it exclusively through its JSON snapshot.
 */
class ChatController {
  constructor(client, { onUpdate } = {}) {
    this.client = client;
    this.onUpdate = onUpdate ?? (() => {});
    /** @type {Map<string, Transcript>} */
    this.transcripts = new Map();
    this.pollers = new Map();
    this.opening = new Map();
    this.disposed = false;
    this.unsubscribe = this.client.onFrame((frame) => this.handleFrame(frame));
    this.hostUnsubscribe = this.client.onHostFrame?.((frame) => this.handleHostFrame(frame));
  }

  handleHostFrame(frame) {
    if (!frame || typeof frame !== 'object') return;
    if (frame.type === 'session/removed' && frame.sessionId) {
      this.close(frame.sessionId);
      return;
    }
    const transcript = this.transcripts.get(frame.sessionId);
    if (!transcript) {
      if (frame.type === 'question/request' || frame.type === 'approval/request') {
        this.open(frame.sessionId).catch((error) => log('chat', 'interactive session open failed', String(error)));
      }
      return;
    }
    if (frame.type === 'approval/request' && frame.approval?.eventId) {
      transcript.approvals.set(frame.approval.eventId, frame.approval);
    } else if ((frame.type === 'approval/cancel' || frame.type === 'approval/answered') && frame.eventId) {
      transcript.approvals.delete(frame.eventId);
    } else if (frame.type === 'question/request' && frame.question?.eventId) {
      transcript.questions.set(frame.question.eventId, frame.question);
    } else if ((frame.type === 'question/cancel' || frame.type === 'question/answered') && frame.eventId) {
      transcript.questions.delete(frame.eventId);
    } else {
      return;
    }
    this.onUpdate({ sessionId: frame.sessionId,
      ...(frame.type.startsWith('approval/') ? { approval: frame.type } : { question: frame.type }),
      transcript: transcript.snapshot() });
  }

  syncPendingApprovals(transcript) {
    transcript.approvals.clear();
    for (const approval of this.client.pendingApprovalsFor?.(transcript.sessionId) ?? []) {
      if (approval?.eventId) transcript.approvals.set(approval.eventId, approval);
    }
    transcript.questions.clear();
    for (const question of this.client.pendingQuestionsFor?.(transcript.sessionId) ?? []) {
      if (question?.eventId) transcript.questions.set(question.eventId, question);
    }
  }

  handleFrame(frame) {
    if (!frame || typeof frame !== 'object') return;
    if (frame.type === 'session/event') {
      const transcript = this.transcripts.get(frame.sessionId);
      if (!transcript) return;
      transcript.apply(frame.event);
      if (frame.event?.type === 'turn/end' && !transcript.running) {
        clearTimeout(this.pollers.get(frame.sessionId));
        this.pollers.delete(frame.sessionId);
      }
      if (frame.view?.for === 'call' || frame.view?.for === 'result') {
        // Host-computed presentation views ride along; keep the raw card but let the
        // renderer show a friendlier title when one is present.
        const callId = frame.event?.data?.callId
          ?? frame.event?.data?.message?.source?.callId
          ?? frame.event?.data?.message?.callId;
        const entry = callId ? transcript.toolCalls.get(callId) : undefined;
        if (entry) entry.view = frame.view.view ?? null;
      }
      this.onUpdate({ sessionId: frame.sessionId, event: frame.event, transcript: transcript.snapshot() });
      return;
    }
    if (frame.type === 'session/snapshot') {
      const transcript = this.transcripts.get(frame.sessionId);
      if (!transcript) return;
      const records = (frame.records ?? [])
        .map((record) => record?.event ?? record)
        .filter((event) => event && typeof event.seq === 'number' && event.seq > transcript.lastSeq)
        .sort((a, b) => a.seq - b.seq);
      for (const event of records) transcript.apply(event);
      transcript.applyProjections(frame.projections?.values);
      if (frame.projections?.values?.title) transcript.title = frame.projections.values.title;
      if (frame.running) transcript.running = true;
      this.onUpdate({ sessionId: frame.sessionId, snapshot: true, transcript: transcript.snapshot() });
      return;
    }
    if (frame.type === 'session/projections') {
      const transcript = this.transcripts.get(frame.sessionId);
      if (!transcript) return;
      transcript.applyProjections(frame.values);
      if (typeof frame.values?.title === 'string') transcript.title = frame.values.title;
      this.onUpdate({ sessionId: frame.sessionId, projections: true, transcript: transcript.snapshot() });
      return;
    }
    if (frame.type === 'session/streaming') {
      const transcript = this.transcripts.get(frame.sessionId);
      if (!transcript) return;
      // An assistant attempt ends before tools/approvals and the next reasoning step.
      // Only turn/end or a successful cancellation ends the whole task.
      if (frame.running) transcript.running = true;
      if (!frame.running) {
        // Keep buffers indexed until the durable assistant/message arrives so it can replace
        // them; only remove the visual "生成中" marker at logical-stream end.
        for (const buffer of transcript.streaming.values()) buffer.streaming = false;
      }
      this.onUpdate({ sessionId: frame.sessionId, streaming: frame.running, transcript: transcript.snapshot() });
      return;
    }
    if (frame.type === 'session/subscribed') {
      const transcript = this.transcripts.get(frame.sessionId);
      if (transcript && typeof frame.lastSeq === 'number') transcript.lastSeq = Math.max(transcript.lastSeq, frame.lastSeq);
      return;
    }
    if (frame.type === 'session/projection') {
      const transcript = this.transcripts.get(frame.sessionId);
      if (!transcript) return;
      transcript.applyProjections({ [frame.key]: frame.value });
      if (frame.key === 'title' && typeof frame.value === 'string') transcript.title = frame.value;
      this.onUpdate({ sessionId: frame.sessionId, projection: frame.key, transcript: transcript.snapshot() });
    }
  }

  /** Ensure a transcript exists (hydrated from history) and return its snapshot. */
  async open(sessionId, options) {
    if (this.opening.has(sessionId)) return this.opening.get(sessionId);
    let transcript = this.transcripts.get(sessionId);
    if (!transcript) {
      transcript = new Transcript(sessionId);
      transcript.applyProjections(this.client.projectionsFor?.(sessionId));
      this.transcripts.set(sessionId, transcript);
      const pending = (async () => {
        try {
          await transcript.hydrate(this.client, options);
          if (!this.disposed && this.transcripts.get(sessionId) === transcript) {
            this.client.followSession?.(sessionId);
            this.syncPendingApprovals(transcript);
            if (transcript.running) this.watchUntilSettled(sessionId);
          }
          return transcript.snapshot();
        } catch (error) {
          this.transcripts.delete(sessionId);
          throw error;
        } finally {
          this.opening.delete(sessionId);
        }
      })();
      this.opening.set(sessionId, pending);
      return pending;
    }
    // Navigation is renderer-only. Keep every opened task subscribed independently.
    transcript.applyProjections(this.client.projectionsFor?.(sessionId));
    this.client.followSession?.(sessionId);
    this.syncPendingApprovals(transcript);
    return transcript.snapshot();
  }

  async refresh(sessionId) {
    // Refresh the inclusive cursor before paging; the cursor cached at startup is otherwise
    // stale and a manual refresh cannot see an answer that just finished.
    await this.client.listSessions();
    await this.open(sessionId);
    const transcript = this.transcripts.get(sessionId);
    if (!transcript) return null;
    // A refresh must see the newest events: the API only returns the newest window, with
    // the highest seq loaded last, so we keep the highest-seq snapshot of each page.
    let beforeSeq;
    const collected = [];
    for (let page = 0; page < 8; page++) {
      // eslint-disable-next-line no-await-in-loop
      const result = await this.client.history(sessionId, beforeSeq, 6);
      const events = result?.events ?? [];
      for (const entry of events) {
        const event = entry?.event ?? entry;
        if (event && event.type !== 'assistant/chunk') collected.push(event);
      }
      if (!result?.hasMore) break;
      beforeSeq = events.length ? events[0].event?.seq : undefined;
      if (beforeSeq === undefined) break;
    }
    collected.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    for (const event of collected) transcript.apply(event);
    // Merge into the live transcript; replacing it here discards in-flight chunks and
    // optimistic messages received while history was loading in another conversation.
    this.syncPendingApprovals(transcript);
    return transcript.snapshot();
  }

  close(sessionId) {
    clearTimeout(this.pollers.get(sessionId));
    this.pollers.delete(sessionId);
    this.client.unfollowSession?.(sessionId);
    this.transcripts.delete(sessionId);
  }

  /** Reconnect to tasks already running when the shell opens, without navigating to them. */
  observeRunning(sessions) {
    for (const session of sessions) {
      if (!session.running || this.transcripts.has(session.sessionId)) continue;
      this.open(session.sessionId).then((transcript) => {
        if (!this.disposed) this.onUpdate({ sessionId: session.sessionId, transcript });
      }).catch((error) => log('chat', 'background session subscription failed', String(error)));
    }
  }

  /** Create a session and return its id (+ the preset that actually bound). */
  async createSession({ cwd, workspaceId, agentPreset } = {}) {
    const payload = {};
    if (workspaceId) payload.workspaceId = workspaceId;
    else if (cwd) payload.cwd = cwd;
    if (agentPreset) payload.agentPreset = agentPreset;
    const created = await this.client.createSession(payload);
    const transcript = new Transcript(created.sessionId);
    transcript.applyProjections(this.client.projectionsFor?.(created.sessionId));
    this.transcripts.set(created.sessionId, transcript);
    this.client.followSession?.(created.sessionId);
    return created;
  }

  /** Send a prompt and optimistically echo the user bubble before the event arrives. */
  async send(sessionId, text, attachments = [], mode = 'queue') {
    let transcript = this.transcripts.get(sessionId);
    if (!transcript) {
      transcript = new Transcript(sessionId);
      transcript.applyProjections(this.client.projectionsFor?.(sessionId));
      this.transcripts.set(sessionId, transcript);
    }
    transcript.running = true;
    const requestId = rid('prompt');
    const optimisticParts = [
      ...attachments.map((attachment) => ({
        kind: attachment.kind === 'image' ? 'image' : 'file',
        name: attachment.name,
        mediaType: attachment.mediaType ?? null,
        bytes: attachment.bytes?.byteLength ?? attachment.bytes?.length ?? 0,
      })),
      ...(text ? [{ kind: 'text', text: clip(text) }] : []),
    ];
    const optimistic = {
      kind: 'user', time: Date.now(), source: 'user', synthetic: false, pending: true,
      requestId,
      text: clip(text),
      parts: optimisticParts,
      seq: undefined,
    };
    transcript.items.push(optimistic);
    this.client.followSession?.(sessionId);
    this.onUpdate({ sessionId, event: { type: 'optimistic' }, transcript: transcript.snapshot() });
    this.watchUntilSettled(sessionId);
    try {
      const content = [];
      for (const attachment of attachments) {
        const bytes = Buffer.isBuffer(attachment.bytes) ? attachment.bytes : Buffer.from(attachment.bytes);
        if (attachment.kind === 'image') {
          content.push({
            type: 'image', mediaType: attachment.mediaType, data: bytes.toString('base64'),
            ...(attachment.name ? { name: attachment.name } : {}),
          });
        } else {
          // Generic files are staged through the Harness's authenticated streaming route;
          // the prompt carries only the one-use receipt, never a filesystem path.
          // eslint-disable-next-line no-await-in-loop
          const uploaded = await this.client.uploadFile(sessionId, bytes, attachment.name);
          content.push({ type: 'file', receiptId: uploaded.receiptId });
        }
      }
      await this.client.prompt(sessionId, text, mode, undefined, requestId, content);
    } catch (error) {
      optimistic.pending = false;
      optimistic.failed = String(error?.message ?? error);
      // A rejected request must not leave an otherwise idle conversation disabled.
      if (transcript.items.includes(optimistic)) transcript.running = false;
      this.onUpdate({ sessionId, event: { type: 'prompt-failed' }, transcript: transcript.snapshot() });
      throw error;
    }
    return transcript.snapshot();
  }

  /** Settle one visible approval and let the blocked tool continue or fail immediately. */
  async answerApproval(sessionId, eventId, outcome) {
    const transcript = this.transcripts.get(sessionId);
    if (!transcript?.approvals.has(eventId)) throw new Error('该权限请求已经结束');
    const result = await this.client.answerApproval(eventId, outcome);
    transcript.approvals.delete(eventId);
    this.onUpdate({ sessionId, approval: 'approval/answered', transcript: transcript.snapshot() });
    return result;
  }

  async answerQuestion(sessionId, eventId, answers) {
    const transcript = this.transcripts.get(sessionId);
    if (!transcript?.questions.has(eventId)) throw new Error('该问题已经结束');
    const result = await this.client.answerQuestion(eventId, answers);
    transcript.questions.delete(eventId);
    this.onUpdate({ sessionId, question: 'question/answered', transcript: transcript.snapshot() });
    return result;
  }

  /**
   * Low-frequency durable reconciliation backs up the live follow stream. It is intentionally
   * kept even with a healthy WebSocket: antivirus/proxy products on Windows can allow the
   * upgrade but drop logical stream frames, and a finished answer must still appear without a
   * restart.
   */
  watchUntilSettled(sessionId, attempt = 0) {
    clearTimeout(this.pollers.get(sessionId));
    const timer = setTimeout(async () => {
      this.pollers.delete(sessionId);
      const transcript = this.transcripts.get(sessionId);
      if (!transcript) return;
      try {
        await this.client.listSessions();
        const page = await this.client.history(sessionId, undefined, 8);
        if (this.disposed || this.transcripts.get(sessionId) !== transcript) return;
        const events = (page?.events ?? [])
          .map((entry) => entry?.event ?? entry)
          .filter((event) => event && typeof event.seq === 'number' && event.seq > transcript.lastSeq)
          .sort((a, b) => a.seq - b.seq);
        for (const event of events) transcript.apply(event);
        if (events.length) this.onUpdate({ sessionId, reconciled: true, transcript: transcript.snapshot() });
      } catch (error) {
        if (attempt === 0) log('chat', 'durable answer reconciliation failed', String(error));
      }
      if (!this.disposed && this.transcripts.get(sessionId) === transcript && transcript.running) {
        this.watchUntilSettled(sessionId, attempt + 1);
      }
    }, Math.min(15000, 1500 + Math.floor(attempt / 20) * 1500));
    this.pollers.set(sessionId, timer);
  }

  async cancel(sessionId) {
    await this.client.cancel(sessionId);
    clearTimeout(this.pollers.get(sessionId));
    this.pollers.delete(sessionId);
    const transcript = this.transcripts.get(sessionId);
    if (transcript) {
      transcript.running = false;
      transcript.finalizeStreaming();
      transcript.finalizeTools('cancelled');
      this.onUpdate({ sessionId, event: { type: 'cancelled' }, transcript: transcript.snapshot() });
    }
  }

  dispose() {
    this.disposed = true;
    for (const sessionId of this.transcripts.keys()) this.client.unfollowSession?.(sessionId);
    this.unsubscribe?.();
    this.hostUnsubscribe?.();
    for (const timer of this.pollers.values()) clearTimeout(timer);
    this.pollers.clear();
    this.transcripts.clear();
  }
}

module.exports = { ChatController, Transcript, blocksOf, summarizeArguments, clip, rid };
