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
  if (!Array.isArray(list)) throw new rules.RemoteRuleError('附件格式无效', 400, 'bad-attachments');
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
    this.command('revoke', { phone: String(phone) });
    this.gateway?.disconnect(String(phone));
    return this.snapshot();
  }

  /** Feed transcript updates from ChatController to the phones' event streams. */
  onTranscript(payload) {
    if (!this.gateway || !payload?.transcript) return;
    const t = payload.transcript;
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
    // 老友 is desktop-only for now; the work it dispatched is ordinary and phones can drive it.
    const notCompanion = (sessionId) => {
      if (ctx().companion?.isCompanion(sessionId)) {
        throw new rules.RemoteRuleError('老友暂时只能在电脑上用', 403, 'companion-desktop-only');
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
      listSessions: async () => ({ items: (await this.sessions.sessionRows()).filter((row) => !row.archived && !row.companion) }),
      createSession: async ({ body, elevated }) => {
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
      },
      openSession: async ({ params: [sessionId], query }) => {
        notCompanion(sessionId);
        await this.sessions.restorePermission(sessionId);
        const snapshot = await chat().open(sessionId);
        const limit = Math.min(Math.max(Number(query.get('limit')) || MAX_ITEMS, 1), 500);
        return { ...snapshot, items: snapshot.items.slice(-limit), truncated: snapshot.items.length > limit };
      },
      sendMessage: async ({ params: [sessionId], body, elevated }) => {
        notCompanion(sessionId);
        guard();
        const permission = await enforcePermission(sessionId, elevated);
        await this.sessions.prompt(sessionId, body?.text ?? '', decodeAttachments(body?.attachments));
        return { ok: true, permission };
      },
      cancel: async ({ params: [sessionId] }) => {
        notCompanion(sessionId);
        await chat().cancel(sessionId);
        return { ok: true };
      },
      answerApproval: async ({ params: [sessionId, eventId], body, elevated }) => {
        guard();
        await enforcePermission(sessionId, elevated);
        await chat().answerApproval(sessionId, eventId, body?.outcome);
        return { ok: true };
      },
      answerQuestion: async ({ params: [sessionId, eventId], body, elevated }) => {
        guard();
        const question = transcriptOf(sessionId)?.questions.get(eventId);
        if (isSafetyQuestion(question) && JSON.stringify(body?.answers ?? null).includes(SAFETY_ALLOW) && !elevated) {
          throw new rules.RemoteRuleError('放行高风险操作前，请先在手机上完成指纹或面容验证', 403, 'needs-verification');
        }
        await chat().answerQuestion(sessionId, eventId, body?.answers);
        return { ok: true };
      },
      permission: async ({ params: [sessionId] }) => ({
        current: (await ctx().client.permissions(sessionId))?.currentValue ?? null,
        max: this.maxPermission(),
      }),
      selectPermission: async ({ params: [sessionId], body, elevated }) => {
        notCompanion(sessionId);
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
          for (const approval of transcript.approvals.values()) items.push({ type: 'approval', sessionId: transcript.sessionId, title: transcript.title, approval });
          for (const question of transcript.questions.values()) {
            items.push({ type: 'question', sessionId: transcript.sessionId, title: transcript.title, question, risky: isSafetyQuestion(question) });
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
