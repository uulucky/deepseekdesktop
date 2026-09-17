'use strict';
/**
 * Model catalog sync.
 *
 * Once per calendar day the app reads the official pricing page
 * (https://api-docs.deepseek.com/zh-cn/quick_start/pricing) and rebuilds the model table the
 * UI shows next to each conversation: model id, version, context/output limits, feature
 * support and the four (off-peak/peak × cached/uncached) input prices plus output price.
 *
 * The parser is table-driven and defensive: the docs page is a Docusaurus MDX table whose
 * shape may change, so a failed or unexpected parse keeps the previous snapshot instead of
 * blanking the UI. The snapshot is written to the config directory and reported to the
 * renderer, which shows "官方模型表 · 更新于 <日期>".
 */
const path = require('node:path');
const { DIRS, log, readJsonSync, writeJsonSync } = require('./util');

const PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing';
const CACHE_FILE = () => path.join(DIRS.config, 'model-catalog.json');

/** Strip tags/entities from one table cell. */
function cellText(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    // CJK text picked up a space where the source had a tag boundary; drop it.
    .replace(/([\u4e00-\u9fff\uff08\uff09\u3001\uff1a])\s+(?=[\u4e00-\u9fff\uff08\uff09\u3001\uff1a])/g, '$1')
    .replace(/\s+([\uff08\uff09\u3001\uff1a])/g, '$1')
    .replace(/(\d)\s+([\uff08\uff09])/g, '$1')
    .replace(/([\uff08\u3001\uff1a])\s+/g, '$1')
    .trim();
}

/**
 * Split the table into a uniform grid, honoring colspan/rowspan so merged cells (the docs
 * page merges the price "kind" column across its two tier rows) keep every row aligned.
 * Returns the widest row width alongside the cell matrix.
 */
function parseRows(html) {
  const rows = [];
  /** @type {Map<number, {text: string, remaining: number}>} */
  const carry = new Map();
  for (const rowHtml of html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = [];
    let column = 0;
    const takeCarried = () => {
      while (carry.has(column)) {
        const carried = carry.get(column);
        cells[column] = carried.text;
        carried.remaining -= 1;
        if (carried.remaining <= 0) carry.delete(column);
        column += 1;
      }
    };
    for (const cellHtml of rowHtml.match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/gi) ?? []) {
      takeCarried();
      const text = cellText(cellHtml);
      const colspan = Number((cellHtml.match(/colspan="?(\d+)/i) ?? [])[1] ?? 1);
      const rowspan = Number((cellHtml.match(/rowspan="?(\d+)/i) ?? [])[1] ?? 1);
      for (let span = 0; span < colspan; span++) {
        cells[column] = text;
        if (rowspan > 1) carry.set(column, { text, remaining: rowspan - 1 });
        column += 1;
      }
    }
    takeCarried();
    rows.push(cells);
  }
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  return { rows: rows.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? '')), width };
}

/** Turn the doc's price cell ("0.02元", "1 元", "$0.28") into a number + unit. */
function parsePrice(text) {
  if (!text) return null;
  const match = String(text).match(/(-?\d+(?:\.\d+)?)\s*(元|美元|USD|CNY|¥|\$)?/);
  if (!match) return null;
  return { amount: Number(match[1]), unit: match[2] && /美元|USD|\$/.test(match[2]) ? 'USD' : 'CNY', raw: text };
}

/** Rebuild the model list from the pricing table. */
function parsePricingTable(html) {
  const tableHtml = (html.match(/<table[\s\S]*?<\/table>/i) ?? [])[0];
  if (!tableHtml) throw new Error('official pricing page contained no table');
  const { rows } = parseRows(tableHtml);
  if (rows.length < 4) throw new Error('official pricing table too small');

  // The leading columns are row labels (the docs page wraps them in a merged cell spanning
  // two or three columns, which the grid expansion faithfully reproduces). The header row
  // tells us how wide that label block is; every other row keeps the same shape.
  const headerRow = rows.find((row) => row.some((cell) => cell === '模型')) ?? rows[0];
  const firstModelColumn = headerRow.findIndex((cell) => /^[a-z0-9][a-z0-9.\-]*\s*\(\d+\)$/i.test(cell));
  if (firstModelColumn < 1) throw new Error('official pricing table header not recognized');

  /** Every non-empty cell before the per-model columns, left to right. */
  const labelCellsOf = (row) => row.slice(0, firstModelColumn).filter(Boolean);
  /** A row's label is its last non-empty value before the per-model columns. */
  const labelOf = (row) => {
    const cells = labelCellsOf(row);
    return cells.length ? cells[cells.length - 1] : '';
  };

  const modelIds = headerRow.slice(firstModelColumn)
    .map((cell) => (cell.match(/([a-z0-9][a-z0-9.\-]*)/i) ?? [])[1])
    .filter(Boolean);

  const models = modelIds.map((id) => ({
    id, version: null, contextWindow: null, maxOutput: null,
    thinking: null, concurrency: null, features: {}, pricing: { currency: 'CNY', tiers: {} },
  }));
  const modelAt = (index) => models[index];

  let priceRowIndex = 0;
  for (const row of rows) {
    const labelCells = labelCellsOf(row);
    const label = labelOf(row);
    const values = row.slice(firstModelColumn);
    if (!label || label === '模型') continue;

    if (label === '模型版本') { values.forEach((value, index) => { const model = modelAt(index); if (model) model.version = value || null; }); continue; }
    if (label === '思考模式') { models.forEach((model) => { model.thinking = values[0] ?? null; }); continue; }
    if (label === '上下文长度') { models.forEach((model) => { model.contextWindow = values[0] ?? null; }); continue; }
    if (label === '输出长度') { models.forEach((model) => { model.maxOutput = values[0] ?? null; }); continue; }
    if (label.startsWith('并发限制')) {
      values.forEach((value, index) => { const model = modelAt(index); if (model) model.concurrency = Number(value) || null; });
      continue;
    }
    if ((labelCells[0] ?? '').startsWith('价格')) {
      // Layout (docs, 2026-08): 价格 | <kind> | <tier> | <price per model…>  with the kind
      // cell spanning two tier rows via rowspan, already normalized by parseRows.
      // The price block is [kind, tier, ...prices]: the kind comes from the label's second
      // text run ("百万tokens输入（缓存命中）"), the tier from the first value cell.
      // The row label is the last cell before the model columns; the price *kind*
      // ("百万tokens输入（缓存命中）") sits in the label cell before it.
      // labelCells = ['价格 (3)', <kind>, <tier>] and the model columns in \`values\` start at
      // the price itself, so both the kind and the tier come from the label block.
      const kind = labelCells[labelCells.length - 2] ?? label;
      const tier = label;
      const prices = values;
      const key = /缓存命中|缓存未命中/.test(kind)
        ? (/缓存命中/.test(kind) && !/未命中/.test(kind) ? 'inputCacheHit' : 'inputCacheMiss')
        : /输出/.test(kind) ? 'output' : `other${priceRowIndex++}`;
      const tierKey = /空闲/.test(tier) ? 'offPeak' : /高峰/.test(tier) ? 'peak' : 'standard';
      prices.forEach((value, index) => {
        const model = modelAt(index);
        const price = parsePrice(value);
        if (!model || !price) return;
        model.pricing.tiers[`${key}.${tierKey}`] = price.amount;
        model.pricing.currency = price.unit;
      });
      continue;
    }
    // Feature matrix rows: label = feature name, one cell per model.
    if (values.length === models.length && values.some((value) => /支持|不支持/.test(value))) {
      values.forEach((value, index) => { const model = modelAt(index); if (model) model.features[label] = value; });
    }
  }
  return models.filter((model) => model.id);
}

/** Read the cached snapshot, if any. */
function readSnapshot() {
  return readJsonSync(CACHE_FILE(), null);
}

/**
 * Fetch + parse the official table. Throws on any failure so callers can keep the old snapshot.
 */
async function fetchCatalog() {
  const response = await fetch(PRICING_URL, {
    headers: { 'user-agent': 'DeepSeekDesktop/1.0 (+local client)', accept: 'text/html' },
  });
  if (!response.ok) throw new Error(`pricing page HTTP ${response.status}`);
  const html = await response.text();
  const models = parsePricingTable(html);
  if (!models.length) throw new Error('no models parsed');
  return { models, source: PRICING_URL, fetchedAt: Date.now() };
}

/**
 * Sync at most once per day. Returns the snapshot actually in effect plus whether it changed.
 * @param {{force?: boolean}} [options]
 */
async function syncCatalog(options = {}) {
  const previous = readSnapshot();
  const today = new Date().toISOString().slice(0, 10);
  const alreadyToday = previous?.day === today && Array.isArray(previous?.models) && previous.models.length > 0;
  if (alreadyToday && !options.force) {
    return { snapshot: previous, changed: false, skipped: true };
  }
  try {
    const fresh = await fetchCatalog();
    const snapshot = {
      ...fresh,
      day: today,
      updatedAt: new Date().toISOString(),
      models: fresh.models.map((model) => ({
        ...model,
        displayName: displayNameFor(model, previous),
      })),
    };
    const changed = JSON.stringify(previous?.models?.map((m) => m.id)) !== JSON.stringify(snapshot.models.map((m) => m.id));
    writeJsonSync(CACHE_FILE(), snapshot);
    log('catalog', `synced ${snapshot.models.length} models`, { changed });
    return { snapshot, changed };
  } catch (error) {
    log('catalog', 'sync failed, keeping previous snapshot', String(error));
    return { snapshot: previous, changed: false, error: String(error?.message ?? error) };
  }
}

/** Display names come from the harness model registry when available; fall back to the doc. */
function displayNameFor(model, previous) {
  const known = previous?.models?.find((entry) => entry.id === model.id);
  if (known?.displayName) return known.displayName;
  return model.version ?? model.id;
}

module.exports = { syncCatalog, fetchCatalog, parsePricingTable, parseRows, cellText, parsePrice, readSnapshot, PRICING_URL };
