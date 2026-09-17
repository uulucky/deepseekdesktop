'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const Module = require('node:module');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dsdesk-ipc-'));
process.env.DEEPSEEK_DESKTOP_HOME = temporary;
const handlers = new Map();
const original = Module._load;
Module._load = function load(request, ...args) {
  if (request === 'electron') return { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } };
  return original.call(this, request, ...args);
};
const { registerIpc } = require('../src/main/ipc');
Module._load = original;
const frame = { url: pathToFileURL(path.resolve(__dirname, '../src/renderer/index.html')).href };
const trusted = { senderFrame: frame, sender: { mainFrame: frame } };
const untrustedFrame = { url: 'https://platform.deepseek.com' };
const untrusted = { senderFrame: untrustedFrame, sender: { mainFrame: untrustedFrame } };
const permissions = new Map([['old', 'danger-full-access']]);
let promptPermission;
let savedDefault;
const ctx = {
  uiStore: {
    get: () => savedDefault,
    merge: patch => { savedDefault = patch.defaultPermission; return patch; },
  },
  defaultSessionOptions: () => ({}),
  client: {
    permissions: async id => ({ currentValue: permissions.get(id) }),
    selectPermission: async (id, preset) => { permissions.set(id, preset); return { currentValue: preset }; },
  },
  chat: {
    createSession: async () => ({ sessionId: 'new' }),
    open: async id => ({ sessionId: id }),
    send: async id => { promptPermission = permissions.get(id); return {}; },
  },
};
registerIpc({ getContext: () => ctx });
async function call(channel, ...args) {
  const result = await handlers.get(channel)(trusted, ...args);
  assert.equal(result.ok, true, result.error?.message);
  return result.value;
}
async function main() {
  assert.equal((await handlers.get('sessions:create')(untrusted)).ok, false);
  assert.equal(permissions.has('new'), false, 'Rejected sender did not create a session');
  await call('sessions:create');
  assert.equal(permissions.get('new'), 'danger-full-access', 'New users default to Full Access in the kernel, not only the UI');
  await call('sessions:prompt', 'old', 'fixture');
  assert.equal(promptPermission, 'danger-full-access', 'Sending does not silently downgrade existing Full Access');
  await call('sessions:open', 'old');
  assert.equal(permissions.get('old'), 'danger-full-access', 'Opening old sessions preserves the actual permission');
  for (const preset of ['read-only', 'workspace-write', 'danger-full-access']) {
    await call('settings:ui-set', { defaultPermission: preset });
    assert.equal(savedDefault, preset, 'All three permission preferences are saved');
    await call('sessions:create');
    assert.equal(permissions.get('new'), preset, 'New sessions inherit the saved preference');
    await call('sessions:select-permission', 'old', preset);
    await call('sessions:open', 'old');
    await call('sessions:prompt', 'old', 'fixture');
    assert.equal(promptPermission, preset, 'Open/send must not override explicit session permissions');
  }
  console.log('PASS main-process IPC rejects remote senders, defaults to Full Access and preserves explicit permission choices');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(temporary, { recursive: true, force: true }));
