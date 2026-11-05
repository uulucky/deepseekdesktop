'use strict';
/**
 * Phone remote (dmuse): owns the Celium sidecar process and the loopback gateway, keeps the
 * state the Settings page shows, and translates phone requests into session operations under
 * the rules in ./rules.js.
 *
 * The feature is off until the user turns it on in Settings → 手机连接. Turning it on starts
 * the sidecar, which keeps this computer on the user's private dmuse network; turning it off
 * stops it. Pairing, revoking and the permission ceiling are desktop-only actions.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DIRS } = require('../modules/util');
const { RemoteGateway } = require('./gateway');
const rules = require('./rules');
const qr = require('./qr');
const { RequestLedger, historyPage } = require('./task-state');
const { MobileWorkbench } = require('./workbench');
const { SessionApprovals, safetyAnswers, isSafetyAllowance } = require('./session-approvals');

const SIDECAR = process.platform === 'win32' ? 'dmuse-sidecar.exe' : 'dmuse-sidecar';
const MAX_ITEMS = 120;
const SAFETY_QUESTION = 'desktop-safety-guard';
const SAFETY_ALLOW = '允许这一次';

function sidecarPath() {
  const candidates = [];
  if (process.env.DMUSE_SIDECAR) candidates.push(process.env.DMUSE_SIDECAR);
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'vendor', 'dmuse', SIDECAR));
  candidates.push(path.join(__dirname, '..', '..', '..', 'vendor', 'dmuse', SIDECAR));
  return candidates.find((file) => fs.existsSync(file)) ?? null;
}

function excerpt(text, limit = 400) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

/** One line a phone list can show for the newest transcript item. */
function lastLine(items) {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === 'user') return { kind: 'user', text: excerpt(item.text) };
    if (item.kind === 'assistant') {
      const text = (item.parts ?? []).filter((part) => part.kind === 'text').map((part) => part.text).join('');
      if (text) return { kind: 'assistant', text: excerpt(text), streaming: Boolean(item.streaming) };
    }
    if (item.kind === 'tool') return { kind: 'tool', text: excerpt(item.summary || item.name, 160), running: Boolean(item.running) };
  }
  return null;
}

function isSafetyQuestion(question) {
  return (question?.questions ?? []).some((q) => q?.id === SAFETY_QUESTION || q?.header === '高风险操作确认');
}

/** Attachments arrive base64-encoded; the desktop's own limits are applied by the prompt. */
function decodeAttachments(list) {
  if (list == null) return [];
  if (!Array.isArray(list) || list.length > 5) throw new rules.RemoteRuleError('附件格式无效', 400, 'bad-attachments');
  return list.map((entry, index) => {
    const value = entry && typeof entry === 'object' ? entry : {};
    if (typeof value.data !== 'string') throw new rules.RemoteRuleError(`附件 ${index + 1} 没有内容`, 400, 'bad-attachments');
    return { name: value.name, mediaType: value.mediaType, kind: value.kind, bytes: Buffer.from(value.data, 'base64') };
  });
}

class RemoteControl {
  /**
   * @param {object} options
   * @param {() => any} options.getContext the app context (uiStore, chat, client, …)
   * @param {object} options.sessions the session operations returned by registerIpc
   * @param {(state: object) => void} options.onState pushes state to the desktop window
   * @param {(...args: any[]) => void} options.log
   * @param {string} [options.version]
   * @param {{ start(type: string): number, stop(id: number): void }} [options.power] Electron's
   *   powerSaveBlocker, for keeping the computer awake while phones may need it
   */
  constructor({ getContext, sessions, onState, log, version = '', power = null }) {
    this.power = power;
    this.blocker = null;
    this.getContext = getContext;
    this.sessions = sessions;
    this.onState = onState ?? (() => {});
    this.log = log ?? (() => {});
    this.version = version;
    this.requests = new RequestLedger(() => this.store());
    this.workbench = new MobileWorkbench(this);
    this.approvalPolicy = new SessionApprovals({
      chat: () => this.getContext().chat,
      permission: async (id) => (await this.getContext().client.permissions(id))?.currentValue,
      maxPermission: () => this.maxPermission(),
      guard: () => rules.guardEnabled(this.guardFile()),
    });
    this.child = null;
    this.gateway = null;
    this.state = {
      status: 'off', joined: false, invite: null, phones: [], connected: [], error: null,
      name: os.hostname(), available: Boolean(sidecarPath()),
    };
  }

  store() { return this.getContext().uiStore; }
  enabled() { return this.store()?.get('remoteEnabled', false) === true; }
  maxPermission() { return rules.maxPermission(this.store()?.get('remoteMaxPermission')); }
  guardFile() { return path.join(DIRS.config, 'safety-guard.json'); }

  snapshot() {
    return {
      ...this.state, enabled: this.enabled(), maxPermission: this.maxPermission(), guard: rules.guardEnabled(this.guardFile()),
      keepAwake: this.keepAwakeWanted(), awake: this.blocker !== null,
    };
  }

  // ---------------------------------------------------------------- keep awake
  keepAwakeWanted() { return this.store()?.get('remoteKeepAwake', false) === true; }

  /**
   * Hold a "prevent app suspension" power assertion while the phone remote is on and the
   * owner asked for it: the system does not idle-sleep (the display still may). Closing a
   * laptop lid still sleeps it; the phone shows how to change that in the OS settings.
   */
  applyKeepAwake() {
    const want = Boolean(this.child) && this.enabled() && this.keepAwakeWanted() && this.power;
    if (want && this.blocker === null) this.blocker = this.power.start('prevent-app-suspension');
    if (!want && this.blocker !== null) {
      try { this.power.stop(this.blocker); } catch { /* already released */ }
      this.blocker = null;
    }
  }

  setKeepAwake(on) {
    this.store().set('remoteKeepAwake', Boolean(on));
    this.applyKeepAwake();
    this.onState(this.snapshot());
    return this.snapshot();
  }

  update(patch) {
    Object.assign(this.state, patch);
    this.onState(this.snapshot());
  }

  // ------------------------------------------------------------------ lifecycle
  async start() {
    if (this.child || !this.enabled()) return this.snapshot();
    const binary = sidecarPath();
    if (!binary) {
      this.update({ status: 'error', available: false, error: '这个版本没有带手机连接组件' });
      return this.snapshot();
    }
    const secret = crypto.randomBytes(32).toString('hex');
    this.gateway = new RemoteGateway({
      secret,
      api: this.api(),
      log: this.log,
      onPhones: (connected) => this.update({ connected }),
    });
    const port = await this.gateway.listen();
    const args = ['--state', path.join(DIRS.root, 'dmuse'), '--target', `127.0.0.1:${port}`, '--name', this.state.name];
    if (process.env.DMUSE_SERVER) args.push('--server', process.env.DMUSE_SERVER);
    if (process.env.DMUSE_CONTROL_KEY) args.push('--control-key', process.env.DMUSE_CONTROL_KEY);
    const child = spawn(binary, args, {
      env: { ...process.env, DMUSE_LOCAL_SECRET: secret },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.workbench.start();
    this.update({ status: 'starting', error: null });
    this.applyKeepAwake();
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try { this.handleEvent(JSON.parse(line)); } catch { this.log('remote', 'unreadable sidecar line'); }
      }
    });
    let errors = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-4000); });
    child.on('error', (error) => this.update({ status: 'error', error: String(error.message ?? error) }));
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.workbench.stop();
      this.approvalPolicy.clear();
      this.child = null;
      this.gateway?.close();
      this.gateway = null;
      this.applyKeepAwake();
      const crashed = code !== 0 && code !== null;
      if (crashed) this.log('remote', 'sidecar exited', { code, tail: errors.slice(-800) });
      this.update({ status: crashed ? 'error' : 'off', invite: null, connected: [], error: crashed ? '手机连接组件意外退出' : null });
    });
    return this.snapshot();
  }

  stop() {
    this.workbench.stop();
    this.approvalPolicy.clear();
    const child = this.child;
    this.child = null;
    if (child) {
      child.stdin.end();
      setTimeout(() => { if (child.exitCode === null) child.kill(); }, 3000).unref?.();
    }
    this.gateway?.close();
    this.gateway = null;
    this.applyKeepAwake();
    this.update({ status: 'off', invite: null, connected: [] });
  }

  command(op, extra = {}) {
    if (!this.child) throw new Error('手机连接未开启');
    this.child.stdin.write(`${JSON.stringify({ op, ...extra })}\n`);
  }

  handleEvent(event) {
    switch (event?.event) {
      case 'ready':
        this.update({ status: event.joined ? 'joining' : 'ready', joined: Boolean(event.joined), phones: event.phones ?? [] });
        break;
      case 'joined':
        this.update({ status: 'online', joined: true, invite: this.state.invite?.kind === 'computer' ? null : this.state.invite });
        break;
      case 'invite':
        // The raw text stays in the main process; the window only ever gets the picture.
        this.inviteText = event.qr;
        this.update({ invite: { kind: event.kind, code: event.code ?? null, expiresAt: event.expiresAt, svg: qr.toSvg(event.qr) } });
        break;
      case 'phones':
        for (const previous of this.state.phones) {
          if (!(event.phones ?? []).includes(previous)) this.approvalPolicy.revokePhone(previous);
        }
        this.update({ phones: event.phones ?? [] });
        break;
      case 'phone':
        if (event.what === 'paired') this.update({ invite: null });
        break;
      case 'error':
        this.log('remote', 'sidecar error', event.message);
        this.update({ error: event.message });
        break;
      default:
    }
  }

  // ------------------------------------------------------------- desktop actions
  async setEnabled(on) {
    this.store().set('remoteEnabled', Boolean(on));
    if (on) return this.start();
    this.stop();
    return this.snapshot();
  }

  setMaxPermission(preset) {
    if (rules.maxPermission(preset) !== this.maxPermission()) this.approvalPolicy.clear();
    this.store().set('remoteMaxPermission', rules.maxPermission(preset));
    this.onState(this.snapshot());
    return this.snapshot();
  }

  pair() { this.command('pair'); return this.snapshot(); }

  cancelPair() {
    this.command('cancel-pair');
    this.update({ invite: null });
    return this.snapshot();
  }

  revoke(phone) {
    const tickets = { ...this.store().get('phonePushTickets', {}) };
    delete tickets[String(phone)];
    this.store().set('phonePushTickets', tickets);
    this.approvalPolicy.revokePhone(String(phone));
    this.command('revoke', { phone: String(phone) });
    this.gateway?.disconnect(String(phone));
    return this.snapshot();
  }

  /**
   * Phones title the main conversation by its name; a rename on the computer touches no
   * transcript, so tell open phones to reload when the name changes.
   */
  onCompanionState(state) {
    if (!state?.sessionId || !state.name) return;
    const previous = this.companionName;
    this.companionName = state.name;
    if (previous && previous !== state.name) this.gateway?.publish({ sessionId: state.sessionId, title: state.name, urgent: true });
  }

  /** Feed transcript updates from ChatController to the phones' event streams. */
  onTranscript(payload) {
    if (!this.gateway || !payload?.transcript) return;
    this.approvalPolicy.drain(payload.sessionId).catch((error) => this.log('remote', 'session approval ended', String(error?.message ?? error)));
    const t = payload.transcript;
    this.workbench.onTranscript(payload.sessionId, t);
    this.gateway.publish({
      sessionId: payload.sessionId,
      title: t.title,
      running: Boolean(t.running),
      approvals: t.approvals?.length ?? 0,
      questions: t.questions?.length ?? 0,
      lastSeq: t.lastSeq,
      last: lastLine(t.items ?? []),
      urgent: Boolean(payload.approval || payload.question || !t.running
        || ['turn/start', 'turn/end', 'cancelled'].includes(payload.event?.type)),
    });
  }

  // ------------------------------------------------------------------ phone API
  api() {
    const ctx = () => this.getContext();
    const chat = () => ctx().chat;
    const guard = () => rules.requireGuard(this.guardFile());
    const transcriptOf = (sessionId) => chat().transcripts?.get(sessionId) ?? null;
    // The main conversation is shared with phones, but its model and permission stay fixed, and
    // whatever it dispatches for a phone stays under the phone's ceiling (see companion.js).
    const companion = () => ctx().companion ?? null;
    const notCompanion = (sessionId) => {
      if (companion()?.isCompanion(sessionId)) {
        throw new rules.RemoteRuleError('主对话固定使用 DeepSeek V4.1 Flash、只读权限，不能修改', 403, 'companion-fixed');
      }
    };
    /** Bring a session down to what the phone may drive before it acts on it. */
    const enforcePermission = async (sessionId, elevated) => {
      const current = (await ctx().client.permissions(sessionId))?.currentValue;
      const capped = rules.capPermission(current, this.maxPermission(), { elevated });
      if (capped.preset !== current) await this.sessions.selectPermission(sessionId, capped.preset);
      return capped.preset;
    };
    return {
      info: ({ phone }) => ({
        desktop: this.state.name,
        version: this.version,
        platform: process.platform,
        maxPermission: this.maxPermission(),
        guard: rules.guardEnabled(this.guardFile()),
        keepAwake: this.keepAwakeWanted(),
        phone,
      }),
      // The one desktop setting a phone may change: staying awake has no security effect,
      // and right after pairing is when the owner decides about it.
      keepAwake: ({ body }) => {
        if (typeof body?.on === 'boolean') this.setKeepAwake(body.on);
        return { keepAwake: this.keepAwakeWanted(), awake: this.blocker !== null, platform: process.platform };
      },
      listSessions: async ({ phone = '', query = new URLSearchParams() } = {}) => {
        let rows = (await this.sessions.sessionRows()).filter((row) => query.get('archived') === '1' ? row.archived : !row.archived).map((row) => this.workbench.decorate(row, phone));
        const search = (query.get('q') ?? '').trim().toLowerCase();
        if (search) {
          const result = query.get('scope') === 'content' && ctx().client.searchSessions ? await ctx().client.searchSessions(search) : null;
          const ids = new Set((result?.items ?? []).map((r) => r.sessionId));
          rows = rows.filter((row) => String(row.title ?? '').toLowerCase().includes(search) || ids.has(row.sessionId));
        }
        rows.sort((a, b) => Number(b.pinned) - Number(a.pinned) || Number(b.updatedAt) - Number(a.updatedAt));
        const friend = await companion()?.snapshot().catch(() => null);
        if (!friend?.sessionId || query.get('archived') === '1' || (search && !rows.some((row) => row.sessionId === friend.sessionId) && !String(friend.name).toLowerCase().includes(search))) return { items: rows.filter((row) => !row.companion) };
        // A main conversation nobody has written in yet is not listed by the kernel.
        const own = rows.find((row) => row.sessionId === friend.sessionId);
        const pinned = { ...(own ?? { sessionId: friend.sessionId, running: false, updatedAt: Date.now(), turns: 0 }), companion: true, title: friend.name };
        return {
          items: [pinned, ...rows.filter((row) => row.sessionId !== friend.sessionId)],
          companion: { sessionId: friend.sessionId, name: friend.name, counts: friend.counts, receipts: friend.receipts.map((task) => ({ taskId: task.taskId, title: task.title, status: task.status })) },
        };
      },
      createSession: async ({ body, elevated, phone = '' }) => this.requests.once(phone, 'create', body, async () => {
        guard();
        const options = ctx().defaultSessionOptions();
        if (typeof body?.workspaceId === 'string' && body.workspaceId.trim()) {
          delete options.cwd;
          options.workspaceId = body.workspaceId.trim();
        }
        const created = await chat().createSession(options);
        const requested = body?.permission ?? ctx().uiStore.get('defaultPermission', 'workspace-write');
        const capped = rules.capPermission(requested, this.maxPermission(), { elevated });
        await this.sessions.selectPermission(created.sessionId, capped.preset);
        return { ...created, permission: capped.preset, capped: capped.capped };
      }),
      openSession: async ({ params: [sessionId], query }) => {
        await this.sessions.restorePermission(sessionId);
        const snapshot = await chat().open(sessionId);
        const limit = Math.min(Math.max(Number(query.get('limit')) || MAX_ITEMS, 1), 500);
        // The main conversation is titled by its current name, so a rename shows up on an open phone.
        const friend = companion()?.isCompanion(sessionId) ? { companion: true, title: companion().name() } : {};
        const page = historyPage(snapshot.items, { limit, before: query.get('before') });
        const decorated = this.workbench.decorate({ sessionId, title: snapshot.title, running: snapshot.running }, '');
        return { ...snapshot, ...friend, ...page, status: decorated.status, failure: decorated.error, artifacts: require('./gateway').recentFiles(await this.api().sessionCwd(sessionId), snapshot.items?.find((i) => i.kind === 'user')?.time ?? Date.now(), { limit: 12 }), billing: this.workbench.billing(sessionId),
          approvalPolicy: await this.approvalPolicy.status(sessionId) };
      },
      sendMessage: async ({ params: [sessionId], body, elevated, phone = '' }) => this.requests.once(phone, `send:${sessionId}`, body, async () => {
        guard();
        const permission = await enforcePermission(sessionId, elevated);
        this.workbench.beforeSend(sessionId, body, elevated);
        if (body?.skills != null && (!Array.isArray(body.skills) || body.skills.length > 8 || body.skills.some((id) => typeof id !== 'string' || id.length > 100))) throw new rules.RemoteRuleError('每次最多选择8个已安装技能', 400);
        if (body?.skills?.length) {
          const available = await this.workbench.skills(sessionId);
          if (body.skills.some((id) => !available.items.some((skill) => skill.enabled && skill.id === id))) throw new rules.RemoteRuleError('所选技能已卸载或不可用，请重新选择', 409, 'skill-unavailable');
        }
        const wasRunning = Boolean(chat().transcripts?.get(sessionId)?.running);
        if (body?.mode === 'stop-adjust') await chat().cancel(sessionId);
        if (body?.mode && !['queue', 'steer', 'stop-adjust'].includes(body.mode)) throw new rules.RemoteRuleError('补充要求方式无效', 400);
        const row = (await this.sessions.sessionRows()).find((value) => value.sessionId === sessionId);
        const promptOptions = { ...body, workspaceId: row ? row.workspaceId ?? '' : body?.workspaceId ?? '' };
        await this.sessions.prompt(sessionId, this.workbench.prompt(sessionId, body?.text ?? '', promptOptions), decodeAttachments(body?.attachments), { origin: 'phone', mode: body?.mode === 'steer' ? 'steer' : 'queue' });
        return { ok: true, permission, requestId: body?.requestId, delivery: wasRunning && (!body?.mode || body.mode === 'queue') ? 'queued' : 'accepted' };
      }),
      workbench: ({ phone, query }) => this.workbench.snapshot(phone, query.get('sessionId') ?? ''),
      workbenchAction: (request) => { guard(); return this.workbench.action(request); },
      requestStatus: ({ phone, params: [id], query }) => this.requests.lookup(phone, query.get('op') ?? 'create', id),
      skills: ({ params: [id] }) => this.workbench.skills(id),
      notifications: ({ phone, body }) => {
        const records = this.store().get('phonePushTickets', {});
        if (body?.enabled === false) delete records[phone];
        else {
          if (!/^[A-Za-z0-9_-]{43}$/.test(body?.ticket ?? '') || !Number.isFinite(body?.expiresAt) || body.expiresAt <= Date.now() || body.expiresAt > Date.now() + 31 * 86400000) throw new rules.RemoteRuleError('通知注册凭据无效', 400);
          records[phone] = { ticket: body.ticket, expiresAt: body.expiresAt };
        }
        this.store().set('phonePushTickets', records); return { ok: true };
      },
      diagnose: async () => {
        const started = Date.now(); const connected = this.snapshot();
        let kernel = false; try { await ctx().client.listSessions(); kernel = true; } catch { /* Report the failed stage, never a false online state. */ }
        return { stages: [{ id: 'network', ok: true, label: '手机到电脑的加密通道已连通' }, { id: 'gateway', ok: true, label: '电脑网关已响应' }, { id: 'kernel', ok: kernel, label: kernel ? '工作台已响应' : '工作台未响应，请在电脑端检查本地服务' }], lastSuccess: kernel ? Date.now() : null, elapsed: Date.now() - started, keepAwake: connected.keepAwake };
      },
      cancel: async ({ params: [sessionId] }) => {
        await chat().cancel(sessionId);
        return { ok: true };
      },
      answerApproval: async ({ params: [sessionId, eventId], body, elevated, phone }) => {
        guard();
        const continuous = body?.outcome === 'allowed-session';
        const ticket = this.approvalPolicy.ticket(sessionId);
        if ((continuous || body?.outcome === 'allowed-once') && !elevated) {
          throw new rules.RemoteRuleError('批准操作前，请先在手机上完成机主验证', 403, 'needs-verification');
        }
        if (continuous) notCompanion(sessionId);
        await enforcePermission(sessionId, elevated);
        if (body?.outcome === 'rejected') this.approvalPolicy.revoke(sessionId);
        await chat().answerApproval(sessionId, eventId, continuous ? 'allowed-once' : body?.outcome);
        const approvalPolicy = continuous ? await this.approvalPolicy.allow(sessionId, phone, ticket) : await this.approvalPolicy.status(sessionId);
        return { ok: true, approvalPolicy };
      },
      answerQuestion: async ({ params: [sessionId, eventId], body, elevated, phone }) => {
        guard();
        const question = transcriptOf(sessionId)?.questions.get(eventId);
        const continuous = body?.approvalScope === 'session';
        const ticket = this.approvalPolicy.ticket(sessionId);
        if (continuous && !isSafetyAllowance(question, body?.answers)) {
          throw new rules.RemoteRuleError('只有安全护栏的批准操作可开启本对话全部允许', 400, 'bad-approval-scope');
        }
        if (isSafetyQuestion(question) && JSON.stringify(body?.answers ?? null).includes(SAFETY_ALLOW) && !elevated) {
          throw new rules.RemoteRuleError('放行高风险操作前，请先在手机上完成指纹或面容验证', 403, 'needs-verification');
        }
        if (continuous) { notCompanion(sessionId); await enforcePermission(sessionId, elevated); }
        if (isSafetyQuestion(question) && !JSON.stringify(body?.answers ?? null).includes(SAFETY_ALLOW)) this.approvalPolicy.revoke(sessionId);
        await chat().answerQuestion(sessionId, eventId, body?.answers);
        const approvalPolicy = continuous ? await this.approvalPolicy.allow(sessionId, phone, ticket) : await this.approvalPolicy.status(sessionId);
        return { ok: true, approvalPolicy };
      },
      revokeApprovalPolicy: async ({ params: [sessionId] }) => {
        this.approvalPolicy.revoke(sessionId);
        return { ok: true, approvalPolicy: { supported: true, active: false } };
      },
      permission: async ({ params: [sessionId] }) => ({
        current: (await ctx().client.permissions(sessionId))?.currentValue ?? null,
        max: this.maxPermission(),
      }),
      selectPermission: async ({ params: [sessionId], body, elevated }) => {
        notCompanion(sessionId);
        this.approvalPolicy.revoke(sessionId);
        const capped = rules.capPermission(body?.preset, this.maxPermission(), { elevated });
        await this.sessions.selectPermission(sessionId, capped.preset);
        return { current: capped.preset, capped: capped.capped };
      },
      models: async ({ params: [sessionId] }) => {
        const models = await ctx().client.sessionModels(sessionId);
        return { current: models.current ?? null, routable: models.routable };
      },
      catalog: async () => {
        const registry = await ctx().client.listModels().catch(() => ({ groups: [] }));
        return {
          groups: (registry.groups ?? []).map((group) => ({
            id: group.id,
            name: group.name,
            models: (group.models ?? []).map((model) => ({
              id: model.id,
              name: model.name,
              efforts: (model.reasoning?.efforts ?? []).map((effort) => (typeof effort === 'string' ? { id: effort, label: effort } : { id: effort.id, label: effort.label ?? effort.name ?? effort.id })),
              defaultEffort: model.reasoning?.defaultEffort ?? null,
            })),
          })),
        };
      },
      selectModel: async ({ params: [sessionId], body }) => {
        notCompanion(sessionId);
        const result = await ctx().client.selectModel(sessionId, body?.provider, body?.model, body?.effort);
        return { selected: result?.selected ?? null };
      },
      pending: async () => {
        const items = [];
        for (const transcript of chat().transcripts?.values() ?? []) {
          for (const approval of transcript.approvals.values()) items.push({ type: 'approval', sessionId: transcript.sessionId, title: transcript.title, approval, sessionApprovalSupported: true });
          for (const question of transcript.questions.values()) {
            items.push({ type: 'question', sessionId: transcript.sessionId, title: transcript.title, question, risky: isSafetyQuestion(question), sessionApprovalSupported: Boolean(safetyAnswers(question)) });
          }
        }
        // Risky confirmations first: they block work and need the most attention.
        items.sort((a, b) => Number(Boolean(b.risky)) - Number(Boolean(a.risky)));
        return { items };
      },
      unpair: async ({ phone }) => {
        // The phone asked to be forgotten; the connection it asked on is dropped afterwards.
        setTimeout(() => this.revoke(phone), 50);
        return { ok: true };
      },
      sessionCwd: async (sessionId) => (await this.sessions.sessionRows()).find((row) => row.sessionId === sessionId)?.cwd ?? null,
    };
  }
}

module.exports = { RemoteControl, lastLine, isSafetyQuestion, decodeAttachments, sidecarPath };
