'use strict';
// Starts a private, pinned Harness; never probes an existing user's port or credentials.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const net = require('node:net');
const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dsdesk-isolated-'));
process.env.DEEPSEEK_DESKTOP_HOME = temporary;
process.env.DEEPSEEK_DESKTOP_NODE_BIN = process.execPath;
delete process.env.DEEPSEEK_API_KEY;
delete process.env.DSH_HOME;
const { Bootstrap } = require('../src/main/modules/bootstrap');
const { DeepSeekHarnessClient } = require('../src/main/modules/api');
const { applyHarnessCredential } = require('../src/main/modules/credentials');
const pins = require('../build/runtime-pins.json');
const entry = process.env.DSH_TEST_KERNEL_ENTRY || [
  path.join(root, 'vendor/kernel/node_modules/@deepseek-ai/dsh/lib/bin.js'),
  path.join(root, 'build/kernel/node_modules/@deepseek-ai/dsh/lib/bin.js'),
].find(fs.existsSync);
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  assert(entry, 'Stage the runtime first: npm run runtime:stage (Windows), or npm ci --prefix build/kernel (native)');
  assert.equal(require(path.resolve(entry, '../../package.json')).version, pins.kernelVersion);
  const port = await freePort();
  const boot = new Bootstrap({ port, emit: () => {} });
  let client;
  try {
    boot.dshBin = entry;
    await boot.spawnServer(port);
    await boot.awaitReady(port);
    assert(boot.authCookie, 'Launch-token authentication is required');
    client = new DeepSeekHarnessClient(`http://127.0.0.1:${port}`, { cookie: boot.authCookie });
    assert.deepEqual(await client.listSessions(), [], 'Fresh test home has no user conversations');
    await assert.rejects(new DeepSeekHarnessClient(client.baseUrl).ping(), /认证|unauthorized/i);
    const created = await client.createSession({ agentPreset: 'standard', cwd: path.join(temporary, 'workspace') });
    assert(created.sessionId);
    for (const permission of ['read-only', 'workspace-write', 'read-only']) {
      assert.equal((await client.selectPermission(created.sessionId, permission)).currentValue, permission);
    }
    assert(Array.isArray((await client.history(created.sessionId)).events));
    const catalog = await client.listModels();
    assert(catalog.groups.some(group => group.models.length > 0), 'Pinned kernel exposes models without a paid request');
    const configured = await applyHarnessCredential(client, 'DEEPSEEK_API_KEY', 'sk-isolated-fixture-not-a-real-key');
    assert(configured.configured, 'Credential compatibility path saves a fixture key');
    let ready = false;
    client.onHostFrame(frame => { if (frame.type === 'remote-events/ready') ready = true; });
    client.connect();
    for (let count = 0; count < 100 && !ready; count += 1) await delay(100);
    assert(ready, 'Authenticated approval event stream becomes ready');
    console.log('PASS isolated real Harness: authentication, session API, permissions, credential persistence, model catalog, approval stream; no paid prompts');
  } finally {
    client?.dispose();
    await boot.stop();
    await delay(500);
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
