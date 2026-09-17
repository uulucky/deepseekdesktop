'use strict';
/** Settings modal — account, model, appearance and runtime controls. */

const TABS = [
  { id: 'account', label: '账号与 API Key' },
  { id: 'models', label: '模型' },
  { id: 'general', label: '通用' },
  { id: 'about', label: '关于' },
];

const Settings = {
  async open(tab = 'account') {
    state.view.modal = true;
    state.view.tab = tab;
    document.getElementById('modal-backdrop').hidden = false;
    this.renderTabs();
    await this.renderBody();
  },

  close() {
    state.view.modal = false;
    document.getElementById('modal-backdrop').hidden = true;
  },

  renderTabs() {
    const host = document.getElementById('modal-tabs');
    host.innerHTML = TABS.map((tab) =>
      `<button class="tab${state.view.tab === tab.id ? ' active' : ''}" data-tab="${tab.id}">${tab.label}</button>`).join('');
  },

  async renderBody() {
    const body = document.getElementById('modal-body');
    body.innerHTML = '<div class="center"><div class="spin"></div>正在加载…</div>';
    try {
      if (state.view.tab === 'account') return await AccountPanel.load();
      if (state.view.tab === 'models') return await this.renderModels();
      if (state.view.tab === 'general') return await this.renderGeneral();
      return this.renderAbout();
    } catch (error) {
      body.innerHTML = `<div class="banner err">加载失败：${esc(error?.message ?? error)}</div>`;
    }
  },

  // ------------------------------------------------------------------- models
  async renderModels() {
    const body = document.getElementById('modal-body');
    const catalog = state.catalog;
    const registry = state.registry?.registry ?? [];
    const catalogNote = catalog
      ? `官方模型表 · 更新于 ${esc(new Date(catalog.fetchedAt).toLocaleString('zh-CN'))}`
      : '尚未获取官方模型表（每天首次打开软件时自动更新）';

    const cards = registry.map((group) => `
      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">${esc(group.name || group.id)}</div>
            <div class="card-sub">${esc(catalogNote)}</div>
          </div>
        </div>
        <div class="key-list">
          ${(group.models ?? []).map((model) => {
            const official = officialModel(model.id);
            const tiers = official?.pricing?.tiers ?? {};
            const price = (key) => tiers[key] === undefined ? '--' : `${tiers[key]} 元`;
            const selected = state.selection?.model === model.id;
            return `<div class="key-row" style="flex-direction:column;align-items:stretch;gap:8px">
              <div class="row">
                <div>
                  <div class="key-name">${esc(model.name || model.id)} ${selected ? '<span class="badge ok">当前</span>' : ''}</div>
                  <div class="key-value">${esc(model.id)}${official?.version ? ' · ' + esc(official.version) : ''}</div>
                </div>
                <div class="spacer"></div>
                <button class="btn small" data-action="use-model" data-model="${esc(model.id)}" data-provider="${esc(group.id)}">设为默认</button>
              </div>
              ${official ? `<div class="pricing-grid">
                <div class="h">百万 tokens</div><div class="h">空闲时段</div><div class="h">高峰时段</div>
                <div>输入（缓存命中）</div><div class="v">${price('inputCacheHit.offPeak')}</div><div class="v">${price('inputCacheHit.peak')}</div>
                <div>输入（缓存未命中）</div><div class="v">${price('inputCacheMiss.offPeak')}</div><div class="v">${price('inputCacheMiss.peak')}</div>
                <div>输出</div><div class="v">${price('output.offPeak')}</div><div class="v">${price('output.peak')}</div>
              </div>
              <div class="hint">上下文 ${esc(official.contextWindow || '--')} · 输出上限 ${esc(official.maxOutput || '--')}${official.concurrency ? ' · 并发 ' + esc(String(official.concurrency)) : ''} · 图像理解 ${esc(official.features?.['图像理解'] || '--')}</div>` : ''}
            </div>`;
          }).join('')}
        </div>
      </div>`).join('');

    body.innerHTML = `
      ${catalog?.models?.length ? `<div class="banner">${esc(catalogNote)} · 来源 api-docs.deepseek.com</div>` : `<div class="banner warn">还没有官方模型表，点击“立即更新”获取。</div>`}
      <div class="row" style="margin-bottom:12px">
        <button class="btn" data-action="sync-catalog">立即更新模型表</button>
      </div>
      ${cards || '<div class="banner warn">本地内核没有返回可用模型。</div>'}
      <div class="card">
        <div class="card-head"><div class="card-title">思考程度</div></div>
        <div class="row" id="effort-row">
          ${['off', 'low', 'high', 'max'].map((effort) => `<button class="effort ${state.selection?.reasoningEffort === effort ? 'active' : ''}" data-action="set-effort" data-effort="${effort}">${({ off: '关闭', low: '低', high: '高', max: '最大' })[effort]}</button>`).join('')}
        </div>
        <div class="hint">思考程度越高，回答质量越好但耗时更长、消耗更多 tokens。</div>
      </div>`;
  },

  // ------------------------------------------------------------------ general
  async renderGeneral() {
    const body = document.getElementById('modal-body');
    const ui = state.ui ?? {};
    if (state.kernelSource === undefined) state.kernelSource = await api.settings.kernelSource().catch(() => null);
    const credential = state.credentials?.DEEPSEEK_API_KEY;
    const preset = state.registry?.registry?.[0]?.id ?? 'deepseek-official';
    body.innerHTML = `
      <div class="card">
        <div class="card-head"><div><div class="card-title">外观</div><div class="card-sub">原来的设置项，重新排版</div></div></div>
        <div class="field">
          <label>主题</label>
          <select class="input" id="ui-theme">
            <option value="dark" ${ui.theme !== 'light' ? 'selected' : ''}>深色</option>
            <option value="light" ${ui.theme === 'light' ? 'selected' : ''}>浅色</option>
          </select>
        </div>
        <div class="field">
          <label class="switch"><input type="checkbox" id="ui-sidebar" ${ui.sidebarVisible === false ? '' : 'checked'} /> 显示左侧对话栏</label>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div><div class="card-title">工作目录</div><div class="card-sub">DeepSeek 会在这里读取和修改文件</div></div></div>
        <div class="field">
          <input class="input" id="ui-workdir" value="${esc(ui.workdir || '')}" placeholder="默认使用用户主目录" />
          <div class="hint">留空表示使用系统主目录。修改后新建的对话生效。</div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div><div class="card-title">API Key</div><div class="card-sub">写入本地内核的凭据（DEEPSEEK_API_KEY）</div></div>
          <span class="badge ${credential?.configured ? 'ok' : 'warn'}">${credential?.configured ? '已配置' : '未配置'}</span>
        </div>
        <div class="field">
          <input class="input" id="api-key-input" type="password" placeholder="sk-…" />
          <div class="hint">保存后立即生效，不会写入任何第三方服务器。在“账号与 API Key”里可以一键生成。</div>
        </div>
        <div class="row">
          <button class="btn primary" data-action="save-key">保存 Key</button>
          <button class="btn danger" data-action="clear-key" ${credential?.configured ? '' : 'disabled'}>清除 Key</button>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div><div class="card-title">对话默认设置</div><div class="card-sub">应用在本地内核上的默认选择</div></div></div>
        <div class="field">
          <label>默认模型</label>
          <select class="input" id="default-model">
            ${(state.registry?.registry ?? []).flatMap((group) => (group.models ?? []).map((model) =>
              `<option value="${esc(group.id)}|${esc(model.id)}" ${state.selection?.model === model.id ? 'selected' : ''}>${esc(model.name || model.id)}</option>`)).join('')}
          </select>
        </div>
        <div class="field">
          <label>默认工作模式</label>
          <select class="input" id="default-preset">
            <option value="standard" ${(ui.agentPreset ?? 'standard') === 'standard' ? 'selected' : ''}>标准（推荐，工具+文件）</option>
            <option value="code" ${ui.agentPreset === 'code' ? 'selected' : ''}>代码（更偏向修改项目）</option>
          </select>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div><div class="card-title">内核安装 / 更新包</div><div class="card-sub">网络受限时用本地包启动，一次生效</div></div>
        </div>
        <div class="field">
          <input class="input" id="kernel-source" value="${esc(state.kernelSource || '')}" placeholder="例如 D:\\pkg\\dsh-0.1.0-rc.7.tgz 或 D:\\pkg\\dsh" />
          <div class="hint">填写本地安装包（.tgz）或已解压目录后重启软件：下次启动会从这个位置安装内核组件，然后自动清除该设置，不会锁定版本。留空表示保持默认。</div>
        </div>
        <div class="row">
          <button class="btn" data-action="save-kernel-source">保存</button>
          <span class="hint" id="kernel-source-state">${state.kernelSource ? '已设置，将在下次启动时使用' : '当前使用默认来源'}</span>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div><div class="card-title">运行日志</div><div class="card-sub">本地内核与启动过程</div></div></div>
        <div class="log-box" id="log-box">${esc((state.world?.journal ?? []).join('\n') || '暂无日志')}</div>
        <div class="row" style="margin-top:10px">
          <button class="btn small" data-action="open-log">打开日志文件</button>
          <button class="btn small" data-action="reload-log">刷新</button>
        </div>
      </div>`;
    void preset;
  },

  // -------------------------------------------------------------------- about
  renderAbout() {
    const body = document.getElementById('modal-body');
    const world = state.world ?? {};
    const boot = state.boot ?? {};
    const update = state.update ?? {};
    const updateLabel = ({
      idle: '等待自动检查', checking: '正在检查…', current: '当前已是最新版本',
      available: `发现新版本 ${update.availableVersion || ''}`,
      downloading: `正在下载 ${Number(update.progress) || 0}%`, installing: '正在安装并准备重启…',
      error: `检查失败：${update.error || '未知错误'}`,
    })[update.status] || '等待自动检查';
    body.innerHTML = `
      <div class="card">
        <div class="card-head">
          <div><div class="card-title">软件更新</div><div class="card-sub">${esc(updateLabel)} · 每小时自动检查一次</div></div>
          ${update.status === 'available' ? `<button class="btn primary" data-action="install-update">更新到 ${esc(update.availableVersion || '')}</button>` : ''}
        </div>
        ${update.error && update.status === 'available' ? `<div class="banner warn">上次检查：${esc(update.error)}，仍可安装已发现的版本。</div>` : ''}
        <div class="row">
          <button class="btn small" data-action="check-update" ${['checking', 'downloading', 'installing'].includes(update.status) ? 'disabled' : ''}>立即检查</button>
          <span class="hint">更新只替换程序文件，登录信息、本地对话与设置所在的 data 目录会完整保留。</span>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><div><div class="card-title">DeepSeek 桌面客户端</div><div class="card-sub">版本 ${esc(world.version || '0.1.0')}</div></div></div>
        <div class="kv">
          <div class="k">本地服务地址</div><div class="mono">${esc(state.baseUrl || '未启动')}</div>
          <div class="k">服务来源</div><div>${boot.ownership === 'app' ? '由本应用启动' : boot.reused ? '复用已在运行的服务' : '未知'}</div>
          <div class="k">运行方式</div><div>${world.portable ? '便携版（绿色，数据在软件目录内）' : '安装版（数据在用户目录）'}</div>
          <div class="k">数据目录</div><div class="mono">${esc(world.dataDir || '')}</div>
          <div class="k">日志文件</div><div class="mono">${esc(world.logFile || '')}</div>
          <div class="k">系统</div><div>${esc(world.platformName || '')} / ${esc(world.arch || '')}</div>
          <div class="k">模型表来源</div><div class="mono">api-docs.deepseek.com/zh-cn/quick_start/pricing</div>
          <div class="k">问题反馈</div><div><button class="feedback-email" data-action="feedback-email">489583561@qq.com</button></div>
        </div>
        <div class="row" style="margin-top:14px">
          <button class="btn small" data-action="open-log">打开日志</button>
          <button class="btn small" data-action="open-data">打开数据目录</button>
          <button class="btn small" data-action="restart-boot">重启本地服务</button>
        </div>
      </div>`;
  },

  /** Delegated click handling for the settings tabs. */
  async onClick(target) {
    const tabButton = target.closest?.('[data-tab]');
    if (tabButton) {
      state.view.tab = tabButton.getAttribute('data-tab');
      this.renderTabs();
      await this.renderBody();
      return true;
    }
    const action = target.closest?.('[data-action]')?.getAttribute('data-action');
    if (!action) return false;
    switch (action) {
      case 'sync-catalog': {
        toast('正在从官网更新模型表…');
        const snapshot = await guard(api.llm.syncCatalog(), '更新失败');
        if (snapshot) {
          state.catalog = snapshot;
          toast(`模型表已更新（${snapshot.models.length} 个模型）`, 'ok');
        }
        await this.renderBody();
        return true;
      }
      case 'use-model': {
        const node = target.closest('[data-action]');
        const provider = node.getAttribute('data-provider');
        const model = node.getAttribute('data-model');
        const targetModel = App.reasoningOptions(provider, model);
        const ids = targetModel.efforts.map((entry) => entry.id);
        const effort = ids.includes(state.selection?.reasoningEffort)
          ? state.selection.reasoningEffort
          : (ids.includes(targetModel.defaultEffort) ? targetModel.defaultEffort : ids[0]);
        const changed = await App.chooseSelection(provider, model, effort, '切换模型');
        await this.renderBody();
        if (changed) toast(state.activeSessionId ? '已切换模型' : '已设为新对话默认模型', 'ok');
        return true;
      }
      case 'set-effort': {
        const effort = target.closest('[data-action]').getAttribute('data-effort');
        await App.chooseSelection(state.selection?.provider, state.selection?.model, effort, '设置思考程度');
        await this.renderBody();
        return true;
      }
      case 'save-key': {
        const value = document.getElementById('api-key-input')?.value?.trim();
        if (!value) { toast('请输入 API Key', 'err'); return true; }
        const applied = await guard(api.credentials.set('DEEPSEEK_API_KEY', value), '验证并保存失败');
        if (!applied?.configured) return true;
        toast('已保存', 'ok');
        await App.refreshCredentials();
        await this.renderBody();
        return true;
      }
      case 'check-update': {
        const update = await guard(api.update.check(), '检查更新失败');
        if (update) {
          state.update = { ...state.update, ...update };
          if (update.status === 'current') toast('当前已是最新版本', 'ok');
          else if (update.status === 'available') toast(`发现新版本 ${update.availableVersion}`, 'ok');
        }
        this.renderAbout();
        Sidebar.renderUpdate();
        return true;
      }
      case 'install-update': {
        await App.installUpdate();
        return true;
      }
      case 'clear-key': {
        await guard(api.credentials.unset('DEEPSEEK_API_KEY'), '清除失败');
        await App.refreshCredentials();
        await this.renderBody();
        return true;
      }
      case 'save-kernel-source': {
        const value = document.getElementById('kernel-source')?.value?.trim() ?? '';
        state.kernelSource = await guard(api.settings.setKernelSource(value), '保存失败');
        const label = document.getElementById('kernel-source-state');
        if (label) label.textContent = state.kernelSource ? '已设置，将在下次启动时使用' : '当前使用默认来源';
        toast(state.kernelSource ? '已保存，重启后生效' : '已清除', 'ok');
        return true;
      }
      case 'open-log': {
        const world = state.world ?? {};
        if (world.logFile) await api.app.openPath(world.logFile);
        return true;
      }
      case 'open-data': {
        const world = state.world ?? {};
        if (world.dataDir) await api.app.openPath(world.dataDir);
        return true;
      }
      case 'feedback-email': {
        await guard(api.app.openExternal('mailto:489583561@qq.com'), '打开邮件客户端失败');
        return true;
      }
      case 'reload-log':
      case 'restart-boot': {
        if (action === 'restart-boot') {
          toast('正在重启本地服务…');
          state.boot = await guard(api.app.retryBoot(), '重启失败');
        } else {
          state.world = await api.app.world();
        }
        await this.renderBody();
        return true;
      }
      default:
        return AccountPanel.onClick(target);
    }
  },

  /** Persist the general-tab fields (called on input change). */
  async onGeneralChange(target) {
    if (!target?.id) return false;
    if (target.id === 'ui-theme') {
      state.ui = await api.settings.setUi({ theme: target.value });
      document.documentElement.dataset.theme = state.ui.theme === 'light' ? 'light' : 'dark';
      return true;
    }
    if (target.id === 'ui-sidebar') {
      state.ui = await api.settings.setUi({ sidebarVisible: target.checked });
      document.getElementById('app').classList.toggle('rail-hidden', !target.checked);
      return true;
    }
    if (target.id === 'ui-workdir') {
      state.ui = await api.settings.setUi({ workdir: target.value.trim() });
      toast('工作目录已保存', 'ok');
      return true;
    }
    if (target.id === 'default-model') {
      const [provider, model] = target.value.split('|');
      state.ui = await api.settings.setUi({ defaultProvider: provider, defaultModel: model });
      const targetModel = App.reasoningOptions(provider, model);
      const effort = targetModel.defaultEffort ?? targetModel.efforts[0]?.id;
      await App.chooseSelection(provider, model, effort, '切换模型');
      return true;
    }
    if (target.id === 'default-preset') {
      state.ui = await api.settings.setUi({ agentPreset: target.value });
      return true;
    }
    return false;
  },
};

window.Settings = Settings;
