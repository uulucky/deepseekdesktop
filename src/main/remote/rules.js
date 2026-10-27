'use strict';
/**
 * What a paired phone may do. The phone is a remote control for work that runs on this
 * computer, so the computer's owner sets the ceiling here and only here:
 *
 *  - Permissions are capped at "the most a phone may use" (Settings → 手机连接, changeable
 *    only on the computer). Full Access additionally needs the phone to have just re-verified
 *    its owner (biometrics) and only lasts for the session it was asked for.
 *  - No settings, extensions, MCP servers, API keys, recharges or safety-guard switches are
 *    reachable from the phone at all: the remote API simply has no such endpoints. The one
 *    exception is "keep the computer awake while the phone remote is on", which changes
 *    nothing about what the agent may do.
 *  - A phone cannot start work or approve a risky command while the safety guard is off on
 *    the computer, because the guard's question card is the last line of defence for
 *    commands nobody is watching.
 */
const fs = require('node:fs');

const PERMISSIONS = ['read-only', 'workspace-write', 'danger-full-access'];
const DEFAULT_MAX = 'workspace-write';

function rank(preset) {
  const index = PERMISSIONS.indexOf(preset);
  return index < 0 ? 0 : index;
}

/** The ceiling as stored; anything unknown falls back to the safe default. */
function maxPermission(stored) {
  return PERMISSIONS.includes(stored) ? stored : DEFAULT_MAX;
}

/**
 * Decide the permission a phone request ends up with.
 * @returns {{ preset: string, capped: boolean }}
 */
function capPermission(requested, max, { elevated = false } = {}) {
  const ceiling = maxPermission(max);
  let wanted = PERMISSIONS.includes(requested) ? requested : DEFAULT_MAX;
  if (wanted === 'danger-full-access' && !elevated) wanted = 'workspace-write';
  if (rank(wanted) > rank(ceiling)) return { preset: ceiling, capped: true };
  return { preset: wanted, capped: wanted !== requested };
}

/** Whether a current session permission is above what a phone may drive. */
function exceeds(current, max, { elevated = false } = {}) {
  return capPermission(current, max, { elevated }).preset !== current;
}

/** The kernel-side guard is on unless its settings file explicitly turns it off. */
function guardEnabled(settingsFile) {
  try {
    return JSON.parse(fs.readFileSync(settingsFile, 'utf8'))?.enabled !== false;
  } catch {
    return true;
  }
}

class RemoteRuleError extends Error {
  constructor(message, status = 403, code = 'forbidden') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function requireGuard(settingsFile) {
  if (!guardEnabled(settingsFile)) {
    throw new RemoteRuleError('电脑上关闭了「安全护栏」，手机暂时不能发起任务或批准操作。请在电脑上重新开启后再试。', 403, 'guard-off');
  }
}

module.exports = { PERMISSIONS, DEFAULT_MAX, maxPermission, capPermission, exceeds, guardEnabled, requireGuard, RemoteRuleError };
