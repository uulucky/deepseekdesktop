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
    if (heading) heading.textContent = activeCount ? `对话 · ${activeCount} 个任务进行中` : '对话';
    if (!sessions.length) {
      list.innerHTML = '<div class="session-empty">还没有对话，点击“新建对话”开始。</div>';
      return;
    }
    list.innerHTML = sessions.map((session) => {
      const { view, waiting, running } = taskState(session);
      const title = esc(view?.transcript?.title || session.title || '新对话');
      const active = session.sessionId === state.activeSessionId ? ' active' : '';
      const label = waiting ? '待批准' : view?.stopping ? '停止中' : running ? '运行中' : view?.unread ? '已完成' : relativeTime(session.updatedAt);
      const statusClass = waiting ? ' waiting' : running ? ' running' : view?.unread ? ' unread' : '';
      return (
        `<button class="session-item${active}" data-session="${esc(session.sessionId)}" title="${title}">` +
        (running ? '<span class="s-run" aria-hidden="true"></span>' : '') +
        `<span class="s-title">${title}</span>` +
        `<span class="s-meta${statusClass}">${esc(label)}</span>` +
        '</button>'
      );
    }).join('');
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
      : update.status === 'installing' ? '安装中' : '更新';
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
