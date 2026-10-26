'use strict';
/**
 * MCP servers the user adds in Settings. They are stored in `config/mcp-servers.json` and turned
 * into `@deepseek-ai/dsh-mcp-client` rows in the kernel's launch patch, so changes apply on the
 * next "restart local service". Every field is validated here because the patch becomes
 * kernel configuration that starts local processes.
 */
const fs = require('node:fs');
const path = require('node:path');
const { readJsonSync, writeJsonSync } = require('./util');

const MCP_PACKAGE = '@deepseek-ai/dsh-mcp-client';
const NAME = /^[A-Za-z0-9_-]{1,32}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const HEADER_KEY = /^[A-Za-z0-9-]{1,64}$/;
const MAX_SERVERS = 20;

/** One-click starting points; versions are pinned so a preset never drifts silently. */
const PRESETS = [
  {
    id: 'browser',
    label: '浏览器自动化（Playwright）',
    description: '让 DeepSeek 打开网页、点击、填写表单和截图。首次使用会通过 npx 下载 @playwright/mcp 及浏览器组件。',
    server: { name: 'browser', transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@0.0.83'] },
  },
];

function configFile(configDir) {
  return path.join(configDir, 'mcp-servers.json');
}

function stringMap(value, keyPattern, label) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}格式无效`);
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!keyPattern.test(key)) throw new Error(`${label}名称无效：${key}`);
    if (typeof raw !== 'string' || raw.length > 4096) throw new Error(`${label} ${key} 的值无效`);
    out[key] = raw;
  }
  return out;
}

/** A clean server record, or an Error explaining the first problem in Chinese. */
function normalizeServer(input) {
  const value = input && typeof input === 'object' ? input : {};
  const name = String(value.name ?? '').trim();
  if (!NAME.test(name)) throw new Error('名称只能使用 1–32 位字母、数字、下划线或短横线');
  const transport = value.transport === 'streamable-http' ? 'streamable-http' : value.transport === 'stdio' ? 'stdio' : null;
  if (!transport) throw new Error('连接方式必须是本地程序（stdio）或 HTTP');
  const server = { name, transport, enabled: value.enabled !== false };
  if (transport === 'stdio') {
    const command = String(value.command ?? '').trim();
    if (!command || command.length > 1024 || /[\r\n\0]/.test(command)) throw new Error('请填写要运行的命令');
    const args = Array.isArray(value.args) ? value.args : [];
    if (args.length > 64 || args.some((arg) => typeof arg !== 'string' || arg.length > 4096 || /[\0]/.test(arg))) {
      throw new Error('参数格式无效');
    }
    Object.assign(server, { command, args: [...args], env: stringMap(value.env, ENV_KEY, '环境变量') });
  } else {
    let url;
    try { url = new URL(String(value.url ?? '')); } catch { throw new Error('请填写有效的 HTTP 地址'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('只支持 http/https 地址，且不能在地址里写账号密码');
    Object.assign(server, { url: url.href, headers: stringMap(value.headers, HEADER_KEY, '请求头') });
  }
  return server;
}

function readServers(configDir) {
  const data = readJsonSync(configFile(configDir), null);
  const list = Array.isArray(data?.servers) ? data.servers : [];
  const servers = [];
  for (const item of list) {
    try {
      const server = normalizeServer(item);
      if (!servers.some((existing) => existing.name === server.name)) servers.push(server);
    } catch { /* a hand-edited invalid row is skipped, not fatal */ }
  }
  return servers.slice(0, MAX_SERVERS);
}

/** Add a server; an existing row is replaced only when its name is passed as `previousName`. */
function saveServer(configDir, input, previousName = null) {
  const server = normalizeServer(input);
  const servers = readServers(configDir).filter((item) => !previousName || item.name !== previousName);
  if (servers.some((item) => item.name === server.name)) throw new Error(`已有名为「${server.name}」的服务器`);
  if (servers.length >= MAX_SERVERS) throw new Error(`最多添加 ${MAX_SERVERS} 个 MCP 服务器`);
  servers.push(server);
  writeJsonSync(configFile(configDir), { servers });
  return servers;
}

function removeServer(configDir, name) {
  const servers = readServers(configDir).filter((item) => item.name !== name);
  writeJsonSync(configFile(configDir), { servers });
  return servers;
}

/** Launch-patch rows for enabled servers; a broken server never blocks the kernel. */
function mcpPatchEntries(configDir) {
  return readServers(configDir).filter((server) => server.enabled).map((server) => ({
    id: `desktop-mcp-${server.name}`,
    name: MCP_PACKAGE,
    config: server.transport === 'stdio'
      ? { serverName: server.name, transport: 'stdio', command: server.command, args: server.args,
        ...(Object.keys(server.env).length ? { env: server.env } : {}), failOnStartupError: false }
      : { serverName: server.name, transport: 'streamable-http', url: server.url,
        ...(Object.keys(server.headers).length ? { headers: server.headers } : {}), failOnStartupError: false },
  }));
}

/** Renderer view: secrets in env/headers are reported by key only. */
function describeServers(configDir) {
  return {
    servers: readServers(configDir).map((server) => ({
      name: server.name,
      transport: server.transport,
      enabled: server.enabled,
      command: server.command ?? null,
      args: server.args ?? [],
      url: server.url ?? null,
      envKeys: Object.keys(server.env ?? {}),
      headerKeys: Object.keys(server.headers ?? {}),
    })),
    presets: PRESETS.map(({ id, label, description, server }) => ({
      id, label, description, installed: readServers(configDir).some((item) => item.name === server.name),
    })),
    file: configFile(configDir),
  };
}

function addPreset(configDir, id) {
  const preset = PRESETS.find((item) => item.id === id);
  if (!preset) throw new Error('未知的预设');
  return saveServer(configDir, preset.server);
}

function setServerEnabled(configDir, name, enabled) {
  const servers = readServers(configDir);
  const server = servers.find((item) => item.name === name);
  if (!server) throw new Error('找不到这个服务器');
  server.enabled = Boolean(enabled);
  writeJsonSync(configFile(configDir), { servers });
  return servers;
}

function exists(configDir) {
  return fs.existsSync(configFile(configDir));
}

module.exports = {
  PRESETS, normalizeServer, readServers, saveServer, removeServer, setServerEnabled,
  addPreset, mcpPatchEntries, describeServers, exists,
};
