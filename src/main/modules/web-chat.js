'use strict';

const OFFICIAL_WEB_URL = 'https://chat.deepseek.com/';
const SURFACE_BAR_HEIGHT = 46;
const DEFAULT_RETRY_MS = 60_000;

function retryDeadline(headers, now = Date.now()) {
  const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === 'retry-after')?.[1];
  const value = String(Array.isArray(entry) ? entry[0] : entry ?? '').trim();
  const delay = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  // Never shorten a server-specified wait. A missing/invalid header gets a conservative minute.
  return now + (Number.isFinite(delay) ? Math.max(1000, delay) : DEFAULT_RETRY_MS);
}

function isDeepSeekWebUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      && (url.hostname === 'deepseek.com' || url.hostname.endsWith('.deepseek.com'));
  } catch { return false; }
}

function surfaceMode(value) {
  return value === 'web' ? 'web' : 'workbench';
}

function isExternalHttpUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

function isLoopbackTestUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  } catch { return false; }
}

function chromeCompatibleUserAgent(value) {
  const original = String(value ?? '').trim();
  const sanitized = original.replace(/\s+(?:Electron|deepseek-desktop|DeepSeekDesktop)\/[^\s]+/gi, '')
    .replace(/\s{2,}/g, ' ').trim();
  return /\bChrome\/\d/i.test(sanitized) ? sanitized : original;
}

/**
 * Hosts the official free DeepSeek website below the local mode switch. The remote page has
 * no preload or Node access and owns its own DOM/history, so a long web conversation is never
 * cloned into the desktop renderer or IPC snapshots.
 */
class WebChatSurface {
  constructor({ window, WebContentsView, partition, shell, store, onState, log,
    url = OFFICIAL_WEB_URL, testMode = false, now = Date.now,
    setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.window = window;
    this.WebContentsView = WebContentsView;
    this.partition = partition;
    this.shell = shell;
    this.store = store;
    this.onState = onState ?? (() => {});
    this.log = log;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.retryTimer = null;
    this.autoRetries = 0;
    this.retryAt = Number(store?.get('webRetryAt', 0)) || 0;
    this.testMode = Boolean(testMode);
    this.url = isDeepSeekWebUrl(url) || (this.testMode && isLoopbackTestUrl(url)) ? url : OFFICIAL_WEB_URL;
    this.mode = surfaceMode(store?.get('surfaceMode', 'workbench'));
    this.status = 'idle';
    this.httpStatus = null;
    this.view = null;
    this.disposed = false;
    this.requestedVisible = false;
    this.responseObserverInstalled = false;
    this.recoveryTimes = [];
    this.createView();
    this.resize();
    this.setVisible(this.mode === 'web');
    if (this.mode === 'web') this.load();
  }

  snapshot() {
    return { mode: this.mode, status: this.status, httpStatus: this.httpStatus, url: this.url,
      retryAt: this.retryAt, autoRetry: this.status === 'blocked' && this.autoRetries < 1 };
  }

  emit() { this.onState(this.snapshot()); }

  allows(value) {
    return isDeepSeekWebUrl(value) || (this.testMode && isLoopbackTestUrl(value));
  }

  createView() {
    if (this.disposed) return;
    const view = new this.WebContentsView({
      webPreferences: {
        partition: this.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: undefined,
        spellcheck: true,
        backgroundThrottling: false,
      },
    });
    this.view = view;
    this.window.contentView.addChildView(view);
    const contents = view.webContents;
    const compatibleUserAgent = chromeCompatibleUserAgent(contents.session?.getUserAgent?.());
    if (compatibleUserAgent) {
      contents.session?.setUserAgent?.(compatibleUserAgent);
      contents.setUserAgent(compatibleUserAgent);
    }
    this.installResponseObserver(contents.session);
    contents.setWindowOpenHandler(({ url }) => {
      if (this.allows(url)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            webPreferences: {
              partition: this.partition,
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true,
              preload: undefined,
            },
          },
        };
      }
      if (isExternalHttpUrl(url)) {
        try { this.shell.openExternal(url); } catch { /* denied by the operating system */ }
      }
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, target) => {
      if (this.allows(target)) return;
      event.preventDefault();
      if (isExternalHttpUrl(target)) {
        try { this.shell.openExternal(target); } catch { /* denied by the operating system */ }
      }
    });
    contents.on('did-start-navigation', (details, _url, inPlace, mainFrame) => {
      if (this.disposed || contents !== this.view?.webContents
        || !(details.isMainFrame ?? mainFrame) || (details.isSameDocument ?? inPlace)) return;
      this.status = 'loading';
      this.httpStatus = null;
      this.cancelRetry();
      this.applyVisibility();
      this.emit();
    });
    contents.on('did-finish-load', () => {
      if (this.disposed || contents !== this.view?.webContents) return;
      if (['blocked', 'verification', 'error'].includes(this.status)) {
        this.applyVisibility();
        this.emit();
        return;
      }
      this.status = 'ready';
      this.retryAt = 0;
      this.autoRetries = 0;
      this.store?.set('webRetryAt', 0);
      this.cancelRetry();
      this.applyVisibility();
      this.emit();
    });
    contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame) this.navigationFailed(contents, code, description);
    });
    contents.on('render-process-gone', (_event, details) => this.recover(details));
  }

  installResponseObserver(targetSession) {
    if (this.responseObserverInstalled || !targetSession?.webRequest?.onHeadersReceived) return;
    this.responseObserverInstalled = true;
    const urls = ['https://chat.deepseek.com/*'];
    if (this.testMode && isLoopbackTestUrl(this.url)) urls.push(`${new URL(this.url).origin}/*`);
    targetSession.webRequest.onHeadersReceived({ urls }, (details, callback) => {
      try {
        const code = Number(details.statusCode)
          || Number(String(details.statusLine ?? '').match(/\s(\d{3})(?:\s|$)/)?.[1])
          || 0;
        const currentId = this.view?.webContents?.id;
        if (!this.disposed && details.resourceType === 'mainFrame'
          && (!Number.isInteger(details.webContentsId) || details.webContentsId === currentId)
          && [403, 429].includes(code)) {
          // 403 can contain an interactive verification page: leave it visible and usable.
          this.status = code === 429 ? 'blocked' : 'verification';
          this.httpStatus = code;
          if (code === 429) {
            this.retryAt = retryDeadline(details.responseHeaders, this.now());
            this.store?.set('webRetryAt', this.retryAt);
            this.scheduleRetry();
          }
          this.applyVisibility();
          this.emit();
          this.log?.('official web access response', { statusCode: code,
            fromCache: Boolean(details.fromCache), retryAt: this.retryAt, autoRetries: this.autoRetries });
        }
      } finally {
        callback({});
      }
    });
  }

  load() {
    if (!this.view || this.view.webContents.isDestroyed()) return false;
    if (this.waitingForRetry()) return false;
    this.status = 'loading';
    this.httpStatus = null;
    this.setVisible(this.requestedVisible);
    this.emit();
    const contents = this.view.webContents;
    contents.loadURL(this.url).catch(error => this.navigationFailed(contents, error.errno, error.code));
    return true;
  }

  reload({ automatic = false } = {}) {
    if (this.disposed || this.status === 'loading' || this.waitingForRetry()) return false;
    this.cancelRetry();
    if (!automatic) this.autoRetries = 0;
    if (!this.view || this.view.webContents.isDestroyed()) {
      this.replaceView();
      return true;
    }
    const failed = ['blocked', 'error'].includes(this.status);
    this.status = 'loading';
    this.httpStatus = null;
    this.setVisible(this.requestedVisible);
    this.emit();
    const contents = this.view.webContents;
    // Failed navigations can leave about:blank; reload() would then never visit the website.
    if (!this.allows(contents.getURL())) {
      contents.loadURL(this.url, { extraHeaders: 'pragma: no-cache\r\n' })
        .catch(error => this.navigationFailed(contents, error.errno, error.code));
    } else if (failed) contents.reloadIgnoringCache();
    else contents.reload();
    return true;
  }

  navigationFailed(contents, code, description) {
    if (this.disposed || contents !== this.view?.webContents || code === -3
      || ['blocked', 'verification'].includes(this.status)) return;
    this.status = 'error';
    this.applyVisibility();
    this.emit();
    // No request URL, headers, cookies or page contents enter the diagnostic log.
    this.log?.('official web load failed', { code, description });
  }

  waitingForRetry() {
    if (this.now() >= this.retryAt) return false;
    this.status = 'blocked';
    this.httpStatus = 429;
    this.scheduleRetry();
    this.applyVisibility();
    this.emit();
    return true;
  }

  cancelRetry() {
    if (this.retryTimer !== null) this.clearTimer(this.retryTimer);
    this.retryTimer = null;
  }

  scheduleRetry() {
    this.cancelRetry();
    if (this.disposed || this.mode !== 'web' || this.status !== 'blocked' || this.autoRetries >= 1) return;
    const delay = Math.max(0, this.retryAt - this.now());
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      if (this.disposed || this.mode !== 'web' || this.status !== 'blocked') return;
      if (this.now() < this.retryAt) { this.scheduleRetry(); return; }
      this.autoRetries += 1;
      this.reload({ automatic: true });
    }, Math.min(delay, 2_147_483_647));
    this.retryTimer?.unref?.();
  }

  setMode(value) {
    this.mode = surfaceMode(value);
    this.store?.set('surfaceMode', this.mode);
    this.setVisible(this.mode === 'web');
    if (this.mode === 'web') {
      if (this.status === 'idle') this.load();
      else if (this.status === 'blocked') this.scheduleRetry();
      this.view?.webContents.focus();
    }
    else { this.cancelRetry(); this.window?.webContents.focus(); }
    this.emit();
    return this.snapshot();
  }

  setVisible(visible) {
    this.requestedVisible = Boolean(visible);
    this.applyVisibility();
  }

  applyVisibility() {
    this.view?.setVisible(this.requestedVisible && !['blocked', 'error'].includes(this.status));
  }

  resize() {
    if (!this.view || this.window.isDestroyed()) return;
    const [width, height] = this.window.getContentSize();
    this.view.setBounds({
      x: 0,
      y: SURFACE_BAR_HEIGHT,
      width: Math.max(0, width),
      height: Math.max(0, height - SURFACE_BAR_HEIGHT),
    });
  }

  recover(details) {
    if (this.disposed) return;
    const now = Date.now();
    this.recoveryTimes = this.recoveryTimes.filter((time) => now - time < 60_000);
    if (this.recoveryTimes.length >= 3) {
      this.status = 'error';
      this.applyVisibility();
      this.emit();
      return;
    }
    this.recoveryTimes.push(now);
    this.replaceView();
    this.log?.('official web renderer recovered', details);
  }

  replaceView() {
    const old = this.view;
    if (old) {
      try { this.window.contentView.removeChildView(old); } catch { /* already detached */ }
      try { old.webContents.close({ waitForBeforeUnload: false }); } catch { /* already gone */ }
    }
    this.createView();
    this.resize();
    this.setVisible(this.mode === 'web');
    this.load();
  }

  dispose() {
    this.disposed = true;
    this.cancelRetry();
    const view = this.view;
    this.view = null;
    if (!view) return;
    try { this.window.contentView.removeChildView(view); } catch { /* already detached */ }
    try { view.webContents.close({ waitForBeforeUnload: false }); } catch { /* already gone */ }
  }
}

module.exports = {
  WebChatSurface, OFFICIAL_WEB_URL, SURFACE_BAR_HEIGHT, isDeepSeekWebUrl, isExternalHttpUrl,
  isLoopbackTestUrl, surfaceMode, chromeCompatibleUserAgent, retryDeadline,
};
