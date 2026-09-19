'use strict';
/**
 * DeepSeek Desktop — application entry.
 *
 * Boot order:
 *   1. single-instance lock + data dirs;
 *   2. a splash renderer that shows nothing but a progress bar while the harness kernel is
 *      located / installed / started (see modules/bootstrap.js);
 *   3. a hidden "worker" window that loads the official harness Web UI on 127.0.0.1 and
 *      mirrors it into the app (see preload/dsh.js);
 *   4. the visible app shell (ChatGPT-style layout) driven entirely by the local API.
 */
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, session, shell, Menu, ipcMain } = require('electron');

const { DIRS, ensureDirs, log, logFilePath, isDev, isPortable, adoptPortablePaths, execDir } = require('./modules/util');
const { Bootstrap } = require('./modules/bootstrap');
const { DeepSeekHarnessClient } = require('./modules/api');
const { ChatController } = require('./modules/chat');
const { DeepSeekPlatform } = require('./modules/platform');
const { syncCatalog, readSnapshot } = require('./modules/catalog');
const { AdSlot } = require('./modules/ad');
const { PortableUpdater, UPDATE_INTERVAL_MS } = require('./modules/updater');
const { Store } = require('./modules/store');
const { TranscriptDispatcher } = require('./modules/transcript-dispatcher');
const { attachWindowRecovery } = require('./modules/window-recovery');
const { registerIpc } = require('./ipc');
const { externalUrl, isPlatformUrl } = require('./modules/security');

const PLATFORM_PARTITION = 'persist:deepseek-platform';
const PLATFORM_REFRESH_MS = 10 * 60 * 1000;
const AGENT_PRESET = process.env.DEEPSEEK_DESKTOP_AGENT_PRESET || 'standard';

/** All mutable runtime state, kept in one object so IPC handlers can late-bind to it. */
const ctx = {
  windows: { splash: null, main: null, worker: null, platform: null, recharge: null },
  baseUrl: null,
  client: null,
  chat: null,
  platform: null,
  ad: null,
  updater: null,
  uiStore: null,
  platformStore: null,
  catalog: { snapshot: readSnapshot(), changed: false },
  credentialState: null,
  domMirror: null,
  dataDir: DIRS.root,
  logFile: logFilePath(),
};

// ---------------------------------------------------------------------------- startup

// Portable (green) mode must claim Chromium's storage paths before the app is ready.
const PORTABLE_ROOT = adoptPortablePaths();

// Optional diagnostic fallback for machines with a persistently broken graphics driver.
if (process.platform === 'win32' && process.env.DEEPSEEK_DESKTOP_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = ctx.windows.main;
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  main();
}

function main() {
  app.setAppUserModelId('com.deepseek.desktop');
  ensureDirs();
  log('app', `starting ${app.getVersion()} on ${process.platform} (${process.arch})`, {
    dev: isDev(),
    portable: isPortable(),
    dataRoot: DIRS.root,
  });

  app.on('window-all-closed', () => {
    // The tray-less desktop client quits with its window on Windows/Linux; macOS keeps the
    // conventional behaviour of staying alive until Cmd+Q.
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if ((!ctx.windows.main || ctx.windows.main.isDestroyed()) && ctx.baseUrl) createMainWindow();
  });

  app.on('before-quit', async () => {
    ctx.quitting = true;
    try {
      if (ctx.adTimer) clearInterval(ctx.adTimer);
      if (ctx.platformTimer) clearInterval(ctx.platformTimer);
      if (ctx.updateTimer) clearInterval(ctx.updateTimer);
      if (ctx.updateKickTimer) clearTimeout(ctx.updateKickTimer);
      ctx.chat?.dispose();
      ctx.transcriptDispatcher?.dispose();
      ctx.client?.dispose();
      await ctx.bootstrap?.stop();
    } catch (error) {
      log('app', 'shutdown error', String(error));
    }
  });

  app.on('web-contents-created', (_event, contents) => {
    // Keep the app self-contained: remote links open in the system browser, new windows
    // never spawn unmanaged Electron shells.
    contents.setWindowOpenHandler(({ url }) => {
      if (isPlatformUrl(url)) {
        return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: PLATFORM_PARTITION, preload: undefined } } };
      }
      const safe = externalUrl(url);
      if (safe) shell.openExternal(safe).catch(() => {});
      return { action: 'deny' };
    });
  });

  app.on('child-process-gone', (_event, details) => {
    if (details?.type !== 'GPU' || ctx.quitting) return;
    log('renderer', 'GPU process gone', details);
    ctx.mainRecovery?.trigger({ kind: 'gpu-crashed', reason: details.reason ?? 'unknown' });
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([
      { role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' },
    ]) : null);
    ctx.uiStore = new Store('ui');
    ctx.platformStore = new Store('platform');
    ctx.ad = new AdSlot();
    ctx.platform = new DeepSeekPlatform({
      session: session.fromPartition(PLATFORM_PARTITION),
      getWindow: () => {
        const win = ctx.windows.platform;
        return win && !win.isDestroyed() ? win : null;
      },
    });
    ctx.updater = new PortableUpdater({
      currentVersion: app.getVersion(),
      portable: isPortable(),
      appRoot: execDir(),
      executable: app.getPath('exe'),
      quit: () => app.quit(),
      openExternal: (url) => shell.openExternal(url),
      onState: (state) => {
        const win = ctx.windows.main;
        if (win && !win.isDestroyed()) win.webContents.send('update:state', state);
      },
    });
    startUpdateRefreshTimer();
    // Create the bootstrap before registering IPC. Older builds passed null here and the IPC
    // module destructured it, permanently breaking retry, session and chat actions.
    ctx.bootstrap = new Bootstrap({
      port: Number(process.env.DEEPSEEK_DESKTOP_PORT || 3080),
      onStopped: (detail) => ctx.windows.main?.webContents.send('server:stopped', { at: Date.now(), ...detail }),
      emit: (state) => {
        ctx.logFile = logFilePath();
        ctx.windows.splash?.webContents.send('boot:state', state);
        if (state.phase === 'ready' && state.baseUrl && !ctx.baseUrl) onKernelReady(
          state.baseUrl,
          ctx.bootstrap?.authCookie,
          ctx.bootstrap?.authenticatedUrl,
        ).catch((error) => {
          log('app', 'post-boot setup failed', String(error));
        });
      },
    });

    createSplash();
    signalUpdateStartupReady();
    registerIpc({
      get bootstrap() { return ctx.bootstrap; },
      get chat() { return ctx.chat; },
      get platform() { return ctx.platform; },
      get ad() { return ctx.ad; },
      getContext: () => ctx,
    });

    // Catalog sync runs in parallel with the kernel boot: it must never block the UI.
    syncCatalog({ force: process.env.DEEPSEEK_DESKTOP_FORCE_CATALOG === '1' })
      .then((result) => { ctx.catalog = result; log('app', 'catalog ready', { changed: result.changed }); })
      .catch((error) => log('app', 'catalog failed', String(error)));

    // Ad feed: fetched lazily, refreshed every 30 minutes, and pushed to the shell on change.
    ctx.ad.refresh()
      .then((changed) => { if (changed) ctx.windows.main?.webContents.send('ad:state', ctx.ad.get()); })
      .catch(() => {});
    ctx.adTimer = setInterval(() => {
      ctx.ad.refresh()
        .then((changed) => { if (changed) ctx.windows.main?.webContents.send('ad:state', ctx.ad.get()); })
        .catch(() => {});
    }, 30 * 60 * 1000);

    try {
      await ctx.bootstrap.start();
    } catch (error) {
      log('app', 'boot failed', String(error));
    }
  });
}

/** Called once (and only once) when the harness web service answers. */
async function onKernelReady(baseUrl, authCookie = null, authenticatedUrl = null) {
  ctx.baseUrl = baseUrl;
  ctx.client = new DeepSeekHarnessClient(baseUrl, { cookie: authCookie });
  ctx.client.connect();
  ctx.transcriptDispatcher?.dispose();
  ctx.transcriptDispatcher = new TranscriptDispatcher((payload) => {
    const win = ctx.windows.main;
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('chat:transcript', payload);
    }
  });
  ctx.chat = new ChatController(ctx.client, {
    onUpdate: (payload) => ctx.transcriptDispatcher.push(payload),
  });
  ctx.client.onState((state) => {
    if (state === 'reconnecting') log('app', 'harness connection reconnecting');
  });

  createMainWindow();
  createWorkerWindow(authenticatedUrl ?? baseUrl);
  await refreshCredentialState().catch((error) => log('app', 'credential probe failed', String(error)));
  // Quietly probe the persistent platform session so the account card already knows whether
  // the user is signed in; the window itself stays hidden.
  await refreshPlatformSnapshot().catch((error) => log('app', 'platform probe failed', String(error)));
  startPlatformRefreshTimer();
  ctx.windows.main?.webContents.send('platform:state', worldSnapshot());
}

/** Cache whether a DeepSeek API key is configured in the harness (shown on the account page). */
async function refreshCredentialState() {
  if (!ctx.client) return null;
  const refs = ['DEEPSEEK_API_KEY'];
  const described = await ctx.client.credentialsDescribe(refs);
  ctx.credentialState = { refs: described, at: Date.now() };
  ctx.windows.main?.webContents.send('platform:state', worldSnapshot());
  return ctx.credentialState;
}

/** Try to adopt a platform sign-in that already exists in the persistent session. */
async function refreshPlatformToken() {
  await ensurePlatformWindow({ show: false });
  const token = await ctx.platform.refreshToken();
  if (token) {
    ctx.windows.main?.webContents.send('platform:state', worldSnapshot());
  }
}

/** Refresh balance and usage as one atomic snapshot; concurrent timer/manual calls coalesce. */
async function refreshPlatformSnapshot() {
  if (ctx.platformRefreshPromise) return ctx.platformRefreshPromise;
  ctx.platformRefreshPromise = (async () => {
    await ensurePlatformWindow({ show: false });
    if (!ctx.platform.hasToken()) await ctx.platform.refreshToken();
    if (!ctx.platform.hasToken()) {
      const result = { needsLogin: true, summary: null, usage: null };
      ctx.windows.main?.webContents.send('platform:state', worldSnapshot());
      return result;
    }

    const [summaryResult, usageResult] = await Promise.allSettled([
      ctx.platform.summary(),
      ctx.platform.usage(),
    ]);
    if (summaryResult.status === 'rejected') {
      if (summaryResult.reason?.code === 'unauthorized') {
        ctx.platformStore.delete('lastBalance');
        ctx.platformStore.delete('lastUsage');
        ctx.windows.main?.webContents.send('platform:state', worldSnapshot());
        return { needsLogin: true, summary: null, usage: null };
      }
      throw summaryResult.reason;
    }
    const summary = summaryResult.value;
    const cachedUsage = ctx.platformStore.get('lastUsage', null);
    const cacheDay = cachedUsage?.today?.date;
    const currentDay = localDayKey(new Date());
    const usage = usageResult.status === 'fulfilled'
      ? usageResult.value
      : (cacheDay === currentDay ? cachedUsage : null);
    if (usageResult.status === 'rejected') {
      log('platform', 'detailed usage refresh failed', String(usageResult.reason));
    }
    ctx.platformStore.set('lastBalance', summary);
    if (usageResult.status === 'fulfilled') ctx.platformStore.set('lastUsage', usageResult.value);
    else if (!usage) ctx.platformStore.delete('lastUsage');
    ctx.windows.main?.webContents.send('platform:state', worldSnapshot());
    return { needsLogin: false, summary, usage, usageFresh: usageResult.status === 'fulfilled' };
  })().finally(() => { ctx.platformRefreshPromise = null; });
  return ctx.platformRefreshPromise;
}

/** Refresh all account data after a login completes, then publish one complete renderer state. */
async function refreshPlatformAccountSnapshot() {
  const snapshot = await refreshPlatformSnapshot();
  if (snapshot?.needsLogin) return snapshot;
  const work = [ctx.platform.listApiKeys()];
  if (ctx.client) work.push(ctx.client.credentialsDescribe(['DEEPSEEK_API_KEY']));
  const [keysResult, credentialResult] = await Promise.allSettled(work);
  if (keysResult.status === 'fulfilled') {
    ctx.platformStore.set('lastKeys', { keys: keysResult.value, fetchedAt: Date.now() });
  } else {
    log('platform', 'API key refresh failed', String(keysResult.reason));
  }
  if (credentialResult?.status === 'fulfilled') {
    ctx.credentialState = { refs: credentialResult.value, at: Date.now() };
  }
  ctx.windows.main?.webContents.send('platform:state', worldSnapshot());
  return { ...snapshot, keys: keysResult.status === 'fulfilled' ? keysResult.value : null };
}

function startPlatformRefreshTimer() {
  if (ctx.platformTimer) clearInterval(ctx.platformTimer);
  ctx.platformTimer = setInterval(() => {
    refreshPlatformSnapshot().catch((error) => log('platform', 'scheduled refresh failed', String(error)));
  }, PLATFORM_REFRESH_MS);
}

/** Check once shortly after launch, then once per hour. A failed check never interrupts boot. */
function startUpdateRefreshTimer() {
  if (!ctx.updater) return;
  if (ctx.updateTimer) clearInterval(ctx.updateTimer);
  if (ctx.updateKickTimer) clearTimeout(ctx.updateKickTimer);
  const check = () => ctx.updater.check().catch((error) => log('update', 'scheduled check failed', String(error)));
  ctx.updateKickTimer = setTimeout(check, 8 * 1000);
  ctx.updateKickTimer.unref?.();
  ctx.updateTimer = setInterval(check, UPDATE_INTERVAL_MS);
  ctx.updateTimer.unref?.();
}

function localDayKey(date) {
  const two = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

// --------------------------------------------------------------------------- windows

function createSplash() {
  const win = new BrowserWindow({
    width: 420,
    height: 300,
    frame: false,
    resizable: false,
    show: true,
    backgroundColor: '#0e1117',
    title: 'DeepSeek',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'main.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'splash.html'));
  ctx.windows.splash = win;
}

/** Let the native updater close its transition window only after this build is visibly alive. */
function signalUpdateStartupReady() {
  const requested = process.env.DEEPSEEK_DESKTOP_UPDATE_READY_FILE;
  if (!requested) return;
  delete process.env.DEEPSEEK_DESKTOP_UPDATE_READY_FILE;
  try {
    const file = path.resolve(requested);
    const updateDir = path.resolve(DIRS.root, 'update');
    const safeName = /^app-started-\d+\.ready$/.test(path.basename(file));
    if (path.dirname(file) !== updateDir || !safeName) {
      log('update', 'ignored unsafe startup acknowledgement path', requested);
      return;
    }
    fs.mkdirSync(updateDir, { recursive: true });
    fs.writeFileSync(file, `pid=${process.pid}\nversion=${app.getVersion()}\ntime=${new Date().toISOString()}\n`, 'utf8');
    log('update', 'startup window acknowledged to bootstrap', { file });
  } catch (error) {
    log('update', 'failed to acknowledge startup window', String(error));
  }
}

function createMainWindow() {
  if (ctx.windows.main && !ctx.windows.main.isDestroyed()) {
    ctx.windows.main.show();
    return ctx.windows.main;
  }
  const bounds = ctx.uiStore.get('mainBounds', null);
  const win = new BrowserWindow({
    width: bounds?.width ?? 1240,
    height: bounds?.height ?? 820,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: '#0e1117',
    title: 'DeepSeek',
    autoHideMenuBar: true,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'main.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  const reveal = () => {
    if (win.isDestroyed() || win.isVisible()) return;
    win.show();
    ctx.windows.splash?.destroy();
    ctx.windows.splash = null;
  };
  // Some Windows graphics/VM combinations never emit ready-to-show for a hidden window even
  // though its document has loaded. Either event is sufficient for this local static shell.
  win.once('ready-to-show', reveal);
  win.webContents.once('did-finish-load', reveal);
  win.webContents.once('did-fail-load', (_event, code, description) => {
    log('app', 'main shell failed to load', { code, description });
    ctx.windows.splash?.webContents.send('boot:state', {
      phase: 'error', percent: 100, label: '界面加载失败', error: `${description} (${code})`,
    });
  });
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    log('app', 'main preload failed', { preloadPath, error: String(error) });
  });
  const recovery = attachWindowRecovery(win, {
    log: (message, detail) => log('renderer', message, detail),
    shouldRecover: () => !ctx.quitting && !win.isDestroyed(),
    reload: () => replaceMainWindow(win),
    onRecovery: (detail) => { ctx.rendererRecovery = detail; },
    attempts: ctx.recoveryAttempts ??= [],
  });
  ctx.mainRecovery = recovery;
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html')).catch((error) => {
    log('app', 'main shell load rejected', String(error));
  });
  const persistBounds = () => {
    if (win.isDestroyed() || win.isMinimized()) return;
    ctx.uiStore.set('mainBounds', win.getNormalBounds());
  };
  win.on('resized', persistBounds);
  win.on('moved', persistBounds);
  win.on('closed', () => {
    recovery.dispose();
    if (ctx.mainRecovery === recovery) ctx.mainRecovery = null;
    if (ctx.windows.main === win) ctx.windows.main = null;
    // Hidden worker/platform windows otherwise keep the Windows portable app alive forever.
    if (process.platform !== 'darwin' && !win.replacedForRecovery) app.quit();
  });
  ctx.windows.main = win;
  return win;
}

/**
 * A crashed WebContents can accept reloadIgnoringCache without ever creating a new renderer on
 * some Windows/macOS builds. Build a fresh BrowserWindow, then retire the black window only
 * after the replacement document has loaded. The main process, Harness and running tasks stay
 * alive throughout the hand-off.
 */
function replaceMainWindow(failedWindow) {
  if (ctx.quitting || failedWindow.isDestroyed() || ctx.windows.main !== failedWindow) return false;
  failedWindow.replacedForRecovery = true;
  ctx.windows.main = null;
  const replacement = createMainWindow();
  const retireFailedWindow = () => {
    if (!failedWindow.isDestroyed()) failedWindow.destroy();
  };
  replacement.webContents.once('did-finish-load', retireFailedWindow);
  replacement.webContents.once('did-fail-load', retireFailedWindow);
  // A failed replacement must not leave two windows around forever.
  setTimeout(retireFailedWindow, 15_000).unref?.();
  return true;
}

/** Return keyboard focus to the app shell after an account/recharge window closes. */
function focusMainWindow() {
  const win = ctx.windows.main;
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.webContents.focus();
  return true;
}

/**
 * The hidden content view. It loads the official harness Web UI with a split partition so its
 * own state never mixes with the platform sign-in, and streams a DOM mirror back to the shell.
 */
function createWorkerWindow(baseUrl) {
  if (ctx.windows.worker && !ctx.windows.worker.isDestroyed()) {
    ctx.windows.worker.loadURL(baseUrl);
    return ctx.windows.worker;
  }
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    skipTaskbar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'dsh.js'),
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:deepseek-harness',
      backgroundThrottling: false,
    },
  });
  win.webContents.on('console-message', (details) => {
    const message = typeof details?.message === 'string' ? details.message : '';
    if (!message.startsWith('__DSH_MIRROR__:')) return;
    try {
      const payload = JSON.parse(message.slice('__DSH_MIRROR__:'.length));
      ctx.domMirror = payload;
      ctx.windows.main?.webContents.send('dsh:dom-mirror', payload);
    } catch { /* malformed mirror frame */ }
  });
  win.webContents.on('did-finish-load', () => log('app', 'hidden harness view loaded'));
  win.loadURL(baseUrl);
  ctx.windows.worker = win;
  return win;
}

/** Platform sign-in / usage window: visible on demand, invisible when only probing storage. */
async function ensurePlatformWindow({ show = true, url } = {}) {
  if (ctx.windows.platform && !ctx.windows.platform.isDestroyed()) {
    if (url) await ctx.windows.platform.loadURL(url);
    if (show) {
      ctx.windows.platform.show();
      ctx.windows.platform.focus();
    }
    return ctx.windows.platform;
  }
  const win = new BrowserWindow({
    width: 1080,
    height: 760,
    show: false,
    title: 'DeepSeek 账号',
    parent: ctx.windows.main && !ctx.windows.main.isDestroyed() ? ctx.windows.main : undefined,
    backgroundColor: '#ffffff',
    webPreferences: {
      partition: PLATFORM_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu?.();
  win.on('closed', () => {
    if (ctx.windows.platform === win) ctx.windows.platform = null;
    if (ctx.quitting) return;
    focusMainWindow();
    // The bearer token is captured from the successful login request before this event.
    // Recreate only a hidden platform view, fetch the complete account snapshot, and update
    // the already-open settings page without requiring the user to close and reopen it.
    refreshPlatformAccountSnapshot()
      .catch((error) => log('platform', 'post-close account refresh failed', String(error)))
      .finally(() => focusMainWindow());
  });
  win.webContents.on('did-finish-load', async () => {
    await ctx.platform.refreshToken();
    if (ctx.platform.hasToken()) {
      refreshPlatformAccountSnapshot().catch((error) => log('platform', 'post-login refresh failed', String(error)));
    } else {
      ctx.windows.main?.webContents.send('platform:state', worldSnapshot());
    }
  });
  ctx.windows.platform = win;
  await win.loadURL(url ?? ctx.platform.usageUrl()).catch((error) => log('app', 'platform load failed', String(error)));
  if (show) win.show();
  return win;
}

/** Recharge runs in its own in-app window so the payment flow never leaves the client. */
async function openRechargeWindow(amount) {
  const url = ctx.platform.rechargeUrl(amount);
  if (ctx.windows.recharge && !ctx.windows.recharge.isDestroyed()) {
    await ctx.windows.recharge.loadURL(url);
    ctx.windows.recharge.show();
    ctx.windows.recharge.focus();
    return true;
  }
  const win = new BrowserWindow({
    width: 1040,
    height: 780,
    title: '充值 — DeepSeek',
    backgroundColor: '#ffffff',
    webPreferences: { partition: PLATFORM_PARTITION, contextIsolation: true, nodeIntegration: false },
  });
  win.removeMenu?.();
  win.on('closed', () => { ctx.windows.recharge = null; });
  ctx.windows.recharge = win;
  await win.loadURL(url).catch((error) => log('app', 'recharge load failed', String(error)));
  return true;
}

/**
 * Send a command to the hidden content view (the mirror bridge acknowledges it). Used for
 * diagnostics and for the mirror's own re-sync; the shell never depends on it.
 */
function tellWorkerView(command) {
  const win = ctx.windows.worker;
  if (!win || win.isDestroyed()) return false;
  win.webContents.send('dsh:command', command);
  return true;
}

/** Everything the renderer needs for a first paint, in one payload. */
function worldSnapshot() {
  return {
    version: app.getVersion(),
    platformName: process.platform,
    arch: process.arch,
    baseUrl: ctx.baseUrl,
    boot: ctx.bootstrap?.state ?? null,
    credential: ctx.credentialState,
    platform: {
      signedIn: Boolean(ctx.platform?.hasToken()),
      activeKeyName: ctx.platformStore?.get('activeKeyName', null),
      lastBalance: ctx.platformStore?.get('lastBalance', null),
      lastUsage: ctx.platformStore?.get('lastUsage', null),
      lastKeys: ctx.platformStore?.get('lastKeys', null),
    },
    catalog: ctx.catalog?.snapshot ?? null,
    catalogChanged: Boolean(ctx.catalog?.changed),
    ad: ctx.ad?.get() ?? null,
    update: ctx.updater?.get() ?? null,
    ui: ctx.uiStore?.all() ?? {},
    rendererRecovery: ctx.rendererRecovery ?? null,
    dataDir: ctx.dataDir,
    logFile: ctx.logFile,
    portable: isPortable(),
    portableRoot: PORTABLE_ROOT,
    execDir: execDir(),
    journal: journalSummary(),
  };
}

/** Last few boot lines, surfaced in Settings so a user can self-diagnose. */
function journalSummary() {
  try {
    const fs = require('node:fs');
    const text = fs.readFileSync(ctx.logFile, 'utf8');
    return text.trim().split('\n').slice(-14);
  } catch {
    return [];
  }
}

// Context helpers the IPC layer calls back into.
ctx.worldSnapshot = worldSnapshot;
ctx.openPlatformWindow = ensurePlatformWindow;
ctx.openRechargeWindow = openRechargeWindow;
ctx.attachClient = (baseUrl) => onKernelReady(baseUrl);
ctx.catalogSnapshot = () => ctx.catalog;
ctx.refreshCredentialState = refreshCredentialState;
ctx.refreshPlatformSnapshot = refreshPlatformSnapshot;
ctx.refreshPlatformAccountSnapshot = refreshPlatformAccountSnapshot;
ctx.focusMainWindow = focusMainWindow;
ctx.tellWorkerView = tellWorkerView;
ctx.clearPlatformSession = async () => {
  await session.fromPartition(PLATFORM_PARTITION).clearStorageData();
};
ctx.defaultSessionOptions = () => ({
  agentPreset: AGENT_PRESET,
  cwd: ctx.uiStore?.get('workdir', null) || DIRS.workspace,
});

// The bootstrap reports a stopped kernel; the shell surfaces it and offers a restart.
ipcMain.on('noop', () => {});
