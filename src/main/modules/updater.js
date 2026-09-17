'use strict';
/**
 * Portable-build updater. It deliberately lives outside Electron's autoUpdater because our
 * shipped artifact is an extracted folder, not an installed NSIS application. New manifests
 * provide a hash-pinned native bootstrap: Electron starts it directly, waits for a ready-file
 * acknowledgement, and only then quits. This avoids the unreliable Electron -> PowerShell
 * detached-process handoff used by 0.2.6-0.2.10.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const { DIRS, log } = require('./util');
const { verifySignedManifest } = require('./update-trust');

const DEFAULT_MANIFEST_URL = 'https://img.uulucky.com/han/deepseek/latest.json';
const UPDATE_INTERVAL_MS = 60 * 60 * 1000;
const ALLOWED_PACKAGE_ORIGIN = 'https://img.uulucky.com';

class PortableUpdater {
  constructor(options = {}) {
    this.currentVersion = String(options.currentVersion || '0.0.0');
    this.manifestUrl = options.manifestUrl || DEFAULT_MANIFEST_URL;
    this.platform = options.platform || process.platform;
    this.arch = options.arch || process.arch;
    this.portable = options.portable ?? false;
    this.appRoot = options.appRoot || null;
    this.executable = options.executable || process.execPath;
    this.dataRoot = options.dataRoot || DIRS.root;
    this.fetch = options.fetch || globalThis.fetch;
    this.spawn = options.spawn || spawn;
    this.quit = options.quit || (() => {});
    this.onState = options.onState || (() => {});
    this.allowedPackageOrigin = options.allowedPackageOrigin || ALLOWED_PACKAGE_ORIGIN;
    this.trustedKeys = options.trustedKeys;
    this.manifest = null;
    this.package = null;
    this.checkPromise = null;
    this.installPromise = null;
    this.state = {
      status: 'idle',
      currentVersion: this.currentVersion,
      availableVersion: null,
      progress: 0,
      checkedAt: null,
      error: null,
      portable: this.portable,
    };
  }

  get() {
    return { ...this.state };
  }

  publish(patch) {
    this.state = { ...this.state, ...patch };
    try { this.onState(this.get()); } catch { /* renderer may be closing */ }
    return this.get();
  }

  async check({ manual = false } = {}) {
    if (this.checkPromise) return this.checkPromise;
    this.checkPromise = this.checkNow(manual).finally(() => { this.checkPromise = null; });
    return this.checkPromise;
  }

  async checkNow(manual) {
    const previousAvailable = this.state.status === 'available' ? this.get() : null;
    this.publish({ status: 'checking', error: null });
    try {
      if (typeof this.fetch !== 'function') throw new Error('当前运行环境不支持下载更新');
      const separator = this.manifestUrl.includes('?') ? '&' : '?';
      const response = await this.fetch(`${this.manifestUrl}${separator}t=${Date.now()}`, {
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
        headers: { accept: 'application/json' },
      });
      if (!response?.ok) throw new Error(`版本服务器返回 HTTP ${response?.status ?? 0}`);
      const manifest = await response.json();
      verifySignedManifest(manifest, this.trustedKeys);
      const target = manifest?.platforms?.[`${this.platform}-${this.arch}`] ?? manifest?.package;
      validateManifest(manifest, target, this.allowedPackageOrigin);
      this.manifest = manifest;
      this.package = target;
      const available = compareVersions(manifest.version, this.currentVersion) > 0;
      const state = this.publish({
        status: available ? 'available' : 'current',
        availableVersion: available ? manifest.version : null,
        notes: Array.isArray(manifest.notes) ? manifest.notes.slice(0, 8) : [],
        progress: 0,
        checkedAt: Date.now(),
        error: null,
      });
      log('update', available ? `version ${manifest.version} available` : 'already current', {
        current: this.currentVersion,
      });
      return state;
    } catch (error) {
      log('update', 'version check failed', String(error));
      if (previousAvailable && !manual) {
        return this.publish({ ...previousAvailable, checkedAt: Date.now(), error: String(error?.message ?? error) });
      }
      return this.publish({ status: 'error', checkedAt: Date.now(), error: String(error?.message ?? error) });
    }
  }

  async install() {
    if (this.installPromise) return this.installPromise;
    this.installPromise = this.installNow().finally(() => { this.installPromise = null; });
    return this.installPromise;
  }

  async installNow() {
    if (!this.portable || this.platform !== 'win32') {
      throw new Error('自动更新仅支持 Windows 便携版');
    }
    if (!this.appRoot) throw new Error('无法确定软件安装目录');
    if (!this.package || compareVersions(this.manifest?.version, this.currentVersion) <= 0) {
      await this.check({ manual: true });
    }
    if (!this.package || compareVersions(this.manifest?.version, this.currentVersion) <= 0) {
      throw new Error(this.state.error || '当前已是最新版本');
    }

    // Verify again at the handoff boundary; a caller cannot bypass checkNow by assigning
    // package state, and no executable is downloaded from an unsigned descriptor.
    verifySignedManifest(this.manifest, this.trustedKeys);
    const signedTarget = this.manifest.platforms?.[`${this.platform}-${this.arch}`];
    validateManifest(this.manifest, signedTarget, this.allowedPackageOrigin);
    this.package = signedTarget;

    const updateDir = path.join(this.dataRoot, 'update');
    fs.mkdirSync(updateDir, { recursive: true });
    const safeVersion = String(this.manifest.version).replace(/[^0-9A-Za-z._-]/g, '');
    const delivery = this.package.bootstrap?.format === 'bootstrap-exe'
      ? this.package.bootstrap
      : this.package;
    const directBootstrap = delivery.format === 'bootstrap-exe';
    const packageFile = path.join(updateDir, directBootstrap
      ? `DeepSeekDesktop-${safeVersion}-update-bootstrap.exe`
      : `DeepSeekDesktop-${safeVersion}-portable.zip`);
    const partialFile = `${packageFile}.download`;
    try { fs.rmSync(partialFile, { force: true }); } catch { /* best effort */ }
    this.publish({ status: 'downloading', progress: 0, error: null });

    try {
      const response = await this.fetch(delivery.url, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30 * 60 * 1000) });
      if (!response?.ok || !response.body) throw new Error(`更新包下载失败 (HTTP ${response?.status ?? 0})`);
      const expectedSize = Number(delivery.size || 0);
      const reportedSize = Number(response.headers?.get?.('content-length') || 0);
      const total = expectedSize || reportedSize;
      const hash = crypto.createHash('sha256');
      let received = 0;
      let lastPercent = -1;
      const meter = new Transform({
        transform: (chunk, _encoding, callback) => {
          received += chunk.length;
          hash.update(chunk);
          const percent = total > 0 ? Math.min(99, Math.floor(received * 100 / total)) : 0;
          if (percent !== lastPercent) {
            lastPercent = percent;
            this.publish({ status: 'downloading', progress: percent });
          }
          callback(null, chunk);
        },
      });
      const source = typeof Readable.fromWeb === 'function' && typeof response.body?.getReader === 'function'
        ? Readable.fromWeb(response.body)
        : Readable.from(response.body);
      await pipeline(source, meter, fs.createWriteStream(partialFile));

      const digest = hash.digest('hex').toLowerCase();
      if (expectedSize && received !== expectedSize) throw new Error(`更新包大小校验失败：${received}/${expectedSize}`);
      if (digest !== String(delivery.sha256).toLowerCase()) throw new Error('更新包 SHA-256 校验失败');
      fs.renameSync(partialFile, packageFile);

      if (directBootstrap) {
        return await this.launchBootstrap(packageFile, updateDir, safeVersion, received);
      }

      // Compatibility path for manifests made before the native bootstrap handoff existed.
      const scriptFile = path.join(updateDir, 'apply-update.ps1');
      fs.writeFileSync(scriptFile, updaterScript(), 'utf8');
      this.publish({ status: 'installing', progress: 100, error: null });
      log('update', 'package verified; launching installer', { version: this.manifest.version, bytes: received });

      const windowsPowerShell = process.env.SystemRoot
        ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : 'powershell.exe';
      const child = this.spawn(windowsPowerShell, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', scriptFile,
        '-Package', packageFile,
        '-AppRoot', this.appRoot,
        '-ExeName', path.basename(this.executable),
        '-ParentPid', String(process.pid),
      ], { detached: true, windowsHide: true, stdio: 'ignore', shell: false });
      await waitForSpawn(child);
      log('update', 'installer helper started', { pid: child.pid });
      child.unref?.();
      setTimeout(() => this.quit(), 150).unref?.();
      return this.get();
    } catch (error) {
      try { fs.rmSync(partialFile, { force: true }); } catch { /* best effort */ }
      this.publish({ status: 'available', progress: 0, error: String(error?.message ?? error) });
      throw error;
    }
  }

  /** Launch the native updater and require proof that it is alive before closing Electron. */
  async launchBootstrap(bootstrapFile, updateDir, safeVersion, received) {
    const readyFile = path.join(updateDir, `bootstrap-${safeVersion}.ready`);
    const payloadFile = path.join(updateDir, `update-payload-${safeVersion}.zip`);
    const handoffLog = path.join(this.dataRoot, 'logs', 'update-handoff.log');
    try { fs.rmSync(readyFile, { force: true }); } catch { /* best effort */ }
    this.publish({ status: 'installing', progress: 100, error: null });
    appendHandoffLog(handoffLog, `starting native bootstrap ${bootstrapFile}`);
    log('update', 'bootstrap verified; starting native handoff', { version: safeVersion, bytes: received });

    let child;
    try {
      child = this.spawn(bootstrapFile, [
        '--app-root', this.appRoot,
        '--payload', payloadFile,
        '--exe-name', path.basename(this.executable),
        '--ready-file', readyFile,
      ], { detached: true, windowsHide: false, stdio: 'ignore', shell: false });
      await waitForSpawn(child);
      await waitForReadyFile(readyFile, child);
    } catch (error) {
      appendHandoffLog(handoffLog, `FAILED: ${String(error?.message ?? error)}`);
      throw error;
    }

    appendHandoffLog(handoffLog, `bootstrap acknowledged pid=${child?.pid ?? 'unknown'}; quitting application`);
    log('update', 'native bootstrap acknowledged', { pid: child?.pid, readyFile });
    child.unref?.();
    setTimeout(() => this.quit(), 150).unref?.();
    return this.get();
  }
}

function appendHandoffLog(file, message) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch { /* the main journal still records the same handoff */ }
}

function waitForSpawn(child, timeoutMs = 5000) {
  if (!child || typeof child.once !== 'function') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('无法启动更新程序（等待进程启动超时）'));
    }, timeoutMs);
    timer.unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener?.('spawn', onSpawn);
      child.removeListener?.('error', onError);
    };
    const onSpawn = () => { cleanup(); resolve(); };
    const onError = (error) => { cleanup(); reject(new Error(`无法启动更新程序：${error.message}`)); };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

/** The bootstrap writes this acknowledgement only after its log and single-instance lock exist. */
function waitForReadyFile(file, child, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      child?.removeListener?.('exit', onExit);
      child?.removeListener?.('error', onError);
    };
    const finish = (error) => {
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onExit = (code) => finish(new Error(`更新引导程序在确认启动前退出（代码 ${code ?? '未知'}）`));
    const onError = (error) => finish(new Error(`更新引导程序启动失败：${error.message}`));
    const poll = () => {
      if (fs.existsSync(file)) return finish();
      if (child?.exitCode !== null && child?.exitCode !== undefined) return onExit(child.exitCode);
      if (Date.now() - startedAt >= timeoutMs) return finish(new Error('更新引导程序未确认启动，软件将保持打开'));
      timer = setTimeout(poll, 50);
    };
    child?.once?.('exit', onExit);
    child?.once?.('error', onError);
    poll();
  });
}

function validateManifest(manifest, target, allowedOrigin = ALLOWED_PACKAGE_ORIGIN) {
  if (!manifest || typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new Error('版本清单格式无效');
  }
  validateTarget(target, allowedOrigin);
  if (target.bootstrap !== undefined) {
    if (target.bootstrap?.format !== 'bootstrap-exe') throw new Error('版本清单中的更新引导程序格式无效');
    validateTarget(target.bootstrap, allowedOrigin);
  }
}

function validateTarget(target, allowedOrigin) {
  if (!target || typeof target.url !== 'string' || !/^[a-f0-9]{64}$/i.test(String(target.sha256 || ''))) {
    throw new Error('版本清单缺少更新包或校验值');
  }
  const url = new URL(target.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash
    || (allowedOrigin && url.origin !== allowedOrigin)) {
    throw new Error('版本清单包含未受信任的下载地址');
  }
  if (target.size !== undefined && (!Number.isSafeInteger(Number(target.size)) || Number(target.size) <= 0)) {
    throw new Error('版本清单中的更新包大小无效');
  }
}

function compareVersions(left, right) {
  const parts = (value) => String(value || '0').split(/[.+-]/, 3).map((item) => Number.parseInt(item, 10) || 0);
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function updaterScript() {
  return String.raw`param(
  [Parameter(Mandatory=$true)][string]$Package,
  [Parameter(Mandatory=$true)][string]$AppRoot,
  [Parameter(Mandatory=$true)][string]$ExeName,
  [Parameter(Mandatory=$true)][int]$ParentPid
)
$ErrorActionPreference = 'Stop'
$UpdateRoot = Join-Path $AppRoot 'data\update'
$LogDir = Join-Path $AppRoot 'data\logs'
$LogFile = Join-Path $LogDir 'update.log'
$Work = Join-Path $UpdateRoot ('w' + $ParentPid)
$Installed = $false
New-Item -ItemType Directory -Path $UpdateRoot -Force | Out-Null
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
function Write-UpdateLog([string]$Message) {
  Add-Content -LiteralPath $LogFile -Value ((Get-Date).ToString('o') + ' ' + $Message) -Encoding UTF8
}
try {
  Write-UpdateLog ('waiting for process ' + $ParentPid)
  Wait-Process -Id $ParentPid -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
  if (Test-Path -LiteralPath $Work) { Remove-Item -LiteralPath $Work -Recurse -Force }
  New-Item -ItemType Directory -Path $Work -Force | Out-Null
  Write-UpdateLog ('extracting ' + $Package)
  Expand-Archive -LiteralPath $Package -DestinationPath $Work -Force
  $Source = Get-ChildItem -LiteralPath $Work -Directory | Where-Object {
    Test-Path -LiteralPath (Join-Path $_.FullName $ExeName)
  } | Select-Object -First 1
  if (-not $Source) { throw '更新包中没有找到应用程序' }
  foreach ($Item in (Get-ChildItem -LiteralPath $Source.FullName -Force)) {
    if ($Item.Name -ieq 'data') { continue }
    $Target = Join-Path $AppRoot $Item.Name
    $Applied = $false
    for ($Attempt = 1; $Attempt -le 30 -and -not $Applied; $Attempt++) {
      try {
        if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Recurse -Force }
        Copy-Item -LiteralPath $Item.FullName -Destination $Target -Recurse -Force
        $Applied = $true
      } catch {
        if ($Attempt -eq 30) { throw }
        Start-Sleep -Seconds 1
      }
    }
  }
  Write-UpdateLog ('launching ' + (Join-Path $AppRoot $ExeName))
  Start-Process -FilePath (Join-Path $AppRoot $ExeName) -WorkingDirectory $AppRoot
  $Installed = $true
  Write-UpdateLog 'handoff started successfully'
} catch {
  Write-UpdateLog ('FAILED: ' + $_.Exception.ToString())
  $CurrentExe = Join-Path $AppRoot $ExeName
  if (Test-Path -LiteralPath $CurrentExe) {
    Start-Process -FilePath $CurrentExe -WorkingDirectory $AppRoot -ErrorAction SilentlyContinue
    Write-UpdateLog 'restarted the existing application after failure'
  }
} finally {
  Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue
  if ($Installed) { Remove-Item -LiteralPath $Package -Force -ErrorAction SilentlyContinue }
}
`;
}

module.exports = {
  PortableUpdater,
  DEFAULT_MANIFEST_URL,
  UPDATE_INTERVAL_MS,
  compareVersions,
  validateManifest,
  updaterScript,
  waitForReadyFile,
};
