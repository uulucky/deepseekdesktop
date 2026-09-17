'use strict';
/**
 * Compatibility helpers for persisting Harness credentials.
 *
 * Current Harness builds expose credentials/set over the local RPC surface. Some users can
 * still have an older, unauthenticated Harness occupying the preferred port, and those builds
 * answer the rest of the desktop API while returning HTTP 404 for that one route. The desktop
 * normally avoids those foreign kernels; this file is the last-resort write path for an owned
 * Harness whose settings controller is missing or still starting.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DIRS, log, sleep } = require('./util');

const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/;

function credentialFile() {
  return path.join(DIRS.root, 'harness', '.credentials.yaml');
}

function loadYaml() {
  try { return require('yaml'); } catch { /* compatibility with older packages */ }
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'vendor', 'kernel', 'node_modules', 'yaml'));
  candidates.push(path.join(__dirname, '..', '..', '..', 'vendor', 'kernel', 'node_modules', 'yaml'));
  for (const candidate of candidates) {
    try { return require(candidate); } catch { /* try the next packaged location */ }
  }
  throw new Error('本地凭据组件不可用，请重新安装最新版客户端');
}

function isMissingCredentialsRoute(error) {
  const message = String(error?.message ?? error ?? '');
  return /credentials\/(?:set|describe).*?(?:HTTP\s*404|not[ -]?found)|(?:HTTP\s*404|not[ -]?found).*?credentials\/(?:set|describe)/i.test(message);
}

async function acquireLock(lockFile, waitMs = 5000) {
  const deadline = Date.now() + waitMs;
  let delay = 20;
  for (;;) {
    try {
      const handle = await fs.promises.open(lockFile, 'wx', 0o600);
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      return;
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error?.code) || Date.now() >= deadline) throw error;
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 200);
  }
}

async function renameWithRetry(from, to) {
  let delay = 20;
  for (let attempt = 0;; attempt += 1) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (error) {
      if (process.platform !== 'win32' || !['EACCES', 'EBUSY', 'EPERM'].includes(error?.code) || attempt >= 8) throw error;
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 200);
  }
}

function mutableDocument(text, filename) {
  const { Document, parseDocument } = loadYaml();
  if (!text || !text.trim()) return new Document({ version: 1, refs: {} });
  const document = parseDocument(text, { prettyErrors: false, uniqueKeys: true });
  if (document.errors.length) {
    const at = document.errors[0]?.linePos?.[0];
    const where = at ? `（第 ${at.line} 行）` : '';
    throw new Error(`本地凭据文件格式有误${where}，为避免覆盖已有配置，本次没有写入`);
  }
  const value = document.toJS() ?? {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`本地凭据文件格式有误：${path.basename(filename)} 必须是映射`);
  }
  if (!Object.hasOwn(value, 'version')) {
    const entries = Object.entries(value);
    if (!entries.length || entries.every(([key, item]) => CREDENTIAL_REF.test(key) && typeof item === 'string' && item)) {
      return new Document({ version: 1, refs: Object.fromEntries(entries) });
    }
    throw new Error('本地凭据文件使用了无法安全迁移的旧格式，本次没有写入');
  }
  if (value.version !== 1) throw new Error(`不支持的本地凭据文件版本：${String(value.version)}`);
  for (const key of Object.keys(value)) {
    if (!['version', 'refs', 'records'].includes(key)) throw new Error(`本地凭据文件包含未知字段：${key}`);
  }
  return document;
}

/** Patch one ref while preserving every unrelated ref, record and YAML comment. */
async function writeLocalCredential(ref, value, options = {}) {
  if (!CREDENTIAL_REF.test(ref)) throw new Error('无效的凭据名称');
  if (typeof value !== 'string' || !value) throw new Error('凭据内容不能为空');
  const filename = options.filename ?? credentialFile();
  const lockFile = `${filename}.lock`;
  await fs.promises.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await acquireLock(lockFile, options.waitMs);
  let temp = null;
  try {
    let text = '';
    try { text = await fs.promises.readFile(filename, 'utf8'); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const document = mutableDocument(text, filename);
    document.setIn(['version'], 1);
    document.setIn(['refs', ref], value);
    temp = `${filename}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    await fs.promises.writeFile(temp, document.toString(), { mode: 0o600, flag: 'wx' });
    await renameWithRetry(temp, filename);
    temp = null;
    await fs.promises.chmod(filename, 0o600).catch(() => {});
  } finally {
    if (temp) await fs.promises.rm(temp, { force: true }).catch(() => {});
    await fs.promises.rm(lockFile, { force: true }).catch(() => {});
  }
  return filename;
}

/** Prefer the supported RPC and fall back only when that route itself is absent. */
async function applyHarnessCredential(client, ref, value, options = {}) {
  try {
    await client.credentialsSet(ref, value);
    const described = await client.credentialsDescribe([ref]);
    if (described?.[ref]?.configured !== true) throw new Error('本地内核未确认 Key 已写入');
    return { configured: true, method: 'rpc', refs: described };
  } catch (error) {
    if (!isMissingCredentialsRoute(error)) throw error;
    log('credentials', 'local RPC route missing; using managed-file compatibility write', { ref });
  }

  await writeLocalCredential(ref, value, options);
  const attempts = options.confirmAttempts ?? 12;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await sleep(attempt === 0 ? 80 : 200);
    try {
      const described = await client.credentialsDescribe([ref]);
      if (described?.[ref]?.configured === true) {
        return { configured: true, method: 'file', refs: described };
      }
    } catch (error) {
      if (!isMissingCredentialsRoute(error)) throw error;
      break;
    }
  }
  throw new Error('Key 已安全保存，但当前本地服务未加载新配置；请重启客户端后重试');
}

/** Never discard the one-time secret when platform creation succeeds but local binding fails. */
async function createAndApplyPlatformKey(platform, client, name, options = {}) {
  const created = await platform.createApiKey(name);
  try {
    const applied = await applyHarnessCredential(client, 'DEEPSEEK_API_KEY', created.secret, options);
    return { created: { ...created, applied: true, applyMethod: applied.method }, refs: applied.refs };
  } catch (error) {
    log('credentials', 'new platform key created but local binding failed', {
      code: error?.code ?? 'unknown', message: String(error?.message ?? error),
    });
    return {
      created: {
        ...created,
        applied: false,
        applyError: String(error?.message ?? error ?? '本地配置失败'),
      },
      refs: null,
    };
  }
}

module.exports = {
  credentialFile,
  isMissingCredentialsRoute,
  writeLocalCredential,
  applyHarnessCredential,
  createAndApplyPlatformKey,
};
