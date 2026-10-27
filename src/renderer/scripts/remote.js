'use strict';
/**
 * Settings → 手机连接 and the "手机已连接" chip in the title bar. All decisions (turning the
 * remote on, pairing, revoking, the permission ceiling) are made here on the computer; the
 * phone has no way to change any of them.
 */

const PERMISSION_LABELS = {
  'read-only': '只读：只能看，不能改文件或执行命令',
  'workspace-write': '工作区可写：可改工作目录里的文件（推荐）',
  'danger-full-access': 'Full Access：每次需手机指纹/面容验证，仅当前对话',
};

const STATUS_LABELS = {
  off: '未开启',
  starting: '正在启动…',
  ready: '等待配对',
  joining: '正在连接…',
  online: '在线',
  error: '出错了',
};

const RemoteView = {
  async load() {
    try { state.remote = await api.remote.status(); } catch { state.remote = null; }
    this.renderChip();
  },

  receive(snapshot) {
    state.remote = snapshot;
    this.renderChip();
    if (state.view.modal && state.view.tab === 'phone') this.render();
  },

  connectedPhones() {
    return (state.remote?.connected ?? []).filter((entry) => entry.connected);
  },

  renderChip() {
    const chip = document.getElementById('remote-chip');
    if (!chip) return;
    const phones = this.connectedPhones();
    chip.hidden = phones.length === 0;
    chip.querySelector('span').textContent = phones.length === 1
      ? `手机已连接：${phones[0].phone}`
      : `${phones.length} 部手机已连接`;
  },

  render() {
    const body = document.getElementById('modal-body');
    const remote = state.remote;
    if (!remote) {
      body.innerHTML = '<div class="banner err">无法读取手机连接状态</div>';
      return;
    }
    const invite = remote.invite;
    const seconds = invite ? Math.max(0, Math.round(invite.expiresAt - Date.now() / 1000)) : 0;
    const inviteCard = invite ? `
      <div class="card">
        <div class="card-head"><div>
          <div class="card-title">${invite.kind === 'computer' ? '用 dmuse 扫码连接这台电脑' : '用 dmuse 扫码添加一部手机'}</div>
          <div class="card-sub">二维码 ${Math.ceil(seconds / 60)} 分钟内有效，只能用一次</div>
        </div></div>
        <div class="phone-qr"><img alt="配对二维码" src="data:image/svg+xml;base64,${btoa(invite.svg)}" /></div>
        ${invite.code ? `<div class="hint">扫不了码时，在手机上手动输入：<code class="phone-code">${esc(invite.code)}</code></div>` : ''}
        <div class="row" style="margin-top:10px"><button class="btn small" data-action="phone-cancel-pair">取消</button></div>
      </div>` : '';
    const connected = new Map(this.connectedPhones().map((entry) => [entry.phone, entry]));
    const phones = (remote.phones ?? []).map((phone) => `
      <div class="row phone-row">
        <span class="phone-name">${esc(phone)}</span>
        <span class="hint">${connected.has(phone) ? '已连接' : '未连接'}</span>
        <button class="btn small danger" data-action="phone-revoke" data-phone="${esc(phone)}">撤销</button>
      </div>`).join('') || '<div class="hint">还没有配对的手机。</div>';
    body.innerHTML = `
      <div class="card">
        <div class="card-head"><div>
          <div class="card-title">用手机指挥这台电脑</div>
          <div class="card-sub">在手机上安装 dmuse，扫码后就能远程派任务、看进度、批准操作。任务始终在这台电脑上运行。</div>
        </div></div>
        <div class="field">
          <label class="switch"><input type="checkbox" id="remote-enabled" ${remote.enabled ? 'checked' : ''} ${remote.available ? '' : 'disabled'} /> 允许手机连接</label>
          <div class="hint">${remote.available ? `状态：${esc(STATUS_LABELS[remote.status] ?? remote.status)}${remote.error ? ` · ${esc(remote.error)}` : ''}` : '这个版本没有带手机连接组件。'}</div>
          <div class="hint">手机和电脑之间走加密的私有网络（Celium），电脑不开放局域网或公网端口。dmuse 不是 DeepSeek 官方产品。</div>
        </div>
        ${remote.enabled ? `<div class="row"><button class="btn primary small" data-action="phone-pair" ${remote.status === 'starting' || remote.status === 'off' ? 'disabled' : ''}>${remote.joined ? '添加手机' : '显示配对二维码'}</button></div>` : ''}
        ${remote.guard ? '' : '<div class="banner err" style="margin-top:10px">安全护栏已关闭：手机暂时不能发起任务或批准操作。到「通用 → 安全护栏」重新开启。</div>'}
      </div>
      ${inviteCard}
      <div class="card">
        <div class="card-head"><div><div class="card-title">手机最高可用权限</div><div class="card-sub">手机发起或操作的对话，权限不会超过这里的设置。只能在电脑上修改。</div></div></div>
        <div class="field">
          <select class="input" id="remote-max-permission">
            ${Object.entries(PERMISSION_LABELS).map(([value, label]) => `<option value="${value}" ${remote.maxPermission === value ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
          <div class="hint">手机上不能修改设置、扩展、MCP、API Key，也不能充值或关闭安全护栏。</div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><div><div class="card-title">已配对的手机</div><div class="card-sub">手机丢了就在这里撤销，它会立即断开且不能再连接</div></div></div>
        ${phones}
      </div>`;
  },

  async onClick(target) {
    const action = target.closest?.('[data-action]')?.getAttribute('data-action');
    if (!action?.startsWith('phone-')) return false;
    if (action === 'phone-pair') state.remote = (await guard(api.remote.pair(), '无法生成二维码')) ?? state.remote;
    if (action === 'phone-cancel-pair') state.remote = (await guard(api.remote.cancelPair(), '操作失败')) ?? state.remote;
    if (action === 'phone-revoke') {
      const phone = target.closest('[data-phone]').getAttribute('data-phone');
      state.remote = (await guard(api.remote.revoke(phone), '撤销失败')) ?? state.remote;
      toast(`已撤销 ${phone}`, 'ok');
    }
    this.render();
    return true;
  },

  async onChange(target) {
    if (target?.id === 'remote-enabled') {
      state.remote = (await guard(api.remote.setEnabled(target.checked), '操作失败')) ?? state.remote;
      this.render();
      return true;
    }
    if (target?.id === 'remote-max-permission') {
      state.remote = (await guard(api.remote.setMaxPermission(target.value), '保存失败')) ?? state.remote;
      toast('已保存手机最高可用权限', 'ok');
      return true;
    }
    return false;
  },
};

window.RemoteView = RemoteView;
