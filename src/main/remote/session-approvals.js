'use strict';

// Explicit owner grants live only in this desktop process. They never become a model
// instruction, a global permission preset, or an answer to an ordinary user question.
function safetyAnswers(pending) {
  const questions = pending?.questions;
  if (!Array.isArray(questions) || questions.length !== 1) return null;
  const q = questions[0];
  if (q?.id !== 'desktop-safety-guard' || !Array.isArray(q.options) || !q.options.some((o) => o?.label === '允许这一次')) return null;
  return [{ id: q.id, selected: ['允许这一次'] }];
}
function isSafetyAllowance(pending, answers) {
  return Boolean(safetyAnswers(pending) && Array.isArray(answers) && answers.length === 1
    && answers[0]?.id === 'desktop-safety-guard' && answers[0]?.selected?.length === 1
    && answers[0].selected[0] === '允许这一次'
    && (answers[0].custom == null || (typeof answers[0].custom === 'string' && !answers[0].custom.trim())));
}

class SessionApprovals {
  constructor({ chat, permission, maxPermission, guard }) {
    Object.assign(this, { chat, permission, maxPermission, guard });
    this.grants = new Map();
    this.draining = new Map();
    this.generation = 0;
    this.revisions = new Map();
  }
  ticket(sessionId) { return { generation: this.generation, revision: this.revisions.get(sessionId) ?? 0 }; }
  clear() { this.generation++; this.grants.clear(); this.revisions.clear(); }
  revoke(sessionId) { this.grants.delete(sessionId); this.revisions.set(sessionId, (this.revisions.get(sessionId) ?? 0) + 1); }
  revokePhone(phone) {
    this.generation++; // Also invalidate a grant still waiting for its first decision reply.
    for (const [id, grant] of this.grants) if (grant.phone === phone) this.revoke(id);
  }
  async valid(sessionId) {
    const grant = this.grants.get(sessionId);
    if (!grant) return null;
    if (!this.guard() || grant.max !== this.maxPermission() || grant.permission !== await this.permission(sessionId)) {
      this.revoke(sessionId);
      return null;
    }
    return this.grants.get(sessionId) === grant ? grant : null;
  }
  async status(sessionId) { return { supported: true, active: Boolean(await this.valid(sessionId)) }; }
  async allow(sessionId, phone, ticket = this.ticket(sessionId)) {
    const permission = await this.permission(sessionId);
    const current = this.ticket(sessionId);
    if (ticket.generation !== current.generation || ticket.revision !== current.revision) throw new Error('会话授权已变化，请刷新后重新确认');
    if (!permission || !this.guard()) throw new Error('当前会话无法开启连续批准，请刷新后重试');
    this.grants.set(sessionId, { phone, permission, max: this.maxPermission() });
    await this.drain(sessionId);
    return this.status(sessionId);
  }
  drain(sessionId) {
    if (this.draining.has(sessionId)) return this.draining.get(sessionId);
    const work = this.flush(sessionId).finally(() => this.draining.delete(sessionId));
    this.draining.set(sessionId, work);
    return work;
  }
  async flush(sessionId) {
    try {
      while (await this.valid(sessionId)) {
        const transcript = this.chat().transcripts.get(sessionId);
        if (!transcript) { this.revoke(sessionId); return; }
        const approval = transcript.approvals.values().next().value;
        const question = [...transcript.questions.values()].find((q) => safetyAnswers(q));
        if (!approval && !question) return;
        // A revoke, permission change, or pending cancellation during the async check wins.
        if (!await this.valid(sessionId)) return;
        if (approval && transcript.approvals.has(approval.eventId)) {
          await this.chat().answerApproval(sessionId, approval.eventId, 'allowed-once');
        } else if (question && transcript.questions.has(question.eventId)) {
          await this.chat().answerQuestion(sessionId, question.eventId, safetyAnswers(question));
        }
      }
    } catch (error) {
      this.revoke(sessionId);
      throw error; // Leave unanswered requests visible; never retry a failed decision.
    }
  }
}
module.exports = { SessionApprovals, safetyAnswers, isSafetyAllowance };
