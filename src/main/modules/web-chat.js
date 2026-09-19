'use strict';

const OFFICIAL_WEB_URL = 'https://chat.deepseek.com/';
const SURFACE_BAR_HEIGHT = 46;

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

/**
 * Hosts the official free DeepSeek website below the local mode switch. The remote page has
 * no preload or Node access and owns its own DOM/history, so a long web conversation is never
 * cloned into the desktop renderer or IPC snapshots.
 */
class WebChatSurface {
  constructor({ window, WebContentsView, partition, shell, store, onState, log,
    url = OFFICIAL_WEB_URL, testMode = false }) {
    this.window = window;
    this.WebContentsView = WebContentsView;
    this.partition = partition;
    this.shell = shell;
    this.store = store;
    this.onState = onState ?? (() => {});
    this.log = log;
    this.testMode = Boolean(testMode);
    this.url = isDeepSeekWebUrl(url) || (this.testMode && isLoopbackTestUrl(url)) ? url : OFFICIAL_WEB_URL;
    this.mode = surfaceMode(store?.get('surfaceMode', 'workbench'));
    this.status = 'idle';
    this.view = null;
    this.disposed = false;
    this.recoveryTimes = [];
    this.createView();
    this.resize();
    this.setVisible(this.mode === 'web');
    if (this.mode === 'web') this.load();
  }

  snapshot() {
    return { mode: this.mode, status: this.status, url: this.url };
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
    contents.on('did-start-loading', () => {
      this.status = 'loading';
      this.emit();
    });
    contents.on('did-finish-load', () => {
      this.status = 'ready';
      this.emit();
    });
    contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      this.status = 'error';
      this.emit();
      this.log?.('official web load failed', { code, description });
    });
    contents.on('render-process-gone', (_event, details) => this.recover(details));
  }

  load() {
    if (!this.view || this.view.webContents.isDestroyed()) return false;
    this.status = 'loading';
    this.emit();
    this.view.webContents.loadURL(this.url).catch(() => {
      if (this.disposed) return;
      this.status = 'error';
      this.emit();
    });
    return true;
  }

  reload() {
    if (!this.view || this.view.webContents.isDestroyed()) {
      this.replaceView();
      return true;
    }
    this.status = 'loading';
    this.emit();
    this.view.webContents.reload();
    return true;
  }

  setMode(value) {
    this.mode = surfaceMode(value);
    this.store?.set('surfaceMode', this.mode);
    this.setVisible(this.mode === 'web');
    if (this.mode === 'web') {
      if (this.status === 'idle') this.load();
      this.view?.webContents.focus();
    }
    else this.window?.webContents.focus();
    this.emit();
    return this.snapshot();
  }

  setVisible(visible) {
    this.view?.setVisible(Boolean(visible));
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
    const view = this.view;
    this.view = null;
    if (!view) return;
    try { this.window.contentView.removeChildView(view); } catch { /* already detached */ }
    try { view.webContents.close({ waitForBeforeUnload: false }); } catch { /* already gone */ }
  }
}

module.exports = {
  WebChatSurface, OFFICIAL_WEB_URL, SURFACE_BAR_HEIGHT, isDeepSeekWebUrl, isExternalHttpUrl,
  isLoopbackTestUrl, surfaceMode,
};
