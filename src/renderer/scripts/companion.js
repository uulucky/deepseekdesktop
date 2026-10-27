'use strict';
/**
 * 老友 in the window: the fixed sidebar entry, its welcome page, dispatch cards, the receipts
 * above the composer and the locked model/reasoning/permission controls. The main process
 * owns the conversation and its ledger (src/main/modules/companion.js) and pushes snapshots.
 */

const COMPANION_TOOLS = new Set(['companion_dispatch', 'companion_send', 'companion_cancel']);
const COMPANION_LOCK_TEXT = '老友固定使用 DeepSeek V4.1 Flash，思考关闭，这样回得快、费用低。复杂的活它会派给工作对话，工作对话可以自由选模型。';
const TASK_STATUS = {
  running: { text: '运行中', tone: 'run' },
  waiting_approval: { text: '等你批准', tone: 'warn' },
  waiting_answer: { text: '等你回答', tone: 'warn' },
  done: { text: '已完成', tone: 'ok' },
  failed: { text: '失败', tone: 'err' },
  stopped: { text: '已停止', tone: 'muted' },
  idle: { text: '还没开始', tone: 'muted' },
  archived: { text: '已归档', tone: 'muted' },
  missing: { text: '已不存在', tone: 'muted' },
};

const CompanionView = {
  /** Whether a session id is 老友. */
  is(sessionId) {
    return Boolean(sessionId) && sessionId === state.companion?.sessionId;
  },

  active() {
    return this.is(state.activeSessionId);
  },

  async load() {
    if (typeof api.companion?.get !== 'function') return null;
    const snapshot = await api.companion.get().catch((error) => {
      state.companionError = String(error?.message ?? error);
      return null;
    });
    if (snapshot) this.receive(snapshot);
    else this.renderEntry();
    return snapshot;
  },

  receive(snapshot) {
    if (!snapshot?.sessionId) return;
    const before = state.companion;
    state.companion = snapshot;
    state.companionError = null;
    this.renderEntry();
    this.renderReceipts();
    this.refreshCards();
    if (snapshot.notice && snapshot.notice !== before?.notice) toast(snapshot.notice, 'ok');
    if (before && before.sessionId !== snapshot.sessionId) Sidebar.renderSessions();
  },

  task(taskId) {
    return (state.companion?.tasks ?? []).find((task) => task.taskId === taskId) ?? null;
  },

  open() {
    const id = state.companion?.sessionId;
    if (!id) {
      toast(state.companionError || '老友还在准备，请稍等', 'err');
      return false;
    }
    return App.openSession(id);
  },

  // ---------------------------------------------------------------- sidebar
  statusLine() {
    const companion = state.companion;
    if (!companion) return state.companionError ? '暂时不可用' : '正在准备…';
    const view = state.sessionViews.get(companion.sessionId);
    if (view?.sending || view?.transcript?.running) return '正在回复…';
    if (companion.counts?.waiting) return `${companion.counts.waiting} 件事等你处理`;
    if (companion.counts?.running) return `${companion.counts.running} 件事在办`;
    if (companion.counts?.finished) return `${companion.counts.finished} 件办完了`;
    const items = view?.transcript?.items ?? [];
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].kind !== 'assistant') continue;
      const text = (items[i].parts ?? []).filter((part) => part.kind === 'text').map((part) => part.text).join('').trim();
      if (text) return text.length > 16 ? `${text.slice(0, 16)}…` : text;
    }
    return '随时找我聊';
  },

  renderEntry() {
    const host = document.getElementById('companion-entry');
    if (!host) return;
    host.hidden = Boolean(state.showArchived);
    const companion = state.companion;
    const counts = companion?.counts ?? {};
    const tone = counts.waiting ? ' waiting' : counts.running ? ' running' : counts.finished ? ' unread' : '';
    const active = companion && state.activeSessionId === companion.sessionId ? ' active' : '';
    host.innerHTML =
      `<button class="companion-item${active}${companion ? '' : ' disabled'}" data-companion-open type="button" title="老友 · 主对话，帮你统筹">` +
        '<span class="companion-avatar" aria-hidden="true">友</span>' +
        '<span class="companion-text">' +
          '<span class="companion-name">老友<span class="companion-tag">主对话</span></span>' +
          `<span class="companion-status${tone}">${counts.running && !counts.waiting ? '<span class="s-run" aria-hidden="true"></span>' : ''}${esc(this.statusLine())}</span>` +
        '</span>' +
      '</button>';
  },

  // ------------------------------------------------------------- chat area
  renderWelcome() {
    const suggestions = ['帮我整理一下下载文件夹', '这周有哪些对话还没跑完？', '随便聊聊'];
    return (
      '<div class="empty companion-welcome">' +
        '<div class="companion-avatar large" aria-hidden="true">友</div>' +
        '<h1>嗨，我是老友</h1>' +
        '<p>平时找我聊天就行；想办的事跟我说一声，我开个工作对话去做，做完回来告诉你。我这边固定用 V4.1 Flash、不开思考，回得快也省钱。</p>' +
        '<div class="suggestions">' +
          suggestions.map((text) => `<button class="suggestion" data-prompt="${esc(text)}">${esc(text)}</button>`).join('') +
        '</div>' +
      '</div>'
    );
  },

  /** Strip the progress block the desktop puts in front of a message to 老友. */
  splitUpdates(text) {
    const value = String(text ?? '');
    const match = /^<desktop-task-updates>\n?([\s\S]*?)\n?<\/desktop-task-updates>\n?/.exec(value);
    if (!match) return { text: value, updates: 0 };
    return { text: value.slice(match[0].length), updates: match[1].split('\n').filter((line) => line.trim().startsWith('-')).length };
  },

  /** A dispatch / follow-up / stop tool call drawn as a card instead of a folded row. */
  renderToolCard(item) {
    if (!COMPANION_TOOLS.has(item.name)) return null;
    let args = {};
    let result = null;
    try { args = JSON.parse(item.arguments || '{}'); } catch { /* still streaming */ }
    try {
      const outer = JSON.parse(item.output || 'null');
      result = typeof outer?.result === 'string' ? JSON.parse(outer.result) : outer;
    } catch { result = null; }
    const taskId = result?.taskId ?? args.taskId ?? null;
    const known = taskId ? this.task(taskId) : null;
    const title = known?.title || result?.title || args.title || '工作对话';
    if (item.running) {
      const doing = item.name === 'companion_dispatch' ? `正在派给「${title}」…` : item.name === 'companion_cancel' ? '正在停止…' : '正在转达…';
      return `<div class="companion-card pending"><span class="companion-card-title">${esc(doing)}</span></div>`;
    }
    if (item.isError || !result || result.ok === false) {
      const reason = result?.error || item.output || '没有成功';
      return `<div class="companion-card failed"><span class="companion-card-title">没派成：${esc(String(reason).slice(0, 160))}</span></div>`;
    }
    if (item.name !== 'companion_dispatch') {
      const verb = item.name === 'companion_cancel' ? '已停止' : result.delivered === 'queued' ? '已追加（排队中）给' : '已追加给';
      return `<div class="companion-card small" data-task-card="${esc(taskId)}"><span class="companion-card-title">${esc(verb)}「${esc(title)}」</span>` +
        `<button class="companion-link" data-open-task="${esc(taskId)}" type="button">打开对话</button></div>`;
    }
    const permission = permissionLabel(result.permission);
    const model = result.model ? modelLabel(result.model) : '默认模型';
    const where = result.workspace ? String(result.workspace).split(/[\\/]/).filter(Boolean).pop() : '默认目录';
    return (
      `<div class="companion-card" data-task-card="${esc(taskId)}">` +
        `<div class="companion-card-head"><span class="companion-card-arrow" aria-hidden="true">➜</span>已派给「<button class="companion-link title" data-open-task="${esc(taskId)}" type="button">${esc(title)}</button>」</div>` +
        `<div class="companion-card-meta">${esc(where)} · ${esc(model)} · ${esc(permission)}权限</div>` +
        `<div class="companion-card-foot">${this.statusBadge(known?.status ?? 'running')}` +
          `<button class="companion-open" data-open-task="${esc(taskId)}" type="button">${this.openLabel(known?.status)}</button></div>` +
      '</div>'
    );
  },

  statusBadge(status) {
    const info = TASK_STATUS[status] ?? TASK_STATUS.running;
    return `<span class="companion-badge ${info.tone}" data-task-status>${esc(info.text)}</span>`;
  },

  openLabel(status) {
    if (status === 'waiting_approval') return '去批准';
    if (status === 'waiting_answer') return '去回答';
    if (status === 'archived') return '在已归档中查看';
    return '打开对话';
  },

  /** Live status on cards already on screen, without repainting the transcript. */
  refreshCards() {
    for (const card of document.querySelectorAll('[data-task-card]')) {
      const task = this.task(card.getAttribute('data-task-card'));
      if (!task) continue;
      const badge = card.querySelector('[data-task-status]');
      if (badge) badge.outerHTML = this.statusBadge(task.status);
      const open = card.querySelector('.companion-open');
      if (open) open.textContent = this.openLabel(task.status);
    }
  },

  renderReceipts() {
    const host = document.getElementById('companion-receipts');
    if (!host) return;
    const receipts = this.active() ? (state.companion?.receipts ?? []) : [];
    host.hidden = !receipts.length;
    if (!receipts.length) { host.innerHTML = ''; return; }
    const shown = receipts.slice(0, 3);
    const line = (task) => {
      const what = task.status === 'done' ? '办完了'
        : task.status === 'failed' ? `没做成${task.lastLine ? `：${task.lastLine.slice(0, 40)}` : ''}`
          : task.status === 'waiting_approval' ? '在等你批准'
            : task.status === 'waiting_answer' ? '在等你回答' : TASK_STATUS[task.status]?.text ?? task.status;
      const go = task.status === 'waiting_approval' ? '去批准' : task.status === 'waiting_answer' ? '去回答' : '看看结果';
      return `<div class="companion-receipt ${esc(TASK_STATUS[task.status]?.tone ?? '')}">` +
        `<span>「${esc(task.title)}」${esc(what)}</span>` +
        `<button class="companion-link" data-open-task="${esc(task.taskId)}" data-ack-task="${esc(task.taskId)}" type="button">${go}</button>` +
        (task.status === 'done' || task.status === 'failed'
          ? `<button class="companion-link" data-report-task="${esc(task.title)}" type="button">让老友汇报</button>` : '') +
      '</div>';
    };
    host.innerHTML = shown.map(line).join('') + (receipts.length > shown.length ? `<div class="companion-receipt more">还有 ${receipts.length - shown.length} 条</div>` : '');
  },

  /** The locked model chip opens this instead of the model list. */
  renderLockPopover(host) {
    if (!host) return;
    host.innerHTML =
      '<div class="companion-lock-title">V4.1 Flash · 固定</div>' +
      `<p>${esc(COMPANION_LOCK_TEXT)}</p>` +
      '<button class="companion-open" data-companion-new type="button">新建工作对话（可选模型）</button>';
  },

  /** Click routing for the sidebar entry, cards and receipts. Returns true when handled. */
  onClick(target) {
    if (target.closest?.('[data-companion-open]')) { this.open(); return true; }
    const ack = target.closest?.('[data-ack-task]')?.getAttribute('data-ack-task');
    if (ack) api.companion?.acknowledge(ack).catch(() => {});
    const open = target.closest?.('[data-open-task]')?.getAttribute('data-open-task');
    if (open) {
      const task = this.task(open);
      if (task?.status === 'archived' && !state.showArchived) { state.showArchived = true; Sidebar.renderSessions(); }
      App.openSession(open);
      return true;
    }
    const report = target.closest?.('[data-report-task]')?.getAttribute('data-report-task');
    if (report) {
      const input = document.getElementById('input');
      input.value = `看看「${report}」怎么样了`;
      App.autoGrow(input);
      App.send();
      return true;
    }
    if (target.closest?.('[data-companion-new]')) {
      App.hidePopover();
      App.newSession(null);
      return true;
    }
    if (target.closest?.('[data-back-companion]')) { this.open(); return true; }
    return false;
  },
};

window.CompanionView = CompanionView;
