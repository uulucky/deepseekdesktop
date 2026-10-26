'use strict';
/**
 * Command-line media tools for the kernel. An app started from Finder or the Start menu gets
 * a minimal PATH, so Homebrew/winget tools the user installed are invisible to the agent and
 * it ends up guessing paths. This module appends the usual package-manager folders (never
 * reorders what is already there), finds ffmpeg/ffprobe, and describes them for the prompt.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const IS_WINDOWS = process.platform === 'win32';

/** The env key that actually holds PATH (Windows spells it `Path`). */
function pathKey(env) {
  return Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
}

function extraDirs(env = process.env, extra = []) {
  const home = os.homedir();
  const dirs = IS_WINDOWS
    ? [
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'),
      env.ProgramData && path.join(env.ProgramData, 'chocolatey', 'bin'),
      path.join(home, 'scoop', 'shims'),
    ]
    : ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin', path.join(home, '.local', 'bin')];
  return [...dirs, ...extra].filter(Boolean);
}

/** `{ [key]: value }` with missing package-manager folders appended to PATH. */
function augmentedPath(env = process.env, extra = []) {
  const key = pathKey(env);
  const separator = IS_WINDOWS ? ';' : ':';
  const current = String(env[key] ?? '').split(separator).filter(Boolean);
  const seen = new Set(current.map((dir) => (IS_WINDOWS ? dir.toLowerCase() : dir)));
  for (const dir of extraDirs(env, extra)) {
    const id = IS_WINDOWS ? dir.toLowerCase() : dir;
    if (seen.has(id)) continue;
    try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
    current.push(dir);
    seen.add(id);
  }
  return { [key]: current.join(separator) };
}

function which(name, searchPath) {
  const separator = IS_WINDOWS ? ';' : ':';
  const names = IS_WINDOWS ? [`${name}.exe`, `${name}.cmd`] : [name];
  for (const dir of String(searchPath ?? '').split(separator).filter(Boolean)) {
    for (const candidate of names) {
      const file = path.join(dir, candidate);
      try {
        if (fs.statSync(file).isFile()) return file;
      } catch { /* keep looking */ }
    }
  }
  return null;
}

function versionOf(file) {
  try {
    const result = spawnSync(file, ['-version'], { encoding: 'utf8', timeout: 4000, windowsHide: true });
    const line = String(result.stdout ?? '').split(/\r?\n/)[0] ?? '';
    return /version\s+(\S+)/.exec(line)?.[1] ?? null;
  } catch { return null; }
}

/** `{ ffmpeg: { path, version } | null, ffprobe: … }` on the augmented PATH. */
function detectMediaTools(env = process.env) {
  const searchPath = Object.values(augmentedPath(env))[0];
  const tools = {};
  for (const name of ['ffmpeg', 'ffprobe']) {
    const file = which(name, searchPath);
    tools[name] = file ? { path: file, version: versionOf(file) } : null;
  }
  return tools;
}

/** Package-manager command that installs both tools on this platform. */
function installCommand() {
  return IS_WINDOWS ? 'winget install --id Gyan.FFmpeg -e' : 'brew install ffmpeg';
}

/** One prompt paragraph so the agent uses the real binaries instead of guessing paths. */
function mediaPromptNote(tools) {
  const parts = [];
  for (const name of ['ffmpeg', 'ffprobe']) {
    parts.push(tools?.[name] ? `${name} is installed at ${tools[name].path}` : `${name} is NOT installed`);
  }
  let note = `Media tools on this computer: ${parts.join('; ')}.`;
  if (tools?.ffmpeg && !tools?.ffprobe) note += ' To inspect media without ffprobe, run `ffmpeg -hide_banner -i <file>` and read stderr.';
  if (!tools?.ffmpeg) note += ` If the task needs ffmpeg, tell the user it can be installed with \`${installCommand()}\` instead of guessing paths.`;
  return note;
}

module.exports = { augmentedPath, detectMediaTools, installCommand, mediaPromptNote, pathKey };
