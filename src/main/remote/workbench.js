'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { RemoteRuleError } = require('./rules');
const { taskState } = require('./task-state');
const { recentFiles } = require('./gateway');

const STATUS_LABELS = { idle: '未开始', running: '运行中', queued: '已排队', 'waiting-answer': '待回答', 'waiting-approval': '待审批', completed: '已完成', stopped: '已停止', failed: '失败', disconnected: '连接中断' };
const TEMPLATES = [
  { id: 'files', name: '整理文件', text: '检查当前工作目录中的文件，先给出整理方案，说明会移动或修改哪些文件，等我确认。' },
  { id: 'report', name: '生成周报', text: '根据当前项目资料整理本周工作报告，列出已完成、遇到的问题和下一步，生成可下载文件。' },
  { id: 'check', name: '检查任务', text: '检查当前项目的运行或测试状态，说明发现的问题和建议，不修改文件。' },
  { id: 'research', name: '资料分析', text: '分析我提供的资料，给出有依据的结论，标明不确定之处，并整理成文档。' },
];
function text(value, max = 2000) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function validTitle(value) { const title = text(value, 120); if (!title) throw new RemoteRuleError('名称不能为空', 400); return title; }
function safeMemory(value) {
  const result = text(value, 4000);
  if (/-----BEGIN|sk-[a-zA-Z0-9]{16,}|(?:密码|口令|token|api.?key)\s*[:：=]\s*\S+/i.test(result)) throw new RemoteRuleError('项目说明中不能保存密码或密钥', 400, 'sensitive-memory');
  return result;
}
function zonedMinute(date, zone) {
  const fields = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(date).map((p) => [p.type, p.value]));
  return { time: `${fields.hour}:${fields.minute}`, weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(fields.weekday) };
}
function nextRun(rule, after) {
  if (rule.kind === 'once') return Number(rule.at) > after ? Number(rule.at) : null;
  if (rule.kind === 'interval') return after + Number(rule.minutes) * 60000;
  const start = Math.floor(after / 60000) * 60000 + 60000;
  for (let at = start; at <= start + 8 * 86400000; at += 60000) {
    const p = zonedMinute(new Date(at), rule.timeZone);
    if (p.time === rule.time && (rule.kind === 'daily' || rule.days.includes(p.weekday))) return at;
  }
  throw new RemoteRuleError('无法计算下一次执行时间', 400);
}
function validateRule(value, now) {
  const rule = { kind: value?.kind ?? 'daily', timeZone: value?.timeZone ?? 'Asia/Shanghai', time: value?.time ?? '09:00', days: value?.days ?? [1, 2, 3, 4, 5], minutes: Number(value?.minutes ?? 60), at: Number(value?.at) };
  try { zonedMinute(new Date(now), rule.timeZone); } catch { throw new RemoteRuleError('时区无效', 400); }
  if (!['once', 'interval', 'daily', 'weekly'].includes(rule.kind) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(rule.time)
    || (rule.kind === 'interval' && (!Number.isFinite(rule.minutes) || rule.minutes < 15 || rule.minutes > 525600))
    || (rule.kind === 'once' && (!Number.isFinite(rule.at) || rule.at <= now))
    || (rule.kind === 'weekly' && (!Array.isArray(rule.days) || !rule.days.length || rule.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)))) throw new RemoteRuleError('执行时间规则无效', 400);
  return rule;
}

class MobileWorkbench {
  constructor(remote, { now = Date.now } = {}) { this.remote = remote; this.now = now; this.running = new Set(); this.timer = null; this.notifications = new Map(); this.lastStates = new Map(); this.budgetStopped = new Set(); this.budgetAllowances = new Map(); }
  ctx() { return this.remote.getContext(); }
  state() { return this.ctx().uiStore.get('mobileWorkbench', { pins: [], seen: {}, events: [], projects: {}, schedules: [], budget: {} }); }
  change(fn) { const value = structuredClone(this.state()); fn(value); this.ctx().uiStore.set('mobileWorkbench', value); return value; }
  start() { if (!this.timer) { this.timer = setInterval(() => this.tick().catch((e) => this.remote.log('remote', 'automation check failed', String(e))), 15000); this.timer.unref?.(); } }
  stop() { clearInterval(this.timer); this.timer = null; for (const t of this.notifications.values()) clearTimeout(t); this.notifications.clear(); }
  snapshotOf(id) { return this.ctx().chat.transcripts?.get(id)?.snapshot?.() ?? this.ctx().chat.transcripts?.get(id) ?? {}; }
  decorate(row, phone) {
    const state = this.state(), snapshot = this.snapshotOf(row.sessionId), status = taskState(snapshot, row);
    const outcome = state.outcomes?.[row.sessionId];
    const resolvedStatus = row.running ? status : (snapshot.items?.length || snapshot.running ? status : outcome?.status ?? status);
    const seq = snapshot.lastSeq ?? outcome?.seq ?? -1, seen = state.seen?.[`${phone}:${row.sessionId}`] ?? -1;
    const workflow = snapshot.items?.findLast?.((i) => i.kind === 'workflow');
    return { ...row, status: resolvedStatus, statusLabel: STATUS_LABELS[resolvedStatus], unread: seq > seen && ['completed', 'failed', 'stopped'].includes(resolvedStatus), pinned: (state.pins ?? []).includes(row.sessionId), lastSeq: seq,
      lastActivity: snapshot.items?.at(-1)?.time ?? row.updatedAt, error: snapshot.items?.findLast?.((i) => i.kind === 'turn-end')?.error
        || (workflow?.status === 'blocked' ? workflow.error : '') || '',
      latest: String((snapshot.items ?? []).filter((i) => ['user', 'assistant'].includes(i.kind)).at(-1)?.parts?.filter((p) => p.kind === 'text').map((p) => p.text).join('') ?? '').replace(/<\/?desktop-summary>/g, '').replace(/<desktop-runtime>[\s\S]*?<\/desktop-runtime>/g, '').slice(0, 160) };
  }
  async snapshot(phone, sessionId = '') {
    const state = this.state();
    const workspaces = await this.ctx().client.listWorkspaces?.() ?? { items: [] };
    const info = this.ctx().uiStore.get('phonePushTickets', {})[phone];
    return { capabilities: { version: 1, historyCursor: true, requests: true, management: true, schedules: true, projects: true, steering: true, billing: true }, templates: [...TEMPLATES, ...(state.templates ?? []).map((t) => ({ ...t, custom: true }))], workspaces: workspaces.items ?? [],
      projects: Object.entries(state.projects ?? {}).map(([id, value]) => ({ id, ...value })),
      schedules: state.schedules ?? [], budget: { ...(state.budget ?? {}), taskLimit: state.budget?.taskLimits?.[sessionId] ?? state.budget?.taskLimit ?? 0 },
      notifications: (state.events ?? []).map((e) => ({ ...e, read: (state.seen?.[`${phone}:${e.sessionId}`] ?? -1) >= e.seq })),
      push: { configured: Boolean(info?.expiresAt > this.now()), message: info?.expiresAt > this.now() ? '已注册系统推送' : '尚未注册系统推送，可在手机任务工具中开启；服务端未配置时仅应用内提醒' },
      sessionId, billing: this.billing(sessionId), desktop: this.remote.state.name };
  }
  billing(id) {
    const s = this.snapshotOf(id), usage = s.usage ?? {}, budget = this.state().budget ?? {};
    const input = Number(usage.uncachedInputTokens ?? 0), output = Number(usage.outputTokens ?? 0), cached = Number(usage.cacheReadTokens ?? 0);
    const model = this.ctx().client.sessionSelections?.get(id)?.model ?? '';
    const rates = budget.ratesModel && budget.ratesModel === model && !this.state().mixedModels?.[id] ? budget.rates : null;
    const priced = rates && ['input', 'output', 'cached'].every((k) => Number.isFinite(rates[k]) && rates[k] >= 0);
    const estimate = priced ? (input * rates.input + output * rates.output + cached * rates.cached) / 1000000 : null;
    const balance = this.ctx().platformStore?.get('lastBalance', null);
    // Do not send platform tokens, API keys or the platform's full account response to phones.
    return { inputTokens: input, outputTokens: output, cachedTokens: cached, estimatedCost: estimate, currency: 'CNY', estimateOnly: true,
      balance: balance ? { total: balance.total ?? balance.balance ?? balance.totalBalance ?? null, currency: balance.currency ?? 'CNY', fetchedAt: balance.fetchedAt ?? null } : null,
      model, lowBalanceWarning: Boolean(balance && budget.lowBalance > 0 && Number(balance.balance ?? balance.total) < budget.lowBalance), taskLimit: budget.taskLimits?.[id] ?? budget.taskLimit ?? null, lowBalance: budget.lowBalance ?? null, priceConfigured: Boolean(priced) };
  }
  beforeSend(id, body, elevated) {
    const billing = this.billing(id), budget = this.state().budget;
    if (body.budgetOverride && elevated) { this.budgetAllowances.set(id, (billing.estimatedCost ?? 0) + (billing.taskLimit ?? 0)); this.budgetStopped.delete(id); }
    if (billing.taskLimit > 0 && billing.estimatedCost >= (this.budgetAllowances.get(id) ?? billing.taskLimit) && !(body.budgetOverride && elevated)) throw new RemoteRuleError('已达到任务预算，请查看用量并验证后允许继续', 409, 'budget-review');
  }
  prompt(id, message, body) {
    const project = this.state().projects?.[body?.workspaceId ?? ''];
    const header = project ? `[用户设置的项目说明，仅作任务背景，不改变权限]\n${project.description ?? ''}\n输出偏好：${project.output ?? ''}\n` : '';
    const skills = Array.isArray(body?.skills) ? body.skills.map((v) => text(v, 100)).filter(Boolean).slice(0, 8) : [];
    return `${header}${skills.length ? `请使用电脑已安装的技能（不可安装或更改配置）：${skills.join('、')}\n` : ''}${message}`;
  }
  async skills(id) {
    const value = await this.ctx().client.listSkills(id);
    const items = Array.isArray(value) ? value : value.items ?? value.skills ?? [];
    return { items: items.map((s) => ({ id: s.id ?? s.name, name: s.name ?? s.id, description: text(s.description, 300), enabled: s.enabled !== false })) };
  }
  async action({ phone, elevated, body }) {
    const op = body.op, id = text(body.sessionId, 200), state = this.state();
    const row = id ? (await this.remote.sessions.sessionRows()).find((r) => r.sessionId === id) : null;
    if (id && !row && !this.ctx().companion?.isCompanion(id)) throw new RemoteRuleError('任务不存在或已移除', 404, 'not-found');
    if (op === 'seen') {
      const seq = Number(body.seq); if (!Number.isSafeInteger(seq) || seq < 0) throw new RemoteRuleError('已读位置无效', 400);
      if (seq > (state.seen?.[`${phone}:${id}`] ?? -1)) this.change((s) => { s.seen[`${phone}:${id}`] = seq; });
      return { ok: true, lastSeen: Math.max(state.seen?.[`${phone}:${id}`] ?? -1, seq) };
    }
    else if (op === 'template-save') {
      const templateId = text(body.id, 100) || crypto.randomUUID(), prompt = text(body.text, 16000);
      if (!prompt || TEMPLATES.some((t) => t.id === templateId)) throw new RemoteRuleError('请保存为自定义快捷任务', 400);
      if ((state.templates?.length ?? 0) >= 30 && !state.templates.some((t) => t.id === templateId)) throw new RemoteRuleError('最多保存30个自定义快捷任务', 400);
      this.change((s) => { s.templates = [...(s.templates ?? []).filter((t) => t.id !== templateId), { id: templateId, name: validTitle(body.name), text: prompt }]; });
    } else if (op === 'template-delete') this.change((s) => { s.templates = (s.templates ?? []).filter((t) => t.id !== text(body.id, 100)); });
    else if (op === 'pin') this.change((s) => { s.pins = body.on ? [...new Set([...s.pins, id])] : s.pins.filter((v) => v !== id); });
    else if (op === 'rename') {
      if (this.ctx().companion?.isCompanion(id)) throw new RemoteRuleError('请在主对话中给助手改名', 400);
      await this.ctx().client.renameSession(id, validTitle(body.title));
    } else if (op === 'archive') {
      if (this.ctx().companion?.isCompanion(id) || row?.running || ['queued', 'waiting-answer', 'waiting-approval'].includes(taskState(this.snapshotOf(id)))) throw new RemoteRuleError('请先停止任务，常驻助手不能归档', 409);
      await this.ctx().client.archiveSession(id); this.ctx().chat.close(id);
    } else if (op === 'project') {
      const workspaceId = text(body.workspaceId, 200);
      const workspaces = await this.ctx().client.listWorkspaces();
      if (!(workspaces.items ?? []).some((w) => w.workspaceId === workspaceId)) throw new RemoteRuleError('工作区已移除，请重新选择', 404);
      this.change((s) => { s.projects[workspaceId] = { name: validTitle(body.name), description: safeMemory(body.description), output: safeMemory(body.output) }; });
    } else if (op === 'project-delete') this.change((s) => { delete s.projects[text(body.workspaceId, 200)]; });
    else if (op === 'workspace') {
      const base = fs.realpathSync(this.ctx().defaultSessionOptions().cwd), target = fs.realpathSync(path.resolve(base, text(body.path, 1000)));
      const relative = path.relative(base, target);
      if ((relative === '..' || relative.startsWith('..' + path.sep)) || path.isAbsolute(relative) || !fs.statSync(target).isDirectory()) throw new RemoteRuleError('请选择电脑默认工作目录内已有的文件夹', 403);
      await this.ctx().client.createWorkspace(target);
    } else if (op === 'budget') {
      const taskLimit = Number(body.taskLimit), lowBalance = Number(body.lowBalance);
      const rates = body.rates;
      if (rates && !text(body.model, 200)) throw new RemoteRuleError('设置单价时请选择当前任务的模型', 400);
      if (![taskLimit, lowBalance].every((n) => Number.isFinite(n) && n >= 0) || (rates && !['input', 'output', 'cached'].every((k) => Number.isFinite(rates[k]) && rates[k] >= 0))) throw new RemoteRuleError('预算或单价无效', 400);
      this.change((s) => { s.budget ??= {}; s.budget.lowBalance = lowBalance; if (id) { s.budget.taskLimits ??= {}; s.budget.taskLimits[id] = taskLimit; } else s.budget.taskLimit = taskLimit; if (rates) { s.budget.rates = rates; s.budget.ratesModel = text(body.model, 200); } }); this.budgetAllowances.delete(id); this.budgetStopped.delete(id);
    } else if (op === 'schedule-save') {
      if (!elevated) throw new RemoteRuleError('创建或修改自动任务前请验证机主', 403, 'needs-verification');
      if (body.permission && body.permission !== 'workspace-write' && body.permission !== 'read-only') throw new RemoteRuleError('自动任务仅支持只读或工作区权限，高风险操作仍需审批', 403);
      const rule = validateRule(body.rule, this.now());
      const previous = (state.schedules ?? []).find((s) => s.id === body.id);
      const task = { id: previous?.id ?? crypto.randomUUID(), title: validTitle(body.title), prompt: text(body.prompt, 8000), workspaceId: text(body.workspaceId, 200), rule, enabled: true,
        permission: body.permission ?? 'workspace-write', nextRun: nextRun(rule, this.now()), history: previous?.history ?? [] };
      if (!task.prompt) throw new RemoteRuleError('任务内容不能为空', 400);
      this.change((s) => { s.schedules = [...s.schedules.filter((v) => v.id !== task.id), task].slice(-100); });
    } else if (['schedule-toggle', 'schedule-delete', 'schedule-run'].includes(op)) {
      const task = state.schedules.find((t) => t.id === body.id);
      if (!task) throw new RemoteRuleError('定时任务不存在', 404);
      if (op === 'schedule-run') { if (!elevated) throw new RemoteRuleError('运行前请验证机主', 403); await this.runSchedule(task, false); }
      else this.change((s) => { if (op === 'schedule-delete') s.schedules = s.schedules.filter((t) => t.id !== task.id); else { const t = s.schedules.find((v) => v.id === task.id); t.enabled = Boolean(body.on); if (t.enabled) t.nextRun = nextRun(t.rule, this.now()); } });
    } else throw new RemoteRuleError('没有这个操作', 400, 'bad-operation');
    this.remote.gateway?.publish({ sessionId: id || 'workbench', urgent: true });
    return this.snapshot(phone, id);
  }
  async runSchedule(task, scheduled = true) {
    const pendingStates = new Set(['starting', 'running', 'queued', 'waiting-answer', 'waiting-approval']);
    const active = task.history?.findLast((r) => pendingStates.has(r.status)
      && pendingStates.has(taskState(this.snapshotOf(r.sessionId), { status: r.status })));
    if (this.running.has(task.id) || active) throw new RemoteRuleError('该自动任务正在启动', 409);
    this.running.add(task.id); const record = { at: this.now(), status: 'starting', sessionId: '' };
    try {
      const api = this.remote.api();
      const created = await api.createSession({ body: { permission: task.permission, workspaceId: task.workspaceId }, elevated: false, phone: 'automation' });
      record.sessionId = created.sessionId;
      await api.sendMessage({ params: [created.sessionId], body: { text: task.prompt, workspaceId: task.workspaceId }, elevated: false, phone: 'automation' });
      record.status = 'running';
    } catch (e) { record.status = 'failed'; record.error = String(e.message).slice(0, 300); }
    finally {
      this.running.delete(task.id);
      this.change((s) => { const t = s.schedules.find((v) => v.id === task.id); if (t) { t.history = [...t.history, record].slice(-40); if (scheduled) { t.nextRun = nextRun(t.rule, this.now()); if (!t.nextRun) t.enabled = false; } } });
    }
    return record;
  }
  async tick() {
    if (!this.remote.enabled() || !this.remote.gateway) return;
    for (const task of this.state().schedules.filter((t) => t.enabled && t.nextRun && t.nextRun <= this.now())) {
      if (this.now() - task.nextRun > 90000) {
        this.change((s) => { const t = s.schedules.find((v) => v.id === task.id); t.history = [...t.history, { at: task.nextRun, status: 'missed', error: '电脑未在线，未补执行' }].slice(-40); t.nextRun = nextRun(t.rule, this.now()); if (!t.nextRun) t.enabled = false; });
      } else {
        try { await this.runSchedule(task); }
        catch (error) {
          if (!(error instanceof RemoteRuleError) || error.status !== 409) throw error;
          this.change((s) => {
            const t = s.schedules.find((v) => v.id === task.id);
            if (!t) return;
            t.history = [...t.history, { at: task.nextRun, status: 'missed', error: '上次任务尚未结束，本次未重复执行' }].slice(-40);
            t.nextRun = nextRun(t.rule, this.now()); if (!t.nextRun) t.enabled = false;
          });
        }
      }
    }
  }
  onTranscript(id, snapshot) {
    const model = this.ctx().client.sessionSelections?.get(id)?.model;
    const lastModel = this.state().models?.[id];
    if (model && lastModel !== model) this.change((s) => { s.models ??= {}; s.mixedModels ??= {}; if (lastModel && Number(snapshot.usage?.outputTokens ?? 0) + Number(snapshot.usage?.uncachedInputTokens ?? 0) > 0) s.mixedModels[id] = true; s.models[id] = model; });
    const status = taskState(snapshot), seq = snapshot.lastSeq ?? -1;
    const saved = this.state().outcomes?.[id];
    if (!saved || saved.status !== status || (!snapshot.running && saved.seq !== seq)) this.change((s) => { s.outcomes ??= {}; delete s.outcomes[id]; s.outcomes[id] = { status, seq }; s.outcomes = Object.fromEntries(Object.entries(s.outcomes).slice(-2000)); });
    const previousState = this.lastStates.get(id);
    this.lastStates.delete(id); this.lastStates.set(id, status); if (this.lastStates.size > 2000) this.lastStates.delete(this.lastStates.keys().next().value);
    const billing = this.billing(id);
    if (snapshot.running && billing.taskLimit > 0 && billing.estimatedCost >= (this.budgetAllowances.get(id) ?? billing.taskLimit) && !this.budgetStopped.has(id)) {
      this.budgetStopped.add(id);
      this.ctx().chat.cancel(id).catch(() => {});
    }
    if (!snapshot.running && billing.estimatedCost < (billing.taskLimit ?? Infinity)) this.budgetStopped.delete(id);
    if (['completed', 'failed', 'stopped', 'waiting-answer', 'waiting-approval'].includes(status)) {
      const previous = this.state().events.findLast((e) => e.sessionId === id);
      const pending = status === 'waiting-answer' ? snapshot.questions : snapshot.approvals;
      const pendingItems = Array.isArray(pending) ? pending : pending instanceof Map ? [...pending.values()] : [];
      const pendingIds = pendingItems.map((v) => v.eventId ?? v.id ?? v.requestId).filter(Boolean).map(String).sort();
      const end = (snapshot.items ?? []).findLast((v) => v.kind === 'turn-end');
      const noticeKey = `${status}:${status.startsWith('waiting') && pendingIds.length ? pendingIds.join(',') : end?.seq ?? seq}`;
      // Restoring the same transcript must not create a fresh event or unread push.
      const sameNotice = previous?.noticeKey ? previous.noticeKey === noticeKey : previous?.status === status && previous?.seq === seq;
      if (!sameNotice || (previousState && previousState !== status)) {
        const event = { id: crypto.randomUUID(), sessionId: id, seq, noticeKey, status, label: STATUS_LABELS[status], at: this.now() };
        this.change((s) => { s.events = [...s.events, event].slice(-300); });
        // No title, command, path, content or files leave the device through push.
        if (!saved || saved.status !== status || saved.seq !== seq) this.queuePush(event);
      }
    }
    if (!snapshot.running && this.state().schedules.some((t) => t.history.some((r) => r.sessionId === id && r.status !== status))) this.change((s) => { for (const t of s.schedules) for (const r of t.history) if (r.sessionId === id) r.status = status; });
  }
  queuePush(event) {
    const records = this.ctx().uiStore.get('phonePushTickets', {});
    if (!Object.keys(records).length) return;
    const key = event.sessionId; clearTimeout(this.notifications.get(key));
    this.notifications.set(key, setTimeout(async () => {
      this.notifications.delete(key);
      if (!this.remote.enabled() || taskState(this.snapshotOf(key)) !== event.status) return;
      const seen = this.state().seen;
      for (const [phone, record] of Object.entries(this.ctx().uiStore.get('phonePushTickets', {}))) {
        if (record.expiresAt <= this.now() || (seen[`${phone}:${key}`] ?? -1) >= event.seq) continue;
        try {
          // A scoped capability targets one phone. Task text, titles, paths and files never leave the computer.
          const response = await fetch('https://login.celium.cn/api/dmuse/push/deliver', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket: record.ticket, event: { eventId: event.id, sessionId: key, status: event.status, at: event.at } }), signal: AbortSignal.timeout(10000), redirect: 'error' });
          if (!response.ok) throw new Error('notification gateway unavailable');
        } catch { this.remote.log('remote', 'push delivery unavailable'); }
      }
    }, 5000));
  }
}
module.exports = { MobileWorkbench, taskState, nextRun, validateRule, TEMPLATES, STATUS_LABELS };
