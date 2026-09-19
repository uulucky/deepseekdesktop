'use strict';
/** App controller: bootstraps the shell, owns navigation, the composer and event wiring. */

const App = {
  async init() {
    this.ready = false;
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
    state.permissionMode = defaultPermission(state.ui.defaultPermission);
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
    const rememberedId = typeof state.ui.activeSessionId === 'string' ? state.ui.activeSessionId : null;
    const rememberedSession = state.sessions.find((session) => (
      session.sessionId === rememberedId && !session.archived
    ));
    let opened = false;
    // A brand-new/blank conversation may not be returned by session/list yet. During renderer
    // recovery, try its remembered ID directly before falling back to the first listed item.
    if (rememberedSession || rememberedId) opened = await this.openSession(rememberedSession?.sessionId ?? rememberedId);
    const firstSession = state.sessions.find((session) => !session.archived);
    if (!opened && firstSession) opened = await this.openSession(firstSession.sessionId);
    if (!opened) {
      await this.loadSelection();
      ChatView.render(null);
      this.renderStreamingState();
    }
    Sidebar.renderAll();
    this.ready = true;
    if (state.world?.rendererRecovery?.status === 'recovering') {
      toast('界面已自动恢复，对话仍在继续', 'ok');
    }
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
      this.receiveTranscript(payload.sessionId, payload.transcript);
      if (['optimistic', 'turn/start', 'turn/end'].includes(payload.event?.type) || payload.projection === 'title') {
        this.refreshSessionsThrottled();
      }
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
    document.getElementById('new-chat').addEventListener('click', () => this.newSession(state.preferredWorkspaceId));
    document.getElementById('refresh-sessions').addEventListener('click', () => this.refreshSessions());
    document.getElementById('toggle-archived').addEventListener('click', () => {
      state.showArchived = !state.showArchived;
      Sidebar.renderSessions();
    });
    document.getElementById('add-workspace').addEventListener('click', () => this.addWorkspace());
    document.getElementById('session-search').addEventListener('input', (event) => this.queueSessionSearch(event.target.value));
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
      const menu = event.target.closest('[data-session-menu]');
      if (menu) {
        event.stopPropagation();
        this.toggleSessionPopover(menu, menu.getAttribute('data-session-menu'));
        return;
      }
      const workspaceNew = event.target.closest('[data-workspace-new]');
      if (workspaceNew) {
        this.newSession(workspaceNew.getAttribute('data-workspace-new'));
        return;
      }
      const button = event.target.closest('[data-session]');
      if (button) this.openSession(button.getAttribute('data-session'));
    });
    document.getElementById('session-popover').addEventListener('click', (event) => {
      const action = event.target.closest('[data-session-action]')?.getAttribute('data-session-action');
      if (action) this.runSessionAction(action);
    });
    document.getElementById('action-cancel').addEventListener('click', () => this.closeActionDialog(null));
    document.getElementById('action-confirm').addEventListener('click', () => this.confirmActionDialog());
    document.getElementById('action-backdrop').addEventListener('mousedown', (event) => {
      if (event.target.id === 'action-backdrop') this.closeActionDialog(null);
    });
    document.getElementById('action-input').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); this.confirmActionDialog(); }
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
    document.getElementById('reasoning-slider').addEventListener('input', (event) => this.previewReasoning(event.target));
    document.getElementById('reasoning-slider').addEventListener('change', (event) => this.setReasoning(event.target));
    document.getElementById('permission-slider').addEventListener('input', (event) => this.previewPermission(event.target));
    document.getElementById('permission-slider').addEventListener('change', (event) => this.setPermission(event.target));
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        this.hidePopover();
        this.hideSessionPopover();
        if (this.actionDialog) this.closeActionDialog(null);
      }
      if ((event.metaKey || event.ctrlKey) && event.key === 'n') { event.preventDefault(); this.newSession(); }
      if ((event.metaKey || event.ctrlKey) && event.key === ',') { event.preventDefault(); Settings.open('general'); }
    });
    document.addEventListener('click', (event) => {
      this.closeModelPopoverFromOutside(event.target);
      this.closeSessionPopoverFromOutside(event.target);
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
    window.addEventListener('resize', () => { this.hidePopover(); this.hideSessionPopover(); });
  },

  async installUpdate() {
    if (state.update?.status !== 'available') return;
    toast(state.update.manual
      ? '正在打开 Mac 下载链接。下载后请退出软件，将新应用拖入“应用程序”替换；本地数据保留。'
      : `正在下载 ${state.update.availableVersion}，完成后会自动重启…`);
    await guard(api.update.install(), state.update.manual ? '打开下载失败' : '自动更新失败');
  },

  /** Single delegated click router for modal actions. */
  async routeClick(event) {
    if (!state.view.modal) return;
    const handled = await Settings.onClick(event.target);
    if (handled) event.stopPropagation();
  },

  // ------------------------------------------------------------------ sessions
  sessionView(sessionId = state.activeSessionId) {
    if (!state.sessionViews.has(sessionId)) state.sessionViews.set(sessionId, {
      transcript: null, revision: 0, draft: '', loading: false, sending: false,
      stopping: false, permissionBusy: false, modelBusy: false, unread: false,
      selection: null, selectionRoutable: false,
      permissionMode: defaultPermission(state.ui.defaultPermission),
    });
    return state.sessionViews.get(sessionId);
  },

  activateSession(sessionId) {
    this.sessionView().draft = document.getElementById('input').value;
    this.cancelTranscriptPaint();
    state.navigation += 1;
    state.activeSessionId = sessionId;
    const view = this.sessionView();
    view.unread = false;
    const input = document.getElementById('input');
    input.value = view.draft;
    this.autoGrow(input);
    this.hidePopover();
    this.hideSessionPopover();
    this.paintSession();
    Sidebar.renderSessions();
    if (state.ui.activeSessionId !== sessionId) {
      state.ui.activeSessionId = sessionId;
      api.settings.setUi({ activeSessionId: sessionId }).then((ui) => { state.ui = ui; }).catch(() => {});
    }
    return state.navigation;
  },

  syncSessionControls() {
    const view = this.sessionView();
    state.transcript = view.transcript;
    state.streaming = Boolean(view.sending || view.transcript?.running);
    state.stopping = view.stopping;
    state.sessionLoading = Boolean(view.loading || view.initializing);
    state.selection = view.selection;
    state.selectionRoutable = view.selectionRoutable;
    state.permissionMode = view.permissionMode;
    state.permissionBusy = view.permissionBusy;
    this.renderStreamingState();
    Sidebar.renderChatHeader();
    Sidebar.renderModelChip();
  },

  paintSession() {
    this.cancelTranscriptPaint();
    this.syncSessionControls();
    ChatView.render(state.transcript);
  },

  scheduleTranscriptPaint(sessionId, immediate = false) {
    if (state.activeSessionId !== sessionId) return;
    if (immediate) {
      this.paintSession();
      return;
    }
    if (this.transcriptPaintTimer) return;
    this.transcriptPaintTimer = setTimeout(() => {
      this.transcriptPaintTimer = null;
      if (state.activeSessionId !== sessionId) return;
      this.syncSessionControls();
      ChatView.render(state.transcript);
    }, 80);
  },

  cancelTranscriptPaint() {
    if (!this.transcriptPaintTimer) return;
    clearTimeout(this.transcriptPaintTimer);
    this.transcriptPaintTimer = null;
  },

  receiveTranscript(sessionId, transcript, expectedRevision) {
    if (!sessionId || transcript?.sessionId !== sessionId) return;
    const view = this.sessionView(sessionId);
    // A slow open/prompt response must not roll back newer live events for this task.
    if (expectedRevision !== undefined && view.revision !== expectedRevision) return;
    const before = view.transcript;
    view.transcript = transcript;
    view.revision += 1;
    if (before?.running && !transcript.running && state.activeSessionId !== sessionId) view.unread = true;
    if (!state.sessions.some((session) => session.sessionId === sessionId)) {
      state.sessions.unshift({ sessionId, title: transcript.title, updatedAt: Date.now() });
    }
    if (state.activeSessionId === sessionId) {
      // Keep Stop / task state accurate immediately, but coalesce expensive Markdown and DOM
      // rebuilding while tokens stream. Terminal and approval transitions paint at once.
      this.syncSessionControls();
      const approvalsChanged = JSON.stringify(before?.approvals ?? []) !== JSON.stringify(transcript.approvals ?? []);
      this.scheduleTranscriptPaint(sessionId, Boolean(
        (before?.running && !transcript.running) || approvalsChanged,
      ));
    }
    if (!before || before.running !== transcript.running || before.title !== transcript.title
      || JSON.stringify(before.approvals ?? []) !== JSON.stringify(transcript.approvals ?? [])) {
      Sidebar.renderSessions();
    }
  },

  async refreshSessions() {
    const request = this.sessionListRequest = (this.sessionListRequest ?? 0) + 1;
    const [sessions, workspaces] = await Promise.all([
      guard(api.sessions.list(), '加载对话列表'),
      typeof api.workspaces?.list === 'function'
        ? guard(api.workspaces.list(), '加载工作区')
        : Promise.resolve({ items: [], archivedSessionIds: [] }),
    ]);
    if (!sessions || request !== this.sessionListRequest) return;
    if (workspaces) {
      state.workspaces = workspaces.items ?? [];
      state.archivedSessionIds = workspaces.archivedSessionIds ?? [];
    }
    // Harness hides blank sessions. Keep locally created drafts navigable until first send.
    const known = new Set(sessions.map((session) => session.sessionId));
    const drafts = state.sessions.filter((session) => !known.has(session.sessionId)
      && state.sessionViews.has(session.sessionId));
    state.sessions = [...drafts, ...sessions];
    Sidebar.renderSessions();
    if (state.sessionQuery.trim()) this.searchSessions(state.sessionQuery);
  },

  refreshSessionsThrottled() {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.refreshSessions();
    }, 1200);
  },

  async openSession(sessionId) {
    if (!sessionId) return false;
    const summary = state.sessions.find((session) => session.sessionId === sessionId);
    state.preferredWorkspaceId = summary?.workspaceId ?? null;
    const view = this.sessionView(sessionId);
    view.loading = true;
    const navigation = this.activateSession(sessionId);
    const revision = view.revision;
    const transcript = await guard(api.sessions.open(sessionId), '打开对话');
    if (transcript) this.receiveTranscript(sessionId, transcript, revision);
    else {
      view.loading = false;
      if (navigation === state.navigation) this.paintSession();
      return false;
    }
    await Promise.all([this.loadSelection(sessionId), this.loadPermission(sessionId)]);
    view.loading = false;
    if (navigation !== state.navigation) return;
    this.paintSession();
    Sidebar.renderAll();
    ChatView.scrollToEnd();
    return true;
  },

  async newSession(workspaceId = state.preferredWorkspaceId) {
    if (state.creatingSession) return null;
    state.creatingSession = true;
    this.renderStreamingState();
    const navigation = state.navigation;
    const intended = state.pendingSelection ?? state.selection ?? this.localDefaultSelection();
    const intendedPermission = state.pendingPermission
      ?? defaultPermission(state.ui.defaultPermission);
    try {
      const created = await guard(api.sessions.create(workspaceId ? { workspaceId } : {}), '新建对话');
      if (!created?.sessionId) return null;
      const sessionId = created.sessionId;
      const view = this.sessionView(sessionId);
      view.initializing = true;
      view.selection = intended;
      view.permissionMode = intendedPermission;
      if (!view.transcript) view.transcript = { sessionId, items: [], title: null, usage: {}, running: false };
      if (!state.sessions.some((session) => session.sessionId === sessionId)) {
        state.sessions.unshift({ sessionId, title: null, updatedAt: Date.now(), workspaceId: workspaceId ?? null, archived: false });
      }
      // Do not pull the user back if they deliberately navigated while creation was pending.
      const activated = navigation === state.navigation;
      if (activated) this.activateSession(sessionId);
      Sidebar.renderSessions();
      const permissions = await guard(api.sessions.selectPermission(sessionId, intendedPermission), '设置新对话权限');
      if (permissions?.currentValue) view.permissionMode = permissions.currentValue;
      if (intended?.provider && intended?.model) {
        const selected = await guard(api.llm.selectModel(sessionId, intended.provider, intended.model,
          intended.reasoningEffort), '设置新对话模型');
        if (selected) view.selection = selected;
      }
      await Promise.all([this.loadSelection(sessionId), this.loadPermission(sessionId)]);
      view.initializing = false;
      if (state.activeSessionId === sessionId) {
        state.pendingSelection = null;
        state.pendingPermission = null;
        this.paintSession();
        this.focusComposer();
      }
      return created;
    } finally {
      state.creatingSession = false;
      this.renderStreamingState();
    }
  },

  queueSessionSearch(value) {
    const query = String(value ?? '').trim();
    state.sessionQuery = query;
    clearTimeout(this.sessionSearchTimer);
    if (!query) {
      this.sessionSearchRequest = (this.sessionSearchRequest ?? 0) + 1;
      state.sessionSearchResults = null;
      state.sessionSearchHasMore = false;
      state.sessionSearchBusy = false;
      Sidebar.renderSessions();
      return;
    }
    state.sessionSearchBusy = true;
    Sidebar.renderSessions();
    this.sessionSearchTimer = setTimeout(() => this.searchSessions(query), 260);
  },

  async searchSessions(query) {
    const request = this.sessionSearchRequest = (this.sessionSearchRequest ?? 0) + 1;
    const result = await guard(api.sessions.search(query), '搜索对话');
    if (request !== this.sessionSearchRequest || query !== state.sessionQuery) return;
    state.sessionSearchBusy = false;
    state.sessionSearchResults = result?.items ?? [];
    state.sessionSearchHasMore = Boolean(result?.hasMore);
    Sidebar.renderSessions();
  },

  async addWorkspace() {
    if (this.addingWorkspace || typeof api.workspaces?.add !== 'function') return;
    this.addingWorkspace = true;
    const button = document.getElementById('add-workspace');
    button.disabled = true;
    try {
      const result = await guard(api.workspaces.add(), '添加工作区');
      if (!result?.workspace) return;
      state.preferredWorkspaceId = result.workspace.workspaceId;
      await this.refreshSessions();
      toast(result.created ? `已添加工作区“${result.workspace.title}”` : `工作区“${result.workspace.title}”已存在`, 'ok');
    } finally {
      this.addingWorkspace = false;
      button.disabled = false;
    }
  },

  toggleSessionPopover(button, sessionId) {
    const popover = document.getElementById('session-popover');
    if (!popover.hidden && state.sessionMenuId === sessionId) {
      this.hideSessionPopover();
      return;
    }
    state.sessionMenuId = sessionId;
    const session = state.sessions.find((item) => item.sessionId === sessionId)
      ?? state.sessionSearchResults?.find((item) => item.sessionId === sessionId);
    popover.querySelector('[data-session-action="archive"]').hidden = Boolean(session?.archived);
    popover.hidden = false;
    const rect = button.getBoundingClientRect();
    const width = 218;
    popover.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width))}px`;
    const height = popover.offsetHeight || 126;
    popover.style.top = `${Math.max(8, Math.min(window.innerHeight - height - 8, rect.bottom + 5))}px`;
  },

  hideSessionPopover() {
    const popover = document.getElementById('session-popover');
    if (popover) popover.hidden = true;
    state.sessionMenuId = null;
  },

  closeSessionPopoverFromOutside(target) {
    const popover = document.getElementById('session-popover');
    if (!popover || popover.hidden) return;
    if (popover.contains(target) || target.closest?.('[data-session-menu]')) return;
    this.hideSessionPopover();
  },

  openActionDialog({ title, message, confirmLabel = '确定', inputValue, danger = false }) {
    if (this.actionDialog) this.closeActionDialog(null);
    const backdrop = document.getElementById('action-backdrop');
    const dialog = backdrop.querySelector('.action-dialog');
    const input = document.getElementById('action-input');
    document.getElementById('action-title').textContent = title;
    document.getElementById('action-message').textContent = message;
    document.getElementById('action-icon').textContent = danger ? '!' : '✎';
    document.getElementById('action-confirm').textContent = confirmLabel;
    document.getElementById('action-confirm').classList.toggle('danger', danger);
    dialog.classList.toggle('danger', danger);
    input.hidden = inputValue === undefined;
    input.value = inputValue ?? '';
    backdrop.hidden = false;
    return new Promise((resolve) => {
      this.actionDialog = { resolve, expectsInput: inputValue !== undefined };
      requestAnimationFrame(() => (input.hidden ? document.getElementById('action-confirm') : input).focus());
    });
  },

  confirmActionDialog() {
    if (!this.actionDialog) return;
    if (this.actionDialog.expectsInput) {
      const value = document.getElementById('action-input').value.trim();
      if (!value) { toast('对话名称不能为空', 'err'); return; }
      this.closeActionDialog(value);
      return;
    }
    this.closeActionDialog(true);
  },

  closeActionDialog(value) {
    const pending = this.actionDialog;
    this.actionDialog = null;
    document.getElementById('action-backdrop').hidden = true;
    pending?.resolve(value);
  },

  async runSessionAction(action) {
    const sessionId = state.sessionMenuId;
    const session = state.sessions.find((item) => item.sessionId === sessionId)
      ?? state.sessionSearchResults?.find((item) => item.sessionId === sessionId);
    this.hideSessionPopover();
    if (!sessionId || !session) return;
    if (action === 'rename') {
      const title = await this.openActionDialog({
        title: '重命名对话',
        message: '输入一个便于以后查找的名称。',
        confirmLabel: '保存',
        inputValue: session.title || this.sessionView(sessionId).transcript?.title || '新对话',
      });
      if (!title) return;
      const renamed = await guard(api.sessions.rename(sessionId, title), '重命名失败');
      if (!renamed) return;
      session.title = renamed.title ?? title;
      const view = this.sessionView(sessionId);
      if (view.transcript) view.transcript = { ...view.transcript, title: session.title };
      Sidebar.renderAll();
      toast('对话已重命名', 'ok');
      this.refreshSessionsThrottled();
      return;
    }
    if (action === 'fork') {
      toast('正在从最近一次完整交互创建新对话…');
      const created = await guard(api.sessions.fork(sessionId), '创建新对话失败');
      if (!created?.sessionId) return;
      state.sessions.unshift({
        sessionId: created.sessionId,
        title: session.title ? `${session.title}（副本）` : '新对话',
        updatedAt: Date.now(),
        workspaceId: session.workspaceId ?? null,
        parentSessionId: sessionId,
        archived: false,
      });
      await this.openSession(created.sessionId);
      this.refreshSessionsThrottled();
      toast(created.warnings?.length
        ? `已创建新对话；${created.warnings.join('；')}`
        : '已创建独立新对话，原对话保持不变', created.warnings?.length ? 'err' : 'ok');
      return;
    }
    if (action === 'archive' && !session.archived) {
      const view = this.sessionView(sessionId);
      if (view.sending || view.transcript?.running || session.running) {
        toast('任务运行中，请先停止后再归档', 'err');
        return;
      }
      const confirmed = await this.openActionDialog({
        title: '归档此对话？',
        message: '归档只会从当前列表隐藏对话，不会删除本地聊天记录。之后可在“已归档”中查看。',
        confirmLabel: '归档',
        danger: true,
      });
      if (!confirmed) return;
      const result = await guard(api.sessions.archive(sessionId), '归档失败');
      if (!result) return;
      const wasActive = state.activeSessionId === sessionId;
      await this.refreshSessions();
      if (wasActive) {
        const next = state.sessions.find((item) => !item.archived && item.sessionId !== sessionId);
        if (next) await this.openSession(next.sessionId);
        else {
          this.activateSession(null);
          await this.loadSelection(null);
          this.paintSession();
        }
      }
      toast('对话已归档', 'ok');
    }
  },

  /** Current model + effort for the active session (session.models → selection). */
  async loadSelection(sessionId = state.activeSessionId) {
    const view = this.sessionView(sessionId);
    const request = view.selectionRequest = (view.selectionRequest ?? 0) + 1;
    if (!sessionId) {
      view.selection = state.pendingSelection ?? this.localDefaultSelection() ?? state.selection;
      view.selectionRoutable = Boolean((state.registry?.registry ?? []).length);
    } else {
      const models = await guard(api.sessions.modelSelection(sessionId), '读取模型');
      if (request !== view.selectionRequest) return view.selection;
      if (models?.current) {
        view.selection = models.current;
        view.selectionRoutable = models.routable;
      } else if (!view.selection) view.selection = this.localDefaultSelection();
    }
    if (state.activeSessionId === sessionId) this.syncSessionControls();
    return view.selection;
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
    Object.assign(this.sessionView(), { selection: { ...selection }, selectionRoutable: true });
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
    if (state.streaming || state.stopping || state.sessionLoading || this.sessionView().modelBusy) return false;
    const request = { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) };
    if (!state.activeSessionId) {
      this.rememberPendingSelection(request);
      return true;
    }
    const sessionId = state.activeSessionId;
    const view = this.sessionView(sessionId);
    view.modelBusy = true;
    view.selectionRequest = (view.selectionRequest ?? 0) + 1;
    this.renderReasoningControl();
    const selected = await guard(api.llm.selectModel(
      sessionId, provider, model, reasoningEffort,
    ), context);
    view.modelBusy = false;
    if (selected) view.selection = selected;
    await this.loadSelection(sessionId);
    if (state.activeSessionId === sessionId) this.syncSessionControls();
    if (!selected) return false;
    return true;
  },

  async refreshCredentials() {
    const described = await guard(api.credentials.describe(['DEEPSEEK_API_KEY']), '读取凭据');
    if (described) state.credentials = described;
  },

  // ------------------------------------------------------------------- sending
  async send() {
    if (state.streaming || state.stopping || state.sessionLoading || (state.creatingSession && !state.activeSessionId)) return;
    const input = document.getElementById('input');
    const text = input.value.trim();
    if (!text) return;
    if (!state.activeSessionId) {
      const created = await this.newSession();
      if (!created || created.sessionId !== state.activeSessionId) return;
    }
    const sessionId = state.activeSessionId;
    const view = this.sessionView(sessionId);
    const revision = view.revision;
    input.value = '';
    view.draft = '';
    view.sending = true;
    this.autoGrow(input);
    this.syncSessionControls();
    const transcript = await guard(api.sessions.prompt(sessionId, text), '发送失败');
    view.sending = false;
    if (transcript) {
      this.receiveTranscript(sessionId, transcript, revision);
    } else if (!view.draft) {
      view.draft = text;
      if (state.activeSessionId === sessionId && !input.value) input.value = text;
    }
    if (state.activeSessionId === sessionId) {
      this.paintSession();
      ChatView.scrollToEnd();
    }
    Sidebar.renderSessions();
    this.refreshSessionsThrottled();
  },

  async stop() {
    if (!state.activeSessionId || !state.streaming || state.stopping) return;
    const sessionId = state.activeSessionId;
    const view = this.sessionView(sessionId);
    view.stopping = true;
    this.syncSessionControls();
    const cancelled = await guard(api.sessions.cancel(sessionId), '停止失败');
    view.stopping = false;
    if (cancelled !== null) {
      view.sending = false;
      if (view.transcript) view.transcript = { ...view.transcript, running: false };
    }
    if (state.activeSessionId === sessionId) this.syncSessionControls();
    Sidebar.renderSessions();
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
    if (send) send.disabled = state.streaming || state.stopping || state.sessionLoading || (state.creatingSession && !state.activeSessionId);
    const newChat = document.getElementById('new-chat');
    if (newChat) {
      newChat.disabled = state.creatingSession;
      newChat.setAttribute('aria-busy', String(state.creatingSession));
      newChat.title = state.creatingSession ? '正在新建对话…' : '新建独立对话，其他任务继续运行（Ctrl/Cmd+N）';
    }
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
    slider.disabled = Boolean(state.sessionLoading || this.sessionView().modelBusy || (state.activeSessionId && (state.streaming || state.stopping)));
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

  async loadPermission(sessionId = state.activeSessionId) {
    const view = this.sessionView(sessionId);
    const request = view.permissionRequest = (view.permissionRequest ?? 0) + 1;
    if (!sessionId) {
      view.permissionMode = state.pendingPermission
        ?? defaultPermission(state.ui.defaultPermission);
    } else {
      const permissions = await guard(api.sessions.permissions(sessionId), '读取权限模式');
      if (request !== view.permissionRequest) return view.permissionMode;
      if (permissions?.currentValue && PERMISSION_MODES.includes(permissions.currentValue)) {
        view.permissionMode = permissions.currentValue;
      }
    }
    if (state.activeSessionId === sessionId) this.syncSessionControls();
    return view.permissionMode;
  },

  renderPermissionControl() {
    const slider = document.getElementById('permission-slider');
    const value = document.getElementById('permission-value');
    if (!slider || !value) return;
    const mode = PERMISSION_MODES.includes(state.permissionMode)
      ? state.permissionMode
      : 'read-only';
    slider.value = String(PERMISSION_MODES.indexOf(mode));
    slider.disabled = Boolean(state.sessionLoading || state.permissionBusy || (state.activeSessionId && (state.streaming || state.stopping)));
    value.textContent = permissionLabel(mode);
    slider.title = `权限：${permissionTitle(mode)}`;
    slider.setAttribute('aria-valuetext', permissionTitle(mode));
    const warning = document.getElementById('permission-warning');
    if (warning) warning.hidden = mode !== 'danger-full-access';
    document.getElementById('permission-control')?.classList.toggle('full-access', mode === 'danger-full-access');
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
    const sessionId = state.activeSessionId;
    const view = this.sessionView(sessionId);
    view.permissionRequest = (view.permissionRequest ?? 0) + 1;
    view.permissionBusy = true;
    this.syncSessionControls();
    let applied = null;
    if (sessionId) {
      applied = await guard(
        api.sessions.selectPermission(sessionId, mode),
        '设置权限模式',
      );
      if (applied?.currentValue === mode) view.permissionMode = mode;
    } else {
      view.permissionMode = mode;
      state.pendingPermission = mode;
      applied = { currentValue: mode };
    }
    if (applied?.currentValue === mode) {
      state.ui.defaultPermission = mode;
      const ui = await guard(api.settings.setUi({ defaultPermission: mode }), '保存默认权限');
      if (ui) state.ui = ui;
      toast(`权限已设为${permissionTitle(mode)}`, 'ok');
    }
    view.permissionBusy = false;
    if (state.activeSessionId === sessionId) this.syncSessionControls();
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
  try {
    await App.ensureModelData();
    await App.init();
    App.renderStreamingState();
  } catch (error) {
    const message = error?.message || String(error);
    api.app?.reportRendererError?.({ phase: 'startup', message, stack: String(error?.stack ?? '') }).catch(() => {});
    const panel = document.getElementById('renderer-error');
    const detail = document.getElementById('renderer-error-detail');
    if (detail) detail.textContent = message;
    if (panel) panel.hidden = false;
  }
});

window.addEventListener('error', (event) => {
  api.app?.reportRendererError?.({
    phase: App.ready ? 'runtime' : 'startup',
    message: event.message || '未知界面错误',
    stack: String(event.error?.stack ?? ''),
  }).catch(() => {});
});
window.addEventListener('unhandledrejection', (event) => {
  const error = event.reason;
  api.app?.reportRendererError?.({
    phase: App.ready ? 'runtime' : 'startup',
    message: error?.message || String(error),
    stack: String(error?.stack ?? ''),
  }).catch(() => {});
});
