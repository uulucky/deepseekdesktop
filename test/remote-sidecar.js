'use strict';
// Opt-in end-to-end check of the phone remote with the real Celium sidecar against a local
// coordination server. Skipped unless these are set:
//   DMUSE_SIDECAR      path to a built dmuse-sidecar
//   DMUSE_SERVER       e.g. http://127.0.0.1:18080 (a local celium-control --derp --auth authkey)
//   DMUSE_CONTROL_KEY  that server's control key
//   DMUSE_PHONE        path to the dmuse-phone simulator
// The desktop side is RemoteControl itself with fake sessions; the phone side is a separate
// process with its own userspace node, so the request crosses the real tunnel.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const needed = ['DMUSE_SIDECAR', 'DMUSE_SERVER', 'DMUSE_CONTROL_KEY', 'DMUSE_PHONE'];
if (needed.some((name) => !process.env[name])) {
  console.log(`SKIP phone remote end-to-end (set ${needed.join(', ')})`);
  process.exit(0);
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsdesk-remote-e2e-'));
process.env.DEEPSEEK_DESKTOP_HOME = home;
const { RemoteControl } = require('../src/main/remote');

const ui = new Map([['remoteEnabled', true], ['remoteMaxPermission', 'workspace-write']]);
const permissions = new Map([['s1', 'danger-full-access']]);
const prompts = [];
const ctx = {
  uiStore: { get: (key, fallback) => (ui.has(key) ? ui.get(key) : fallback), set: (key, value) => ui.set(key, value) },
  defaultSessionOptions: () => ({}),
  client: { permissions: async (id) => ({ currentValue: permissions.get(id) }) },
  chat: { transcripts: new Map() },
};
const sessions = {
  sessionRows: async () => [{ sessionId: 's1', title: '周报', archived: false }],
  restorePermission: async () => {},
  selectPermission: async (id, preset) => { permissions.set(id, preset); return { currentValue: preset }; },
  prompt: async (id, text) => { prompts.push({ id, text, permission: permissions.get(id) }); },
};

function waitFor(control, predicate, what, ms = 60000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const state = control.snapshot();
      if (predicate(state)) return resolve(state);
      if (Date.now() - started > ms) return reject(new Error(`timed out waiting for ${what}: ${JSON.stringify({ ...state, invite: state.invite && '…' })}`));
      setTimeout(tick, 100);
    };
    tick();
  });
}

function phone(args) {
  return new Promise((resolve, reject) => {
    execFile(process.env.DMUSE_PHONE, [
      '--server', process.env.DMUSE_SERVER, '--control-key', process.env.DMUSE_CONTROL_KEY,
      '--state', path.join(home, 'phone'), '--name', 'pixel-e2e', ...args,
    ], { env: { ...process.env, DMUSE_PASSWORD: crypto.randomBytes(12).toString('hex') }, timeout: 120000 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`${error.message}\n${stdout}\n${stderr}`));
      resolve(stdout);
    });
  });
}

(async () => {
  const states = [];
  const control = new RemoteControl({ getContext: () => ctx, sessions, onState: (s) => states.push(s), version: 'e2e' });
  control.state.name = `e2e-${crypto.randomBytes(3).toString('hex')}`;
  await control.start();
  await waitFor(control, (s) => s.status === 'ready', 'sidecar ready');
  control.pair();
  const state = await waitFor(control, (s) => s.invite?.kind === 'computer', 'pairing invite');
  assert.match(state.invite.svg, /^<svg /);
  assert.match(state.invite.code, /^[a-z0-9]{4}-[a-z0-9]{4}$/);
  fs.writeFileSync(path.join(home, 'invite.txt'), control.inviteText);

  // First pairing: sign up, approve the computer, join, pair, then send a task.
  const user = `e2e${crypto.randomBytes(4).toString('hex')}`;
  const started = Date.now();
  const first = await phone(['--user', user, '--register', '--invite', path.join(home, 'invite.txt'),
    '-X', 'POST', '--get', '/v1/sessions/s1/messages', '-d', JSON.stringify({ text: '把周报整理好' })]);
  assert.match(first, /desktop answered 200 OK/);
  await waitFor(control, (s) => s.status === 'online' && s.phones.includes('pixel-e2e'), 'computer online with the phone listed');
  assert.deepEqual(prompts[0], { id: 's1', text: '把周报整理好', permission: 'workspace-write' });
  console.log(`  first pairing to task delivered: ${Date.now() - started} ms`);

  // A later request from the restarted phone uses its saved token.
  const again = await phone(['--get', '/v1/info']);
  const info = JSON.parse(again.split('desktop answered 200 OK: ')[1]);
  assert.equal(info.phone, 'pixel-e2e');
  assert.equal(info.maxPermission, 'workspace-write');

  // Revoking on the desktop locks the phone out.
  control.revoke('pixel-e2e');
  await waitFor(control, (s) => !s.phones.includes('pixel-e2e'), 'phone revoked');
  await assert.rejects(phone(['--get', '/v1/info']), /no longer paired/);

  control.stop();
  await waitFor(control, (s) => s.status === 'off', 'stopped');
  fs.rmSync(home, { recursive: true, force: true });
  console.log('PASS phone remote end-to-end: real sidecar, local Celium server, pairing, task, token reconnect, revoke');
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
