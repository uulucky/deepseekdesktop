'use strict';
const crypto = require('node:crypto');
const { RemoteRuleError } = require('./rules');

function canonical(value) { return JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v); }

/** A finished model turn is not proof that its automatic workflow passed acceptance. */
function workflowOutcome(items = []) {
  const workflow = [...items].reverse().find(item => item.kind === 'workflow');
  if (workflow?.status === 'blocked') return 'failed';
  if (workflow?.status === 'cancelled' || workflow?.status === 'running') return 'stopped';
  return null;
}

/** A disconnected client is not evidence that execution completed. */
function taskState(snapshot = {}, fallback = {}) {
  if (snapshot.approvals?.length || snapshot.approvals?.size) return 'waiting-approval';
  if (snapshot.questions?.length || snapshot.questions?.size) return 'waiting-answer';
  if (snapshot.running ?? fallback.running) return 'running';
  if (snapshot.items?.some((i) => i.kind === 'user' && i.pending && !i.failed)) return 'queued';
  const workflow = workflowOutcome(snapshot.items);
  if (workflow) return workflow;
  const end = [...(snapshot.items ?? [])].reverse().find((item) => item.kind === 'turn-end');
  if (end?.error || /error|fail/i.test(end?.reason ?? '')) return 'failed';
  if (/cancel|stop|interrupt/i.test(end?.reason ?? '')) return 'stopped';
  if (end) return 'completed';
  return fallback.status ?? 'idle';
}

/** Stable sequence cursor: live appended items never move the earlier-page boundary. */
function historyPage(items, { before, limit = 120 } = {}) {
  const count = Math.min(120, Math.max(1, Math.floor(Number(limit) || 120)));
  let source = items ?? [];
  if (before != null && before !== '') {
    if (/^i:\d+$/.test(String(before))) source = source.slice(0, Number(String(before).slice(2)));
    else {
      const seq = Number(before);
      if (!Number.isFinite(seq)) throw new RemoteRuleError('历史分页游标无效', 400, 'bad-cursor');
      source = source.filter((item) => Number.isFinite(item.seq) && item.seq < seq);
    }
  }
  const selected = source.slice(-count), start = source.length - selected.length;
  return { items: selected, hasMore: start > 0,
    before: selected.length ? (Number.isFinite(selected[0].seq) ? String(selected[0].seq) : `i:${start}`) : null,
    truncated: start > 0 };

}

/** Persist intent before executing. An interrupted POST stays uncertain, never auto-replayed. */
class RequestLedger {
  constructor(store, now = Date.now) { this.store = store; this.now = now; this.inflight = new Map(); }
  records() { return this.store().get('remoteRequests', {}); }
  key(phone, op, id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(id)) throw new RemoteRuleError('请求标识无效', 400, 'bad-request-id');
    return crypto.createHash('sha256').update(`${phone}\0${op}\0${id}`).digest('hex');
  }
  lookup(phone, op, id) { return this.records()[this.key(phone, op, id)] ?? { status: 'not-found' }; }
  save(key, value) {
    const records = { ...this.records(), [key]: value };
    const entries = Object.entries(records).sort((a, b) => b[1].at - a[1].at).slice(0, 2000);
    this.store().set('remoteRequests', Object.fromEntries(entries));
  }
  async once(phone, op, body, action) {
    if (!body?.requestId) return action(); // Compatibility with already released phones.
    const key = this.key(phone, op, body.requestId);
    const digest = crypto.createHash('sha256').update(canonical(body)).digest('hex');
    const previous = this.records()[key];
    if (previous) {
      if (previous.digest !== digest) throw new RemoteRuleError('同一请求标识不能用于不同内容', 409, 'request-conflict');
      if (this.inflight.has(key)) return this.inflight.get(key);
      if (previous.status === 'accepted') return previous.result;
      throw new RemoteRuleError('上次请求结果未知，请先核对电脑上的任务；不会自动重发', 409, 'request-uncertain');
    }
    this.save(key, { at: this.now(), status: 'pending', digest });
    const promise = (async () => {
      try {
        const result = await Promise.resolve().then(action);
        // Only handlers with compact, non-secret receipts may use this ledger.
        this.save(key, { at: this.now(), status: 'accepted', digest, result });
        return result;
      } catch (error) {
        this.save(key, { at: this.now(), status: 'uncertain', digest });
        throw error;
      } finally { this.inflight.delete(key); }
    })();
    this.inflight.set(key, promise); return promise;
  }
}
module.exports = { taskState, workflowOutcome, historyPage, RequestLedger };
