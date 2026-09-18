'use strict';
/** Shared renderer state + tiny helpers. Everything else talks to the main process via window.deepseek. */
/** The preload bridge. A missing bridge means the page is being previewed outside the
 *  Electron shell (tests, a plain browser) — the UI still renders and degrades quietly. */
const api = window.deepseek ?? {};
const call = (group, method, ...args) => {
  const fn = api?.[group]?.[method];
  if (typeof fn !== 'function') return Promise.reject(new Error('当前环境没有可用的主进程接口'));
  return fn(...args);
};

const state = {
  boot: null,
  baseUrl: null,
  platform: { signedIn: false, lastBalance: null, lastUsage: null, lastKeys: null, activeKeyName: null },
  catalog: null,
  registry: null,
  ad: null,
  update: { status: 'idle', currentVersion: null, availableVersion: null, progress: 0, error: null },
  ui: {},
  credentials: {},
  sessions: [],
  sessionViews: new Map(),
  navigation: 0,
  creatingSession: false,
  sessionLoading: false,
  activeSessionId: null,
  selection: null,
  selectionRoutable: false,
  pendingSelection: null,
  permissionMode: 'danger-full-access',
  permissionBusy: false,
  pendingPermission: null,
  transcript: null,
  streaming: false,
  stopping: false,
  connection: 'connected',
  account: { summary: null, usage: null, keys: null, busy: false, error: null, revealed: null },
  view: { modal: null, tab: 'account' },
};

/** Chinese display name for a harness model id. */
function modelLabel(id) {
  const groups = state.registry?.registry ?? [];
  for (const group of groups) {
    const model = (group.models ?? []).find((entry) => entry.id === id);
    if (model) return model.name || model.id;
  }
  const official = state.catalog?.models?.find((entry) => entry.id === id);
  return official?.displayName || official?.version || id || '未知模型';
}

/** Official pricing facts for a model id (undefined when the catalog has not synced). */
function officialModel(id) {
  return state.catalog?.models?.find((entry) => entry.id === id) ?? null;
}

/** Format a CNY amount the way the platform does. */
function money(value, currency = 'CNY') {
  const symbol = currency === 'USD' ? '$' : '¥';
  const number = Number(value ?? 0);
  return symbol + number.toFixed(2);
}

/** Compact number formatting for token counts. */
function compact(value) {
  const number = Number(value ?? 0);
  if (number >= 1e8) return (number / 1e8).toFixed(2) + ' 亿';
  if (number >= 1e4) return (number / 1e4).toFixed(2) + ' 万';
  return String(number);
}

function reasoningLabel(id) {
  return ({ off: '关闭', low: '低', medium: '中', high: '高', max: '最大' })[id] ?? id ?? '默认';
}

const PERMISSION_MODES = ['read-only', 'workspace-write', 'danger-full-access'];

function defaultPermission(value) {
  if (value == null) return 'danger-full-access';
  return PERMISSION_MODES.includes(value) ? value : 'read-only';
}

function permissionLabel(id) {
  return ({
    'read-only': '只读',
    'workspace-write': '工作区',
    'danger-full-access': '完全',
  })[id] ?? '工作区';
}

function permissionTitle(id) {
  return ({
    'read-only': 'Read Only（只读，不允许修改文件）',
    'workspace-write': 'Workspace Write（仅允许在工作目录和临时目录写入）',
    'danger-full-access': 'Full Access（不受沙箱限制，且不再询问批准）',
  })[id] ?? id;
}

function relativeTime(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return Math.round(diff / 60e3) + ' 分钟前';
  if (diff < 86400e3) return Math.round(diff / 3600e3) + ' 小时前';
  if (diff < 7 * 86400e3) return Math.round(diff / 86400e3) + ' 天前';
  return new Date(ms).toLocaleDateString('zh-CN');
}

/** Escape for safe innerHTML interpolation. */
function esc(text) {
  return window.Markdown.escapeHtml(text);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Toast helper used across modules. */
function toast(message, kind = '') {
  const host = document.getElementById('toast-host');
  if (!host) return;
  const node = el('div', 'toast ' + kind, message);
  host.appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s ease';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 260);
  }, kind === 'err' ? 6000 : 3200);
}

/** Run an async action, surfacing failures as a toast instead of an unhandled rejection. */
async function guard(promise, context) {
  try {
    return await promise;
  } catch (error) {
    const message = error?.message || String(error);
    toast(`${context}：${message}`, 'err');
    return null;
  }
}
