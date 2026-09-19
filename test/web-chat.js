'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { WebChatSurface, SURFACE_BAR_HEIGHT } = require('../src/main/modules/web-chat');

class FakeContents extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.loads = [];
    this.destroyed = false;
  }
  setWindowOpenHandler(handler) { this.openHandler = handler; }
  loadURL(url) { this.loads.push(url); return Promise.resolve(); }
  reload() { this.reloads = (this.reloads ?? 0) + 1; }
  focus() { this.focused = true; }
  isDestroyed() { return this.destroyed; }
  close() { this.destroyed = true; }
}
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

surface.setMode('web');
assert.equal(surface.view.visible, true);
assert.equal(surface.view.webContents.loads.length, 1, 'first switch loads the official page once');
surface.setMode('workbench');
surface.setMode('web');
assert.equal(surface.view.webContents.loads.length, 1, 'mode switching preserves web DOM and long conversations');
assert.equal(values.surfaceMode, 'web');

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
