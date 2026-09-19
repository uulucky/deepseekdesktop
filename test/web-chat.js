'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { WebChatSurface, SURFACE_BAR_HEIGHT, chromeCompatibleUserAgent } = require('../src/main/modules/web-chat');

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
  reload() { this.reloads = (this.reloads ?? 0) + 1; }
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
}, getUserAgent: () => 'Mozilla/5.0 Chrome/152.0.0.0 Electron/44.4.1 Safari/537.36',
setUserAgent(value) { this.userAgent = value; } };
const surface = new WebChatSurface({
  window: parent,
  WebContentsView: FakeView,
  partition: 'persist:test-platform',
  shell: { openExternal: (url) => external.push(url) },
  store: { get: (key, fallback) => values[key] ?? fallback, set: (key, value) => { values[key] = value; } },
  onState: (state) => states.push(state),
});

assert.equal(children.length, 1);
assert.equal(surface.view.visible, false, 'official page is lazy and hidden in workbench mode');
assert.deepEqual(surface.view.bounds, { x: 0, y: SURFACE_BAR_HEIGHT, width: 1200, height: 800 - SURFACE_BAR_HEIGHT });
assert.equal(surface.view.options.webPreferences.nodeIntegration, false);
assert.equal(surface.view.options.webPreferences.sandbox, true);
assert.equal(surface.view.options.webPreferences.preload, undefined);
assert.match(surface.view.webContents.userAgent, /Chrome\/152/);
assert.doesNotMatch(surface.view.webContents.userAgent, /Electron/i);
assert.equal(fakeSession.userAgent, surface.view.webContents.userAgent, 'popups and redirects inherit the compatible session User-Agent');
assert.equal(chromeCompatibleUserAgent('not-a-browser Electron/44.4.1'), 'not-a-browser Electron/44.4.1');

surface.setMode('web');
assert.equal(surface.view.visible, true);
assert.equal(surface.view.webContents.loads.length, 1, 'first switch loads the official page once');
surface.setMode('workbench');
surface.setMode('web');
assert.equal(surface.view.webContents.loads.length, 1, 'mode switching preserves web DOM and long conversations');
assert.equal(values.surfaceMode, 'web');

let responseContinued = false;
fakeSession.webRequest.listener({
  statusCode: 429,
  resourceType: 'mainFrame',
  webContentsId: surface.view.webContents.id,
}, () => { responseContinued = true; });
assert.equal(responseContinued, true, 'response observer never blocks the official response itself');
assert.equal(surface.snapshot().status, 'blocked');
assert.equal(surface.snapshot().httpStatus, 429);
assert.equal(surface.view.visible, false, 'official refusal page yields to the local recovery message');
surface.reload();
assert.equal(surface.snapshot().status, 'loading');
assert.equal(surface.snapshot().httpStatus, null);
assert.equal(surface.view.visible, true, 'manual retry is explicit and restores the remote surface');

surface.openInBrowser();
assert(external.includes('https://chat.deepseek.com/'), 'browser fallback always opens the fixed official URL');

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
surface.dispose();
assert.equal(children.length, 0);
assert(states.some((state) => state.mode === 'web'));
console.log('PASS official web surface isolation, lazy persistence, exact navigation and crash recovery');
