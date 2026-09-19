'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { WebChatSurface, SURFACE_BAR_HEIGHT, chromeCompatibleUserAgent, retryDeadline } = require('../src/main/modules/web-chat');

class FakeContents extends EventEmitter {
  constructor(options) {
    super();
    this.id = FakeContents.nextId++;
    this.options = options;
    this.loads = [];
    this.destroyed = false;
    this.session = fakeSession;
  }
  setUserAgent(value) { this.userAgent = value; }
  setWindowOpenHandler(handler) { this.openHandler = handler; }
  loadURL(url) { this.loads.push(url); return Promise.resolve(); }
  getURL() { return this.loads.at(-1) ?? ''; }
  reload() { this.reloads = (this.reloads ?? 0) + 1; }
  reloadIgnoringCache() { this.cacheBypass = true; this.reload(); }
  focus() { this.focused = true; }
  isDestroyed() { return this.destroyed; }
  close() { this.destroyed = true; }
}
FakeContents.nextId = 1;
class FakeView {
  constructor(options) { this.options = options; this.webContents = new FakeContents(options.webPreferences); }
  setVisible(value) { this.visible = value; }
  setBounds(value) { this.bounds = value; }
}

const children = [];
const parent = {
  contentView: {
    addChildView(view) { children.push(view); },
    removeChildView(view) { const at = children.indexOf(view); if (at >= 0) children.splice(at, 1); },
  },
  webContents: { focus() { this.focused = true; } },
  getContentSize() { return [1200, 800]; },
  isDestroyed() { return false; },
};
const values = {};
const external = [];
const states = [];
const fakeSession = { webRequest: {
  onHeadersReceived(_filter, listener) { this.listener = listener; },
}, getUserAgent: () => 'Mozilla/5.0 deepseek-desktop/0.3.2 Chrome/152.0.0.0 Electron/44.4.1 Safari/537.36',
setUserAgent(value) { this.userAgent = value; } };
let now = 100000;
const timers = new Map();
let nextTimer = 0;
const surface = new WebChatSurface({
  window: parent,
  WebContentsView: FakeView,
  partition: 'persist:test-platform',
  shell: { openExternal: (url) => external.push(url) },
  store: { get: (key, fallback) => values[key] ?? fallback, set: (key, value) => { values[key] = value; } },
  onState: (state) => states.push(state),
  now: () => now,
  setTimer: (fn, ms) => { timers.set(++nextTimer, { fn, ms }); return nextTimer; },
  clearTimer: id => timers.delete(id),
});

assert.equal(children.length, 1);
assert.equal(surface.view.visible, false, 'official page is lazy and hidden in workbench mode');
assert.deepEqual(surface.view.bounds, { x: 0, y: SURFACE_BAR_HEIGHT, width: 1200, height: 800 - SURFACE_BAR_HEIGHT });
assert.equal(surface.view.options.webPreferences.nodeIntegration, false);
assert.equal(surface.view.options.webPreferences.sandbox, true);
assert.equal(surface.view.options.webPreferences.preload, undefined);
assert.match(surface.view.webContents.userAgent, /Chrome\/152/);
assert.doesNotMatch(surface.view.webContents.userAgent, /Electron/i);
assert.doesNotMatch(surface.view.webContents.userAgent, /deepseek-desktop/i);
assert.equal(chromeCompatibleUserAgent('Mozilla/5.0 DeepSeekDesktop/0.3.2 Chrome/152.0.0.0 Electron/44.4.1 Safari/537.36'), 'Mozilla/5.0 Chrome/152.0.0.0 Safari/537.36');
assert.equal(fakeSession.userAgent, surface.view.webContents.userAgent, 'popups and redirects inherit the compatible session User-Agent');
assert.equal(chromeCompatibleUserAgent('not-a-browser Electron/44.4.1'), 'not-a-browser Electron/44.4.1');

surface.setMode('web');
assert.equal(surface.view.visible, true);
assert.equal(surface.view.webContents.loads.length, 1, 'first switch loads the official page once');
surface.setMode('workbench');
surface.setMode('web');
assert.equal(surface.view.webContents.loads.length, 1, 'mode switching preserves web DOM and long conversations');
assert.equal(values.surfaceMode, 'web');

const respond = (statusCode, extra = {}) => {
  let continued = false;
  fakeSession.webRequest.listener({ statusCode, resourceType: 'mainFrame',
    webContentsId: surface.view.webContents.id, ...extra }, () => { continued = true; });
  assert(continued, 'response observer never blocks the official response itself');
};
assert.equal(retryDeadline({ 'Retry-After': ['120'] }, now), now + 120000);
assert.equal(retryDeadline({ 'retry-after': [new Date(now + 7200000).toUTCString()] }, now), now + 7200000);
assert.equal(retryDeadline({ 'Retry-After': ['invalid'] }, now), now + 60000);
assert.equal(retryDeadline({}, now), now + 60000);
respond(429, { responseHeaders: { 'Retry-After': ['120'] } });
assert.equal(surface.snapshot().status, 'blocked');
assert.equal(surface.snapshot().httpStatus, 429);
assert.equal(surface.view.visible, false, 'official refusal page yields to the local recovery message');
surface.reload();
assert.equal(surface.snapshot().status, 'blocked', 'manual clicking cannot shorten the server wait');
assert.equal(surface.view.webContents.reloads, undefined);
surface.view.webContents.emit('did-fail-load', {}, -2, 'ERR_FAILED', 'https://chat.deepseek.com/', true);
surface.view.webContents.emit('did-finish-load');
assert.equal(surface.snapshot().status, 'blocked', 'load callbacks cannot erase a real 429');
surface.view.webContents.emit('did-start-loading');
assert.equal(surface.snapshot().status, 'blocked', 'subresource loading cannot reset the refusal');
surface.setMode('workbench');
assert.equal(timers.size, 0, 'hidden web mode does not retry in the background');
surface.setMode('web');
assert.equal(timers.size, 1);
now += 120000;
const retry = [...timers.values()][0]; timers.clear(); retry.fn();
assert.equal(surface.snapshot().status, 'loading');
assert.equal(surface.snapshot().httpStatus, null);
assert.equal(surface.view.visible, true);
assert.equal(surface.view.webContents.reloads, 1);
assert.equal(surface.view.webContents.cacheBypass, true, 'recovery bypasses cached error documents');
respond(429);
assert.equal(timers.size, 0, 'a second refusal does not start an endless retry loop');
assert.equal(surface.snapshot().autoRetry, false);
now += 60000;
surface.reload();
surface.view.webContents.emit('did-finish-load');
assert.equal(surface.status, 'ready');
assert.equal(values.webRetryAt, 0, 'successful navigation clears persisted cooldown');
respond(429, { resourceType: 'xhr' });
assert.equal(surface.status, 'ready', 'an API refusal cannot replace the entire official page');
respond(429, { webContentsId: 10000 });
assert.equal(surface.status, 'ready', 'another window cannot block this web view');
respond(403);
surface.view.webContents.emit('did-finish-load');
assert.equal(surface.status, 'verification');
assert.equal(surface.view.visible, true, 'the official verification page remains interactive in the app');
surface.view.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
surface.view.webContents.emit('did-finish-load');
assert.equal(surface.status, 'ready', 'completed verification can navigate to the normal site');
surface.view.webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', '', true);
assert.equal(surface.view.visible, false, 'connection failures have a visible local recovery panel');

let prevented = false;
surface.view.webContents.emit('will-navigate', { preventDefault: () => { prevented = true; } }, 'https://evil.test/');
assert(prevented && external.includes('https://evil.test/'), 'external top-level navigation leaves the sandboxed page');
assert.equal(surface.view.webContents.openHandler({ url: 'https://chat.deepseek.com/sign_in' }).action, 'allow');
assert.equal(surface.view.webContents.openHandler({ url: 'file:///tmp/a' }).action, 'deny');

const first = surface.view;
first.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
assert.notEqual(surface.view, first, 'a crashed official renderer is replaced with a fresh isolated view');
assert.equal(children.length, 1);
assert.equal(surface.view.visible, true);
respond(429);
assert(timers.size > 0);
surface.dispose();
assert.equal(children.length, 0);
assert.equal(timers.size, 0, 'closed app never leaves a scheduled navigation');
assert(states.some((state) => state.mode === 'web'));
const restarted = new WebChatSurface({ window: parent, WebContentsView: FakeView,
  partition: 'persist:test-platform', shell: { openExternal: url => external.push(url) },
  store: { get: (key, fallback) => values[key] ?? fallback, set: (key, value) => { values[key] = value; } },
  now: () => now,
  setTimer: (fn, ms) => { timers.set(++nextTimer, { fn, ms }); return nextTimer; },
  clearTimer: id => timers.delete(id),
});
assert.equal(restarted.status, 'blocked');
assert.equal(restarted.view.webContents.loads.length, 0, 'restart respects a persisted server cooldown');
now = values.webRetryAt;
const resume = [...timers.values()][0]; timers.clear(); resume.fn();
assert.deepEqual(restarted.view.webContents.loads, ['https://chat.deepseek.com/'], 'retry navigates an empty replacement to the official page, not about:blank');
restarted.dispose();
console.log('PASS official web compatibility, bounded Retry-After recovery, visible verification, isolation and persistence');
