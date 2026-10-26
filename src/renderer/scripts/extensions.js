'use strict';
/** Settings › Extensions — reuse local Agent Skills and connect MCP servers. */

const ExtensionsPanel = {
  skills: null,
  mcp: null,
  filter: '',
  restartNeeded: false,

  async render() {
    const body = document.getElementById('modal-body');
    const [skills, mcp] = await Promise.all([
      guard(api.extensions.skills(), '读取技能'),
      guard(api.extensions.mcp(), '读取 MCP 服务器'),
    ]);
    this.skills = skills ?? { skills: [], localOnly: [], folder: '' };
    this.mcp = mcp ?? { servers: [], presets: [] };
    const banner = this.restartNeeded
      ? '<div class="banner warn">MCP 或插件设置已更改，重启本地服务后生效。<button class="btn small primary" data-action="restart-boot">立即重启本地服务</button></div>'
      : '';
    body.innerHTML = `${banner}${this.skillsCard()}${this.mcpCard()}${typeof PluginCenter !== 'undefined' ? await PluginCenter.card() : ''}`;
  },

  skillsCard() {
    const { skills, localOnly, folder } = this.skills;
    const enabled = skills.filter((skill) => skill.enabled).length;
    const query = this.filter.trim().toLowerCase();
    const shown = query
      ? skills.filter((skill) => `${skill.name} ${skill.description} ${skill.source}`.toLowerCase().includes(query))
      : skills;
    const rows = shown.map((skill) => `
      <label class="ext-row">
        <input type="checkbox" data-skill="${esc(skill.id)}" ${skill.enabled ? 'checked' : ''} />
        <span class="ext-main">
          <span class="ext-name">${esc(skill.name)} <span class="ext-source">${esc(skill.source)}</span></span>
          <span class="ext-desc">${esc(skill.description || '（没有描述）')}</span>
        </span>
      </label>`).join('');
    return `
      <div class="card">
        <div class="card-head">
          <div><div class="card-title">技能（Skills）</div><div class="card-sub">直接复用你在 Claude、Codex 里已有的技能，勾选后立即可用</div></div>
          <span class="badge ${enabled ? 'ok' : ''}">已启用 ${enabled}</span>
        </div>
        ${skills.length ? `
          <div class="field"><input class="input" id="ext-skill-filter" type="search" placeholder="搜索技能名称或描述" value="${esc(this.filter)}" /></div>
          <div class="ext-list">${rows || '<div class="hint">没有匹配的技能</div>'}</div>` : `
          <div class="hint">没有在 ~/.claude/skills、~/.codex/skills 或 Codex 插件里找到技能。</div>`}
        ${localOnly.length ? `<div class="hint">技能文件夹里还有你自己放入的：${localOnly.map(esc).join('、')}（始终启用）。</div>` : ''}
        <div class="hint">启用只是在技能文件夹里放一个指向原目录的链接，不会复制或修改原技能；停用只删除这个链接。DeepSeek 会在需要时自动加载对应技能。</div>
        <div class="row"><button class="btn small" data-action="ext-open-skills" ${folder ? '' : 'disabled'}>打开技能文件夹</button></div>
      </div>`;
  },

  mcpCard() {
    const { servers, presets } = this.mcp;
    const list = servers.map((server) => `
      <div class="ext-server">
        <label class="switch"><input type="checkbox" data-mcp-toggle="${esc(server.name)}" ${server.enabled ? 'checked' : ''} /> <strong>${esc(server.name)}</strong></label>
        <span class="ext-desc">${server.transport === 'stdio'
    ? esc([server.command, ...server.args].join(' '))
    : esc(server.url)}${server.envKeys.length ? ` · 环境变量 ${server.envKeys.map(esc).join(', ')}` : ''}${server.headerKeys.length ? ` · 请求头 ${server.headerKeys.map(esc).join(', ')}` : ''}</span>
        <button class="btn small danger" data-action="ext-mcp-remove" data-name="${esc(server.name)}">删除</button>
      </div>`).join('');
    const presetRows = presets.map((preset) => `
      <div class="ext-server">
        <span class="ext-main"><span class="ext-name">${esc(preset.label)}</span><span class="ext-desc">${esc(preset.description)}</span></span>
        <button class="btn small" data-action="ext-mcp-preset" data-preset="${esc(preset.id)}" ${preset.installed ? 'disabled' : ''}>${preset.installed ? '已添加' : '添加'}</button>
      </div>`).join('');
    return `
      <div class="card">
        <div class="card-head"><div><div class="card-title">MCP 服务器</div><div class="card-sub">把外部工具接给 DeepSeek，工具名形如 mcp__名称__工具</div></div></div>
        ${list || '<div class="hint">还没有添加 MCP 服务器。</div>'}
        <div class="field"><label>常用预设</label>${presetRows}</div>
        <details class="ext-form">
          <summary>添加自定义服务器</summary>
          <div class="field"><label>名称</label><input class="input" id="mcp-name" placeholder="例如 github（字母、数字、_ 或 -）" /></div>
          <div class="field"><label>连接方式</label>
            <select class="input" id="mcp-transport">
              <option value="stdio">本地程序（stdio）</option>
              <option value="streamable-http">HTTP 服务（Streamable HTTP）</option>
            </select>
          </div>
          <div class="field" data-mcp-for="stdio"><label>命令</label><input class="input" id="mcp-command" placeholder="例如 npx" /></div>
          <div class="field" data-mcp-for="stdio"><label>参数（每行一个）</label><textarea class="input" id="mcp-args" rows="3" placeholder="-y&#10;@modelcontextprotocol/server-github"></textarea></div>
          <div class="field" data-mcp-for="stdio"><label>环境变量（每行 KEY=VALUE，可留空）</label><textarea class="input" id="mcp-env" rows="2" placeholder="GITHUB_TOKEN=..."></textarea></div>
          <div class="field" data-mcp-for="streamable-http" hidden><label>地址</label><input class="input" id="mcp-url" placeholder="http://localhost:3000/mcp" /></div>
          <div class="field" data-mcp-for="streamable-http" hidden><label>请求头（每行 Name: Value，可留空）</label><textarea class="input" id="mcp-headers" rows="2" placeholder="Authorization: Bearer ..."></textarea></div>
          <div class="hint">令牌等敏感值保存在本机数据目录的 config/mcp-servers.json 中，不会上传；界面只显示变量名。服务器会以你的账户权限在本机运行，只添加你信任的服务器。</div>
          <div class="row"><button class="btn primary" data-action="ext-mcp-save">保存服务器</button></div>
        </details>
      </div>`;
  },

  readForm() {
    const value = (id) => document.getElementById(id)?.value ?? '';
    const lines = (id) => value(id).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const pairs = (id, separator) => Object.fromEntries(lines(id).map((line) => {
      const index = line.indexOf(separator);
      if (index <= 0) throw new Error(`无法解析：${line}`);
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    }));
    const transport = value('mcp-transport');
    return transport === 'stdio'
      ? { name: value('mcp-name').trim(), transport, command: value('mcp-command').trim(), args: lines('mcp-args'), env: pairs('mcp-env', '=') }
      : { name: value('mcp-name').trim(), transport, url: value('mcp-url').trim(), headers: pairs('mcp-headers', ':') };
  },

  async afterMcpChange(result, message) {
    if (!result) return true;
    this.mcp = result;
    this.restartNeeded = true;
    toast(message, 'ok');
    await Settings.renderBody();
    return true;
  },

  async onClick(target) {
    const node = target.closest?.('[data-action]');
    const action = node?.getAttribute('data-action');
    switch (action) {
      case 'ext-plugin-install':
      case 'ext-plugin-remove': {
        const name = node.getAttribute('data-name');
        const installing = action === 'ext-plugin-install';
        node.disabled = true;
        node.textContent = installing ? '正在安装…' : '正在卸载…';
        if (installing) toast('正在下载并校验插件，可能需要一两分钟…');
        const result = await guard(installing ? api.extensions.installPlugin(name) : api.extensions.removePlugin(name), installing ? '安装失败' : '卸载失败');
        if (result) {
          this.restartNeeded = true;
          toast(installing ? '插件已安装，重启本地服务后生效' : '插件已卸载，重启本地服务后生效', 'ok');
        }
        await Settings.renderBody();
        return true;
      }
      case 'ext-plugin-home': {
        const url = node.getAttribute('data-url');
        if (url) await guard(api.app.openExternal(url), '打开主页失败');
        return true;
      }
      case 'ext-open-skills':
        if (this.skills?.folder) await guard(api.app.openPath(this.skills.folder), '打开文件夹失败');
        return true;
      case 'ext-mcp-preset':
        return this.afterMcpChange(await guard(api.extensions.addMcpPreset(node.getAttribute('data-preset')), '添加失败'), '已添加预设');
      case 'ext-mcp-remove':
        return this.afterMcpChange(await guard(api.extensions.removeMcp(node.getAttribute('data-name')), '删除失败'), '已删除');
      case 'ext-mcp-save': {
        let server;
        try { server = this.readForm(); } catch (error) { toast(error.message, 'err'); return true; }
        return this.afterMcpChange(await guard(api.extensions.saveMcp(server), '保存失败'), '服务器已保存');
      }
      default:
        return false;
    }
  },

  async onChange(target) {
    const skillId = target?.getAttribute?.('data-skill');
    if (skillId) {
      const result = await guard(api.extensions.setSkill(skillId, target.checked), target.checked ? '启用技能失败' : '停用技能失败');
      if (result) {
        this.skills = result;
        toast(target.checked ? '技能已启用，新消息即可使用' : '技能已停用', 'ok');
      } else {
        target.checked = !target.checked;
      }
      return true;
    }
    const mcpName = target?.getAttribute?.('data-mcp-toggle');
    if (mcpName) {
      return this.afterMcpChange(await guard(api.extensions.toggleMcp(mcpName, target.checked), '修改失败'),
        target.checked ? '已启用，重启本地服务后生效' : '已停用，重启本地服务后生效');
    }
    if (target?.id === 'mcp-transport') {
      for (const field of document.querySelectorAll('[data-mcp-for]')) field.hidden = field.getAttribute('data-mcp-for') !== target.value;
      return true;
    }
    return false;
  },

  onInput(target) {
    if (target?.id !== 'ext-skill-filter') return false;
    this.filter = target.value;
    const list = document.querySelector('.ext-list');
    if (!list || !this.skills) return true;
    const query = this.filter.trim().toLowerCase();
    for (const row of list.querySelectorAll('.ext-row')) {
      row.hidden = Boolean(query) && !row.textContent.toLowerCase().includes(query);
    }
    return true;
  },
};

/** Reviewed Harness plugins with their status against the running kernel; read-only for now. */
const PluginCenter = {
  async card() {
    const data = await guard(api.extensions.plugins(), '读取插件列表');
    if (!data) return '';
    const rows = data.plugins.map((plugin) => `
      <div class="ext-server">
        <span class="ext-main">
          <span class="ext-name">${esc(plugin.title)} <span class="ext-source">${esc(plugin.name)}@${esc(plugin.version)} · ${esc(plugin.license)}</span></span>
          <span class="ext-desc">${esc(plugin.description)}</span>
        </span>
        <span class="badge ${plugin.verdict === 'works' ? 'ok' : 'warn'}" title="${esc(plugin.testNote ?? '')}">${esc(plugin.verdictLabel)}</span>
        ${plugin.installedVersion
    ? `<button class="btn small danger" data-action="ext-plugin-remove" data-name="${esc(plugin.name)}">卸载</button>`
    : plugin.installable ? `<button class="btn small primary" data-action="ext-plugin-install" data-name="${esc(plugin.name)}">安装</button>` : ''}
        <button class="btn small" data-action="ext-plugin-home" data-url="${esc(plugin.homepage)}">主页</button>
      </div>
      ${plugin.testNote ? `<div class="hint ext-note">${esc(plugin.testNote)}</div>` : ''}`).join('');
    return `
      <div class="card">
        <div class="card-head"><div><div class="card-title">精选插件</div><div class="card-sub">经过审阅、固定版本的 Harness 插件（当前内核 ${esc(data.kernelVersion ?? '未知')}）</div></div></div>
        ${rows}
        <div class="hint">第三方插件以本地服务的权限运行。只有在当前内核上实测通过的插件可以安装：固定版本，下载后核对完整性校验，不运行依赖的安装脚本；安装和卸载都在重启本地服务后生效。只作用于 Harness 网页界面的插件（如桌宠、余额挂件、壁纸）在客户端里看不到效果，因此不在此列。</div>
      </div>`;
  },
};

window.ExtensionsPanel = ExtensionsPanel;
window.PluginCenter = PluginCenter;
