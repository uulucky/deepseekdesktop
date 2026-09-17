'use strict';
/** Account page: balance, recharge, and the single place where API keys are created and bound. */

const AccountPanel = {
  async load(force = false) {
    const account = state.account;
    if (account.busy && !force) return;
    account.busy = true;
    account.error = null;
    this.render();
    try {
      const [snapshot, keys, credentials] = await Promise.all([
        api.platform.refresh(),
        api.platform.keys(),
        api.credentials.describe(['DEEPSEEK_API_KEY']),
      ]);
      account.summary = snapshot?.needsLogin ? null : snapshot?.summary ?? null;
      account.usage = snapshot?.needsLogin ? null : snapshot?.usage ?? state.platform.lastUsage ?? null;
      account.keys = keys?.needsLogin ? null : keys?.keys ?? null;
      account.needsLogin = Boolean(snapshot?.needsLogin || keys?.needsLogin);
      state.credentials = credentials ?? {};
      if (account.summary) state.platform.lastBalance = account.summary;
      if (account.usage) state.platform.lastUsage = account.usage;
      if (account.keys) state.platform.lastKeys = { keys: account.keys, fetchedAt: Date.now() };
      account.busy = false;
      this.render();
      Sidebar.renderAll();
    } catch (error) {
      account.busy = false;
      const message = error?.message ?? String(error);
      const unauthorized = /unauthorized|请先登录|登录状态已过期/.test(String(error?.code) + message);
      account.needsLogin = unauthorized;
      // Transport failures (offline, WAF, DOM drift) are shown as errors, never as "log in",
      // so a user is not asked to sign in to fix something that is not an auth problem.
      account.error = unauthorized ? null : message;
      this.render();
    }
  },

  render() {
    const body = document.getElementById('modal-body');
    if (!body || state.view.tab !== 'account') return;
    // Platform refreshes can arrive while the user is typing. Preserve the live editor and
    // focus before replacing the card markup so a balance update never makes inputs feel
    // unclickable or erases a pasted secret.
    const editorIds = ['new-key-name', 'manual-key-input'];
    const editorState = Object.fromEntries(editorIds.map((id) => {
      const node = document.getElementById(id);
      return [id, node ? { value: node.value, start: node.selectionStart, end: node.selectionEnd } : null];
    }));
    const focusedId = editorIds.includes(document.activeElement?.id) ? document.activeElement.id : null;
    const scrollTop = body.scrollTop;
    const account = state.account;
    const summary = account.summary;
    const credential = state.credentials?.DEEPSEEK_API_KEY;
    const keys = account.keys ?? [];

    const balanceCard = summary
      ? `<div class="card">
           <div class="card-head">
             <div>
               <div class="card-title">账户余额</div>
               <div class="card-sub">数据来自 DeepSeek 开放平台，${esc(new Date(summary.fetchedAt).toLocaleTimeString('zh-CN'))} 更新 · 每 10 分钟自动刷新</div>
             </div>
             <button class="btn small" data-action="refresh-account">刷新</button>
           </div>
           <div class="balance-amount">${money(summary.balance, summary.currency)}</div>
           <div class="balance-meta">
             <span>预计可用 ${compact(summary.tokenEstimation)} tokens</span>
             ${summary.wallets?.filter((w) => w.wallet === 'bonus').length ? `<span>赠送余额 ${money(summary.wallets.find((w) => w.wallet === 'bonus').balance, summary.currency)}</span>` : ''}
           </div>
           <div class="row" style="margin-top:14px">
             <button class="btn primary" data-action="recharge">充值</button>
             <button class="btn" data-action="usage">用量明细</button>
             <div class="spacer"></div>
             <button class="btn small danger" data-action="logout">退出登录</button>
           </div>
         </div>`
      : `<div class="card">
           <div class="card-head">
             <div>
               <div class="card-title">登录 DeepSeek 账号</div>
               <div class="card-sub">在应用内登录一次，即可查看余额、充值并生成 API Key</div>
             </div>
           </div>
           ${account.error ? `<div class="banner err">${esc(account.error)}</div>` : ''}
           <div class="row">
             <button class="btn primary" data-action="login">在应用内登录 / 注册</button>
             <span class="hint">登录页面在软件内打开，不会跳转到浏览器。</span>
           </div>
         </div>`;

    const keyCard = `<div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">API Key</div>
            <div class="card-sub">生成与使用都在这里完成，不需要去网页来回切换</div>
          </div>
          <span class="badge ${credential?.configured ? 'ok' : 'warn'}">${credential?.configured ? '已配置到本地内核' : '尚未配置'}</span>
        </div>
        ${account.revealed ? `<div class="banner ${account.revealed.applied ? 'warn' : 'err'}">
            ${account.revealed.applied
              ? '新 Key 只显示这一次，已经自动写入本地内核：'
              : `新 Key 已生成，但自动配置尚未完成：${esc(account.revealed.applyError || '本地服务暂未确认写入')}<br>请先复制保存，再点击“重试自动配置”。`}
            <div class="secret-box" id="revealed-key">${esc(account.revealed.secret)}</div>
            <button class="btn small" data-action="copy-revealed" style="margin-top:8px">复制</button>
            ${account.revealed.applied ? '' : '<button class="btn small" data-action="retry-revealed" style="margin-top:8px">重试自动配置</button>'}
           </div>` : ''}
        ${account.needsLogin ? '<div class="banner warn">登录账号后即可在这里查看和生成 API Key。</div>' : ''}
        ${account.error ? `<div class="banner err">暂时无法读取平台数据：${esc(account.error)}<button class="btn small" data-action="refresh-account" style="margin-left:auto">重试</button></div>` : ''}
        ${keys.length ? `<div class="key-list">${keys.map((key) => `
          <div class="key-row">
            <div style="min-width:0">
              <div class="key-name">${esc(key.name || '默认')}</div>
              <div class="key-value">${esc(key.maskedKey || '')}</div>
              <div class="hint">创建于 ${esc(key.createdAt ? new Date(key.createdAt).toLocaleDateString('zh-CN') : '未知')} · 最近使用 ${esc(key.lastUsed ? relativeTime(key.lastUsed) : '从未使用')}</div>
            </div>
            <div class="spacer"></div>
            <button class="btn small" data-action="use-key" data-name="${esc(key.name || '')}">粘贴完整 Key</button>
            <button class="btn small danger" data-action="delete-key" data-name="${esc(key.name || '')}" data-masked="${esc(key.maskedKey || '')}" data-created="${esc(String(key.createdAt ?? ''))}" data-tracking="${esc(key.trackingId || '')}">删除</button>
          </div>`).join('')}</div>` : (account.needsLogin ? '' : '<div class="hint">还没有 API Key。</div>')}
        <div class="row" style="margin-top:14px">
          <input class="input" id="new-key-name" placeholder="新 Key 名称（留空自动生成）" style="max-width:260px" ${account.needsLogin ? 'disabled' : ''} />
          <button class="btn primary" data-action="create-key" ${account.needsLogin ? 'disabled' : ''}>生成并使用新 Key</button>
        </div>
        <div class="hint">生成后会自动写入本地内核（DEEPSEEK_API_KEY）。平台不会再次返回已有 Key 的完整内容。</div>
        <div class="field" style="margin-top:16px">
          <label>使用已有 Key</label>
          <div class="row">
            <input class="input" id="manual-key-input" type="password" autocomplete="off" placeholder="粘贴完整 DeepSeek API Key（sk-…）" />
            <button class="btn" data-action="manual-key">验证并写入本地内核</button>
          </div>
          <div class="hint">客户端会先向 DeepSeek 官方余额接口验证，再确认本地内核已成功保存。</div>
        </div>
      </div>`;

    body.innerHTML = balanceCard + keyCard + this.renderUsageCard();
    for (const id of editorIds) {
      const saved = editorState[id];
      const node = document.getElementById(id);
      if (saved && node) node.value = saved.value;
    }
    body.scrollTop = scrollTop;
    if (focusedId) requestAnimationFrame(() => {
      const node = document.getElementById(focusedId);
      const saved = editorState[focusedId];
      if (!node || !saved) return;
      node.focus({ preventScroll: true });
      try { node.setSelectionRange(saved.start, saved.end); } catch { /* unsupported input */ }
    });
  },

  renderUsageCard() {
    const summary = state.account.summary;
    if (!summary) return '';
    const usage = state.account.usage;
    if (!usage) {
      return `<div class="card">
        <div class="card-head"><div><div class="card-title">今日用量</div><div class="card-sub">详细用量暂时不可用，余额仍会照常刷新</div></div></div>
      </div>`;
    }
    const periodLabel = usage.period?.kind === 'currentMonth' ? '本月' : '近 30 天';
    return `<div class="card">
      <div class="card-head">
        <div><div class="card-title">今日用量</div><div class="card-sub">按本机时区统计 · ${esc(new Date(usage.fetchedAt).toLocaleTimeString('zh-CN'))} 更新</div></div>
        ${usage.topModel ? `<span class="badge">主要模型 ${esc(usage.topModel)}</span>` : ''}
      </div>
      <div class="usage-summary">
        <div class="usage-stat"><div class="usage-stat-label">今日费用</div><div class="usage-stat-value">${money(usage.today?.cost, usage.currency)}</div><div class="usage-stat-sub">${periodLabel} ${money(usage.period?.cost, usage.currency)}</div></div>
        <div class="usage-stat"><div class="usage-stat-label">今日 Tokens</div><div class="usage-stat-value">${compact(usage.today?.tokens)}</div><div class="usage-stat-sub">${periodLabel} ${compact(usage.period?.tokens)}</div></div>
        <div class="usage-stat"><div class="usage-stat-label">今日请求</div><div class="usage-stat-value">${compact(usage.today?.requests)}</div><div class="usage-stat-sub">${periodLabel} ${compact(usage.period?.requests)}</div></div>
      </div>
    </div>`;
  },

  /** Delegated click handling for the account tab. */
  async onClick(target) {
    const action = target.closest?.('[data-action]')?.getAttribute('data-action');
    if (!action) return false;
    const account = state.account;
    if (action === 'refresh-account') { await this.load(true); return true; }
    if (action === 'login') {
      await api.platform.login();
      toast('请在应用内完成登录');
      return true;
    }
    if (action === 'logout') {
      await guard(api.platform.logout(), '退出登录');
      state.account.summary = null;
      state.account.usage = null;
      state.account.keys = null;
      state.platform.signedIn = false;
      state.platform.lastBalance = null;
      state.platform.lastUsage = null;
      this.render();
      Sidebar.renderAll();
      return true;
    }
    if (action === 'recharge') {
      await api.platform.recharge();
      toast('已打开官方充值页面');
      return true;
    }
    if (action === 'usage') { await api.platform.usage(); return true; }
    if (action === 'create-key') {
      const name = document.getElementById('new-key-name')?.value?.trim() || null;
      account.busy = true;
      this.render();
      const result = await guard(api.platform.createKey(name), '生成 API Key');
      account.busy = false;
      if (result?.created) {
        account.revealed = result.created;
        await this.load(true);
        toast(result.created.applied ? '已生成并写入本地内核' : 'Key 已生成，请保存并重试自动配置', result.created.applied ? 'ok' : 'err');
      } else {
        this.render();
      }
      return true;
    }
    if (action === 'copy-revealed') {
      await api.app.copy(account.revealed?.secret ?? '');
      toast('已复制', 'ok');
      return true;
    }
    if (action === 'retry-revealed') {
      const secret = account.revealed?.secret;
      if (!secret) return true;
      const applied = await guard(api.credentials.set('DEEPSEEK_API_KEY', secret), '自动配置失败');
      if (!applied?.configured) return true;
      account.revealed = { ...account.revealed, applied: true, applyError: null };
      toast('已写入本地内核', 'ok');
      await this.load(true);
      return true;
    }
    if (action === 'delete-key') {
      const node = target.closest('[data-action]');
      const confirmed = await api.app.info().then(() => window.confirm(`删除 API Key “${node.getAttribute('data-name') || ''}”？`));
      if (!confirmed) return true;
      await guard(api.platform.deleteKey({
        maskedKey: node.getAttribute('data-masked'),
        createdAt: Number(node.getAttribute('data-created')) || null,
        trackingId: node.getAttribute('data-tracking'),
      }), '删除 API Key');
      await this.load(true);
      return true;
    }
    if (action === 'use-key') {
      const input = document.getElementById('manual-key-input');
      input?.focus();
      input?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      toast('平台只显示已有 Key 的脱敏值，请粘贴原始完整 Key');
      return true;
    }
    if (action === 'manual-key') {
      const input = document.getElementById('manual-key-input');
      const secret = input?.value?.trim();
      if (!secret) { toast('请粘贴完整 API Key', 'err'); input?.focus(); return true; }
      const applied = await guard(api.credentials.set('DEEPSEEK_API_KEY', secret), '验证并写入 Key');
      if (!applied?.configured) return true;
      input.value = '';
      toast('已验证并写入本地内核', 'ok');
      await this.load(true);
      return true;
    }
    return false;
  },
};

window.AccountPanel = AccountPanel;
