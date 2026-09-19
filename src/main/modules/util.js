'use strict';
/**
 * Platform facts, paths, logging and small async helpers shared by every main-process
 * module. Kept dependency-free so it can be required from tests and from the boot
 * sequence before any Electron service is ready.
 */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const IS_WINDOWS = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';

/**
 * Under Electron this reports the packaging state; under plain Node (unit tests, CLI probes)
 * it degrades to "development" instead of throwing, so every module stays importable.
 */
function isDev() {
  if (!process.versions.electron) return true;
  try {
    return !require('electron').app.isPackaged;
  } catch {
    return true;
  }
}

/** Directory holding the running app, or null outside a packaged Electron process. */
function execDir() {
  if (!process.versions.electron) return null;
  try {
    const { app } = require('electron');
    if (!app.isPackaged) return null;
    return path.dirname(app.getPath('exe'));
  } catch {
    return null;
  }
}

/**
 * Portable (green) mode: everything lives in a \`data\` folder next to the executable, so the
 * whole app is a single extractable folder that leaves nothing behind in %APPDATA%.
 *
 * It activates when the folder is writable and either a \`portable.flag\` marker sits beside the
 * executable or the launcher sets DEEPSEEK_DESKTOP_PORTABLE=1. When the folder is read-only
 * (installed under Program Files, or run straight from a mounted archive) it declines and the
 * app falls back to the per-user app-data directory.
 */
function portableDataDir() {
  // Never store Mac data inside a signed/translocated .app or mounted read-only DMG.
  if (IS_MAC) return null;
  if (process.env.DEEPSEEK_DESKTOP_PORTABLE === '0') return null;
  // The folder holding the executable decides where state lives. The override exists for
  // tests and for moving the data folder to another drive while keeping the app portable.
  const base = process.env.DEEPSEEK_DESKTOP_PORTABLE_ROOT
    ? path.resolve(process.env.DEEPSEEK_DESKTOP_PORTABLE_ROOT)
    : execDir();
  if (!base) return null;
  const marker = path.join(base, 'portable.flag');
  const forced = process.env.DEEPSEEK_DESKTOP_PORTABLE === '1' || Boolean(process.env.DEEPSEEK_DESKTOP_PORTABLE_ROOT);
  if (!forced && !existsSync(marker)) return null;
  try {
    fs.mkdirSync(base, { recursive: true });
    fs.accessSync(base, fs.constants.W_OK);
  } catch {
    return null;
  }
  return path.join(base, 'data');
}

/** True when this run stores its state beside the executable. */
function isPortable() {
  return portableDataDir() !== null;
}

/** Root directory that holds every user-visible artifact (config, cache, logs, runtime). */
function dataRoot() {
  const override = process.env.DEEPSEEK_DESKTOP_HOME;
  if (override) return path.resolve(override);
  const portable = portableDataDir();
  if (portable) return portable;
  try {
    return require('electron').app.getPath('userData');
  } catch {
    // Outside Electron (unit tests, CLI probes) fall back to a per-user temp directory so
    // every module stays importable without an app instance.
    return path.join(os.tmpdir(), 'deepseek-desktop');
  }
}

/**
 * Point Electron's own storage (Chromium cache, cookies, localStorage) at the portable data
 * directory. Must run before the app is ready, otherwise Chromium has already opened the
 * per-user paths.
 */
function adoptPortablePaths() {
  const portable = process.env.DEEPSEEK_DESKTOP_HOME
    ? path.resolve(process.env.DEEPSEEK_DESKTOP_HOME) : portableDataDir();
  if (!portable) return null;
  try {
    const { app } = require('electron');
    fs.mkdirSync(portable, { recursive: true });
    const userData = path.join(portable, 'chromium');
    fs.mkdirSync(userData, { recursive: true });
    app.setPath('userData', userData);
    app.setPath('sessionData', userData);
    app.setPath('cache', path.join(userData, 'cache'));
    app.setPath('logs', path.join(portable, 'logs'));
    return portable;
  } catch {
    return null;
  }
}

const DIRS = {
  get root() { return dataRoot(); },
  get config() { return path.join(dataRoot(), 'config'); },
  get cache() { return path.join(dataRoot(), 'cache'); },
  get logs() { return path.join(dataRoot(), 'logs'); },
  get runtime() { return path.join(dataRoot(), 'runtime'); },
  get workspace() { return path.join(dataRoot(), 'workspace'); },
  /** Install prefix used when the app has to obtain dsh itself. */
  get dshPrefix() { return path.join(dataRoot(), 'runtime', 'dsh'); },
  /** Portable Node runtime used on machines without a usable system Node.js. */
  get nodeRuntime() { return path.join(dataRoot(), 'runtime', 'node'); },
};

function ensureDirs() {
  for (const dir of [DIRS.root, DIRS.config, DIRS.cache, DIRS.logs, DIRS.runtime, DIRS.workspace]) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
  }
}

/** Open append-only handle for the current day's log file, or null when unusable. */
let logFd = null;
let logFdDay = null;

function logFilePath() {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(DIRS.logs, `main-${day}.log`);
}

/**
 * Append one line to the rotating daily log file; never throws.
 *
 * The write is synchronous on purpose: a boot crash is exactly the case the log has to
 * survive, and an async stream would lose the last lines when the process dies.
 */
function log(scope, message, extra) {
  const line = redact(`${new Date().toISOString()} [${scope}] ${message}${extra === undefined ? '' : ' ' + safeJson(extra)}`);
  try {
    const day = new Date().toISOString().slice(0, 10);
    if (logFd === null || logFdDay !== day) {
      const file = logFilePath();
      // Lazily create the log directory: logging can run before boot created it, and a
      // failed write must never take the process down.
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (logFd !== null) { try { fs.closeSync(logFd); } catch { /* ignore */ } }
      logFd = fs.openSync(file, 'a');
      logFdDay = day;
    }
    fs.writeSync(logFd, line + '\n');
  } catch {
    logFd = null;
    logFdDay = null;
  }
  if (isDev() || process.env.DEEPSEEK_DESKTOP_VERBOSE) process.stdout.write(line + '\n');
}

/** Defense in depth; logs can still contain user text/paths and need review before sharing. */
function redact(value) {
  return String(value)
    .replace(/\bsk-[a-zA-Z0-9_-]+/g, 'sk-[REDACTED]')
    .replace(/\bBearer\s+[^\s"\\]+/gi, 'Bearer [REDACTED]')
    .replace(/([?&](?:token|access_token|api_key)=)[^&\s"\\]+/gi, '$1[REDACTED]')
    .replace(/("(?:password|secret|apiKey|access_token|authorization|cookie)"\s*:\s*")[^"\r\n]*"/gi, '$1[REDACTED]"');
}

function safeJson(value) {
  try { return JSON.stringify(value); } catch { return String(value); }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Clamp a number into [min, max]. */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Random id with a stable prefix, used for renderer-side message correlation. */
function rid(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

/**
 * Resolve how to reach a Windows command interpreter. Node refuses to spawn .cmd/.bat
 * without a shell on Windows, so batch shims (dsh.cmd, npm.cmd, pnpm.cmd) need one.
 */
function spawnSpec(command, args, options = {}) {
  const shell = options.shell ?? (IS_WINDOWS && /\.(cmd|bat)$/i.test(command));
  return { command, args, shell, windowsHide: true, ...options };
}

/** Whether a file is executable-ish (exists on disk). */
function existsSync(target) {
  try { fs.accessSync(target); return true; } catch { return false; }
}

/** Read a JSON file, returning the fallback on any failure. */
function readJsonSync(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** Write a JSON file atomically (tmp + rename) so a crash cannot truncate it. */
function writeJsonSync(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

module.exports = {
  IS_WINDOWS, IS_MAC, IS_LINUX, isDev,
  DIRS, dataRoot, ensureDirs, isPortable, portableDataDir, adoptPortablePaths, execDir,
  log, logFilePath, redact, safeJson, sleep, clamp, rid, spawnSpec,
  existsSync, readJsonSync, writeJsonSync,
};
