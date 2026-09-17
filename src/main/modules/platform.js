'use strict';
/**
 * DeepSeek Platform integration — the "account" half of the app.
 *
 * Everything here works against https://platform.deepseek.com from *inside* the app, using a
 * persistent Electron session so a single sign-in is enough and no browser tab ever appears:
 *
 *   GET  /api/v0/users/get_user_summary → wallet balances (normal + bonus) and token usage
 *   GET  /api/v0/users/get_api_keys     → key list (masked sensitive_id, never the secret)
 *   POST /api/v0/users/edit_api_keys    → create/edit/delete; CREATE returns the full key once
 *
 * Request shapes verified against the live platform: all three carry the account bearer token
 * and answer HTTP 200 with a business code (40002 = missing token, 40003 = invalid/expired).
 *
 * Auth is the platform's own bearer string kept in localStorage under \`userToken\`; it is read
 * from the in-app page, cached only in memory, and never written to disk.
 */
const { log } = require('./util');

const PLATFORM_ORIGIN = 'https://platform.deepseek.com';
const USER_TOKEN_KEY = 'userToken';
/** Endpoint paths, mirrored from the platform bundle (see docs/PLATFORM-NOTES.md). */
const PATHS = {
  apiKeys: '/api/v0/users/get_api_keys',
  editApiKeys: '/api/v0/users/edit_api_keys',
  userSummary: '/api/v0/users/get_user_summary',
  usageAmount: '/api/v0/usage/by_api_key/amount',
  usageCost: '/api/v0/usage/by_api_key/cost',
  monthlyUsageAmount: '/api/v0/usage/amount',
  monthlyUsageCost: '/api/v0/usage/cost',
};
const TOKEN_TYPES = new Set(['PROMPT_CACHE_HIT_TOKEN', 'PROMPT_CACHE_MISS_TOKEN', 'RESPONSE_TOKEN']);
/** Platform result codes for the key API (0 = OK). */
const EDIT_CODES = {
  0: { ok: true },
  1: { ok: false, message: 'API Key 数量已达上限，请先删除不再使用的 Key' },
  2: { ok: false, message: 'API Key 名称过长' },
};

class PlatformError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'PlatformError';
    this.code = code;
  }
}

/** Business codes that mean "the account token is missing or no longer valid". */
const AUTH_CODES = new Set([40002, 40003]);

/**
 * Normalize the platform's double-wrapped response envelope. The platform answers HTTP 200
 * even for auth and business failures, so the codes are the real contract.
 */
function unwrap(json) {
  if (!json || typeof json !== 'object') throw new PlatformError('平台返回了空响应', 'empty');
  const outerCode = typeof json.code === 'number' ? json.code : 0;
  if (AUTH_CODES.has(outerCode)) {
    throw new PlatformError(
      json.msg === 'Missing Token' ? '请先登录 DeepSeek 账号' : '登录状态已过期，请重新登录',
      'unauthorized',
    );
  }
  if (outerCode !== 0 && json.data == null) {
    throw new PlatformError(json.msg || `平台返回错误码 ${outerCode}`, outerCode);
  }
  const data = json.data ?? {};
  if (typeof data.biz_code === 'number' && data.biz_code !== 0) {
    if (AUTH_CODES.has(data.biz_code)) throw new PlatformError('登录状态已过期，请重新登录', 'unauthorized');
    throw new PlatformError(data.biz_msg || `平台返回错误码 ${data.biz_code}`, data.biz_code);
  }
  return data.biz_data ?? data ?? json;
}

class DeepSeekPlatform {
  /**
   * @param {{session: Electron.Session, getWindow: () => Electron.BrowserWindow|null}} options
   */
  constructor(options) {
    this.session = options.session;
    this.getWindow = options.getWindow;
    /** @type {string|null} */
    this.token = null;
    this.tokenAt = 0;
    /** Discovered at runtime from real traffic, so a platform rename degrades instead of breaks. */
    this.discovered = { rechargeUrl: null, apiKeysPath: PATHS.apiKeys, editPath: PATHS.editApiKeys };
    this.installSniffer();
  }

  // ------------------------------------------------------------------ traffic

  /** Record platform API traffic; used only to discover the recharge URL and path drift. */
  installSniffer() {
    // The current web app can store its token in a JSON-wrapped localStorage value. Capturing
    // the Authorization header from the platform's own successful requests is both more
    // durable and independent of that private storage shape.
    this.session.webRequest.onBeforeSendHeaders({ urls: [`${PLATFORM_ORIGIN}/api/*`] }, (details, callback) => {
      const headers = details.requestHeaders ?? {};
      const key = Object.keys(headers).find((name) => name.toLowerCase() === 'authorization');
      if (key) this.setToken(headers[key]);
      callback({ requestHeaders: headers });
    });
    this.session.webRequest.onCompleted({ urls: ['*://platform.deepseek.com/*'] }, (details) => {
      const url = details.url;
      if (/\/api\/v0\/users\/(get_api_keys|edit_api_keys|get_user_summary)/.test(url)) {
        log('platform', `${details.method} ${url} → ${details.statusCode}`);
      }
      if (/top_?up|topup|recharge|pay/i.test(url) && details.method === 'GET' && !/\/api\//.test(url)) {
        this.discovered.rechargeUrl = url;
        log('platform', `recharge url discovered: ${url}`);
      }
    });
  }

  // --------------------------------------------------------------------- auth

  /** Cache a bearer token discovered in the page (memory only). */
  setToken(token) {
    const value = typeof token === 'string' ? token.trim().replace(/^Bearer\s+/i, '') : '';
    if (!value) return false;
    if (value !== this.token) log('platform', 'platform token captured');
    this.token = value;
    this.tokenAt = Date.now();
    return true;
  }

  hasToken() {
    return Boolean(this.token);
  }

  clearToken() {
    this.token = null;
    this.tokenAt = 0;
  }

  /**
   * Ask the loaded platform page for its token. Returns null when the page is on the sign-in
   * route or holds no plausible token — callers then surface a login button.
   */
  async refreshToken() {
    const win = this.getWindow();
    if (!win || win.isDestroyed()) return null;
    try {
      const url = win.webContents.getURL();
      if (!url.startsWith(PLATFORM_ORIGIN)) return null;
      const probe = await win.webContents.executeJavaScript(
        `(() => {
           try {
             const raw = window.localStorage.getItem(${JSON.stringify(USER_TOKEN_KEY)});
             return { raw, signIn: location.pathname.indexOf('sign_in') >= 0 };
           } catch { return { raw: null, signIn: false }; }
         })()`,
        true,
      );
      const token = plausibleToken(probe?.raw);
      if (token) this.setToken(token);
      // A transient sign-in route is not proof that a token captured from real API traffic is
      // invalid. Only an authenticated API response may invalidate it.
      return token ?? this.token;
    } catch (error) {
      log('platform', 'token refresh failed', String(error));
      return null;
    }
  }

  /** Whether the in-app platform window is currently showing the sign-in route. */
  async needsSignIn() {
    const win = this.getWindow();
    if (!win || win.isDestroyed()) return true;
    try {
      const url = win.webContents.getURL();
      return !url.startsWith(PLATFORM_ORIGIN) || url.includes('sign_in');
    } catch {
      return true;
    }
  }

  /** Fetch a platform API path from inside the page (same origin, real cookies + UA). */
  async inPageFetch(path, init = {}, { requiresToken = true } = {}) {
    const win = this.getWindow();
    if (!win || win.isDestroyed()) throw new PlatformError('请先登录 DeepSeek 账号', 'no-window');
    if (requiresToken && !this.token) await this.refreshToken();
    if (requiresToken && !this.token) throw new PlatformError('请先登录 DeepSeek 账号', 'unauthorized');

    const body = init.body === undefined
      ? null
      : typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
    const script = `(async () => {
      try {
        const response = await fetch(${JSON.stringify(PLATFORM_ORIGIN + path)}, {
          method: ${JSON.stringify(init.method || 'GET')},
          headers: Object.assign({
            'content-type': 'application/json',
            accept: '*/*',
            authorization: 'Bearer ' + ${JSON.stringify(this.token ?? '')},
            'x-client-platform': 'web',
          }, ${JSON.stringify(init.headers || {})}),
          credentials: 'include',
          ${body === null ? '' : `body: ${JSON.stringify(body)},`}
        });
        const text = await response.text();
        return { ok: response.ok, status: response.status, text: text.slice(0, 400000) };
      } catch (error) {
        return { ok: false, status: 0, text: String(error && error.message ? error.message : error) };
      }
    })()`;
    const result = await win.webContents.executeJavaScript(script, true).catch((error) => {
      throw new PlatformError(String(error?.message ?? error), 'fetch-failed');
    });
    if (!result || result.status === 0) throw new PlatformError(`平台接口不可用：${result?.text ?? '未知错误'}`, 'network');
    let json = null;
    try { json = JSON.parse(result.text); } catch { /* non-JSON error page */ }
    if (result.status === 401 || result.status === 403) {
      this.clearToken();
      throw new PlatformError('登录状态已过期，请重新登录', 'unauthorized');
    }
    if (!result.ok) throw new PlatformError(`平台接口返回 HTTP ${result.status}`, result.status);
    if (!json) throw new PlatformError('平台返回了无法解析的内容', 'bad-json');
    try {
      return unwrap(json);
    } catch (error) {
      if (error?.code === 'unauthorized') this.clearToken();
      throw error;
    }
  }

  // ------------------------------------------------------------------ balance

  /** Wallet balances plus lifetime/monthly usage from get_user_summary. */
  async summary() {
    const data = await this.inPageFetch(PATHS.userSummary, { method: 'GET' });
    const wallets = [
      ...(data.normal_wallets ?? []).map((wallet) => ({ ...wallet, wallet: 'normal' })),
      ...(data.bonus_wallets ?? []).map((wallet) => ({ ...wallet, wallet: 'bonus' })),
    ];
    const preferred = wallets.find((wallet) => wallet.currency === 'CNY') ?? wallets[0] ?? null;
    return {
      available: Boolean(data.current_token),
      currency: preferred?.currency ?? 'CNY',
      balance: preferred?.balance ?? 0,
      tokenEstimation: preferred?.token_estimation ?? data.total_available_token_estimation ?? 0,
      wallets,
      totalUsage: data.total_usage ?? null,
      monthlyUsage: data.monthly_usage ?? null,
      fetchedAt: Date.now(),
    };
  }

  /**
   * Detailed usage for today and the recent period. The platform's by-key endpoints accept
   * epoch seconds plus the local UTC offset, which keeps the "today" bucket aligned with the
   * user's clock instead of UTC. Older platform builds fall back to the monthly endpoints.
   */
  async usage(now = new Date()) {
    const window = usageWindow(now);
    const query = `?start=${window.start}&end=${window.end}&tz=${window.timeZoneSeconds}`;
    try {
      const [amount, cost] = await Promise.all([
        this.inPageFetch(PATHS.usageAmount + query, { method: 'GET' }),
        this.inPageFetch(PATHS.usageCost + query, { method: 'GET' }),
      ]);
      return parseByApiKeyUsage(amount, cost, now);
    } catch (error) {
      if (error?.code === 'unauthorized') throw error;
      log('platform', 'by-key usage unavailable; falling back to monthly totals', String(error));
      const month = now.getMonth() + 1;
      const year = now.getFullYear();
      const fallbackQuery = `?month=${month}&year=${year}`;
      const [amount, cost] = await Promise.all([
        this.inPageFetch(PATHS.monthlyUsageAmount + fallbackQuery, { method: 'GET' }),
        this.inPageFetch(PATHS.monthlyUsageCost + fallbackQuery, { method: 'GET' }),
      ]);
      return parseMonthlyUsage(amount, cost, now);
    }
  }

  /** Balance straight from the public API with a client API key (no platform login needed). */
  async balanceByApiKey(apiKey) {
    const response = await fetch('https://api.deepseek.com/user/balance', {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    });
    if (response.status === 401 || response.status === 403) {
      throw new PlatformError('API Key 无效或已被撤销', 'invalid-key');
    }
    if (!response.ok) throw new PlatformError(`余额查询失败 (HTTP ${response.status})`, response.status);
    const json = await response.json();
    const info = (json.balance_infos ?? []).find((entry) => entry.currency === 'CNY') ?? (json.balance_infos ?? [])[0];
    return {
      available: Boolean(json.is_available),
      currency: info?.currency ?? 'CNY',
      balance: Number(info?.total_balance ?? 0),
      granted: Number(info?.granted_balance ?? 0),
      toppedUp: Number(info?.topped_up_balance ?? 0),
      fetchedAt: Date.now(),
      source: 'api-key',
    };
  }

  // ----------------------------------------------------------------- api keys

  /** Key list. \`sensitive_id\` is the platform's masked display value, never the secret. */
  async listApiKeys() {
    const data = await this.inPageFetch(this.discovered.apiKeysPath, { method: 'GET' });
    const keys = (data.api_keys ?? []).map((key) => ({
      name: key.name,
      maskedKey: key.sensitive_id,
      trackingId: key.tracking_id ?? null,
      createdAt: key.created_at ? key.created_at * 1000 : null,
      lastUsed: key.last_use ? key.last_use * 1000 : null,
    }));
    return keys.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }

  /**
   * Create a key. The platform returns the full secret exactly once — this is the only
   * moment the app can hand a usable key to the harness.
   */
  async createApiKey(name) {
    const acceptedName = typeof name === 'string' && name.trim() ? name.trim() : defaultKeyName();
    const data = await this.inPageFetch(this.discovered.editPath, {
      method: 'POST',
      body: apiKeyMutationBody({ action: 'create', name: acceptedName }),
    });
    const code = data?.code ?? 0;
    const outcome = EDIT_CODES[code];
    if (outcome && !outcome.ok) throw new PlatformError(outcome.message, code);
    const key = data?.api_key;
    if (!key?.sensitive_id) throw new PlatformError('创建成功但未返回 Key 信息', 'no-key');
    return {
      name: key.name,
      secret: key.sensitive_id,
      maskedKey: key.sensitive_id ? `${key.sensitive_id.slice(0, 6)}…${key.sensitive_id.slice(-4)}` : '',
      createdAt: key.created_at ? key.created_at * 1000 : Date.now(),
    };
  }

  /** Rename or delete a key (delete passes the masked value the list reported). */
  async editApiKey({ action, name, redactedKey, createdAt, trackingId }) {
    const data = await this.inPageFetch(this.discovered.editPath, {
      method: 'POST',
      body: apiKeyMutationBody({ action, name, redactedKey, createdAt, trackingId }),
    });
    const outcome = EDIT_CODES[data?.code ?? 0];
    if (outcome && !outcome.ok) throw new PlatformError(outcome.message, data?.code);
    return true;
  }

  deleteApiKey(key) {
    return this.editApiKey({
      action: 'delete',
      redactedKey: key.maskedKey,
      createdAt: key.createdAt,
      trackingId: key.trackingId,
    });
  }

  renameApiKey(key, name) {
    return this.editApiKey({
      action: 'update',
      name,
      redactedKey: key.maskedKey,
      createdAt: key.createdAt,
      trackingId: key.trackingId,
    });
  }

  // ----------------------------------------------------------------- recharge

  /** Official recharge page, opened inside the app rather than a browser tab. */
  rechargeUrl(amount) {
    if (this.discovered.rechargeUrl) return this.discovered.rechargeUrl;
    const base = `${PLATFORM_ORIGIN}/top_up`;
    return amount ? `${base}?amount=${encodeURIComponent(amount)}` : base;
  }

  /** Deep-link for the usage dashboard (also used by the balance card's "详情"). */
  usageUrl() {
    return `${PLATFORM_ORIGIN}/usage`;
  }
}

/**
 * Decide whether a raw localStorage value is a real platform token. The site reuses the
 * \`userToken\` key for small preference objects, so a JSON blob is not a credential.
 */
function plausibleToken(raw) {
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  if (value.startsWith('"')) {
    try {
      const decoded = JSON.parse(value);
      if (typeof decoded === 'string') value = decoded.trim();
    } catch { return null; }
  }
  value = value.replace(/^Bearer\s+/i, '');
  if (value.length < 12 || value.length > 4096) return null;
  if (value.startsWith('{') || value.startsWith('[')) return null;
  return value;
}

/** Current official frontend request contract for create/update/delete. */
function apiKeyMutationBody({ action, name, redactedKey, createdAt, trackingId }) {
  return {
    action,
    name: name ?? null,
    redacted_key: redactedKey ?? null,
    created_at: createdAt == null ? null : Number(createdAt) / 1000,
    tracking_id: trackingId && trackingId !== 'null' ? trackingId : null,
  };
}

function defaultKeyName(now = new Date()) {
  const two = (number) => String(number).padStart(2, '0');
  return `DeepSeek Desktop ${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}`;
}

/** A local-day 30-day window in the exact query format used by the platform. */
function usageWindow(now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = new Date(today);
  start.setDate(start.getDate() - 29);
  const end = new Date(today);
  end.setDate(end.getDate() + 1);
  return {
    start: Math.floor(start.getTime() / 1000),
    end: Math.floor(end.getTime() / 1000),
    timeZoneSeconds: -now.getTimezoneOffset() * 60,
  };
}

function dayKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const two = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

function numeric(value) {
  const number = Number(typeof value === 'string' ? value.trim() : value);
  return Number.isFinite(number) ? number : 0;
}

function emptyDay(date) {
  return { date, tokens: 0, cost: 0, requests: 0 };
}

function addUsage(target, usage) {
  for (const [type, raw] of Object.entries(usage ?? {})) {
    const value = numeric(raw);
    if (type.toUpperCase() === 'REQUEST') target.requests += value;
    else if (TOKEN_TYPES.has(type.toUpperCase())) target.tokens += value;
  }
}

function addUsageItems(target, items, { cost = false } = {}) {
  for (const item of items ?? []) {
    const type = String(item?.type ?? '').toUpperCase();
    if (type === 'REQUEST') {
      if (!cost) target.requests += numeric(item?.amount);
    } else if (TOKEN_TYPES.has(type)) {
      if (cost) target.cost += numeric(item?.amount);
      else target.tokens += numeric(item?.amount);
    }
  }
}

function finishUsage(days, now, currency, period, extra = {}) {
  const todayDate = dayKey(now);
  const today = days.get(todayDate) ?? emptyDay(todayDate);
  const totals = [...days.values()].reduce((sum, item) => ({
    tokens: sum.tokens + item.tokens,
    cost: sum.cost + item.cost,
    requests: sum.requests + item.requests,
  }), { tokens: 0, cost: 0, requests: 0 });
  return {
    today,
    period: { ...totals, kind: period },
    currency: currency || 'CNY',
    daily: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    fetchedAt: Date.now(),
    ...extra,
  };
}

/** Normalize the current by-API-key response used by the DeepSeek usage dashboard. */
function parseByApiKeyUsage(amountData, costData, now = new Date()) {
  const amountSeries = Array.isArray(amountData?.series) ? amountData.series : [];
  const currencies = Array.isArray(costData?.data) ? costData.data : [];
  const preferredCost = currencies.find((entry) => entry?.currency === 'CNY') ?? currencies[0] ?? {};
  const costSeries = Array.isArray(preferredCost?.series) ? preferredCost.series : [];
  const days = new Map();
  const models = new Map();
  const apiKeys = new Set();
  const ensureDay = (date) => {
    if (!days.has(date)) days.set(date, emptyDay(date));
    return days.get(date);
  };

  for (const series of amountSeries) {
    const key = typeof series?.api_key === 'string'
      ? series.api_key
      : series?.api_key?.tracking_id ?? series?.api_key?.name;
    if (key) apiKeys.add(String(key));
    for (const bucket of series?.buckets ?? []) {
      const date = dayKey(numeric(bucket?.time) * 1000);
      if (!date) continue;
      const before = ensureDay(date).tokens;
      addUsage(ensureDay(date), bucket?.usage);
      const added = ensureDay(date).tokens - before;
      if (series?.model) models.set(series.model, (models.get(series.model) ?? 0) + added);
    }
  }
  for (const series of costSeries) {
    for (const bucket of series?.buckets ?? []) {
      const date = dayKey(numeric(bucket?.time) * 1000);
      if (date) ensureDay(date).cost += numeric(bucket?.cost);
    }
  }
  const topModel = [...models.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
  return finishUsage(days, now, preferredCost?.currency, 'last30Days', {
    apiKeyCount: apiKeys.size,
    topModel,
  });
}

/** Normalize the legacy month/year response used as a compatibility fallback. */
function parseMonthlyUsage(amountData, costData, now = new Date()) {
  const days = new Map();
  const costGroups = Array.isArray(costData) ? costData : [];
  const preferredCost = costGroups.find((entry) => entry?.currency === 'CNY') ?? costGroups[0] ?? {};
  for (const day of amountData?.days ?? []) {
    const date = String(day?.date ?? '');
    if (!date) continue;
    const target = emptyDay(date);
    for (const model of day?.data ?? []) addUsageItems(target, model?.usage);
    days.set(date, target);
  }
  for (const day of preferredCost?.days ?? []) {
    const date = String(day?.date ?? '');
    if (!date) continue;
    const target = days.get(date) ?? emptyDay(date);
    for (const model of day?.data ?? []) addUsageItems(target, model?.usage, { cost: true });
    days.set(date, target);
  }
  return finishUsage(days, now, preferredCost?.currency, 'currentMonth');
}

module.exports = {
  DeepSeekPlatform,
  PlatformError,
  PATHS,
  PLATFORM_ORIGIN,
  USER_TOKEN_KEY,
  plausibleToken,
  apiKeyMutationBody,
  defaultKeyName,
  unwrap,
  usageWindow,
  parseByApiKeyUsage,
  parseMonthlyUsage,
};
