'use strict';

/** Attach bounded recovery for a renderer that crashes or stops processing events. */
function attachWindowRecovery(win, {
  log = () => {},
  reload = () => win.webContents.reloadIgnoringCache(),
  onRecovery = () => {},
  shouldRecover = () => true,
  crashDelayMs = 350,
  unresponsiveDelayMs = 8000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  attempts = [],
} = {}) {
  // BrowserWindow.webContents throws after the native window has been destroyed. Cleanup is
  // called from `closed`, so retain the EventEmitter while the window is still alive.
  const contents = win.webContents;
  let recoveryTimer = null;
  let unresponsiveTimer = null;
  let disposed = false;

  const schedule = (detail, delay) => {
    if (disposed || !shouldRecover() || recoveryTimer) return;
    const now = Date.now();
    while (attempts.length && now - attempts[0] > 60_000) attempts.shift();
    if (attempts.length >= 3) {
      log('renderer recovery paused after repeated failures', detail);
      onRecovery({ ...detail, status: 'failed', at: now });
      return;
    }
    attempts.push(now);
    onRecovery({ ...detail, status: 'recovering', at: now });
    recoveryTimer = setTimer(() => {
      recoveryTimer = null;
      if (disposed || !shouldRecover() || win.isDestroyed()) return;
      try {
        log('reloading main shell after renderer failure', detail);
        reload();
      } catch (error) {
        log('renderer reload failed', String(error));
      }
    }, delay);
  };

  const onGone = (_event, details = {}) => {
    log('main renderer process gone', details);
    schedule({ kind: 'crashed', reason: details.reason ?? 'unknown', exitCode: details.exitCode }, crashDelayMs);
  };
  const onUnresponsive = () => {
    if (unresponsiveTimer || disposed || !shouldRecover()) return;
    log('main renderer became unresponsive');
    unresponsiveTimer = setTimer(() => {
      unresponsiveTimer = null;
      schedule({ kind: 'unresponsive', reason: 'event-loop-timeout' }, 0);
    }, unresponsiveDelayMs);
  };
  const onResponsive = () => {
    if (unresponsiveTimer) clearTimer(unresponsiveTimer);
    unresponsiveTimer = null;
    log('main renderer responsive again');
  };

  contents.on('render-process-gone', onGone);
  win.on('unresponsive', onUnresponsive);
  win.on('responsive', onResponsive);

  return {
    trigger(detail = { kind: 'unknown', reason: 'manual' }) { schedule(detail, crashDelayMs); },
    dispose() {
      disposed = true;
      if (recoveryTimer) clearTimer(recoveryTimer);
      if (unresponsiveTimer) clearTimer(unresponsiveTimer);
      recoveryTimer = null;
      unresponsiveTimer = null;
      contents.removeListener('render-process-gone', onGone);
      win.removeListener('unresponsive', onUnresponsive);
      win.removeListener('responsive', onResponsive);
    },
  };
}

module.exports = { attachWindowRecovery };
