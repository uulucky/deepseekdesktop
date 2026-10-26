'use strict';
/**
 * Install or remove one curated plugin in the kernel's `web` profile, the same way
 * `dsh plugin --profile web add` does, but driven from the desktop so it also works on
 * Windows (dsh spawns a bare `pnpm`, which cannot run a .cmd shim there).
 *
 * pnpm comes from the bundled Node's corepack at a pinned version; pnpm 10 refuses dependency
 * build scripts by default. After `add`, the lockfile's integrity must equal the catalog's
 * pinned `dist.integrity` or the change is rolled back. A package that declares `dsh.bundle`
 * joins `dsh.profile.bundles`, as dsh's own reconcile step does. Changes apply on the next
 * local-service restart.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { CATALOG, verdictFor } = require('./plugin-catalog');
const { pathKey } = require('./media-tools');

const PNPM = 'pnpm@10.34.9';
const TIMEOUT_MS = 10 * 60 * 1000;

function profileDir(dataRoot) {
  return path.join(dataRoot, 'harness', 'profiles', 'web');
}

function readManifest(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
}

function writeManifest(dir, manifest) {
  const file = path.join(dir, 'package.json');
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/** `{ [name]: version }` for catalog plugins currently in the profile. */
function installedPlugins(dataRoot) {
  try {
    const deps = readManifest(profileDir(dataRoot)).dependencies ?? {};
    return Object.fromEntries(CATALOG.filter((plugin) => deps[plugin.name]).map((plugin) => [plugin.name, deps[plugin.name]]));
  } catch { return {}; }
}

function corepackScript(nodeBin) {
  const dir = path.dirname(nodeBin);
  return [
    path.join(dir, '..', 'lib', 'node_modules', 'corepack', 'dist', 'corepack.js'),
    path.join(dir, 'node_modules', 'corepack', 'dist', 'corepack.js'),
  ].find((file) => fs.existsSync(file)) ?? null;
}

function runPnpm({ nodeBin, cwd, args, runtimeDir }) {
  const script = corepackScript(nodeBin);
  if (!script) return Promise.reject(new Error('内置运行环境缺少 corepack，无法安装插件'));
  const key = pathKey(process.env);
  const separator = process.platform === 'win32' ? ';' : ':';
  const registry = process.env.DEEPSEEK_DESKTOP_NPM_REGISTRY;
  const env = {
    ...process.env,
    [key]: [path.dirname(nodeBin), process.env[key]].filter(Boolean).join(separator),
    COREPACK_HOME: path.join(runtimeDir, 'corepack'),
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    COREPACK_ENABLE_STRICT: '0',
    npm_config_store_dir: path.join(runtimeDir, 'pnpm-store'),
    ...(registry ? { npm_config_registry: registry, COREPACK_NPM_REGISTRY: registry } : {}),
  };
  return new Promise((resolve, reject) => {
    let output = '';
    const child = spawn(nodeBin, [script, PNPM, ...args], { cwd, env, windowsHide: true });
    const timer = setTimeout(() => { child.kill(); reject(new Error('安装超时，请检查网络后重试')); }, TIMEOUT_MS);
    const collect = (chunk) => { output = (output + chunk).slice(-8000); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(Object.assign(new Error(`pnpm 退出码 ${code}`), { output }));
    });
  });
}

function lockedIntegrity(dir, name, version) {
  let lock = '';
  try { lock = fs.readFileSync(path.join(dir, 'pnpm-lock.yaml'), 'utf8'); } catch { return null; }
  const escaped = `${name}@${version}`.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const match = new RegExp(`\\n  '?${escaped}'?:\\n    resolution: \\{integrity: (sha512-[A-Za-z0-9+/=]+)\\}`).exec(lock);
  return match?.[1] ?? null;
}

function declaresBundle(dir, name) {
  try {
    return readManifest(path.join(dir, 'node_modules', ...name.split('/'))).dsh?.bundle?.patch !== undefined;
  } catch { return false; }
}

function setBundle(dir, name, present) {
  const manifest = readManifest(dir);
  const bundles = [...(manifest.dsh?.profile?.bundles ?? [])];
  const index = bundles.indexOf(name);
  if (present && index === -1) bundles.push(name);
  if (!present && index !== -1) bundles.splice(index, 1);
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } };
  writeManifest(dir, manifest);
}

/** Install a catalog plugin verified on `kernelVersion`; resolves with the installed map. */
async function installPlugin({ dataRoot, runtimeDir, nodeBin, kernelVersion, name }) {
  const plugin = CATALOG.find((item) => item.name === name);
  if (!plugin) throw new Error('不在精选插件列表中');
  if (verdictFor(plugin, kernelVersion) !== 'works') throw new Error(`该插件未在当前内核 ${kernelVersion ?? '未知'} 上实测通过，暂不允许安装`);
  if (!nodeBin) throw new Error('本地服务尚未启动，请稍后重试');
  const dir = profileDir(dataRoot);
  if (!fs.existsSync(path.join(dir, 'package.json'))) throw new Error('插件目录尚未初始化，请先完整启动一次本地服务');
  const before = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
  await runPnpm({ nodeBin, cwd: dir, runtimeDir, args: ['add', `${plugin.name}@${plugin.version}`, '--save-exact', '--config.confirmModulesPurge=false'] });
  const integrity = lockedIntegrity(dir, plugin.name, plugin.version);
  if (integrity !== plugin.integrity) {
    await runPnpm({ nodeBin, cwd: dir, runtimeDir, args: ['remove', plugin.name, '--config.confirmModulesPurge=false'] }).catch(() => {});
    fs.writeFileSync(path.join(dir, 'package.json'), before, 'utf8');
    throw new Error('下载的插件与审阅版本的完整性校验不一致，已撤销安装');
  }
  setBundle(dir, plugin.name, declaresBundle(dir, plugin.name));
  return installedPlugins(dataRoot);
}

async function removePlugin({ dataRoot, runtimeDir, nodeBin, name }) {
  const plugin = CATALOG.find((item) => item.name === name);
  if (!plugin) throw new Error('不在精选插件列表中');
  const dir = profileDir(dataRoot);
  if (!installedPlugins(dataRoot)[plugin.name]) return installedPlugins(dataRoot);
  // Unregister first: even if pnpm fails, the kernel stops loading the plugin.
  setBundle(dir, plugin.name, false);
  if (nodeBin) await runPnpm({ nodeBin, cwd: dir, runtimeDir, args: ['remove', plugin.name, '--config.confirmModulesPurge=false'] });
  else {
    const manifest = readManifest(dir);
    delete manifest.dependencies?.[plugin.name];
    writeManifest(dir, manifest);
  }
  return installedPlugins(dataRoot);
}

module.exports = { installPlugin, removePlugin, installedPlugins, lockedIntegrity, profileDir, corepackScript };
