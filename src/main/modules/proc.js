'use strict';
/**
 * Child-process helpers: line-oriented output capture (so progress can be parsed
 * from npm/pnpm/dsh output), timeouts, and graceful tree termination.
 */
const { spawn } = require('node:child_process');
const { log, spawnSpec, sleep } = require('./util');

/**
 * Spawn a long-lived child and stream its output line by line.
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, env?: Record<string,string>, onLine?: (line: string, stream: 'stdout'|'stderr') => void, shell?: boolean}} options
 * @returns {{child: import('node:child_process').ChildProcess, done: Promise<{code: number|null, signal: string|null}>, kill: () => void}}
 */
function runStreaming(command, args, options = {}) {
  const spec = spawnSpec(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    shell: options.shell,
  });
  log('proc', `spawn ${command} ${args.join(' ')}`, { cwd: options.cwd });
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd, env: spec.env, shell: spec.shell, windowsHide: true,
  });

  const pump = (stream, name) => {
    let buffered = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffered += chunk;
      let index;
      while ((index = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, index).replace(/\r$/, '');
        buffered = buffered.slice(index + 1);
        if (line.trim()) options.onLine?.(line, name);
      }
      if (buffered.length > 8192) { options.onLine?.(buffered, name); buffered = ''; }
    });
    stream.on('end', () => { if (buffered.trim()) options.onLine?.(buffered, name); });
  };
  if (child.stdout) pump(child.stdout, 'stdout');
  if (child.stderr) pump(child.stderr, 'stderr');

  const done = new Promise((resolve) => {
    child.on('error', (error) => {
      log('proc', `spawn error ${command}`, String(error));
      options.onLine?.(`spawn error: ${error.message}`, 'stderr');
      resolve({ code: -1, signal: null });
    });
    child.on('close', (code, signal) => resolve({ code, signal }));
  });

  return { child, done, kill: () => killTree(child) };
}

/** Run a command to completion, collecting output; rejects on non-zero exit. */
function run(command, args, options = {}) {
  const lines = [];
  const handle = runStreaming(command, args, { ...options, onLine: (line, stream) => {
    lines.push(line);
    options.onLine?.(line, stream);
  } });
  return handle.done.then(({ code, signal }) => {
    const output = lines.join('\n');
    if (code !== 0) {
      const error = new Error(`${command} exited with code ${code}${signal ? ' signal ' + signal : ''}`);
      error.code = code; error.output = output;
      throw error;
    }
    return output;
  });
}

/** Terminate a child process and, on Windows, the whole tree it started. */
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  } catch (error) {
    log('proc', 'kill failed', String(error));
  }
}

/** Wait until predicate() is truthy or the budget runs out; returns the last value. */
async function waitFor(predicate, { timeoutMs = 30000, intervalMs = 250, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(intervalMs);
  }
  log('proc', `waitFor timeout: ${label}`);
  return last;
}

module.exports = { runStreaming, run, killTree, waitFor };
