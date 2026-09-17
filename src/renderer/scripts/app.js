'use strict';
/** App controller: bootstraps the shell, owns navigation, the composer and event wiring. */

const App = {
  async init() {
    state.world = await api.app.world().catch(() => null);
    if (state.world) {
      state.boot = state.world.boot;
      state.baseUrl = state.world.baseUrl;
      state.platform = { ...state.platform, ...state.world.platform };
      state.catalog = state.world.catalog;
      state.ad = state.world.ad;
      state.update = { ...state.update, ...(state.world.update ?? {}) };
      state.ui = state.world.ui ?? {};
      state.credentials = state.world.credential?.refs ?? {};
    }
    state.permissionMode = ['read-only', 'workspace-write'].includes(state.ui.defaultPermission)
      ? state.ui.defaultPermission
      : 'read-only';
    state.account.summary = state.platform.lastBalance ?? null;
    state.account.usage = state.platform.lastUsage ?? null;
    state.account.keys = state.platform.lastKeys?.keys ?? null;
    state.account.needsLogin = !state.platform.signedIn;
    this.applyAppearance();
    ChatView.install();
    this.installEvents();
    Sidebar.renderAll();

    await this.refreshSessions();
    await this.refreshCredentials();
    // The account card is refreshed lazily: only when it is actually visible.
    if (state.sessions.length) await this.openSession(state.sessions[0].sessionId);
    else {
      await this.loadSelection();
      ChatView.render(null);
      this.renderStreamingState();
    }
    Sidebar.renderAll();
  },

  applyAppearance() {
    document.documentElement.dataset.theme = state.ui.theme === 'light' ? 'light' : 'dark';
    const railHidden = state.ui.sidebarVisible === false;
    document.getElementById('app').classList.toggle('rail-hidden', railHidden);
  },

  installEvents() {
    api.events.onBootState((boot) => { state.boot = boot; Sidebar.renderProfile(); });
    api.events.onTranscript((payload) => {
      if (!payload?.transcript) return;
      if (state.activeSessionId && payload.sessionId !== state.activeSessionId) {
        this.refreshSessionsThrottled();
        return;
      }
      state.transcript = payload.transcript;
      state.streaming = Boolean(payload.transcript.running);
      this.renderStreamingState();
      ChatView.render(state.transcript);
      Sidebar.renderChatHeader();
      if (payload.event?.type === 'turn/end') this.refreshSessionsThrottled();
    });
    api.events.onPlatformState((world) => {
      const incoming = world.platform ?? {};
      state.platform = { ...state.platform, ...incoming };
      state.account.needsLogin = !state.platform.signedIn;
      state.account.summary = state.platform.signedIn ? (incoming.lastBalance ?? state.account.summary) : null;
      state.account.usage = state.platform.signedIn ? (incoming.lastUsage ?? state.account.usage) : null;
      if (incoming.lastKeys?.keys) state.account.keys = incoming.lastKeys.keys;
      if (!state.platform.signedIn) state.account.keys = null;
      if (state.platform.signedIn) state.account.error = null;
      state.credentials = world.credential?.refs ?? state.credentials;
      Sidebar.renderAll();
      if (state.view.modal && state.view.tab === 'account') {
        const active = document.activeElement;
        const editing = active && document.getElementById('modal-body')?.contains(active)
          && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName);
        if (!editing) AccountPanel.render();
      }
    });
    api.events.onDomMirror(() => { /* mirror kept for diagnostics; the API is authoritative */ });
    api.events.onAdState((payload) => {
      if (!payload) return;
      state.ad = payload;
      Sidebar.renderAd();
    });
    api.events.onUpdateState((update) => {
      if (!update) return;
      state.update = { ...state.update, ...update };
      Sidebar.renderUpdate();
      if (state.view.modal && state.view.tab === 'about') Settings.renderAbout();
    });
    api.events.onServerStop(() => {
      toast('本地服务已停止，请在设置中重启', 'err');
    });

    // Rails and header wiring
    document.getElementById('new-chat').addEventListener('click', () => this.newSession());
    document.getElementById('refresh-sessions').addEventListener('click', () => this.refreshSessions());
    document.getElementById('rail-collapse').addEventListener('click', () => this.toggleRail(false));
    document.getElementById('rail-toggle').addEventListener('click', () => this.toggleRail(true));
    document.getElementById('open-settings').addEventListener('click', () => Settings.open('general'));
    document.getElementById('update-btn').addEventListener('click', () => this.installUpdate());
    document.getElementById('open-profile').addEventListener('click', () => Settings.open('account'));
    document.getElementById('modal-close').addEventListener('click', () => Settings.close());
    document.getElementById('modal-backdrop').addEventListener('mousedown', (event) => {
      if (event.target.id === 'modal-backdrop') Settings.close();
    });
    document.getElementById('session-list').addEventListener('click', (event) => {
      const button = event.target.closest('[data-session]');
      if (button) this.openSession(button.getAttribute('data-session'));
    });
    document.getElementById('balance-chip').addEventListener('click', () => Settings.open('account'));
    document.getElementById('model-chip').addEventListener('click', () => this.toggleModelPopover());

    // Composer
    const input = document.getElementById('input');
    input.addEventListener('input', () => this.autoGrow(input));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        this.send();
      }
      if (event.key === 'Escape') this.hidePopover();
    });
    document.getElementById('send-btn').addEventListener('click', () => this.send());
    document.getElementById('stop-btn').addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.stop();
    });
    document.getElementById('permission-confirm-cancel').addEventListener('click', () => {
      this.settleFullAccessConfirmation(false);
    });
    document.getElementById('permission-confirm-accept').addEventListener('click', () => {
      this.settleFullAccessConfirmation(true);
    });
    document.getElementById('permission-confirm-backdrop').addEventListener('mousedown', (event) => {
      if (event.target.id === 'permission-confirm-backdrop') this.settleFullAccessConfirmation(false);
    });
    document.getElementById('reasoning-slider').addEventListener('input', (event) => this.previewReasoning(event.target));
    document.getElementById('reasoning-slider').addEventListener('change', (event) => this.setReasoning(event.target));
    document.getElementById('permission-slider').addEventListener('input', (event) => this.previewPermission(event.target));
    document.getElementById('permission-slider').addEventListener('change', (event) => this.setPermission(event.target));
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (!document.getElementById('permission-confirm-backdrop').hidden) {
          this.settleFullAccessConfirmation(false);
        } else {
          this.hidePopover();
        }
      }
      if ((event.metaKey || event.ctrlKey) && event.key === 'n') { event.preventDefault(); this.newSession(); }
      if ((event.metaKey || event.ctrlKey) && event.key === ',') { event.preventDefault(); Settings.open('general'); }
    });
    document.addEventListener('click', (event) => {
      this.closeModelPopoverFromOutside(event.target);
      this.routeClick(event);
    });
    document.addEventListener('pointerdown', (event) => {
      const editor = event.target.closest?.('input, textarea, select');
      if (!editor || editor.disabled || editor.readOnly) return;
      // Windows does not always return native keyboard focus after the child login window is
      // closed. Reassert it in the main process and focus the exact editor the user clicked.
      Promise.resolve(api.window.focus()).catch(() => {}).finally(() => {
        requestAnimationFrame(() => editor.isConnected && editor.focus({ preventScroll: true }));
      });
    }, true);
    document.addEventListener('change', (event) => Settings.onGeneralChange(event.target));
    document.getElementById('ad-slot').addEventListener('click', () => Sidebar.openCurrentAd());
    window.addEventListener('resize', () => this.hidePopover());
  },

  async installUpdate() {
    if (state.update?.status !== 'available') return;
    toast(`正在下载 ${state.update.availableVersion}，完成后会自动重启…`);
    await guard(api.update.install(), '自动更新失败');
  },

  /** Single delegated click router for modal actions. */
  async routeClick(event) {
    if (!state.view.modal) return;
    const handled = await Settings.onClick(event.target);
    if (handled) event.stopPropagation();
  },

  // ------------------------------------------------------------------ sessions
  async refreshSessions() {
    const sessions = await guard(api.sessions.list(), '加载对话列表');
    if (sessions) { state.sessions = sessions; Sidebar.renderSessions(); }
  },

  refreshSessionsThrottled() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refreshSessions(), 1200);
  },

  async openSession(sessionId) {
    if (!sessionId) return;
    state.activeSessionId = sessionId;
    Sidebar.renderSessions();
    const transcript = await guard(api.sessions.open(sessionId), '打开对话');
    if (transcript) {
      state.transcript = transcript;
      state.streaming = Boolean(transcript.running);
      ChatView.render(transcript);
    }
    this.renderStreamingState();
    await Promise.all([this.loadSelection(), this.loadPermission()]);
    Sidebar.renderAll();
    ChatView.scrollToEnd();
  },

  async newSession() {
    const intended = state.pendingSelection ?? state.selection ?? this.localDefaultSelection();
    const intendedPermission = state.pendingPermission
      ?? (['read-only', 'workspace-write'].includes(state.ui.defaultPermission) ? state.ui.defaultPermission : 'read-only');
    const created = await guard(api.sessions.create(), '新建对话');
    if (!created?.sessionId) return;
    state.activeSessionId = created.sessionId;
    state.transcript = { sessionId: created.sessionId, items: [], title: null, usage: {} };
    state.streaming = false;
    ChatView.render(state.transcript);
    Sidebar.renderAll();
    const permissions = await guard(
      api.sessions.selectPermission(created.sessionId, intendedPermission),
      '设置新对话权限',
    );
    if (permissions?.currentValue) {
      state.permissionMode = permissions.currentValue;
      state.pendingPermission = null;
    }
    if (intended?.provider && intended?.model) {
      const selected = await guard(api.llm.selectModel(
        created.sessionId,
        intended.provider,
        intended.model,
        intended.reasoningEffort,
      ), '设置新对话模型');
      if (selected) {
        state.selection = selected;
        state.pendingSelection = null;
      }
    }
    await Promise.all([this.loadSelection(), this.loadPermission()]);
    this.renderStreamingState();
    this.focusComposer();
  },

  /** Current model + effort for the active session (session.models → selection). */
  async loadSelection() {
    if (!state.activeSessionId) {
      state.selection = state.pendingSelection ?? this.localDefaultSelection() ?? state.selection;
      state.selectionRoutable = Boolean((state.registry?.registry ?? []).length);
      this.renderReasoningControl();
      return null;
    }
    const models = await guard(api.sessions.modelSelection(state.activeSessionId), '读取模型');
    if (models?.current) {
      state.selection = models.current;
      state.selectionRoutable = models.routable;
      state.pendingSelection = null;
    } else if (state.ui.defaultModel) {
      state.selection = { provider: state.ui.defaultProvider ?? 'deepseek-official', model: state.ui.defaultModel };
    }
    this.renderReasoningControl();
    return state.selection ?? null;
  },

  localDefaultSelection() {
    const base = state.registry?.default ?? null;
    const provider = state.ui.defaultProvider ?? base?.provider;
    const model = state.ui.defaultModel ?? base?.model;
    if (!provider || !model) return null;
    return {
      provider,
      model,
      ...((state.ui.defaultEffort ?? base?.reasoningEffort) ? {
        reasoningEffort: state.ui.defaultEffort ?? base.reasoningEffort,
      } : {}),
    };
  },

  rememberPendingSelection(selection) {
    state.selection = { ...selection };
    state.pendingSelection = { ...selection };
    state.selectionRoutable = true;
    api.settings.setUi({
      defaultProvider: selection.provider,
      defaultModel: selection.model,
      defaultEffort: selection.reasoningEffort ?? null,
    }).then((ui) => { state.ui = ui; }).catch(() => {});
    this.renderStreamingState();
    Sidebar.renderModelChip();
  },

  /** Apply a selection to a real session, or remember it for the first/new conversation. */
  async chooseSelection(provider, model, reasoningEffort, context = '切换模型') {
    if (!provider || !model) return false;
    const request = { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) };
    if (!state.activeSessionId) {
      this.rememberPendingSelection(request);
      return true;
    }
    const selected = await guard(api.llm.selectModel(
      state.activeSessionId, provider, model, reasoningEffort,
    ), context);
    if (!selected) return false;
    state.selection = selected;
    await this.loadSelection();
    this.renderStreamingState();
    Sidebar.renderModelChip();
    return true;
  },

  async refreshCredentials() {
    const described = await guard(api.credentials.describe(['DEEPSEEK_API_KEY']), '读取凭据');
    if (described) state.credentials = described;
  },

  // ------------------------------------------------------------------- sending
  async send() {
    const input = document.getElementById('input');
    const text = input.value.trim();
    if (!text) return;
    if (!state.activeSessionId) {
      await this.newSession();
      if (!state.activeSessionId) return;
    }
    input.value = '';
    this.autoGrow(input);
    state.streaming = true;
    this.renderStreamingState();
    const transcript = await guard(api.sessions.prompt(state.activeSessionId, text), '发送失败');
    if (transcript) {
      state.transcript = transcript;
      ChatView.render(transcript);
      ChatView.scrollToEnd();
    } else {
      state.streaming = false;
      this.renderStreamingState();
    }
    this.refreshSessionsThrottled();
  },

  async stop() {
    if (!state.activeSessionId || !state.streaming || state.stopping) return;
    const sessionId = state.activeSessionId;
    state.stopping = true;
    this.renderStreamingState();
    const cancelled = await guard(api.sessions.cancel(sessionId), '停止失败');
    state.stopping = false;
    if (cancelled !== null && state.activeSessionId === sessionId) state.streaming = false;
    this.renderStreamingState();
  },

  renderStreamingState() {
    const stop = document.getElementById('stop-btn');
    const send = document.getElementById('send-btn');
    const hint = document.getElementById('composer-hint');
    if (stop) {
      stop.hidden = !state.streaming;
      stop.disabled = state.stopping;
      stop.textContent = state.stopping ? '停止中…' : '停止';
      stop.setAttribute('aria-busy', state.stopping ? 'true' : 'false');
    }
    if (send) send.disabled = state.streaming;
    if (hint) {
      hint.textContent = state.selection ? modelLabel(state.selection.model) : '';
    }
    this.renderReasoningControl();
    this.renderPermissionControl();
  },

  /** Model-advertised effort levels for the active selection, kept in harness order. */
  reasoningOptions(provider = state.selection?.provider, model = state.selection?.model) {
    const group = (state.registry?.registry ?? []).find((entry) => entry.id === provider);
    const selected = (group?.models ?? []).find((entry) => entry.id === model);
    return { efforts: selected?.efforts ?? [], defaultEffort: selected?.defaultEffort ?? null };
  },

  renderReasoningControl() {
    const control = document.getElementById('reasoning-control');
    const slider = document.getElementById('reasoning-slider');
    const value = document.getElementById('reasoning-value');
    if (!control || !slider || !value) return;
    const { efforts, defaultEffort } = this.reasoningOptions();
    const visible = Boolean(state.selection && state.selectionRoutable !== false && efforts.length);
    control.hidden = !visible;
    if (!visible) return;
    const ids = efforts.map((effort) => effort.id);
    const active = ids.includes(state.selection?.reasoningEffort)
      ? state.selection.reasoningEffort
      : (ids.includes(defaultEffort) ? defaultEffort : ids[0]);
    slider.min = '0';
    slider.max = String(Math.max(0, ids.length - 1));
    slider.value = String(Math.max(0, ids.indexOf(active)));
    slider.dataset.efforts = JSON.stringify(ids);
    slider.disabled = Boolean(state.activeSessionId && (state.streaming || state.stopping));
    value.textContent = reasoningLabel(active);
    slider.title = `推理等级：${reasoningLabel(active)}`;
  },

  previewReasoning(slider) {
    const ids = JSON.parse(slider.dataset.efforts || '[]');
    const effort = ids[Number(slider.value)];
    const value = document.getElementById('reasoning-value');
    if (value) value.textContent = reasoningLabel(effort);
    slider.title = `推理等级：${reasoningLabel(effort)}`;
  },

  async setReasoning(slider) {
    if (slider.disabled) return;
    const ids = JSON.parse(slider.dataset.efforts || '[]');
    const effort = ids[Number(slider.value)];
    if (!effort || effort === state.selection?.reasoningEffort) return;
    const selected = await this.chooseSelection(
      state.selection.provider,
      state.selection.model,
      effort,
      '设置推理等级',
    );
    if (selected) {
      toast(`推理等级已设为${reasoningLabel(effort)}`, 'ok');
    }
    this.renderStreamingState();
  },

  async loadPermission() {
    if (!state.activeSessionId) {
      state.permissionMode = state.pendingPermission
        ?? (['read-only', 'workspace-write'].includes(state.ui.defaultPermission) ? state.ui.defaultPermission : 'read-only');
      this.renderPermissionControl();
      return state.permissionMode;
    }
    const permissions = await guard(api.sessions.permissions(state.activeSessionId), '读取权限模式');
    if (permissions?.currentValue && PERMISSION_MODES.includes(permissions.currentValue)) {
      state.permissionMode = permissions.currentValue;
      state.pendingPermission = null;
    }
    this.renderPermissionControl();
    return state.permissionMode;
  },

  renderPermissionControl() {
    const slider = document.getElementById('permission-slider');
    const value = document.getElementById('permission-value');
    if (!slider || !value) return;
    const mode = PERMISSION_MODES.includes(state.permissionMode)
      ? state.permissionMode
      : 'read-only';
    slider.value = String(PERMISSION_MODES.indexOf(mode));
    slider.disabled = Boolean(state.permissionBusy || (state.activeSessionId && (state.streaming || state.stopping)));
    value.textContent = permissionLabel(mode);
    slider.title = `权限：${permissionTitle(mode)}`;
  },

  previewPermission(slider) {
    const mode = PERMISSION_MODES[Number(slider.value)] ?? 'read-only';
    const value = document.getElementById('permission-value');
    if (value) value.textContent = permissionLabel(mode);
    slider.title = `权限：${permissionTitle(mode)}`;
  },

  async setPermission(slider) {
    if (slider.disabled) return;
    const mode = PERMISSION_MODES[Number(slider.value)];
    if (!mode || mode === state.permissionMode) {
      this.renderPermissionControl();
      return;
    }
    if (mode === 'danger-full-access') {
      const accepted = await this.confirmFullAccess();
      if (!accepted) {
        this.renderPermissionControl();
        return;
      }
    }
    state.permissionBusy = true;
    this.renderPermissionControl();
    let applied = null;
    if (state.activeSessionId) {
      applied = await guard(
        api.sessions.selectPermission(state.activeSessionId, mode),
        '设置权限模式',
      );
      if (applied?.currentValue === mode) state.permissionMode = mode;
    } else {
      state.permissionMode = mode;
      state.pendingPermission = mode;
      applied = { currentValue: mode };
    }
    if (applied?.currentValue === mode) {
      api.settings.setUi({ defaultPermission: mode === 'danger-full-access' ? 'read-only' : mode })
        .then((ui) => { state.ui = ui; })
        .catch(() => {});
      toast(`权限已设为${permissionTitle(mode)}`, 'ok');
    }
    state.permissionBusy = false;
    this.renderPermissionControl();
  },

  confirmFullAccess() {
    this.settleFullAccessConfirmation(false);
    const backdrop = document.getElementById('permission-confirm-backdrop');
    backdrop.hidden = false;
    return new Promise((resolve) => {
      this.fullAccessConfirmation = resolve;
      requestAnimationFrame(() => document.getElementById('permission-confirm-cancel').focus());
    });
  },

  settleFullAccessConfirmation(accepted) {
    const backdrop = document.getElementById('permission-confirm-backdrop');
    if (backdrop) backdrop.hidden = true;
    const resolve = this.fullAccessConfirmation;
    this.fullAccessConfirmation = null;
    if (resolve) resolve(Boolean(accepted));
  },

  focusComposer() {
    const input = document.getElementById('input');
    if (!input) return;
    input.disabled = false;
    input.readOnly = false;
    requestAnimationFrame(() => input.focus({ preventScroll: true }));
  },

  autoGrow(input) {
    input.style.height = 'auto';
    input.style.height = Math.min(220, input.scrollHeight) + 'px';
  },

  toggleRail(show) {
    const appEl = document.getElementById('app');
    const hidden = show === undefined ? !appEl.classList.contains('rail-hidden') : !show;
    appEl.classList.toggle('rail-hidden', hidden);
    api.settings.setUi({ sidebarVisible: !hidden }).then((ui) => { state.ui = ui; });
  },

  // -------------------------------------------------------------- model picker
  toggleModelPopover() {
    const popover = document.getElementById('model-popover');
    if (!popover.hidden) { this.hidePopover(); return; }
    const chip = document.getElementById('model-chip');
    const rect = chip.getBoundingClientRect();
    popover.style.top = rect.bottom + 8 + 'px';
    popover.style.right = Math.max(12, window.innerWidth - rect.right) + 'px';
    popover.hidden = false;
    this.renderModelPopover();
  },

  hidePopover() {
    const popover = document.getElementById('model-popover');
    if (popover) popover.hidden = true;
  },

  closeModelPopoverFromOutside(target) {
    const popover = document.getElementById('model-popover');
    const chip = document.getElementById('model-chip');
    if (!popover || popover.hidden) return;
    if (popover.contains(target) || chip?.contains(target)) return;
    this.hidePopover();
  },

  renderModelPopover() {
    const body = document.getElementById('model-list');
    const foot = document.getElementById('model-foot');
    const groups = state.registry?.registry ?? [];
    const catalog = state.catalog;
    if (!groups.length) {
      body.innerHTML = '<div class="center">本地内核没有返回模型</div>';
    } else {
      body.innerHTML = groups.map((group) => (group.models ?? []).map((model) => {
        const active = state.selection?.model === model.id;
        const official = officialModel(model.id);
        const efforts = model.efforts ?? [];
        const effortRow = active && efforts.length
          ? `<div class="effort-row">${efforts.map((effort) => `<button class="effort ${state.selection?.reasoningEffort === effort.id ? 'active' : ''}" data-effort="${esc(effort.id)}">${esc(effort.name)}</button>`).join('')}</div>`
          : '';
        return `<button class="model-option${active ? ' active' : ''}" data-model="${esc(model.id)}" data-provider="${esc(group.id)}">
            <div>
              <div class="m-name">${esc(model.name || model.id)}</div>
              <div class="m-sub">${esc(model.id)}${official?.contextWindow ? ' · 上下文 ' + esc(official.contextWindow) : ''}</div>
            </div>
          </button>${effortRow}`;
      }).join('')).join('');
    }
    foot.textContent = catalog
      ? `官方价格表更新于 ${new Date(catalog.fetchedAt).toLocaleDateString('zh-CN')} · 在设置中查看完整价格`
      : '正在获取官方模型表…';

    body.onclick = async (event) => {
      const effortButton = event.target.closest('[data-effort]');
      if (effortButton) {
        await this.chooseSelection(state.selection.provider, state.selection.model, effortButton.getAttribute('data-effort'), '设置思考程度');
        this.renderModelPopover();
        this.renderStreamingState();
        return;
      }
      const option = event.target.closest('[data-model]');
      if (!option) return;
      const provider = option.getAttribute('data-provider');
      const model = option.getAttribute('data-model');
      const target = this.reasoningOptions(provider, model);
      const effortIds = target.efforts.map((effort) => effort.id);
      const effort = effortIds.includes(state.selection?.reasoningEffort)
        ? state.selection.reasoningEffort
        : (effortIds.includes(target.defaultEffort) ? target.defaultEffort : effortIds[0]);
      const changed = await this.chooseSelection(provider, model, effort, '切换模型');
      if (!changed) return;
      this.hidePopover();
      toast('已切换模型', 'ok');
    };
  },

  /** Load the model registry + catalog the first time a session exists. */
  async ensureModelData() {
    const data = await guard(api.llm.catalog(), '读取模型列表');
    if (data) {
      state.registry = { registry: data.registry, failures: data.failures, default: data.default ?? null };
      if (data.official) state.catalog = data.official;
    }
  },
};

window.App = App;

document.addEventListener('DOMContentLoaded', async () => {
  await App.ensureModelData();
  await App.init();
  App.renderStreamingState();
});
