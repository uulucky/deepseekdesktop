'use strict';
/**
 * Sidebar ad slot (left rail, directly under the conversation list).
 *
 * The slot is remote-configurable. The app fetches
 *
 *   { "rotateSeconds": 6,
 *     "ads": [ { "url": "https://…", "pic": "https://….jpg", "title": "…", "text": "…" } ] }
 *
 * from the configured feed URL (default https://www.uulucky.com/dsad.json), shows one ad at a
 * time and rotates through them. A bare array is accepted as well. When the fetch fails —
 * offline, not uploaded yet, CORS — the cached payload or the built-in house ad keeps the slot
 * populated, so the rail never shows an empty box.
 *
 * Image sizing: the rail is 268px wide with 12px gutters, so the slot's content box is ~240px;
 * with the ad's 16:9 frame that is 240x135 CSS px, i.e. 480x270 at 2x. Images are drawn with
 * object-fit: cover, so any roughly 16:9 asset crops gracefully.
 */
const path = require('node:path');
const { DIRS, log, readJsonSync, writeJsonSync } = require('./util');

const DEFAULT_AD_URL = 'https://www.uulucky.com/dsad.json';
const REFRESH_MS = 30 * 60 * 1000;
const MAX_ADS = 12;
const DEFAULT_ROTATE_SECONDS = 6;

/** Built-in house ad: shown before the first successful fetch and whenever one fails. */
const HOUSE_AD = {
  url: 'https://platform.deepseek.com/usage',
  pic: null,
  title: 'DeepSeek 开放平台',
  text: '用同一个账号管理 API Key 与余额',
};

function cacheFile() {
  return path.join(DIRS.cache, 'ads.json');
}

/** Accept the documented shape and the bare-array shape, and drop unusable entries. */
function normalize(payload) {
  const list = Array.isArray(payload) ? payload : payload?.ads;
  if (!Array.isArray(list)) return null;
  const ads = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const url = typeof entry.url === 'string' ? entry.url.trim() : '';
    const pic = typeof entry.pic === 'string' ? entry.pic.trim() : '';
    if (!/^https?:\/\//i.test(url)) continue;
    ads.push({
      url,
      pic: /^https?:\/\//i.test(pic) ? pic : null,
      title: typeof entry.title === 'string' && entry.title.trim() ? entry.title.trim().slice(0, 60) : null,
      text: typeof entry.text === 'string' && entry.text.trim() ? entry.text.trim().slice(0, 80) : null,
    });
    if (ads.length >= MAX_ADS) break;
  }
  if (!ads.length) return null;
  const rotate = Number(Array.isArray(payload) ? undefined : payload?.rotateSeconds);
  return {
    ads,
    rotateSeconds: Number.isFinite(rotate) && rotate >= 2 && rotate <= 120 ? rotate : DEFAULT_ROTATE_SECONDS,
  };
}

class AdSlot {
  constructor() {
    /** @type {{ads: object[], rotateSeconds: number, source: string, fetchedAt: number|null, error: string|null}} */
    this.state = this.loadCache() ?? {
      ads: [HOUSE_AD],
      rotateSeconds: DEFAULT_ROTATE_SECONDS,
      source: 'builtin',
      fetchedAt: null,
      error: null,
    };
  }

  /** Last successful payload, so a restart while offline still shows real ads. */
  loadCache() {
    const cached = readJsonSync(cacheFile(), null);
    const normalized = cached ? normalize(cached) : null;
    if (!normalized) return null;
    return { ...normalized, source: 'cache', fetchedAt: cached.fetchedAt ?? null, error: null };
  }

  /** What the renderer should display right now. */
  get() {
    return {
      enabled: true,
      ads: this.state.ads,
      rotateSeconds: this.state.rotateSeconds,
      source: this.state.source,
      fetchedAt: this.state.fetchedAt,
      error: this.state.error,
      feedUrl: this.url(),
      recommendedSize: { width: 480, height: 270 },
    };
  }

  /** The feed URL, overridable from Settings for self-hosted setups. */
  url() {
    return DEFAULT_AD_URL;
  }

  /**
   * Fetch the feed. Returns true when the displayed payload should be re-read. Never throws:
   * a failure leaves the previous ads in place and records the reason for the Ad tab.
   */
  async refresh({ force = false } = {}) {
    const now = Date.now();
    if (!force && this.state.fetchedAt && now - this.state.fetchedAt < REFRESH_MS) return false;

    const url = this.url();
    const before = JSON.stringify({ ads: this.state.ads, rotateSeconds: this.state.rotateSeconds, source: this.state.source });
    try {
      const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const normalized = normalize(await response.json());
      if (!normalized) throw new Error('配置格式不正确');
      this.state = { ...normalized, source: 'remote', fetchedAt: now, error: null };
      writeJsonSync(cacheFile(), this.state);
      log('ad', 'ads refreshed', { url, count: normalized.ads.length });
    } catch (error) {
      this.state = { ...this.state, fetchedAt: now, error: String(error?.message ?? error) };
      log('ad', 'ads unavailable', { url, error: this.state.error });
    }
    const after = JSON.stringify({ ads: this.state.ads, rotateSeconds: this.state.rotateSeconds, source: this.state.source });
    return before !== after;
  }
}

module.exports = { AdSlot, DEFAULT_AD_URL, HOUSE_AD, normalize, MAX_ADS, DEFAULT_ROTATE_SECONDS };
