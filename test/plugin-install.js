'use strict';
// Network test (opt-in: DSD_NETWORK_TESTS=1): install, load and remove a verified curated
// plugin in a throwaway data root with the pinned kernel. HOME and every cache are isolated;
// the model is the loopback fixture, so no account or paid request is involved.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');

if (process.env.DSD_NETWORK_TESTS !== '1') {
  console.log('SKIP plugin install (set DSD_NETWORK_TESTS=1; downloads pnpm and the plugin from npm)');
  process.exit(0);
}

const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dsdesk-plugin-'));
process.env.DEEPSEEK_DESKTOP_HOME = path.join(temporary, 'data');
process.env.HOME = path.join(temporary, 'home');
process.env.USERPROFILE = process.env.HOME;
process.env.DEEPSEEK_DESKTOP_NODE_BIN = process.env.DEEPSEEK_DESKTOP_NODE_BIN || process.execPath;
fs.mkdirSync(process.env.HOME, { recursive: true });
delete process.env.DEEPSEEK_API_KEY;
delete process.env.DSH_HOME;

const { Bootstrap } = require('../src/main/modules/bootstrap');
const { DeepSeekHarnessClient } = require('../src/main/modules/api');
const { applyHarnessCredential } = require('../src/main/modules/credentials');
const { DIRS } = require('../src/main/modules/util');
const installer = require('../src/main/modules/plugin-installer');
const { startModelServer } = require('./fixtures/model-server');

const entry = [
  path.join(root, 'vendor/kernel/node_modules/@deepseek-ai/dsh/lib/bin.js'),
  path.join(root, 'build/kernel/node_modules/@deepseek-ai/dsh/lib/bin.js'),
].find(fs.existsSync);

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Boot the kernel once and return the tool names a fresh session offers the model. */
async function bootAndListTools(provider, marker) {
  const port = await freePort();
  const boot = new Bootstrap({ port, emit: () => {} });
  boot.dshBin = entry;
  try {
    await boot.spawnServer(port);
    await boot.awaitReady(port);
    const client = new DeepSeekHarnessClient(`http://127.0.0.1:${port}`, { cookie: boot.authCookie });
    await applyHarnessCredential(client, 'DEEPSEEK_API_KEY', 'sk-isolated-fixture-not-a-real-key');
    const created = await client.createSession({ agentPreset: 'standard', cwd: DIRS.workspace });
    await client.selectModel(created.sessionId, 'deepseek-official', 'deepseek-v4-flash', 'off');
    await client.prompt(created.sessionId, marker);
    const request = await provider.waitFor(marker);
    request.finish('ok');
    client.dispose();
    return { tools: (request.body.tools ?? []).map((tool) => tool.function?.name ?? tool.name), nodeBin: boot.nodeBin, kernel: boot.runningKernelVersion };
  } finally {
    await boot.stop();
  }
}

(async () => {
  assert(entry, 'Stage the runtime first');
  const provider = await startModelServer();
  process.env.DEEPSEEK_BASE_URL = provider.baseUrl;
  try {
    const first = await bootAndListTools(provider, 'plugin-baseline');
    assert.equal(first.tools.includes('multi_search'), false);
    const options = { dataRoot: DIRS.root, runtimeDir: DIRS.runtime, nodeBin: first.nodeBin, kernelVersion: first.kernel };

    await assert.rejects(installer.installPlugin({ ...options, name: '@dfy-plugins/dsh-image-generation' }), /未在当前内核/);
    await assert.rejects(installer.installPlugin({ ...options, name: 'left-pad' }), /不在精选/);

    const installed = await installer.installPlugin({ ...options, name: 'dsh-free-search' });
    assert.equal(installed['dsh-free-search'], '0.9.15');
    const manifest = JSON.parse(fs.readFileSync(path.join(installer.profileDir(DIRS.root), 'package.json'), 'utf8'));
    assert.ok(manifest.dsh.profile.bundles.includes('dsh-free-search'), 'bundle registered');
    assert.match(installer.lockedIntegrity(installer.profileDir(DIRS.root), 'dsh-free-search', '0.9.15'), /^sha512-T6YxSR4N/);

    const withPlugin = await bootAndListTools(provider, 'plugin-installed');
    assert.ok(withPlugin.tools.includes('multi_search'), `plugin tools load: ${withPlugin.tools.join(', ')}`);

    assert.deepEqual(await installer.removePlugin({ ...options, name: 'dsh-free-search' }), {});
    const afterRemove = await bootAndListTools(provider, 'plugin-removed');
    assert.equal(afterRemove.tools.includes('multi_search'), false, 'removed plugin no longer loads');
    console.log('PASS plugin install: verified curated plugin installs with matching integrity, loads into the pinned kernel and removes cleanly');
  } finally {
    await provider.close();
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
