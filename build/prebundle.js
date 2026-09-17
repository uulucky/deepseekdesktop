'use strict';
/**
 * Stages everything the client would otherwise download on first run:
 *
 *   vendor/node/     portable Node.js for Windows (the runtime that spawns the kernel)
 *   vendor/kernel/   the harness kernel installed with production dependencies for win32-x64
 *
 * Packaged builds execute both directly from their immutable resources directory, which turns
 * a first launch from "download ~130 MB" into a quick local compatibility check.
 *
 *   node build/prebundle.js                 # both (downloads Node if missing)
 *   node build/prebundle.js --only=kernel   # just refresh the kernel
 *   node build/prebundle.js --only=node     # just refresh the portable runtime
 *
 * Mirrors are honoured through the same env vars the app itself uses.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const pins = require('./runtime-pins.json');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor');
const NODE_VERSION = pins.nodeVersion;
const MINIMUM_NODE_MAJOR = 24;
const NODE_MIRROR = process.env.DEEPSEEK_DESKTOP_NODE_MIRROR || 'https://nodejs.org/dist';
const NPM_REGISTRY = process.env.DEEPSEEK_DESKTOP_NPM_REGISTRY || 'https://registry.npmjs.org';
const only = (process.argv.find((arg) => arg.startsWith('--only=')) || '').split('=')[1] || 'all';

const log = (...args) => console.log('[prebundle]', ...args);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.status !== 0) throw new Error(command + ' ' + args.join(' ') + ' exited with ' + result.status);
}

/** Recursive size in bytes. */
function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
}

function countFiles(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) total += countFiles(path.join(dir, entry.name));
    else total += 1;
  }
  return total;
}

/** Download a file with a progress line. */
async function download(url, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error('download failed: HTTP ' + response.status + ' ' + url);
  const total = Number(response.headers.get('content-length') || 0);
  let received = 0;
  const handle = fs.createWriteStream(destination);
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (!handle.write(Buffer.from(value))) await new Promise((resolve) => handle.once('drain', resolve));
    if (total) process.stdout.write('\r  ' + (received / 1048576).toFixed(1) + ' / ' + (total / 1048576).toFixed(1) + ' MB');
  }
  await new Promise((resolve) => handle.end(resolve));
  process.stdout.write('\n');
}

/** Portable Node.js runtime for Windows. */
async function stageNode() {
  const dest = path.join(VENDOR, 'node');
  const exe = path.join(dest, 'node.exe');
  const markerFile = path.join(dest, '.deepseek-runtime.json');
  let marker = null;
  try { marker = JSON.parse(fs.readFileSync(markerFile, 'utf8')); } catch { /* old bundle */ }
  if (fs.existsSync(exe) && marker?.nodeVersion === NODE_VERSION) {
    log('node runtime already staged: ' + exe + ' (' + (dirSize(dest) / 1048576).toFixed(1) + ' MB)');
    return;
  }
  if (fs.existsSync(exe)) log('replacing stale Node runtime with ' + NODE_VERSION);
  const zip = path.join(VENDOR, 'node-' + NODE_VERSION + '-win-x64.zip');
  if (!fs.existsSync(zip) || fs.statSync(zip).size < 1048576) {
    const url = NODE_MIRROR + '/' + NODE_VERSION + '/node-' + NODE_VERSION + '-win-x64.zip';
    log('downloading ' + url);
    await download(url, zip);
  }
  const digest = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
  if (digest !== pins.nodeWindowsX64Sha256) throw new Error('Official Node archive SHA-256 mismatch; refusing extraction');
  log('extracting ' + path.basename(zip));
  const staging = path.join(VENDOR, '.node-staging');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const unzip = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:DS_BUILD_ARCHIVE -DestinationPath $env:DS_BUILD_STAGING -Force'], { env: { ...process.env, DS_BUILD_ARCHIVE: zip, DS_BUILD_STAGING: staging } })
    : spawnSync('unzip', ['-oq', zip, '-d', staging]);
  if (unzip.status !== 0) throw new Error('unzip failed — extract ' + zip + ' manually into ' + dest);
  const inner = fs.readdirSync(staging).find((name) => name.startsWith('node-'));
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(path.join(staging, inner), dest, { recursive: true });
  fs.writeFileSync(markerFile, JSON.stringify({ nodeVersion: NODE_VERSION, platform: 'win32', arch: 'x64' }, null, 2));
  fs.rmSync(staging, { recursive: true, force: true });
  if (!fs.existsSync(exe)) throw new Error('node.exe missing after extraction');
  log('node runtime staged: ' + dest + ' (' + (dirSize(dest) / 1048576).toFixed(1) + ' MB)');
}

/** Fail packaging when the staged runtime cannot execute the staged kernel entry. */
function verifyRuntimeContract() {
  const markerFile = path.join(VENDOR, 'node', '.deepseek-runtime.json');
  const entry = path.join(VENDOR, 'kernel', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  let marker;
  try { marker = JSON.parse(fs.readFileSync(markerFile, 'utf8')); } catch {
    throw new Error('bundled Node runtime marker is missing; run prebundle without --only=kernel');
  }
  const major = Number(String(marker.nodeVersion || '').match(/^v?(\d+)/)?.[1]);
  if (!Number.isFinite(major) || major < MINIMUM_NODE_MAJOR) {
    throw new Error(`bundled Node ${marker.nodeVersion || 'unknown'} is incompatible with DSH; Node ${MINIMUM_NODE_MAJOR}+ is required`);
  }
  if (!fs.existsSync(entry)) throw new Error('kernel entry point is missing: ' + entry);
  const source = fs.readFileSync(entry, 'utf8');
  if (source.includes('import.meta.main') && major < 24) {
    throw new Error('DSH uses import.meta.main but the bundled Node runtime is older than 24');
  }
  log('runtime contract verified: ' + marker.nodeVersion + ' + DSH kernel');
}

/** Kernel with production dependencies, resolved for win32-x64. */
function stageKernel() {
  const dest = path.join(VENDOR, 'kernel');
  log('installing kernel with production dependencies for win32-x64');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'kernel', 'package.json'), path.join(dest, 'package.json'));
  fs.copyFileSync(path.join(__dirname, 'kernel', 'package-lock.json'), path.join(dest, 'package-lock.json'));

  // --os/--cpu make npm resolve the win32-x64 optional packages (sharp, koffi prebuilds);
  // --ignore-scripts stops native modules from being compiled for the *build* machine, which
  // is exactly what would otherwise put macOS binaries (or a failed build) into the bundle.
  const args = [
    'ci', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error',
    '--os=win32', '--cpu=x64', '--ignore-scripts',
    '--registry', NPM_REGISTRY,
  ];
  const npmCli = process.env.DEEPSEEK_DESKTOP_NPM_CLI;
  const cli = npmCli || process.env.npm_execpath;
  if (cli) run(process.execPath, [cli, ...args], { cwd: dest });
  else if (process.platform === 'win32') run(process.execPath, [path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), ...args], { cwd: dest });
  else run('npm', args, { cwd: dest });

  const entry = path.join(dest, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (!fs.existsSync(entry)) throw new Error('kernel entry point missing after install: ' + entry);
  const before = dirSize(dest);
  pruneBundle(dest);
  const manifest = JSON.parse(fs.readFileSync(path.join(dest, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
  if (manifest.version !== pins.kernelVersion) throw new Error('Staged Harness does not match reviewed runtime pins');
  log('kernel staged: ' + manifest.name + '@' + manifest.version
    + ' (' + (before / 1048576).toFixed(1) + ' MB -> ' + (dirSize(dest) / 1048576).toFixed(1) + ' MB, '
    + countFiles(dest) + ' files)');
}

/**
 * Trim what a Windows-only runtime never reads: prebuilt binaries for other platforms, type
 * definitions, source maps, docs and test fixtures. Everything here is safe to drop — Node
 * resolves neither .d.ts nor .map at runtime, and native modules pick their own platform's
 * prebuild — and it keeps the shipped archive noticeably smaller.
 */
function pruneBundle(root) {
  // A directory is treated as "another platform's package" only when it looks like an npm
  // package name (or a package's own platform folder): \`sharp-darwin-arm64\`,
  // \`@koromix/koffi-linux-x64\`, \`node-addon-require-builtin-darwin-arm64\`. Sub-directories such
  // as node-pty's \`prebuilds/<platform>\` are matched by their full path instead, so the shape of
  // the tree is never guessed from a leaf name alone.
  const KEEP = 'win32-x64';
  const PLATFORM = /(darwin|linux|freebsd|android|openbsd|sunos)[-_](arm64|x64|ia32|arm|riscv64|loong64|ppc64|s390x)|win32-(arm64|ia32)/;
  let removed = 0;
  let bytes = 0;

  const drop = (full) => {
    bytes += dirSize(full);
    fs.rmSync(full, { recursive: true, force: true });
    removed += 1;
  };

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('prebuilds')) {
          // Native modules ship one folder per platform here; keep only the target one.
          for (const inner of fs.readdirSync(full, { withFileTypes: true })) {
            if (inner.isDirectory() && inner.name !== KEEP && PLATFORM.test(inner.name)) drop(path.join(full, inner.name));
          }
          continue;
        }
        if (entry.name !== KEEP && PLATFORM.test(entry.name)) {
          drop(full);
          continue;
        }
        if (entry.name === 'docs') {
          drop(full);
          continue;
        }
        walk(full);
        continue;
      }
      if (entry.name.endsWith('.map') || entry.name.endsWith('.d.ts') || entry.name.endsWith('.d.mts')
        || entry.name === 'CHANGELOG.md' || entry.name === 'README.md' || entry.name === 'readme.md') {
        bytes += fs.statSync(full).size;
        fs.rmSync(full, { force: true });
        removed += 1;
      }
    }
  };
  walk(root);
  log('pruned ' + removed + ' entries (' + (bytes / 1048576).toFixed(1) + ' MB)');
}

async function main() {
  fs.mkdirSync(VENDOR, { recursive: true });
  if (only === 'all' || only === 'node') await stageNode();
  if (only === 'all' || only === 'kernel') stageKernel();
  verifyRuntimeContract();
  log('vendor total: ' + (dirSize(VENDOR) / 1048576).toFixed(1) + ' MB');
}

main().catch((error) => {
  console.error('[prebundle] failed: ' + error.message);
  process.exit(1);
});
