'use strict';
/** Left rail: conversation list, ad slot, profile / settings entry points. */

const Sidebar = {
  renderSessions() {
    const list = document.getElementById('session-list');
    if (!list) return;
    const sessions = state.sessions ?? [];
    const taskState = (session) => {
      const view = state.sessionViews.get(session.sessionId);
      const waiting = Boolean(view?.transcript?.approvals?.length);
      const running = Boolean(view?.sending || (view?.transcript ? view.transcript.running : session.running));
      return { view, waiting, running };
    };
    const activeCount = sessions.filter((session) => taskState(session).running || taskState(session).waiting).length;
    const heading = document.getElementById('sessions-status');
    const query = state.sessionQuery.trim();
    if (heading) heading.textContent = query
      ? (state.sessionSearchBusy ? '正在搜索…' : `搜索结果 · ${(state.sessionSearchResults ?? []).length}`)
      : state.showArchived ? '已归档'
        : activeCount ? `对话 · ${activeCount} 个任务进行中` : '对话';
    const archivedToggle = document.getElementById('toggle-archived');
    if (archivedToggle) {
      archivedToggle.classList.toggle('active', state.showArchived);
      archivedToggle.title = state.showArchived ? '返回当前对话' : '查看已归档对话';
      archivedToggle.setAttribute('aria-label', archivedToggle.title);
    }
    const preferred = (state.workspaces ?? []).find((workspace) => workspace.workspaceId === state.preferredWorkspaceId);
    const newLabel = document.getElementById('new-chat-label');
    if (newLabel) newLabel.textContent = preferred ? `在 ${preferred.title} 新建对话` : '新建对话';

    const row = (session) => {
      const { view, waiting, running } = taskState(session);
      const title = esc(view?.transcript?.title || session.title || '新对话');
      const active = session.sessionId === state.activeSessionId ? ' active' : '';
      const label = waiting ? '待批准' : view?.stopping ? '停止中' : running ? '运行中' : view?.unread ? '已完成' : relativeTime(session.updatedAt);
      const statusClass = waiting ? ' waiting' : running ? ' running' : view?.unread ? ' unread' : '';
      const snippet = session.snippet ? `<span class="session-snippet">${esc(session.snippet)}</span>` : '';
      return (
        `<div class="session-row${active}" data-session-row="${esc(session.sessionId)}">` +
          `<button class="session-item" data-session="${esc(session.sessionId)}" title="${title}">` +
            (running ? '<span class="s-run" aria-hidden="true"></span>' : '') +
            `<span class="session-title-wrap"><span class="s-title">${title}</span>${snippet}</span>` +
            (session.archived ? '<span class="archived-badge">归档</span>' : `<span class="s-meta${statusClass}">${esc(label)}</span>`) +
          '</button>' +
          `<button class="session-menu" data-session-menu="${esc(session.sessionId)}" title="对话操作" aria-label="${title}的操作">` +
            '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></svg>' +
          '</button>' +
        '</div>'
      );
    };

    if (query) {
      const results = state.sessionSearchResults ?? [];
      list.innerHTML = results.length
        ? results.map(row).join('') + (state.sessionSearchHasMore ? '<div class="session-empty">仅显示前 20 个内容匹配结果，请输入更具体的关键词。</div>' : '')
        : `<div class="session-empty">${state.sessionSearchBusy ? '正在搜索对话内容…' : '没有找到相关对话。'}</div>`;
      return;
    }

    const visible = sessions.filter((session) => Boolean(session.archived) === Boolean(state.showArchived));
    if (!visible.length && state.showArchived) {
      list.innerHTML = '<div class="session-empty">还没有已归档的对话。</div>';
      return;
    }
    const workspaceMarkup = (state.workspaces ?? []).map((workspace) => {
      const members = visible.filter((session) => session.workspaceId === workspace.workspaceId);
      if (state.showArchived && !members.length) return '';
      return `<section class="workspace-group" data-workspace="${esc(workspace.workspaceId)}">` +
        `<div class="workspace-head" title="${esc(workspace.path)}">` +
          '<svg class="workspace-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h7l2 2h9v10H3z" /></svg>' +
          `<span class="workspace-name">${esc(workspace.title)}</span>` +
          (state.showArchived ? '' : `<button class="workspace-new" data-workspace-new="${esc(workspace.workspaceId)}" title="在此工作区新建对话" aria-label="在${esc(workspace.title)}新建对话"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg></button>`) +
        '</div>' +
        (members.length ? members.map(row).join('') : '<div class="workspace-empty">暂无对话</div>') +
      '</section>';
    }).join('');
    const loose = visible.filter((session) => !session.workspaceId);
    const looseMarkup = loose.length
      ? `<section class="workspace-group"><div class="workspace-head"><span class="workspace-name">${state.workspaces?.length ? '其他对话' : '最近对话'}</span></div>${loose.map(row).join('')}</section>`
      : '';
    list.innerHTML = workspaceMarkup + looseMarkup || '<div class="session-empty">还没有对话，点击“新建对话”开始。</div>';
  },

  /**
   * Ad slot: one image at a time, rotating through the configured list.
   * Images come from the remote feed (url/pic/title/text) with the built-in house ad as the
   * fallback, so the frame is never empty.
   */
  renderAd() {
    const host = document.getElementById('ad-slot');
    if (!host) return;
    const ad = state.ad ?? {};
    const ads = Array.isArray(ad.ads) ? ad.ads.filter((entry) => entry && entry.url) : [];
    if (ad.enabled === false || !ads.length) {
      this.stopAdRotation();
      host.hidden = true;
      host.innerHTML = '';
      return;
    }

    host.hidden = false;
    const index = Math.min(this.adIndex ?? 0, ads.length - 1);
    this.adIndex = index;
    const current = ads[index];
    const dots = ads.length > 1
      ? `<div class="ad-dots">${ads.map((_, i) => `<span class="ad-dot${i === index ? ' on' : ''}"></span>`).join('')}</div>`
      : '';

    host.innerHTML =
      '<div class="ad-frame">' +
        (current.pic
          ? `<img class="ad-img" src="${esc(current.pic)}" alt="${esc(current.title || '广告')}" loading="lazy" referrerpolicy="no-referrer" />`
          : `<div class="ad-placeholder">${esc(current.title || '广告')}</div>`) +
        '<span class="ad-badge">广告</span>' +
      '</div>' +
      (current.title ? `<div class="ad-title">${esc(current.title)}</div>` : '') +
      (current.text ? `<div class="ad-body">${esc(current.text)}</div>` : '') +
      dots;

    this.startAdRotation(ads.length, ad.rotateSeconds);
  },

  /** Rotate on a timer; only when the slot is visible and on screen. */
  startAdRotation(count, seconds) {
    this.stopAdRotation();
    if (count < 2) return;
    const delay = Math.max(2, Number(seconds) || 6) * 1000;
    this.adTimer = setInterval(() => {
      if (document.hidden) return;
      this.adIndex = ((this.adIndex ?? 0) + 1) % count;
      this.renderAd();
    }, delay);
  },

  stopAdRotation() {
    if (this.adTimer) {
      clearInterval(this.adTimer);
      this.adTimer = null;
    }
  },

  /** Open the ad currently on screen. */
  openCurrentAd() {
    const ads = state.ad?.ads ?? [];
    const ad = ads[this.adIndex ?? 0] ?? ads[0];
    if (ad?.url) api.app.openExternal(ad.url);
  },

  renderProfile() {
    const balance = state.platform?.lastBalance;
    const nameEl = document.getElementById('profile-name');
    const subEl = document.getElementById('profile-sub');
    const avatar = document.getElementById('profile-avatar');
    if (state.platform?.signedIn) {
      nameEl.textContent = '个人信息';
      subEl.textContent = balance ? `余额 ${money(balance.balance, balance.currency)}` : '已登录 DeepSeek 账号';
      avatar.textContent = 'D';
    } else {
      nameEl.textContent = '个人信息';
      subEl.textContent = '登录后可查看余额与充值';
    }
    const brandSub = document.getElementById('brand-sub');
    if (brandSub) {
      brandSub.textContent = state.boot?.phase === 'ready'
        ? (state.boot.reused ? '已连接本地服务' : '本地内核已连接')
        : (state.boot?.label || '正在启动服务');
    }
  },

  renderBalanceChip() {
    const chip = document.getElementById('balance-text');
    const usageChip = document.getElementById('usage-text');
    const separator = document.querySelector('.balance-separator');
    if (!chip || !usageChip) return;
    const balance = state.platform?.lastBalance;
    const usage = state.platform?.lastUsage;
    if (balance) chip.textContent = `余额 ${money(balance.balance, balance.currency)}`;
    else if (state.platform?.signedIn) chip.textContent = '余额 --';
    else chip.textContent = '登录查看余额';
    if (usage) {
      if (separator) separator.hidden = false;
      usageChip.hidden = false;
      usageChip.textContent = `今日 ${money(usage.today?.cost, usage.currency)}`;
      usageChip.title = `${compact(usage.today?.tokens)} tokens · ${compact(usage.today?.requests)} 次请求`;
    } else {
      const showUsage = Boolean(state.platform?.signedIn);
      if (separator) separator.hidden = !showUsage;
      usageChip.hidden = !showUsage;
      usageChip.textContent = showUsage ? '今日 --' : '';
      usageChip.title = '';
    }
  },

  renderModelChip() {
    const nameEl = document.getElementById('model-name');
    const dot = document.getElementById('model-dot');
    const selection = state.selection;
    if (nameEl) nameEl.textContent = selection ? modelLabel(selection.model) : '模型';
    if (dot) dot.className = 'dot' + (state.connection === 'connected' ? ' on' : '');
  },

  renderUpdate() {
    const button = document.getElementById('update-btn');
    if (!button) return;
    const update = state.update ?? {};
    const visible = ['available', 'downloading', 'installing'].includes(update.status);
    button.hidden = !visible;
    button.disabled = update.status === 'downloading' || update.status === 'installing';
    button.textContent = update.status === 'downloading'
      ? `${Math.max(0, Number(update.progress) || 0)}%`
      : update.status === 'installing' ? '安装中' : update.manual ? '下载新版' : '更新';
    button.title = update.availableVersion
      ? `更新到 ${update.availableVersion}${update.error ? `：${update.error}` : ''}`
      : '下载并安装新版本';
  },

  renderChatHeader() {
    const title = document.getElementById('chat-title');
    const sub = document.getElementById('chat-sub');
    const transcript = state.transcript;
    if (!title) return;
    if (!transcript) {
      title.textContent = '新对话';
      sub.textContent = state.ui?.workdir ? `工作目录 ${state.ui.workdir}` : '';
      return;
    }
    title.textContent = transcript.title || state.sessions.find((s) => s.sessionId === transcript.sessionId)?.title || '未命名对话';
    const usage = transcript.usage ?? {};
    const total = (usage.uncachedInputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + (usage.outputTokens ?? 0);
    sub.textContent = state.sessionLoading ? '正在准备对话…' : [
      transcript.approvals?.length ? '等待你的批准' : state.streaming ? '任务运行中 · 可新建其他对话' : '',
      total ? `本会话约 ${compact(total)} tokens` : '',
    ].filter(Boolean).join(' · ');
  },

  renderAll() {
    this.renderSessions();
    this.renderAd();
    this.renderProfile();
    this.renderBalanceChip();
    this.renderModelChip();
    this.renderUpdate();
    this.renderChatHeader();
  },
};

window.Sidebar = Sidebar;
