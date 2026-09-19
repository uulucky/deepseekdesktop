'use strict';
/**
 * Preload for the app shell. Exposes one frozen namespace; the renderer never sees Node,
 * Electron or the harness internals — only these functions.
 */
const { contextBridge, ipcRenderer } = require('electron');

/** Invoke a main-process handler and unwrap { ok, value } into a plain value / Error. */
async function invoke(channel, ...args) {
  const reply = await ipcRenderer.invoke(channel, ...args);
  if (reply && typeof reply === 'object' && 'ok' in reply) {
    if (reply.ok) return reply.value;
    const error = new Error(reply.error?.message ?? '操作失败');
    error.code = reply.error?.code ?? null;
    throw error;
  }
  return reply;
}

/** Subscribe to a main-process push channel; returns an unsubscribe function. */
function subscribe(channel, listener) {
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('deepseek', {
  app: {
    info: () => invoke('app:info'),
    bootState: () => invoke('app:boot-state'),
    retryBoot: () => invoke('app:retry-boot'),
    world: () => invoke('app:world'),
    openExternal: (url) => invoke('app:open-external', url),
    openPath: (target) => invoke('app:open-path', target),
    copy: (text) => invoke('app:copy', text),
    reportRendererError: (detail) => invoke('app:renderer-error', detail),
  },
  sessions: {
    list: () => invoke('sessions:list'),
    search: (query) => invoke('sessions:search', query),
    open: (sessionId) => invoke('sessions:open', sessionId),
    refresh: (sessionId) => invoke('sessions:refresh', sessionId),
    create: (request) => invoke('sessions:create', request),
    modelSelection: (sessionId) => invoke('sessions:model-selection', sessionId),
    permissions: (sessionId) => invoke('sessions:permissions', sessionId),
    selectPermission: (sessionId, preset) => invoke('sessions:select-permission', sessionId, preset),
    rename: (sessionId, title) => invoke('sessions:rename', sessionId, title),
    archive: (sessionId) => invoke('sessions:archive', sessionId),
    fork: (sessionId) => invoke('sessions:fork', sessionId),
    prompt: (sessionId, text, attachments) => invoke('sessions:prompt', sessionId, text, attachments),
    attachment: (sessionId, attachmentId) => invoke('sessions:attachment', sessionId, attachmentId),
    cancel: (sessionId) => invoke('sessions:cancel', sessionId),
    answerApproval: (sessionId, eventId, outcome) => invoke('sessions:answer-approval', sessionId, eventId, outcome),
  },
  workspaces: {
    list: () => invoke('workspaces:list'),
    add: () => invoke('workspaces:add'),
  },
  llm: {
    catalog: () => invoke('llm:catalog'),
    syncCatalog: () => invoke('catalog:sync'),
    selectModel: (sessionId, provider, model, effort) => invoke('llm:select-model', sessionId, provider, model, effort),
  },
  settings: {
    describe: () => invoke('settings:describe'),
    updateNamespace: (ns, patch) => invoke('settings:update-ns', ns, patch),
    ui: () => invoke('settings:ui-get'),
    setUi: (patch) => invoke('settings:ui-set', patch),
    kernelSource: () => invoke('settings:kernel-source-get'),
    setKernelSource: (value) => invoke('settings:kernel-source-set', value),
  },
  credentials: {
    describe: (refs) => invoke('credentials:describe', refs),
    set: (ref, value) => invoke('credentials:set', ref, value),
    unset: (ref) => invoke('credentials:unset', ref),
  },
  platform: {
    status: () => invoke('platform:status'),
    login: () => invoke('platform:login'),
    refresh: () => invoke('platform:refresh'),
    balance: () => invoke('platform:balance'),
    keys: () => invoke('platform:keys'),
    createKey: (name) => invoke('platform:create-key', name),
    deleteKey: (key) => invoke('platform:delete-key', key),
    renameKey: (key, name) => invoke('platform:rename-key', key, name),
    recharge: (amount) => invoke('platform:recharge', amount),
    usage: () => invoke('platform:usage'),
    logout: () => invoke('platform:logout'),
  },
  update: {
    status: () => invoke('update:status'),
    check: () => invoke('update:check'),
    install: () => invoke('update:install'),
  },
  surface: {
    status: () => invoke('surface:status'),
    setMode: (mode) => invoke('surface:set-mode', mode),
    reload: () => invoke('surface:reload'),
  },
  window: {
    focus: () => invoke('window:focus-main'),
    minimize: () => invoke('window:minimize'),
    toggleMaximize: () => invoke('window:toggle-maximize'),
    close: () => invoke('window:close'),
    isMaximized: () => invoke('window:is-maximized'),
  },
  events: {
    onBootState: (listener) => subscribe('boot:state', listener),
    onTranscript: (listener) => subscribe('chat:transcript', listener),
    onServerStop: (listener) => subscribe('server:stopped', listener),
    onPlatformState: (listener) => subscribe('platform:state', listener),
    onDomMirror: (listener) => subscribe('dsh:dom-mirror', listener),
    onAdState: (listener) => subscribe('ad:state', listener),
    onUpdateState: (listener) => subscribe('update:state', listener),
    onSurfaceState: (listener) => subscribe('surface:state', listener),
  },
});
