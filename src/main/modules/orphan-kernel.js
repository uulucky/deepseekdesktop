'use strict';
/**
 * A macOS crash can leave the app's Node/Harness child reparented to launchd. It keeps
 * session.lock descriptors open, so a new desktop process can list old conversations but
 * receives SessionAlreadyOwnedError when it tries to resume them. Reap only children that
 * are unmistakably this app's orphaned, patched Harness; never touch a user's own dsh.
 */
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { sleep, log } = require('./util');

const execFileAsync = promisify(execFile);

function isAppOrphan(line, presentationPatch, selfPid = process.pid) {
  const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
  if (!match) return null;
  const pid = Number(match[1]);
  const ppid = Number(match[2]);
  const command = match[3];
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === selfPid || ppid !== 1) return null;
  // Both the reviewed dsh entry and the unique app-owned presentation patch must match.
  // A generic `dsh web` or a service still owned by a live desktop process is untouched.
  const bundledNode = command.includes('/DeepSeek Desktop.app/Contents/Resources/vendor/node/bin/node ');
  const entry = /\/DeepSeek Desktop\.app\/Contents\/Resources\/vendor\/kernel\/node_modules\/@deepseek-ai\/dsh\/lib\/bin\.js web --patch /;
  if (!bundledNode) return null;
  if (!entry.test(command)) return null;
  if (!command.includes(`--patch ${presentationPatch} --port `)) return null;
  if (!/--port \d+ --no-open(?:\s|$)/.test(command)) return null;
  return pid;
}

async function processTable() {
  const { stdout } = await execFileAsync('/bin/ps', ['-ww', '-axo', 'pid=,ppid=,command='], {
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function reapOrphanKernels(root, options = {}) {
  if ((options.platform ?? process.platform) !== 'darwin') return { stopped: [], remaining: [] };
  const patch = path.join(root, 'runtime', 'desktop-presentation', 'cordis.patch.json');
  const list = options.processTable ?? processTable;
  const terminate = options.terminate ?? ((pid) => process.kill(pid, 'SIGTERM'));
  const alive = options.isAlive ?? isAlive;
  const pause = options.sleep ?? sleep;
  let initial;
  try { initial = await list(); } catch (error) {
    log('bootstrap', 'orphan kernel scan unavailable', String(error));
    return { stopped: [], remaining: [] };
  }
  const candidates = initial.split('\n').map((line) => isAppOrphan(line, patch)).filter(Boolean);
  const stopped = [];
  const remaining = [];
  for (const pid of candidates) {
    try {
      // Recheck immediately before signalling, guarding against PID reuse or a changed owner.
      const current = await list();
      if (!current.split('\n').some((line) => isAppOrphan(line, patch) === pid)) continue;
      terminate(pid);
      for (let attempt = 0; attempt < 25 && alive(pid); attempt += 1) await pause(100);
      if (alive(pid)) remaining.push(pid);
      else stopped.push(pid);
    } catch (error) {
      log('bootstrap', `orphan kernel ${pid} could not be stopped`, String(error));
      remaining.push(pid);
    }
  }
  if (stopped.length || remaining.length) log('bootstrap', 'orphan kernel recovery', { stopped, remaining });
  return { stopped, remaining };
}

module.exports = { isAppOrphan, reapOrphanKernels };
