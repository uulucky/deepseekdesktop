'use strict';
/**
 * The single IPC surface between the renderer and the main process. Every channel is
 * registered here so the preload contract stays auditable in one place, and every handler
 * answers with a plain JSON value the renderer can render directly.
 */
const { ipcMain, shell, dialog, app, clipboard } = require('electron');
const { log } = require('./modules/util');
const { applyHarnessCredential, createAndApplyPlatformKey } = require('./modules/credentials');
const { isTrustedIpc, reusablePermission, externalUrl } = require('./modules/security');

/** Wrap a handler so a thrown error becomes a structured failure instead of a rejection. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      if (!isTrustedIpc(event)) throw new Error('已拒绝非客户端页面的请求');
      return { ok: true, value: await fn(...args) };
    } catch (error) {
      log('ipc', `${channel} failed`, String(error?.stack ?? error));
      return { ok: false, error: { message: String(error?.message ?? error), code: error?.code ?? null } };
    }
  });
}

/**
 * @param {object} services
 * @param {import('./modules/bootstrap').Bootstrap} services.bootstrap
 * @param {import('./modules/chat').ChatController} services.chat
 * @param {import('./modules/platform').DeepSeekPlatform} services.platform
 * @param {import('./modules/ad').AdSlot} services.ad
 * @param {() => any} services.getContext late-bound app context (windows, client, catalog)
 */
function registerIpc(services) {
  const { getContext } = services;
  // Never snapshot late-created services here. The kernel, chat controller and window-backed
  // platform client come online at different points during startup.
  const service = (name) => getContext()?.[name] ?? services[name];
  // Harness permission commands are not durable across kernel restarts. Persist the
  // confirmed per-session choice separately from the default for future conversations.
  const restoredPermissions = new WeakMap();
  const restoredFor = (client) => {
    if (!restoredPermissions.has(client)) restoredPermissions.set(client, new Set());
    return restoredPermissions.get(client);
  };
  const rememberPermission = (sessionId, value) => {
    if (!['read-only', 'workspace-write', 'danger-full-access'].includes(value)) return;
    const store = getContext().uiStore;
    const saved = store.get('sessionPermissions', {});
    if (saved?.[sessionId] !== value) store.set('sessionPermissions', { ...saved, [sessionId]: value });
  };
  const selectPermission = async (sessionId, preset) => {
    const client = getContext().client;
    const result = await client.selectPermission(sessionId, preset);
    if (result?.currentValue !== preset) throw new Error('内核没有确认新的权限模式');
    rememberPermission(sessionId, preset);
    restoredFor(client).add(sessionId);
    return result;
  };
  const restorePermission = async (sessionId) => {
    const ctx = getContext();
    const restored = restoredFor(ctx.client);
    const current = await ctx.client.permissions(sessionId);
    const saved = ctx.uiStore.get('sessionPermissions', {})?.[sessionId];
    if (!restored.has(sessionId) && ['read-only', 'workspace-write', 'danger-full-access'].includes(saved)
      && current.currentValue !== saved) {
      return selectPermission(sessionId, saved);
    }
    // Preserve old sessions without a saved desktop choice and any in-session /permission
    // command. A changed global default must never overwrite a particular session's choice.
    rememberPermission(sessionId, current.currentValue);
    restored.add(sessionId);
    return current;
  };

  // ------------------------------------------------------------------ lifecycle
  handle('app:info', () => {
    const ctx = getContext();
    return {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      dataDir: ctx.dataDir,
      logFile: ctx.logFile,
      boot: service('bootstrap')?.state ?? null,
      baseUrl: ctx.baseUrl,
    };
  });
  handle('app:boot-state', () => service('bootstrap')?.state ?? null);
  handle('app:retry-boot', async () => {
    const ctx = getContext();
    const bootstrap = service('bootstrap');
    if (!bootstrap) throw new Error('启动服务尚未初始化');
    await bootstrap.start().catch(() => {});
    if (bootstrap.state.baseUrl) ctx.attachClient(bootstrap.state.baseUrl);
    return bootstrap.state;
  });
  handle('app:open-external', async (url) => {
    const webUrl = typeof url === 'string' && externalUrl(url);
    const emailUrl = typeof url === 'string'
      && /^mailto:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(url);
    if (!webUrl && !emailUrl) throw new Error('无效链接');
    await shell.openExternal(url);
    return true;
  });
  handle('app:open-path', async (target) => shell.openPath(String(target)));
  handle('app:copy', (text) => { clipboard.writeText(String(text ?? '')); return true; });
  handle('app:world', () => {
    const ctx = getContext();
    return ctx.worldSnapshot ? ctx.worldSnapshot() : null;
  });

  // ------------------------------------------------------------------- sessions
  handle('sessions:list', async () => {
    const ctx = getContext();
    const items = await ctx.client.listSessions();
    service('chat')?.observeRunning?.(items);
    return items
      .filter((item) => !item.blank)
      .map((item) => ({
        sessionId: item.sessionId,
        title: item.projections?.values?.title ?? null,
        cwd: item.cwd,
        agentPreset: item.agentPreset,
        running: Boolean(item.running),
        updatedAt: item.updatedAt,
        turns: item.projections?.values?.sessionStats?.turns ?? 0,
      }))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  });
  handle('sessions:open', async (sessionId) => {
    await restorePermission(sessionId);
    return service('chat').open(sessionId);
  });
  handle('sessions:refresh', (sessionId) => service('chat').refresh(sessionId));
  handle('sessions:create', async () => {
    const ctx = getContext();
    const created = await service('chat').createSession(ctx.defaultSessionOptions());
    // The renderer alone must not be responsible for initial tool permissions.
    await selectPermission(created.sessionId, reusablePermission(ctx.uiStore?.get('defaultPermission', null)));
    return created;
  });
  handle('sessions:rename', async (sessionId, title) => {
    const result = await getContext().client.renameSession(sessionId, title);
    return result;
  });
  handle('sessions:delete-transcript', (sessionId) => { service('chat').close(sessionId); return true; });
  handle('sessions:prompt', async (sessionId, text) => {
    await restorePermission(sessionId);
    return service('chat').send(sessionId, text);
  });
  handle('sessions:cancel', (sessionId) => service('chat').cancel(sessionId));
  handle('sessions:answer-approval', (sessionId, eventId, outcome) => (
    service('chat').answerApproval(sessionId, eventId, outcome)
  ));
  handle('sessions:model-selection', async (sessionId) => {
    const ctx = getContext();
    const models = await ctx.client.sessionModels(sessionId);
    return { current: models.current ?? null, routable: models.routable, failures: models.failures ?? [] };
  });
  handle('sessions:permissions', (sessionId) => getContext().client.permissions(sessionId));
  handle('sessions:select-permission', selectPermission);

  // ----------------------------------------------------------------------- llm
  handle('llm:catalog', async () => {
    const ctx = getContext();
    const [registry, catalog] = await Promise.all([
      ctx.client.listModels().catch(() => ({ groups: [], failures: [] })),
      Promise.resolve(ctx.catalogSnapshot()),
    ]);
    return {
      default: registry.default ?? null,
      registry: (registry.groups ?? []).map((group) => ({
        id: group.id,
        name: group.name,
        models: (group.models ?? []).map((model) => ({
          id: model.id,
          name: model.name,
          efforts: model.reasoning?.efforts ?? [],
          defaultEffort: model.reasoning?.defaultEffort ?? null,
        })),
      })),
      official: catalog?.snapshot ?? null,
      failures: registry.failures ?? [],
    };
  });
  handle('catalog:sync', async () => {
    const ctx = getContext();
    const { syncCatalog } = require('./modules/catalog');
    const result = await syncCatalog({ force: true });
    ctx.catalog = result;
    return result.snapshot ?? null;
  });
  handle('llm:select-model', async (sessionId, provider, model, effort) => {
    const ctx = getContext();
    return ctx.client.selectModel(sessionId, provider, model, effort).then((result) => result.selected);
  });

  // ------------------------------------------------------------------- settings
  handle('settings:describe', () => getContext().client.settingsDescribe());
  handle('settings:update-ns', (ns, patch) => getContext().client.settingsUpdate(ns, patch));
  handle('settings:ui-get', () => getContext().uiStore.all());
  // One-shot kernel update source for machines that cannot reach the public registry.
  handle('settings:kernel-source-get', () => getContext().uiStore.get('kernelSpec', null));
  handle('settings:kernel-source-set', (value) => {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text) getContext().uiStore.set('kernelSpec', text);
    else getContext().uiStore.delete('kernelSpec');
    return text || null;
  });
  handle('settings:ui-set', (patch) => {
    const safe = { ...(patch ?? {}) };
    if ('defaultPermission' in safe) safe.defaultPermission = reusablePermission(safe.defaultPermission);
    return getContext().uiStore.merge(safe);
  });

  // ---------------------------------------------------------------- credentials
  handle('credentials:describe', (refs) => getContext().client.credentialsDescribe(refs ?? ['DEEPSEEK_API_KEY']));
  handle('credentials:set', async (ref, value) => {
    const ctx = getContext();
    const secret = typeof value === 'string' ? value.trim() : '';
    if (ref !== 'DEEPSEEK_API_KEY') throw new Error('不支持的凭据名称');
    if (!/^sk-[A-Za-z0-9_-]{12,}$/.test(secret)) throw new Error('请输入完整的 DeepSeek API Key（sk-…）');
    // Verify a pasted key before persisting it. A valid key with no remaining balance still
    // returns HTTP 200 and is accepted; only an invalid/revoked credential is rejected.
    const balance = await service('platform').balanceByApiKey(secret);
    const applied = await applyHarnessCredential(ctx.client, ref, secret);
    const described = applied.refs;
    ctx.credentialState = { refs: described, at: Date.now() };
    ctx.platformStore.set('lastBalance', balance);
    ctx.windows.main?.webContents.send('platform:state', ctx.worldSnapshot());
    log('credentials', 'DeepSeek API key verified and configured');
    return { configured: true, balance };
  });
  handle('credentials:unset', async (ref) => {
    await getContext().client.credentialsUnset(ref);
    return true;
  });

  // ------------------------------------------------------------------- platform
  handle('platform:status', () => platformStatus(getContext()));
  handle('platform:login', async () => { await getContext().openPlatformWindow({ intent: 'login' }); return true; });
  handle('platform:recharge', (amount) => getContext().openRechargeWindow(amount));
  handle('platform:usage', async () => { await getContext().openPlatformWindow({ intent: 'usage' }); return true; });
  handle('platform:refresh', () => getContext().refreshPlatformSnapshot());
  // Kept as a compatibility alias for older renderer bundles.
  handle('platform:balance', () => getContext().refreshPlatformSnapshot());
  handle('platform:keys', async () => {
    const ctx = getContext();
    const platform = service('platform');
    await ctx.openPlatformWindow({ show: false });
    if (!platform.hasToken()) await platform.refreshToken();
    if (!platform.hasToken()) return { needsLogin: true, keys: [] };
    const keys = await platform.listApiKeys();
    ctx.platformStore.set('lastKeys', { keys, fetchedAt: Date.now() });
    return { needsLogin: false, keys };
  });
  handle('platform:create-key', async (name) => {
    const ctx = getContext();
    const platform = service('platform');
    await ctx.openPlatformWindow({ show: false });
    if (!platform.hasToken()) await platform.refreshToken();
    // The platform returns the secret only once. A local binding failure must still return it
    // to the renderer so the user can copy or retry instead of losing the newly created key.
    const result = await createAndApplyPlatformKey(platform, ctx.client, name);
    if (result.created.applied) {
      ctx.platformStore.set('activeKeyName', result.created.name);
      ctx.credentialState = { refs: result.refs, at: Date.now() };
    }
    await ctx.refreshCredentialState?.().catch(() => null);
    const keys = await platform.listApiKeys().catch(() => []);
    ctx.platformStore.set('lastKeys', { keys, fetchedAt: Date.now() });
    ctx.refreshPlatformSnapshot?.().catch((error) => log('platform', 'post-create refresh failed', String(error)));
    return result;
  });
  handle('platform:delete-key', async (key) => {
    await service('platform').deleteApiKey(key);
    return true;
  });
  handle('platform:rename-key', async (key, name) => {
    await service('platform').renameApiKey(key, name);
    return true;
  });
  handle('platform:logout', async () => {
    const ctx = getContext();
    const platform = service('platform');
    platform.clearToken();
    ctx.platformStore.delete('lastBalance');
    ctx.platformStore.delete('lastUsage');
    await ctx.clearPlatformSession();
    return true;
  });

  // --------------------------------------------------------------------- update
  handle('update:status', () => service('updater')?.get() ?? null);
  handle('update:check', () => {
    const updater = service('updater');
    if (!updater) throw new Error('更新服务尚未初始化');
    return updater.check({ manual: true });
  });
  handle('update:install', () => {
    const updater = service('updater');
    if (!updater) throw new Error('更新服务尚未初始化');
    return updater.install();
  });

  // ---------------------------------------------------------------------- misc
  handle('window:minimize', () => getContext().windows.main?.minimize());
  handle('window:focus-main', () => getContext().focusMainWindow?.() ?? false);
  handle('window:toggle-maximize', () => {
    const win = getContext().windows.main;
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  handle('window:close', () => getContext().windows.main?.close());
  handle('window:is-maximized', () => Boolean(getContext().windows.main?.isMaximized()));
  handle('dialog:message', async (options) => {
    const win = getContext().windows.main;
    return dialog.showMessageBox(win, options ?? {});
  });
}

/** Current platform sign-in / balance snapshot without any network round-trip. */
function platformStatus(ctx) {
  return {
    signedIn: ctx.platform.hasToken(),
    activeKeyName: ctx.platformStore.get('activeKeyName', null),
    lastBalance: ctx.platformStore.get('lastBalance', null),
    lastUsage: ctx.platformStore.get('lastUsage', null),
    lastKeys: ctx.platformStore.get('lastKeys', null),
  };
}

module.exports = { registerIpc, handle };
