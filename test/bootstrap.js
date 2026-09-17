'use strict';
/**
 * Boot-contract test — no Electron, no network. Runs the real bootstrap module against a
 * stubbed environment to prove the promises the UI depends on:
 *
 *   1. an already-serving kernel is reused instead of spawned (progress jumps to 100);
 *   2. percentages only ever move forward and stay inside their documented bands;
 *   3. the installer resolves node/npm, spawns npm with a correct spec, and re-resolves the
 *      installed entry point (this is what makes the Windows first run work);
 *   4. the daily catalog guard fetches once per day.
 *
 *   node test/bootstrap.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsdesk-boot-contract-'));
process.env.DEEPSEEK_DESKTOP_HOME = TEST_ROOT;

const { Bootstrap, dshSpec } = require(path.join(ROOT, 'src', 'main', 'modules', 'bootstrap.js'));
const { DeepSeekHarnessClient } = require(path.join(ROOT, 'src', 'main', 'modules', 'api.js'));

let failures = 0;
function check(name, condition, detail) {
  if (!condition) failures += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' — ' + detail}`);
}

/** A throwaway HTTP server that answers with a DSH-looking shell. */
function fakeKernel(port) {
  const http = require('node:http');
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><head><script>window.__DSH_BOOT__={}</script></head><body>DeepSeek Harness</body></html>');
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

/** DSH 0.1.5-style index auth: launch token mints a signed session cookie. */
function fakeAuthenticatedKernel(port) {
  const http = require('node:http');
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname.startsWith('/api/')) {
      if (req.headers.cookie !== 'dsh_test=ready') {
        res.writeHead(401); res.end('unauthorized'); return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push({ path: url.pathname, request });
      const value = url.pathname === '/api/credentials/describe'
        ? { DEEPSEEK_API_KEY: { configured: true, inherited: false } }
        : { authenticated: true };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        type: 'server-response', rpcId: request.rpcId,
        result: { ok: true, value },
      }));
      return;
    }
    if (req.headers.cookie === 'dsh_test=ready') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>DeepSeek Harness</title>');
      return;
    }
    if (url.pathname === '/' && url.searchParams.get('token') === 'launch') {
      res.writeHead(303, { location: '/', 'set-cookie': 'dsh_test=ready; HttpOnly; SameSite=Strict' });
      res.end();
      return;
    }
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('dsh web authentication required; reopen the URL printed by dsh web.\n');
  });
  server.requests = requests;
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

async function main() {
  // ---------------------------------------------------------- 1. reuse a live kernel
  const port = 3199;
  const server = await fakeKernel(port);
  const states = [];
  const boot = new Bootstrap({ port, allowExternalReuse: true, emit: (state) => states.push({ ...state }) });
  const final = await boot.start();
  check('reuses a kernel already answering on the port', final.reused && final.ownership === 'external', final.baseUrl);
  check('progress ends at 100', final.percent === 100);
  check('progress is monotonic', states.every((s, i) => i === 0 || s.percent >= states[i - 1].percent));
  check('no package names leak into the status labels', states.every((s) => !/npm|dsh|node_modules|@deepseek-ai/i.test(s.label)), JSON.stringify([...new Set(states.map((s) => s.label))]));
  const isolated = new Bootstrap({ port, emit: () => {} });
  isolated.stageBundledRuntime = async () => ({ staged: true });
  isolated.resolveToolchain = async function resolveIsolatedToolchain() { this.dshBin = '/test/dsh.js'; };
  isolated.resolveOverride = async () => {};
  isolated.pickPort = async () => port + 20;
  isolated.spawnServer = async function spawnIsolated(portToUse) {
    this.ownership = 'app';
    this.state.port = portToUse;
  };
  isolated.awaitReady = async function finishIsolated(portToUse) {
    this.report({ phase: 'ready', percent: 100, label: '准备完成', port: portToUse, baseUrl: `http://127.0.0.1:${portToUse}` });
    return this.state;
  };
  const isolatedState = await isolated.start();
  check('legacy external kernels are not reused by default', isolatedState.reused === false && isolatedState.port === port + 20, JSON.stringify(isolatedState));
  await boot.stop();
  server.close();

  // A launcher that exits before the HTTP service answers must be an error, never a false
  // `ready` state. This is the exact regression behind the Windows "100% / 服务已停止" splash.
  const earlyStates = [];
  const earlyExit = new Bootstrap({ port: 3200, emit: (state) => earlyStates.push({ ...state }) });
  earlyExit.childResult = { code: 0, signal: null };
  let earlyError = null;
  try { await earlyExit.awaitReady(3200); } catch (error) { earlyError = error; }
  check('premature kernel exit rejects readiness', /退出码 0/.test(earlyError?.message ?? ''), earlyError?.message);
  check('waiting for HTTP never publishes a false ready state', earlyStates.every((state) => state.phase !== 'ready'), JSON.stringify(earlyStates));
  check('kernel output diagnostics redact secrets', !earlyExit.redactKernelLine('http://127.0.0.1/?token=secret').includes('secret'));

  const authPort = 3201;
  const authServer = await fakeAuthenticatedKernel(authPort);
  const authBoot = new Bootstrap({ port: authPort, emit: () => {} });
  authBoot.authenticatedUrl = `http://127.0.0.1:${authPort}/?token=launch`;
  const authBaseUrl = await authBoot.awaitReady(authPort);
  check('launch token is exchanged for the DSH session cookie', authBoot.authCookie === 'dsh_test=ready', authBoot.authCookie);
  check('authenticated readiness returns the clean base URL', authBaseUrl === `http://127.0.0.1:${authPort}`, authBaseUrl);
  const authClient = new DeepSeekHarnessClient(authBaseUrl, { cookie: authBoot.authCookie });
  const authReply = await authClient.call('auth.check');
  check('main-process RPC sends the authenticated cookie', authReply.authenticated === true);
  const authRequest = authServer.requests.at(-1);
  check('RPC uses the DSH 0.1.5 slash endpoint', authRequest?.path === '/api/auth/check', authRequest?.path);
  check('RPC wraps named arguments in payload.args', JSON.stringify(authRequest?.request?.payload) === JSON.stringify({ args: {} }), JSON.stringify(authRequest?.request?.payload));
  const described = await authClient.credentialsDescribe(['DEEPSEEK_API_KEY']);
  check('credential response is the direct DSH record', described.DEEPSEEK_API_KEY?.configured === true, JSON.stringify(described));
  const credentialRequest = authServer.requests.at(-1);
  check('credentials.describe uses the registered endpoint', credentialRequest?.path === '/api/credentials/describe', credentialRequest?.path);
  check('credentials.describe preserves its named refs argument', credentialRequest?.request?.payload?.args?.refs?.[0] === 'DEEPSEEK_API_KEY', JSON.stringify(credentialRequest?.request?.payload));
  await authClient.credentialsSet('DEEPSEEK_API_KEY', 'sk-contract-test-value');
  const credentialWrite = authServer.requests.at(-1);
  check('credentials.set uses the registered endpoint', credentialWrite?.path === '/api/credentials/set', credentialWrite?.path);
  check('credentials.set sends both named arguments', credentialWrite?.request?.payload?.args?.ref === 'DEEPSEEK_API_KEY' && credentialWrite?.request?.payload?.args?.value === 'sk-contract-test-value');
  authClient.dispose();
  authServer.close();

  // ------------------------------------------------------------- 2. install contract
  check('npm spec floats a bare name to @latest', dshSpec() === '@deepseek-ai/dsh@latest', dshSpec());

  const stubDir = path.join(TEST_ROOT, 'stub-package');
  fs.mkdirSync(path.join(stubDir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(stubDir, 'package.json'), JSON.stringify({ name: 'dsh-install-stub', version: '0.0.1', bin: { dsh: 'lib/bin.js' } }));
  fs.writeFileSync(path.join(stubDir, 'lib', 'bin.js'), 'console.log("stub dsh 0.0.1");\n');

  const installHome = path.join(TEST_ROOT, 'install-home');
  const realHome = process.env.DEEPSEEK_DESKTOP_HOME;
  process.env.DEEPSEEK_DESKTOP_HOME = installHome;
  process.env.DEEPSEEK_DESKTOP_DSH_PACKAGE = `file:${stubDir}`;
  delete require.cache[require.resolve(path.join(ROOT, 'src', 'main', 'modules', 'bootstrap.js'))];
  delete require.cache[require.resolve(path.join(ROOT, 'src', 'main', 'modules', 'util.js'))];
  const { Bootstrap: FreshBootstrap } = require(path.join(ROOT, 'src', 'main', 'modules', 'bootstrap.js'));

  const installStates = [];
  const installer = new FreshBootstrap({
    port: 3299,
    emit: (state) => { if (['install', 'verify', 'node'].includes(state.phase)) installStates.push(state); },
  });
  // Pretend the machine has no kernel yet so the real install path runs. Detection runs
  // first, so the installer's own re-detection (guarded by "no binary yet") stays a no-op.
  installer.resolveToolchain = async () => { installer.nodeBin = installer.resolveNode(); installer.npmCli = installer.resolveNpmCli(installer.nodeBin); installer.dshBin = null; };
  await installer.installDsh();
  const percents = installStates.map((s) => s.percent);
  check('installer reports progress', percents.length > 0, JSON.stringify(percents));
  check('install progress is monotonic', percents.every((p, i) => i === 0 || p >= percents[i - 1]));
  check('install progress stays in its band', percents.every((p) => p >= 42 && p <= 90));
  const installedBin = installer.dshBin ?? '';
  check('installer resolves a usable launcher', installedBin.includes('runtime') && installedBin.includes('dsh'), installedBin);
  const entry = installer.dshEntryFromPrefix() ?? '';
  check('launcher entry point resolves to the package bin', entry.endsWith(path.join('lib', 'bin.js')), entry);

  // --------------------------------------------- 3. port fallback + spawn command
  const busy = await fakeKernel(port);
  const freePort = await installer.pickPort(port);
  check('pickPort skips a busy port', freePort !== port && freePort > 0, `3079 → ${freePort}`);

  // A fresh machine must be able to spawn what it just installed: capture the argv instead of
  // really starting it, and assert the hidden-launch contract (port + --no-open).
  let spawned = null;
  installer.resolveNode = () => process.execPath;
  installer.spawnServer = async function capture(portToUse) {
    const entryPoint = this.dshEntryFromPrefix();
    const useNodeEntry = process.platform === 'win32' && this.nodeBin;
    spawned = {
      command: useNodeEntry ? this.nodeBin : this.dshBin,
      args: useNodeEntry ? [entryPoint, 'web', '--port', String(portToUse), '--no-open'] : ['web', '--port', String(portToUse), '--no-open'],
    };
    this.state.port = portToUse;
    this.state.baseUrl = `http://127.0.0.1:${portToUse}`;
    return { child: null, done: Promise.resolve({ code: 0 }) };
  };
  await installer.spawnServer(freePort);
  check('spawn passes the chosen port and --no-open', spawned?.args?.includes('--no-open') && spawned.args.includes(String(freePort)), JSON.stringify(spawned));
  busy.close();

  // --------------------------------------------------------------- 4. catalog guard
  process.env.DEEPSEEK_DESKTOP_HOME = realHome;
  const { syncCatalog } = require(path.join(ROOT, 'src', 'main', 'modules', 'catalog.js'));
  const originalFetch = global.fetch;
  let fetchCount = 0;
  global.fetch = async () => {
    fetchCount += 1;
    return { ok: true, text: async () => '<table><tr><th>模型</th><th>deepseek-fixture (1)</th></tr><tr><td>模型版本</td><td>fixture</td></tr><tr><td>上下文长度</td><td>128K</td></tr><tr><td>输出长度</td><td>8K</td></tr></table>' };
  };
  try {
    const first = await syncCatalog();
    const second = await syncCatalog();
    check('catalog syncs on the first call of the day', first.snapshot?.models.length === 1 && first.skipped !== true);
    check('catalog is cached for the rest of the day', second.skipped === true && fetchCount === 1);
  } finally { global.fetch = originalFetch; }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('bootstrap test crashed:', error);
  process.exit(2);
});
