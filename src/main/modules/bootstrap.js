'use strict';
/**
 * Boot sequencer. Brings the local DeepSeek Harness ("dsh") web service up without the
 * user ever seeing a terminal, a package name or a browser tab:
 *
 *   1. detect an already-serving DSH web instance on the preferred port (reuse it);
 *   2. otherwise locate dsh in the packaged resources / app runtime directory / PATH;
 *   3. when absent, obtain a Node.js runtime (Windows only) and install dsh into the
 *      app's data directory through npm/pnpm;
 *   4. spawn \`dsh web --port <port> --no-open\` hidden and wait until it answers;
 *   5. hand the renderer a base URL plus a monotonically increasing percentage.
 *
 * Every step reports { percent, label } where the label is deliberately generic
 * ("正在准备运行环境") — the requirement is that the user sees progress, not the
 * moving parts behind it.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DIRS, IS_WINDOWS, IS_MAC, isDev, log, clamp, sleep, existsSync, readJsonSync, writeJsonSync } = require('./util');
const { run, runStreaming, killTree, waitFor } = require('./proc');

const DEFAULT_PORT = 3080;
// DSH 0.1.5+ uses `import.meta.main` in its executable entry. That API is available in
// Node 24; with the old Node 22 runtime the entry was a silent no-op and exited with code 0.
const NODE_VERSION = process.env.DEEPSEEK_DESKTOP_NODE_VERSION || 'v24.15.0';
/** Package installed when the kernel is missing (overridable for mirrors and tests). */
function dshPackage() {
  return process.env.DEEPSEEK_DESKTOP_DSH_PACKAGE || '@deepseek-ai/dsh';
}

/** Every package name an installed prefix may hold, most specific first. */
function dshPackageNames() {
  const spec = dshPackage();
  const name = spec.startsWith('file:') || spec.startsWith('.') || spec.startsWith('/')
    ? '@deepseek-ai/dsh'
    : spec.replace(/@(latest|\^[\d.]+|~[\d.]+|[\d][\w.\-]*)$/, '');
  return [name, '@deepseek-ai/dsh'];
}

/**
 * Build the npm install spec. A pinned package (\`name@1.2.3\`) keeps its version, a local
 * path is used verbatim, and anything else floats to \`@latest\`.
 */
function dshSpec() {
  const pkg = dshPackage();
  if (pkg.startsWith('file:') || pkg.startsWith('.') || pkg.startsWith('/')) return pkg;
  if (pkg.startsWith('@')) return pkg.includes('@', 1) ? pkg : `${pkg}@latest`;
  return pkg.includes('@') ? pkg : `${pkg}@latest`;
}
const NPM_MIRROR = process.env.DEEPSEEK_DESKTOP_NPM_REGISTRY || 'https://registry.npmjs.org';
const NODE_MIRROR = process.env.DEEPSEEK_DESKTOP_NODE_MIRROR || 'https://npmmirror.com/mirrors/node';

/** Strip npm spec syntax down to a comparable version, or null when it is not pinned. */
function pinnedVersion(spec) {
  const match = String(spec).match(/@(\d+\.\d+\.\d+[\w.\-]*)$/);
  return match ? match[1] : null;
}

/** Sequential boot steps with the percentage band each one owns. */
const STEP_BANDS = {
  detect: [2, 8],
  // Copying the pre-staged runtime out of the app folder (no network involved).
  stage: [6, 40],
  node: [8, 42],
  install: [42, 82],
  verify: [82, 90],
  spawn: [90, 97],
  ready: [97, 100],
};

/**
 * Recursively copy a directory tree, tolerating symlinks and per-file failures the way
 * \`cp -r\` would. Used to move the pre-staged runtime into the data directory.
 */
async function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  const entries = await fs.promises.readdir(from, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) return copyTree(source, target);
    if (entry.isSymbolicLink()) {
      try {
        const link = await fs.promises.readlink(source);
        await fs.promises.symlink(link, target).catch(() => {});
      } catch { /* ignore */ }
      return undefined;
    }
    try {
      await fs.promises.copyFile(source, target);
    } catch { /* a locked or unreadable file must not abort the whole copy */ }
    return undefined;
  }));
}

class Bootstrap {
  /**
   * @param {{emit: (state: object) => void, port?: number}} options
   */
  constructor(options) {
    this.emitState = options.emit ?? (() => {});
    /** Called when the kernel this instance started exits unexpectedly. */
    this.onStopped = options.onStopped ?? null;
    this.preferredPort = Number(options.port ?? process.env.DEEPSEEK_DESKTOP_PORT ?? DEFAULT_PORT);
    // Reusing an unauthenticated service from an older desktop build mixes profiles, runtime
    // versions and credential routes. It is now opt-in for power users; normal clients always
    // start the bundled, version-matched Harness on the next free port.
    this.allowExternalReuse = options.allowExternalReuse
      ?? process.env.DEEPSEEK_DESKTOP_REUSE_DSH === '1';
    /** Optional user-supplied update package; overrides the official one for this run only. */
    this.override = { spec: null, source: null };
    this.state = {
      phase: 'idle',
      percent: 0,
      label: '',
      detail: '',
      baseUrl: null,
      port: null,
      reused: false,
      ownership: 'none',
      error: null,
      startedAt: Date.now(),
    };
    /** @type {import('node:child_process').ChildProcess|null} */
    this.child = null;
    this.nodeBin = null;
    this.npmCli = null;
    this.dshBin = null;
    /** Last settled result and a small, redacted output tail for startup diagnostics. */
    this.childResult = null;
    this.kernelOutput = [];
    /** DSH 0.1.5+ prints a one-time browser URL; exchanged cookies stay private here. */
    this.authenticatedUrl = null;
    this.authCookie = null;
  }

  /** Publish a state patch; percentage only ever moves forward. */
  report(patch, band) {
    if (band) patch.percent = clamp(Number(patch.percent ?? band[0]), band[0], band[1]);
    if (patch.percent !== undefined) patch.percent = Math.max(patch.percent, this.state.percent);
    Object.assign(this.state, patch, { elapsedMs: Date.now() - this.state.startedAt });
    this.emitState({ ...this.state });
  }

  /** Map a 0..1 ratio inside a named band to an absolute percentage. */
  bandPercent(name, ratio) {
    const [lo, hi] = STEP_BANDS[name];
    return Math.round(lo + (hi - lo) * clamp(ratio, 0, 1));
  }

  async start() {
    try {
      return await this.run();
    } catch (error) {
      log('bootstrap', 'failed', String(error && error.stack ? error.stack : error));
      this.report({ phase: 'error', error: String(error && error.message ? error.message : error), label: '启动失败' });
      // A timed-out boot is not useful in the background and may retain ports/lock files that
      // make the next retry fail differently. Only stop a process owned by this app.
      if (this.ownership === 'app' && this.child) {
        killTree(this.child);
        this.child = null;
      }
      throw error;
    }
  }

  async run() {
    this.report({ phase: 'detect', percent: 2, label: '正在检查运行环境' });

    // 0. explicit override wins (used by tests and by power users who already run dsh).
    const forced = process.env.DEEPSEEK_DESKTOP_DSH_BIN;
    if (forced && existsSync(forced)) this.dshBin = forced;
    // A published portable package is self-contained. Never silently replace a missing
    // reviewed kernel with a floating registry build on a customer's machine.
    if (!isDev() && !forced && (!this.bundledKernelEntry() || !existsSync(path.join(this.bundledVendorDir() || '', 'node', 'node.exe')))) {
      throw new Error('随包运行组件不完整，请从项目发布页重新下载完整便携包');
    }

    // 1. reuse a DSH web instance that already answers on the preferred port.
    const existing = await this.probeDshService(this.preferredPort, 1200);
    if (existing?.authenticated && this.allowExternalReuse) {
      log('bootstrap', `reusing DSH web on port ${this.preferredPort}`);
      this.report({
        phase: 'ready', percent: 100, label: '已连接', reused: true, ownership: 'external',
        baseUrl: `http://127.0.0.1:${this.preferredPort}`, port: this.preferredPort,
      });
      return this.state;
    }
    if (existing?.authenticated) {
      log('bootstrap', `legacy DSH already owns port ${this.preferredPort}; selecting an isolated port`);
    }
    if (existing?.authRequired) {
      // A different DSH process owns this port and its launch token is intentionally unknowable.
      // pickPort() below will choose another port that this application can authenticate.
      log('bootstrap', `authenticated DSH already owns port ${this.preferredPort}; selecting another port`);
    }

    // 2. adopt the runtime that ships with the app (copy it into the data dir once).
    await this.stageBundledRuntime();

    // 3. locate dsh + a usable Node/npm pair.
    await this.resolveToolchain();

    // 4. install dsh when it is genuinely missing, or when an update package was supplied.
    await this.resolveOverride();
    if (!this.dshBin || this.override.spec) await this.installDsh();

    // 5. pick a free port and spawn the hidden server.
    const port = await this.pickPort(this.preferredPort);
    await this.spawnServer(port);

    // 6. wait for the HTTP surface to answer.
    await this.awaitReady(port);
    return this.state;
  }

  /**
 * Adopt the pre-staged Node runtime and kernel the first time the app runs. Both live next to
 * the executable in a "batteries included" build and are used in place. Partial/legacy bundles
 * retain the copy fallback; when nothing is bundled the normal detect/install ladder takes over.
   */
  async stageBundledRuntime() {
    const vendor = this.bundledVendorDir();
    if (!vendor) return { staged: false };

    const bundledNodeDir = path.join(vendor, 'node');
    const bundledKernelDir = path.join(vendor, 'kernel');
    const bundledNode = path.join(bundledNodeDir, IS_WINDOWS ? 'node.exe' : 'bin/node');
    const kernelEntry = this.bundledKernelEntry();
    // A packaged build can execute immutable runtime files directly from resources. Avoiding
    // a first-run copy removes thousands of Windows file operations, MAX_PATH exposure and
    // the possibility of an antivirus scanner leaving a half-copied kernel behind.
    if (existsSync(bundledNode) && kernelEntry) {
      this.report({ phase: 'stage', percent: this.bandPercent('stage', 0), label: '正在准备运行环境' });
      log('bootstrap', 'using bundled runtime in place', { vendor });
      this.report({ percent: this.bandPercent('stage', 1), label: '正在准备运行环境' });
      return { staged: true, direct: true, node: false, kernel: false };
    }
    const needNode = existsSync(bundledNode) && !existsSync(path.join(DIRS.nodeRuntime, IS_WINDOWS ? 'node.exe' : 'bin/node'));
    // Presence is checked through the entry point, not just the directory: a half-copied tree
    // must be re-staged rather than used.
    const stagedKernelEntry = path.join(DIRS.dshPrefix, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    const needKernel = Boolean(kernelEntry) && !existsSync(stagedKernelEntry);
    if (!needNode && !needKernel) return { staged: true, skipped: true };

    const [lo, hi] = STEP_BANDS.stage;
    this.report({ phase: 'stage', percent: this.bandPercent('stage', 0), label: '正在准备运行环境' });
    const started = Date.now();
    const ticker = setInterval(() => {
      const ratio = Math.min(0.95, (Date.now() - started) / 12000);
      this.report({ percent: this.bandPercent('stage', ratio), label: '正在准备运行环境' });
    }, 600);

    try {
      if (needNode) {
        await copyTree(bundledNodeDir, DIRS.nodeRuntime);
        log('bootstrap', 'staged bundled node runtime', { to: DIRS.nodeRuntime });
      }
      if (needKernel) {
        // <vendor>/kernel holds the npm prefix (package.json + node_modules), which is exactly
        // the layout DIRS.dshPrefix expects.
        await copyTree(bundledKernelDir, DIRS.dshPrefix);
        log('bootstrap', 'staged bundled kernel', { to: DIRS.dshPrefix });
      }
    } finally {
      clearInterval(ticker);
    }
    this.report({ percent: this.bandPercent('stage', 1), label: '正在准备运行环境' });
    return { staged: true, node: needNode, kernel: needKernel };
  }

  // ---------------------------------------------------------------- detection

  /** Find an executable on PATH (handles the Windows .cmd shims). */
  findOnPath(names) {
    const pathValue = process.env.PATH || '';
    const exts = IS_WINDOWS ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';') : [''];
    for (const dir of pathValue.split(path.delimiter)) {
      if (!dir) continue;
      for (const name of names) {
        for (const ext of exts) {
          const candidate = path.join(dir, name + ext.toLowerCase());
          if (existsSync(candidate)) return candidate;
          const upper = path.join(dir, name + ext);
          if (upper !== candidate && existsSync(upper)) return upper;
        }
      }
    }
    return null;
  }

  /** Node/npm/dsh candidates shipped inside the app bundle or the app data dir. */
  localCandidates() {
    const list = [];
    const resources = process.resourcesPath;
    if (resources) {
      list.push(path.join(resources, 'vendor', 'node'));
      list.push(path.join(resources, 'runtime', 'node'));
      list.push(path.join(resources, 'node'));
    }
    list.push(path.join(__dirname, '..', '..', '..', 'vendor', 'node'));
    list.push(DIRS.nodeRuntime);
    return list;
  }

  /**
   * Directory holding the pre-staged runtime shipped with the app:
   *   <resources>/vendor/{node,kernel}
   * Present in a "batteries included" build; absent when the app was built without prebundling,
   * in which case the ladder below falls back to the network exactly as before.
   */
  bundledVendorDir() {
    const candidates = [];
    if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'vendor'));
    candidates.push(path.join(__dirname, '..', '..', '..', 'vendor'));
    for (const candidate of candidates) {
      if (existsSync(path.join(candidate, 'kernel')) || existsSync(path.join(candidate, 'node'))) return candidate;
    }
    return null;
  }

  /** Entry point of the pre-staged kernel, or null when this build has none. */
  bundledKernelEntry() {
    const vendor = this.bundledVendorDir();
    if (!vendor) return null;
    const entry = path.join(vendor, 'kernel', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    return existsSync(entry) ? entry : null;
  }

  /** Locate a Node runtime, preferring the app's own copy over the system one. */
  resolveNode() {
    const override = process.env.DEEPSEEK_DESKTOP_NODE_BIN;
    if (override && existsSync(override)) return override;
    for (const dir of this.localCandidates()) {
      const candidate = path.join(dir, IS_WINDOWS ? 'node.exe' : 'bin/node');
      if (existsSync(candidate)) return candidate;
    }
    return this.findOnPath(['node']);
  }

  /** Locate the npm CLI entry point (npm-cli.js), which needs no shell wrapper. */
  resolveNpmCli(nodeBin) {
    const override = process.env.DEEPSEEK_DESKTOP_NPM_CLI;
    if (override && existsSync(override)) return override;
    const near = [];
    if (nodeBin) {
      const root = path.dirname(path.dirname(nodeBin));
      near.push(path.join(root, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
      near.push(path.join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
      near.push(path.join(path.dirname(nodeBin), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    }
    for (const dir of this.localCandidates()) {
      near.push(path.join(dir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
      near.push(path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    }
    for (const candidate of near) if (existsSync(candidate)) return candidate;
    const global = this.findOnPath(IS_WINDOWS ? ['npm.cmd', 'npm'] : ['npm']);
    if (global) {
      const guess = path.join(path.dirname(global), 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (existsSync(guess)) return guess;
      const guess2 = path.join(path.dirname(global), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (existsSync(guess2)) return path.resolve(guess2);
    }
    return null;
  }

  /** Locate the dsh launcher, including the copy this app installed itself. */
  resolveDsh() {
    // The build-time bundle and its Node runtime are tested as one unit, so keep them paired.
    // This also supersedes an incomplete/stale first-run copy left by an older portable build.
    const bundled = this.bundledKernelEntry();
    if (bundled) return bundled;
    const binName = IS_WINDOWS ? 'dsh.cmd' : 'dsh';
    const installed = path.join(DIRS.dshPrefix, 'node_modules', '.bin', binName);
    if (existsSync(installed)) return installed;
    const installedUnix = path.join(DIRS.dshPrefix, 'node_modules', '.bin', 'dsh');
    if (existsSync(installedUnix)) return installedUnix;
    // A prefix whose .bin shims were not created still resolves through the package entry
    // point, which we can spawn with the bundled Node directly.
    const entry = this.dshEntryFromPrefix();
    if (entry) return entry;
    const onPath = this.findOnPath(IS_WINDOWS ? ['dsh.cmd', 'dsh.bat', 'dsh'] : ['dsh']);
    if (onPath) return onPath;
    // A dsh installed by npm -g but not exported on PATH.
    const npmPrefix = process.env.APPDATA && IS_WINDOWS ? path.join(process.env.APPDATA, 'npm') : null;
    if (npmPrefix) {
      const candidate = path.join(npmPrefix, IS_WINDOWS ? 'dsh.cmd' : 'dsh');
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  async resolveToolchain() {
    this.nodeBin = this.resolveNode();
    this.npmCli = this.nodeBin ? this.resolveNpmCli(this.nodeBin) : null;
    if (!this.dshBin) this.dshBin = this.resolveDsh();
    log('bootstrap', 'toolchain', { node: this.nodeBin, npmCli: this.npmCli, dsh: this.dshBin });
    this.report({ phase: 'detect', percent: this.bandPercent('detect', 1), label: '正在检查运行环境' });
  }

  // ------------------------------------------------------------------ runtime

  /** Download and unpack a portable Node.js runtime (Windows machines without Node). */
  async provideNodeRuntime() {
    const band = 'node';
    this.report({ percent: this.bandPercent(band, 0.05), phase: 'node', label: '正在准备运行环境' });

    const zipName = `node-${NODE_VERSION}-win-x64.zip`;
    const cacheZip = path.join(DIRS.cache, zipName);
    const destRoot = path.join(DIRS.nodeRuntime, `node-${NODE_VERSION}-win-x64`);

    if (!existsSync(path.join(destRoot, 'node.exe'))) {
      if (!existsSync(cacheZip) || fs.statSync(cacheZip).size < 1024 * 1024) {
        const url = `${NODE_MIRROR}/${NODE_VERSION}/${zipName}`;
        await this.download(url, cacheZip, (ratio) => {
          this.report({ percent: this.bandPercent(band, 0.05 + ratio * 0.6), label: '正在准备运行环境' });
        });
      }
      this.report({ percent: this.bandPercent(band, 0.72), label: '正在准备运行环境' });
      fs.mkdirSync(destRoot, { recursive: true });
      await this.unzip(cacheZip, destRoot);
    }
    this.nodeBin = path.join(destRoot, 'node.exe');
    fs.mkdirSync(DIRS.nodeRuntime, { recursive: true });
    writeJsonSync(path.join(DIRS.nodeRuntime, 'active.json'), { node: this.nodeBin, version: NODE_VERSION });
    this.report({ percent: this.bandPercent(band, 1), label: '正在准备运行环境' });
    return this.nodeBin;
  }

  /** Stream a URL to a file, reporting progress when the server sends a length. */
  async download(url, destination, onProgress) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const tmp = `${destination}.part`;
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`下载失败 (HTTP ${response.status})`);
    const total = Number(response.headers.get('content-length') || 0);
    let received = 0;
    const handle = fs.createWriteStream(tmp);
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (!handle.write(Buffer.from(value))) await new Promise((resolve) => handle.once('drain', resolve));
        if (total > 0) onProgress?.(received / total);
      }
    } finally {
      await new Promise((resolve) => handle.end(resolve));
    }
    fs.renameSync(tmp, destination);
    onProgress?.(1);
  }

  /** Expand a zip archive using the tools every supported Windows ships. */
  async unzip(archive, destination) {
    if (IS_WINDOWS) {
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${destination}' -Force`]);
      return;
    }
    await run('unzip', ['-oq', archive, '-d', destination]);
  }

  /**
   * Read the optional update package from the settings store. This is how a user on a machine
   * that cannot reach the public registry still gets the kernel: point "安装/更新包" at a
   * portable package path (folder or .tgz) and the next boot installs from there instead.
   * The override is used for exactly one boot and then cleared, so it can never pin a machine
   * to an old version by accident.
   */
  async resolveOverride() {
    try {
      // Required lazily: the ladder must stay usable before any Electron service exists.
      const { Store } = require('./store');
      const store = new Store('ui');
      const spec = store.get('kernelSpec', null);
      if (!spec || typeof spec !== 'string') return null;
      store.delete('kernelSpec');
      const normalized = /^file:/.test(spec) ? spec : `file:${spec}`;
      this.override = { spec: normalized, source: spec };
      log('bootstrap', 'installing kernel from a user-supplied package', { spec: normalized });
      return normalized;
    } catch (error) {
      log('bootstrap', 'override lookup failed', String(error));
      return null;
    }
  }

  // ------------------------------------------------------------------ install

  /** Install dsh into the app's own runtime prefix so the system stays untouched. */
  async installDsh() {
    const band = 'install';
    this.report({ phase: 'install', percent: this.bandPercent(band, 0), label: '正在安装运行组件' });

    // The installer may be reached without a prior detection pass (retry paths), so make
    // sure the toolchain is resolved before it is used.
    await this.resolveToolchain();

    if (IS_WINDOWS && (!this.nodeBin || !/node\.exe$/i.test(this.nodeBin))) {
      await this.provideNodeRuntime();
    }
    if (!this.nodeBin) throw new Error('未找到可用的运行环境');
    if (!this.npmCli) this.npmCli = this.resolveNpmCli(this.nodeBin);
    if (!this.npmCli) throw new Error('未找到可用的安装器');

    const prefix = DIRS.dshPrefix;
    fs.mkdirSync(prefix, { recursive: true });
    const args = [
      this.npmCli, 'install', '--prefix', prefix, '--no-audit', '--no-fund',
      '--loglevel', 'http', '--registry', NPM_MIRROR, this.override.spec ?? dshSpec(),
    ];

    const started = Date.now();
    let sawProgress = false;
    const handle = runStreaming(this.nodeBin, args, {
      env: { npm_config_cache: path.join(DIRS.cache, 'npm'), npm_config_update_notifier: 'false' },
      onLine: (line) => {
        if (/http fetch|reify|extract|\bGET\b/i.test(line)) {
          sawProgress = true;
          // npm gives no honest percentage; interpolate inside the band and switch to
          // the time-based ramp only while output keeps flowing.
          const ratio = clamp(0.05 + Math.min(0.55, (Date.now() - started) / 120000), 0.05, 0.6);
          this.report({ percent: this.bandPercent(band, ratio), label: '正在安装运行组件' });
        }
      },
    });

    const ticker = setInterval(() => {
      const elapsed = Date.now() - started;
      const ratio = clamp(0.1 + elapsed / 150000, 0.1, 0.82);
      this.report({
        percent: this.bandPercent(band, ratio),
        label: sawProgress ? '正在安装运行组件' : '正在下载运行组件',
      });
    }, 900);

    try {
      const { code } = await handle.done;
      if (code !== 0) throw new Error(`安装未完成 (退出码 ${code})`);
    } finally {
      clearInterval(ticker);
    }

    this.report({ phase: 'verify', percent: this.bandPercent('verify', 0.3), label: '正在校验组件' });
    this.resolveToolchainSync();
    // An explicit update must win over the immutable bundle for this and future launches.
    this.dshBin = this.dshEntryFromPrefix() ?? this.resolveDsh();
    if (!this.dshBin) throw new Error('组件安装后仍不可用');
    log('bootstrap', `kernel installed: ${this.kernelVersion() ?? 'unknown version'}`);
    this.report({ phase: 'verify', percent: this.bandPercent('verify', 1), label: '正在校验组件' });
  }

  /** Re-resolve node/npm/dsh from disk without touching the installer. */
  resolveToolchainSync() {
    this.nodeBin = this.resolveNode() ?? this.nodeBin;
    this.npmCli = this.npmCli ?? (this.nodeBin ? this.resolveNpmCli(this.nodeBin) : null);
    if (!this.dshBin) this.dshBin = this.resolveDsh();
  }

  /** Version of the kernel present in the app's prefix, read from its manifest. */
  kernelVersion() {
    const manifest = path.join(DIRS.dshPrefix, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
    try {
      return JSON.parse(fs.readFileSync(manifest, 'utf8')).version ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Resolve the real entry point (lib/bin.js) of an installed copy. On Windows the npm shim
   * is a .cmd batch file which Node cannot execute directly, so the entry point is what gets
   * spawned; on POSIX it is equally usable.
   */
  dshEntryFromPrefix() {
    const modulesRoot = path.join(DIRS.dshPrefix, 'node_modules');
    const candidates = [];
    // Prefer the declared bin path of whatever package was installed into the prefix.
    for (const name of ['dsh-install-stub', ...dshPackageNames()]) {
      const pkgRoot = name.startsWith('@')
        ? path.join(modulesRoot, ...name.split('/'))
        : path.join(modulesRoot, name);
      const manifest = path.join(pkgRoot, 'package.json');
      if (existsSync(manifest)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
          const bin = parsed.bin;
          const relative = typeof bin === 'string' ? bin : bin?.dsh;
          if (relative) candidates.push(path.join(pkgRoot, relative));
        } catch { /* malformed manifest: fall through to the default layout */ }
      }
      candidates.push(path.join(pkgRoot, 'lib', 'bin.js'));
    }
    for (const candidate of candidates) if (existsSync(candidate)) return candidate;
    return null;
  }

  /** Backwards-compatible alias used by the Windows spawn path. */
  dshBinPathFromShim() {
    return this.dshEntryFromPrefix() ?? this.dshBin;
  }

  // ------------------------------------------------------------------- server

  /** Ask the host for a free TCP port, starting at the preferred one. */
  async pickPort(preferred) {
    const net = require('node:net');
    const probe = (port) => new Promise((resolve) => {
      const server = net.createServer();
      server.unref();
      server.once('error', () => resolve(false));
      server.once('listening', () => server.close(() => resolve(true)));
      server.listen(port, '127.0.0.1');
    });
    for (let port = preferred; port < preferred + 40; port++) {
      // eslint-disable-next-line no-await-in-loop
      if (await probe(port)) return port;
    }
    return 0; // let the OS choose
  }

  /** Fetch a URL and distinguish a public/authorized shell from DSH's auth challenge. */
  async probeDshService(port, timeoutMs = 1500, cookie = null) {
    if (!port) return null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        signal: controller.signal,
        redirect: 'manual',
        headers: cookie ? { cookie } : undefined,
      });
      clearTimeout(timer);
      const body = await response.text();
      if (response.ok && /__DSH_BOOT__|dsh-client-modules|DeepSeek Harness/i.test(body)) {
        return { ready: true, authenticated: true, authRequired: false, status: response.status };
      }
      if (response.status === 401 && /dsh web authentication required|unauthorized/i.test(body)) {
        return { ready: true, authenticated: false, authRequired: true, status: response.status };
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Spawn the hidden web service; stdout is parsed for the authoritative URL. */
  async spawnServer(port) {
    const band = 'spawn';
    this.report({ phase: 'spawn', percent: this.bandPercent(band, 0.1), label: '正在启动服务' });

    try {
      if (!this.dshBin) throw new Error('未找到运行组件');
      this.report({ percent: this.bandPercent(band, 0.3), label: '正在启动服务' });

      // Prefer the app's own runtime: the pre-staged Node is a known-good version, while a
      // system Node on the target machine may be too old for the kernel.
      this.nodeBin = this.resolveNode();
      const entry = this.dshBin && /\.m?js$/i.test(this.dshBin)
        ? this.dshBin
        : (this.dshEntryFromPrefix() ?? this.bundledKernelEntry());
      // A .cmd shim cannot be spawned by Node directly on Windows, and going through the
      // entry point lets the app's own runtime execute the kernel everywhere.
      const useNodeEntry = Boolean(this.nodeBin) && Boolean(entry)
        && (IS_WINDOWS || /\.m?js$/i.test(this.dshBin ?? ''));
      const command = useNodeEntry ? this.nodeBin : this.dshBin;
      const args = useNodeEntry
        ? [entry, 'web', '--port', String(port), '--no-open']
        : ['web', '--port', String(port), '--no-open'];

      this.childResult = null;
      this.kernelOutput = [];
      this.authenticatedUrl = null;
      this.authCookie = null;
      fs.mkdirSync(DIRS.workspace, { recursive: true });
      const handle = runStreaming(command, args, {
        cwd: DIRS.workspace,
        env: {
          DSH_WEB_URL: `http://127.0.0.1:${port}`,
          // Keep profiles, auth secrets and sessions inside the portable/app data root instead
          // of sharing an unrelated global ~/.dsh installation.
          DSH_HOME: path.join(DIRS.root, 'harness'),
          FORCE_COLOR: '0',
          NO_COLOR: '1',
        },
        onLine: (line) => {
          const safeLine = this.redactKernelLine(line);
          this.kernelOutput.push(safeLine);
          if (this.kernelOutput.length > 16) this.kernelOutput.shift();
          const match = line.match(/https?:\/\/127\.0\.0\.1:(\d+)/) || line.match(/https?:\/\/localhost:(\d+)/);
          if (match) this.report({ port: Number(match[1]), percent: this.bandPercent(band, 0.6) });
          const launchUrl = line.match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/\?[^\s)]+/i)?.[0];
          if (launchUrl) {
            try {
              const parsed = new URL(launchUrl);
              if (parsed.searchParams.has('token')) this.authenticatedUrl = parsed.href;
            } catch { /* ignore an unrelated URL-looking line */ }
          }
          log('dsh-http', safeLine);
        },
      });
      this.child = handle.child;
      this.ownership = 'app';
      handle.done.then(({ code, signal }) => {
        this.childResult = { code, signal };
        log('bootstrap', `dsh web exited with code ${code}${signal ? ` (${signal})` : ''}`, {
          tail: this.kernelOutput.slice(-5),
        });
        if (!this.stopping && this.state.phase === 'ready') {
          const error = this.kernelExitError(code, signal);
          this.report({ phase: 'error', label: '服务异常退出', error: error.message, percent: 100 });
          this.onStopped?.({ code, signal, error: error.message });
        }
      });
      this.report({ percent: this.bandPercent(band, 0.7), label: '正在启动服务' });
      return handle;
    } catch (error) {
      throw error;
    }
  }

  /** Poll until the service answers, then record the base URL. */
  async awaitReady(port) {
    const band = 'ready';
    // `ready` is reserved for a service that has actually answered and remained alive. Older
    // builds set it before polling, turning an immediate launcher exit into the misleading
    // "100% / 服务已停止" screen.
    this.report({ phase: 'spawn', percent: this.bandPercent(band, 0.1), label: '正在等待服务' });
    const found = await waitFor(async () => {
      if (this.childResult) throw this.kernelExitError(this.childResult.code, this.childResult.signal);
      const probe = await this.probeDshService(port, 1500);
      // DSH 0.1.5+ protects the index and API with a launch-token exchange. The HTTP 401
      // proves the server is ready, but we also need its private URL before proceeding.
      if (probe?.authRequired && !this.authenticatedUrl) return null;
      return probe;
    }, { timeoutMs: 120000, intervalMs: 700, label: 'dsh web readiness' });

    if (!found) throw new Error('服务启动超时');
    if (found.authRequired) await this.exchangeLaunchToken();
    // A listening socket can appear just before an initialization failure. Require a short
    // stable interval so the main window never attaches to a process that is already dying.
    for (let check = 0; check < 3; check += 1) {
      await sleep(400);
      if (this.childResult) throw this.kernelExitError(this.childResult.code, this.childResult.signal);
      const probe = await this.probeDshService(port, 1500, this.authCookie);
      if (!probe?.authenticated) throw new Error('服务启动后未能保持运行');
    }
    this.state.baseUrl = `http://127.0.0.1:${port}`;
    this.state.port = port;
    this.report({ phase: 'ready', percent: 100, label: '准备完成', baseUrl: this.state.baseUrl, port });
    return this.state.baseUrl;
  }

  /** Exchange DSH's process token for the signed Cookie used by HTTP and WebSocket APIs. */
  async exchangeLaunchToken() {
    if (!this.authenticatedUrl) throw new Error('服务已启动，但未收到认证地址');
    const response = await fetch(this.authenticatedUrl, { redirect: 'manual' });
    if (response.status !== 303) throw new Error(`本地服务认证失败（HTTP ${response.status}）`);
    const setCookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean);
    const cookie = setCookies[0]?.split(';', 1)[0];
    if (!cookie || !cookie.includes('=')) throw new Error('本地服务认证未返回会话 Cookie');
    this.authCookie = cookie;
    log('bootstrap', 'local service authentication established');
    return cookie;
  }

  /** Remove process tokens and credentials before keeping output in logs or UI state. */
  redactKernelLine(line) {
    return String(line)
      .replace(/([?&](?:token|key|secret|authorization)=)[^&\s]+/gi, '$1[已隐藏]')
      .replace(/(bearer\s+)[\w.+\-/=]+/gi, '$1[已隐藏]');
  }

  /** Turn a premature child exit into a compact, actionable startup error. */
  kernelExitError(code, signal) {
    const status = signal ? `信号 ${signal}` : `退出码 ${code ?? '未知'}`;
    const tail = this.kernelOutput.slice().reverse().find((line) => line.trim());
    return new Error(`本地服务未能持续运行（${status}）${tail ? `：${tail}` : ''}`);
  }

  /** Stop the server this instance started (never touches a reused one). */
  async stop() {
    this.stopping = true;
    if (this.child) {
      killTree(this.child);
      this.child = null;
    }
  }

  get isOwner() {
    return this.ownership === 'app';
  }
}

module.exports = { Bootstrap, DEFAULT_PORT, STEP_BANDS, dshPackage, dshSpec, pinnedVersion };
