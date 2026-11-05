'use strict';
/**
 * The desktop end of the phone remote: a loopback HTTP API that only the dmuse sidecar can
 * reach. Every connection must open with "DMUSE/1 <secret> <phone>\n" — the secret is handed
 * to the sidecar at spawn time and never leaves this machine — so another program on the same
 * computer cannot drive the app by guessing the port, and each request knows which phone sent
 * it. What the phone may do is decided by ./rules.js; the handlers below only translate HTTP
 * into the same session operations the desktop window uses.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { RemoteRuleError } = require('./rules');

const PREAMBLE_LIMIT = 512;
const PREAMBLE_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 40 * 1024 * 1024;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const EVENT_THROTTLE_MS = 250;
const HEARTBEAT_MS = 20000;

function secretMatches(given, expected) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Parse the sidecar's first line; returns the phone name or null. */
function parsePreamble(line, secret) {
  const match = /^DMUSE\/1 (\S+) (.+)$/.exec(line);
  if (!match || !secretMatches(match[1], secret)) return null;
  try {
    const phone = JSON.parse(match[2]);
    return typeof phone === 'string' && phone ? phone.slice(0, 64) : null;
  } catch {
    return null;
  }
}

function send(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
}

function fail(res, error) {
  const status = error instanceof RemoteRuleError ? error.status : (error?.status ?? 400);
  send(res, status, { error: { message: String(error?.message ?? error), code: error?.code ?? null } });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new RemoteRuleError('请求太大（附件总大小上限 30 MB）', 413, 'too-large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new RemoteRuleError('请求不是有效的 JSON', 400, 'bad-json')); }
    });
    req.on('error', reject);
  });
}

/** Resolve a path inside root, refusing anything that escapes it (including via symlinks). */
function containedFile(root, relative) {
  if (typeof root !== 'string' || !root) throw new RemoteRuleError('这个对话没有工作目录', 404, 'no-cwd');
  if (typeof relative !== 'string' || !relative || relative.includes('\0')) throw new RemoteRuleError('文件路径无效', 400, 'bad-path');
  let realRoot;
  let target;
  try {
    realRoot = fs.realpathSync(root);
    target = fs.realpathSync(path.resolve(realRoot, relative));
  } catch {
    throw new RemoteRuleError('文件不存在', 404, 'not-found');
  }
  const inside = path.relative(realRoot, target);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new RemoteRuleError('只能下载对话工作目录里的文件', 403, 'outside-cwd');
  }
  const stat = fs.statSync(target);
  if (!stat.isFile()) throw new RemoteRuleError('不是文件', 400, 'not-file');
  if (stat.size > MAX_FILE_BYTES) throw new RemoteRuleError('文件超过 50 MB，请在电脑上查看', 413, 'too-large');
  return { file: target, size: stat.size };
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.next', 'dist', 'build', '.cache', 'target']);

/**
 * Files in a session's working directory, newest first: what the phone shows as "产出文件".
 * Bounded in depth and count so a huge repository cannot stall the gateway.
 */
function recentFiles(root, since = 0, { maxDepth = 3, maxScan = 4000, limit = 50 } = {}) {
  if (typeof root !== 'string' || !root) return [];
  let realRoot;
  try { realRoot = fs.realpathSync(root); } catch { return []; }
  const found = [];
  let scanned = 0;
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (++scanned > maxScan) return;
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIRS.has(entry.name)) walk(full, depth + 1);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(full);
          if (stat.mtimeMs >= since) found.push({ path: path.relative(realRoot, full).split(path.sep).join('/'), size: stat.size, modified: Math.round(stat.mtimeMs) });
        } catch { /* vanished */ }
      }
    }
  };
  walk(realRoot, 0);
  return found.sort((a, b) => b.modified - a.modified).slice(0, limit);
}

const ROUTES = [
  ['GET', /^\/v1\/info$/, 'info'],
  ['GET', /^\/v1\/workbench$/, 'workbench'],
  ['POST', /^\/v1\/workbench$/, 'workbenchAction'],
  ['GET', /^\/v1\/diagnostics$/, 'diagnose'],
  ['POST', /^\/v1\/notifications$/, 'notifications'],
  ['GET', /^\/v1\/requests\/([^/]+)$/, 'requestStatus'],
  ['GET', /^\/v1\/sessions\/([^/]+)\/skills$/, 'skills'],
  ['GET', /^\/v1\/sessions$/, 'listSessions'],
  ['POST', /^\/v1\/sessions$/, 'createSession'],
  ['GET', /^\/v1\/pending$/, 'pending'],
  ['POST', /^\/v1\/unpair$/, 'unpair'],
  ['GET', /^\/v1\/catalog$/, 'catalog'],
  ['GET', /^\/v1\/keep-awake$/, 'keepAwake'],
  ['POST', /^\/v1\/keep-awake$/, 'keepAwake'],
  ['GET', /^\/v1\/sessions\/([^/]+)$/, 'openSession'],
  ['POST', /^\/v1\/sessions\/([^/]+)\/messages$/, 'sendMessage'],
  ['POST', /^\/v1\/sessions\/([^/]+)\/cancel$/, 'cancel'],
  ['POST', /^\/v1\/sessions\/([^/]+)\/approvals\/([^/]+)$/, 'answerApproval'],
  ['POST', /^\/v1\/sessions\/([^/]+)\/questions\/([^/]+)$/, 'answerQuestion'],
  ['DELETE', /^\/v1\/sessions\/([^/]+)\/approval-policy$/, 'revokeApprovalPolicy'],
  ['GET', /^\/v1\/sessions\/([^/]+)\/permission$/, 'permission'],
  ['POST', /^\/v1\/sessions\/([^/]+)\/permission$/, 'selectPermission'],
  ['GET', /^\/v1\/sessions\/([^/]+)\/models$/, 'models'],
  ['POST', /^\/v1\/sessions\/([^/]+)\/model$/, 'selectModel'],
];

class RemoteGateway {
  /**
   * @param {object} options
   * @param {string} options.secret the line-one secret shared with the sidecar
   * @param {object} options.api session operations (see remote/index.js)
   * @param {(phones: object[]) => void} [options.onPhones] connected-phone changes
   * @param {(...args: any[]) => void} [options.log]
   */
  constructor({ secret, api, onPhones, log } = {}) {
    if (!secret || secret.length < 32) throw new Error('remote gateway needs a strong secret');
    this.secret = secret;
    this.api = api;
    this.onPhones = onPhones ?? (() => {});
    this.log = log ?? (() => {});
    this.phones = new Map();
    this.streams = new Set();
    this.pendingEvents = new Map();
    this.eventTimers = new Map();
    this.http = http.createServer((req, res) => this.route(req, res).catch((error) => fail(res, error)));
    this.http.keepAliveTimeout = 30000;
    this.server = net.createServer((socket) => this.accept(socket));
    this.heartbeat = null;
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject);
        this.heartbeat = setInterval(() => {
          for (const stream of this.streams) stream.res.write(': keep-alive\n\n');
        }, HEARTBEAT_MS);
        this.heartbeat.unref?.();
        resolve(this.server.address().port);
      });
    });
  }

  close() {
    clearInterval(this.heartbeat);
    for (const timer of this.eventTimers.values()) clearTimeout(timer);
    for (const stream of this.streams) stream.res.end();
    this.streams.clear();
    this.server.close();
    this.http.close();
    for (const entry of this.phones.values()) for (const socket of entry.sockets) socket.destroy();
    this.phones.clear();
  }

  /** Read the preamble, then hand the socket to the HTTP server. */
  accept(socket) {
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => socket.destroy(), PREAMBLE_TIMEOUT_MS);
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) {
        if (buffered.length > PREAMBLE_LIMIT) socket.destroy();
        return;
      }
      clearTimeout(timer);
      socket.off('data', onData);
      const phone = parsePreamble(buffered.subarray(0, newline).toString('utf8'), this.secret);
      if (!phone) {
        this.log('remote', 'refused a loopback connection without the sidecar secret');
        socket.destroy();
        return;
      }
      const rest = buffered.subarray(newline + 1);
      socket.dmusePhone = phone;
      this.track(phone, socket);
      socket.pause();
      if (rest.length) socket.unshift(rest);
      this.http.emit('connection', socket);
      socket.resume();
    };
    socket.on('data', onData);
    socket.on('error', () => {});
  }

  track(phone, socket) {
    const entry = this.phones.get(phone) ?? { sockets: new Set(), lastSeen: 0 };
    entry.sockets.add(socket);
    entry.lastSeen = Date.now();
    this.phones.set(phone, entry);
    this.publishPhones();
    socket.once('close', () => {
      entry.sockets.delete(socket);
      entry.lastSeen = Date.now();
      this.publishPhones();
    });
  }

  connectedPhones() {
    return [...this.phones.entries()].map(([phone, entry]) => ({
      phone, connected: entry.sockets.size > 0, lastSeen: entry.lastSeen,
    }));
  }

  publishPhones() { this.onPhones(this.connectedPhones()); }

  /** Close every connection from a phone (after the desktop revoked it). */
  disconnect(phone) {
    const entry = this.phones.get(phone);
    if (!entry) return;
    for (const socket of entry.sockets) socket.destroy();
    for (const stream of [...this.streams]) if (stream.phone === phone) this.streams.delete(stream);
    this.phones.delete(phone);
    this.publishPhones();
  }

  async route(req, res) {
    const phone = req.socket.dmusePhone;
    if (!phone) return req.socket.destroy();
    const entry = this.phones.get(phone);
    if (entry) entry.lastSeen = Date.now();
    const url = new URL(req.url, 'http://deepseek-desktop');
    const elevated = req.headers['x-dmuse-elevated'] === '1';
    if (req.method === 'GET' && url.pathname === '/v1/events') return this.openStream(req, res, phone);
    if (req.method === 'GET') {
      const file = /^\/v1\/sessions\/([^/]+)\/files$/.exec(url.pathname);
      if (file && url.searchParams.has('path')) return this.sendFile(res, decodeURIComponent(file[1]), url.searchParams.get('path'));
      if (file) return send(res, 200, { items: recentFiles(await this.api.sessionCwd(decodeURIComponent(file[1])), Number(url.searchParams.get('since')) || 0) });
    }
    for (const [method, pattern, name] of ROUTES) {
      if (method !== req.method) continue;
      const match = pattern.exec(url.pathname);
      if (!match) continue;
      const params = match.slice(1).map(decodeURIComponent);
      const body = req.method === 'POST' ? await readJson(req) : {};
      const value = await this.api[name]({ phone, elevated, params, body, query: url.searchParams });
      return send(res, 200, value ?? {});
    }
    return send(res, 404, { error: { message: '没有这个接口', code: 'not-found' } });
  }

  async sendFile(res, sessionId, relative) {
    const cwd = await this.api.sessionCwd(sessionId);
    const { file, size } = containedFile(cwd, relative);
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': size,
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
      'cache-control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  }

  openStream(req, res, phone) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
    const stream = { res, phone };
    this.streams.add(stream);
    res.write(`event: hello\ndata: ${JSON.stringify({ phone })}\n\n`);
    req.on('close', () => this.streams.delete(stream));
  }

  /**
   * Forward a transcript update to every open event stream, at most every
   * EVENT_THROTTLE_MS per session; approvals, questions and the end of a run go out at once.
   */
  publish(summary) {
    if (!summary?.sessionId || !this.streams.size) return;
    this.pendingEvents.set(summary.sessionId, summary);
    if (summary.urgent) return this.flushEvent(summary.sessionId);
    if (this.eventTimers.has(summary.sessionId)) return;
    this.eventTimers.set(summary.sessionId, setTimeout(() => this.flushEvent(summary.sessionId), EVENT_THROTTLE_MS));
  }

  flushEvent(sessionId) {
    clearTimeout(this.eventTimers.get(sessionId));
    this.eventTimers.delete(sessionId);
    const summary = this.pendingEvents.get(sessionId);
    this.pendingEvents.delete(sessionId);
    if (!summary) return;
    const { urgent, ...data } = summary;
    const frame = `event: session\ndata: ${JSON.stringify(data)}\n\n`;
    for (const stream of this.streams) stream.res.write(frame);
  }
}

module.exports = { RemoteGateway, parsePreamble, containedFile, recentFiles };
