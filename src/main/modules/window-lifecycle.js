'use strict';

/**
 * Electron can destroy a child WebContents while its BrowserWindow is still in the native
 * close callback. Do not let late account/timer callbacks touch either object during teardown.
 */
function withLiveWindow(getWindow, action, { isStopping = () => false, onError = () => {} } = {}) {
  if (isStopping()) return false;
  try {
    const win = getWindow();
    if (!win || win.closingForExit || win.isDestroyed()) return false;
    const contents = win.webContents;
    if (!contents || contents.isDestroyed() || isStopping()) return false;
    return action(win, contents) !== false;
  } catch (error) {
    // A native close can win the race between isDestroyed() and show/focus/send(). An Electron
    // "Object has been destroyed" error must not become an uncaught main-process dialog.
    try { onError(error); } catch { /* diagnostics must never break shutdown */ }
    return false;
  }
}

function focusLiveWindow(getWindow, options) {
  return withLiveWindow(getWindow, (win, contents) => {
    if (win.isMinimized()) win.restore();
    if (win.closingForExit || win.isDestroyed() || contents.isDestroyed()) return false;
    win.show();
    if (win.closingForExit || win.isDestroyed() || contents.isDestroyed()) return false;
    win.focus();
    contents.focus();
    return true;
  }, options);
}

module.exports = { withLiveWindow, focusLiveWindow };
