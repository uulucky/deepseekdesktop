'use strict';

/**
 * Coalesce high-frequency Harness snapshots before they cross Electron IPC.
 *
 * A streaming token can cause ChatController to emit a complete transcript. Sending every
 * snapshot makes Electron clone an ever-growing object over and over and can exhaust the
 * Windows renderer. We only need the newest snapshot for each conversation between paints.
 */
class TranscriptDispatcher {
  constructor(send, { intervalMs = 80, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.send = send;
    this.intervalMs = intervalMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.pending = new Map();
    this.timers = new Map();
  }

  push(payload) {
    const sessionId = payload?.sessionId;
    if (!sessionId || !payload?.transcript) return;
    this.pending.set(sessionId, payload);
    if (this.isUrgent(payload)) {
      this.flush(sessionId);
      return;
    }
    if (this.timers.has(sessionId)) return;
    this.timers.set(sessionId, this.setTimer(() => this.flush(sessionId), this.intervalMs));
  }

  isUrgent(payload) {
    const type = payload?.event?.type;
    return Boolean(payload.approval || payload.question || payload.transcript?.running === false
      || ['optimistic', 'prompt-failed', 'cancelled', 'turn/start', 'turn/end'].includes(type));
  }

  flush(sessionId) {
    const timer = this.timers.get(sessionId);
    if (timer !== undefined) this.clearTimer(timer);
    this.timers.delete(sessionId);
    const payload = this.pending.get(sessionId);
    this.pending.delete(sessionId);
    if (payload) this.send(payload);
  }

  dispose() {
    for (const timer of this.timers.values()) this.clearTimer(timer);
    this.timers.clear();
    this.pending.clear();
  }
}

module.exports = { TranscriptDispatcher };
