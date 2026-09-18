'use strict';
/**
 * UI harness: runs the REAL renderer under Electron against a stubbed IPC surface so the
 * interface can be rendered, asserted and screenshotted without a kernel boot.
 *
 *   npm run ui:shot          # builds build/app, renders, writes build/ui-shot*.png
 *
 * Never shipped: the packaged app runs src/main/index.js.
 */
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const APP_VERSION = require('./package.json').version;

const SHOT = process.env.DSH_UI_SHOT || path.join(__dirname, 'ui-shot.png');
const SPLASH_MS = Number(process.env.DSH_UI_SPLASH_MS || 1200);
const shot = (suffix) => SHOT.replace(/\.png$/, suffix + '.png');
/** capturePage can reject while the compositor is still warming up; retry once. */
async function capture(win) {
  try {
    return await win.capturePage();
  } catch (error) {
    console.log('CAPTURE_RETRY', String(error));
    await new Promise((resolve) => setTimeout(resolve, 700));
    return win.capturePage();
  }
}
const now = Date.now();

/** Two inline banners (480x270, the documented ad size) so rotation is testable offline. */
const banner = (from, to, label) => 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270">'
  + '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">'
  + '<stop offset="0" stop-color="' + from + '"/><stop offset="1" stop-color="' + to + '"/>'
  + '</linearGradient></defs><rect width="480" height="270" fill="url(#g)"/>'
  + '<text x="240" y="150" font-family="sans-serif" font-size="42" font-weight="700" fill="#fff" text-anchor="middle">'
  + label + '</text></svg>');
const PIC_A = banner('#5a78ff', '#3550e0', 'AD 1');
const PIC_B = banner('#2fbf71', '#0f7a45', 'AD 2');

const transcript = {
  sessionId: 'session-demo',
  title: '把 README 改写成新手版本',
  running: false,
  usage: { uncachedInputTokens: 128000, outputTokens: 24000, cacheReadTokens: 64000, cacheWriteTokens: 0 },
  approvals: [{
    eventId: 'approval-demo', sessionId: 'session-demo', toolName: 'pwsh', callId: 'call-pwsh',
    reason: '查看本机磁盘空间需要运行只读 PowerShell 命令。',
  }],
  items: [
    { kind: 'user', seq: 1, time: now - 90000, source: 'user', parts: [{ kind: 'text', text: '帮我看下这个项目的启动流程，并给出一个新手也能看懂的说明。' }] },
    {
      kind: 'assistant', seq: 2, time: now - 60000,
      parts: [
        { kind: 'reasoning', text: '先看 README 和 package.json，确认入口，再整理成三步。' },
        {
          kind: 'text',
          text: [
            '我把启动流程拆成三步：',
            '',
            '1. **准备运行环境**（首次启动自动完成）',
            '2. 启动本地服务，监听 `127.0.0.1:3080`',
            '3. 客户端连接该端口并渲染界面',
            '',
            '```bash',
            '# 手动启动等价于',
            'dsh web --port 3080 --no-open',
            '```',
            '',
            '> 本地服务只监听回环地址，不会暴露到局域网。',
            '',
            '| 项目 | 说明 |',
            '| --- | --- |',
            '| 端口 | 3080 |',
            '| 数据目录 | 用户目录下的应用数据 |',
          ].join('\n'),
        },
      ],
      usage: { inputTokens: 128000, outputTokens: 24000, cacheReadTokens: 64000 },
    },
    { kind: 'tool', seq: 3, time: now - 45000, callId: 'call-1', name: 'read', summary: 'README.md', arguments: '{"path":"README.md"}', output: '# DeepSeek Desktop\n\n本地优先的 DeepSeek 客户端。', isError: false, running: false },
    { kind: 'tool', seq: 3.5, time: now - 30000, callId: 'call-pwsh', name: 'pwsh', summary: '查询本机磁盘空间', arguments: '{"command":"Get-CimInstance Win32_LogicalDisk"}', output: null, isError: false, running: true },
    { kind: 'assistant', seq: 4, time: now - 20000, parts: [{ kind: 'text', text: '上面就是完整流程。需要我把这些步骤写进 README 吗？' }] },
  ],
};

const sessions = [
  { sessionId: 'session-demo', title: '把 README 改写成新手版本', cwd: '/home/user/deepseek', agentPreset: 'standard', running: false, updatedAt: now - 60000, turns: 4 },
  { sessionId: 'session-2', title: '批量重命名脚本', cwd: '/home/user/deepseek', agentPreset: 'code', running: true, updatedAt: now - 3600e3, turns: 2 },
  { sessionId: 'session-3', title: '整理接口文档', cwd: '/home/user/docs', agentPreset: 'standard', running: false, updatedAt: now - 86400e3, turns: 9 },
];
let selection = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' };
let permissionMode = 'danger-full-access';
const catalog = {
  fetchedAt: now, day: '2026-09-11', source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
  models: [
    { id: 'deepseek-flash', displayName: 'DeepSeek-V4.1-Flash', version: 'DeepSeek-V4.1-Flash', contextWindow: '1M', maxOutput: '最大 384K', concurrency: 2500, features: { 图像理解: '支持' }, pricing: { currency: 'CNY', tiers: { 'inputCacheHit.offPeak': 0.02, 'inputCacheHit.peak': 0.04, 'inputCacheMiss.offPeak': 1, 'inputCacheMiss.peak': 2, 'output.offPeak': 4, 'output.peak': 8 } } },
    { id: 'deepseek-v4-pro', displayName: 'DeepSeek-V4-Pro', version: 'DeepSeek-V4-Pro-0813', contextWindow: '1M', maxOutput: '最大 384K', concurrency: 500, features: { 图像理解: '不支持' }, pricing: { currency: 'CNY', tiers: { 'inputCacheHit.offPeak': 0.15, 'inputCacheHit.peak': 0.3, 'inputCacheMiss.offPeak': 4.5, 'inputCacheMiss.peak': 9, 'output.offPeak': 13.5, 'output.peak': 27 } } },
  ],
};

const world = {
  baseUrl: 'http://127.0.0.1:3080',
  boot: { phase: 'ready', percent: 100, label: '准备完成', reused: false, ownership: 'app' },
  credential: { refs: { DEEPSEEK_API_KEY: { configured: true, source: 'file', writable: true } } },
  platform: {
    signedIn: true,
    activeKeyName: 'desktop',
    lastBalance: { currency: 'CNY', balance: 86.42, tokenEstimation: 12400000, wallets: [{ currency: 'CNY', balance: 86.42 }, { currency: 'CNY', balance: 10, wallet: 'bonus' }], fetchedAt: now },
    lastUsage: { currency: 'CNY', today: { date: '2026-09-14', tokens: 184220, cost: 0.83, requests: 16 }, period: { kind: 'last30Days', tokens: 3242000, cost: 14.62, requests: 289 }, topModel: 'deepseek-flash', fetchedAt: now },
    lastKeys: null,
  },
  catalog,
  ad: {
    enabled: true,
    source: 'remote',
    rotateSeconds: 2,
    fetchedAt: now,
    error: null,
    recommendedSize: { width: 480, height: 270 },
    ads: [
      { url: 'https://www.a.com/aaa', pic: PIC_A, title: '示例广告一', text: '点击图片打开 a.com' },
      { url: 'https://www.b.com/bbb', pic: PIC_B, title: '示例广告二', text: '点击图片打开 b.com' },
    ],
  },
  ui: { theme: 'dark', defaultPermission: 'workspace-write' },
  update: { status: 'current', currentVersion: APP_VERSION, availableVersion: null, progress: 0, checkedAt: now, error: null, portable: true },
  dataDir: '/home/user/.config/DeepSeek Desktop',
  logFile: '/home/user/.config/DeepSeek Desktop/logs/main.log',
  version: APP_VERSION,
  platformName: process.platform,
  arch: process.arch,
  journal: ['2026-09-11T09:00:01.000Z [bootstrap] reusing DSH web on port 3080'],
};

const registry = [
  {
    id: 'deepseek-official', name: 'DeepSeek',
    models: [
      { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', efforts: [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }], defaultEffort: 'high' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }], defaultEffort: 'high' },
    ],
  },
];

const ok = (value) => ({ ok: true, value });

// The harness runs from build/app/, so the renderer and preload trees sit beside it.
const preload = path.join(__dirname, 'src', 'preload', 'main.js');
const page = (name) => path.join(__dirname, 'src', 'renderer', name);

function registerStubIpc() {
  ipcMain.handle('app:info', () => ok({ ...world, platform: process.platform, arch: process.arch }));
  ipcMain.handle('app:boot-state', () => ok(world.boot));
  ipcMain.handle('app:world', () => ok(world));
  ipcMain.handle('app:copy', () => ok(true));
  ipcMain.handle('app:open-external', () => ok(true));
  ipcMain.handle('app:open-path', () => ok(true));
  ipcMain.handle('sessions:list', () => ok(sessions));
  ipcMain.handle('sessions:open', () => ok(transcript));
  ipcMain.handle('sessions:refresh', () => ok(transcript));
  ipcMain.handle('sessions:create', () => ok({ sessionId: 'session-new' }));
  ipcMain.handle('sessions:model-selection', () => ok({ current: selection, routable: true }));
  ipcMain.handle('sessions:permissions', () => ok({
    currentValue: permissionMode,
    options: [
      { value: 'read-only', name: 'read-only' },
      { value: 'workspace-write', name: 'workspace-write' },
      { value: 'danger-full-access', name: 'danger-full-access' },
    ],
  }));
  ipcMain.handle('sessions:select-permission', (_event, _sessionId, preset) => {
    permissionMode = preset;
    return ok({ currentValue: permissionMode, options: [] });
  });
  ipcMain.handle('sessions:prompt', () => ok(transcript));
  ipcMain.handle('sessions:cancel', async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return ok(true);
  });
  ipcMain.handle('sessions:answer-approval', () => ok({ accepted: true, outcome: 'allowed-once' }));
  ipcMain.handle('llm:catalog', () => ok({ default: selection, registry, official: catalog, failures: [] }));
  ipcMain.handle('llm:select-model', (_event, _sessionId, provider, model, reasoningEffort) => {
    selection = { provider, model, reasoningEffort };
    return ok(selection);
  });
  ipcMain.handle('catalog:sync', () => ok(catalog));
  ipcMain.handle('credentials:describe', () => ok(world.credential.refs));
  ipcMain.handle('credentials:set', () => ok({ configured: true, balance: world.platform.lastBalance }));
  ipcMain.handle('credentials:unset', () => ok(true));
  ipcMain.handle('settings:ui-get', () => ok(world.ui));
  ipcMain.handle('settings:ui-set', (_event, patch) => ok(Object.assign(world.ui, patch)));
  ipcMain.handle('settings:ad-get', () => ok(world.ad));
  ipcMain.handle('settings:ad-set', (_event, patch) => ok({ ...world.ad, ...patch }));
  ipcMain.handle('settings:describe', () => ok({ namespaces: [] }));
  ipcMain.handle('settings:kernel-source-get', () => ok(null));
  ipcMain.handle('settings:kernel-source-set', (_event, value) => ok(value || null));
  ipcMain.handle('platform:status', () => ok(world.platform));
  ipcMain.handle('platform:login', () => ok(true));
  ipcMain.handle('platform:recharge', () => ok(true));
  ipcMain.handle('platform:usage', () => ok(true));
  ipcMain.handle('platform:refresh', () => ok({ needsLogin: false, summary: world.platform.lastBalance, usage: world.platform.lastUsage, usageFresh: true }));
  ipcMain.handle('platform:balance', () => ok({ needsLogin: false, summary: world.platform.lastBalance, usage: world.platform.lastUsage }));
  ipcMain.handle('platform:keys', () => ok({ needsLogin: false, keys: [
    { name: 'desktop', maskedKey: 'sk-9f2c...7ab1', createdAt: now - 86400e3 * 6, lastUsed: now - 3600e3, trackingId: null },
    { name: 'batch-script', maskedKey: 'sk-31ab...0e77', createdAt: now - 86400e3 * 30, lastUsed: null, trackingId: null },
  ] }));
  ipcMain.handle('platform:create-key', () => ok({ created: { name: 'desktop-2', secret: 'sk-demo0123456789abcdef0123456789abcdef', maskedKey: 'sk-dem...cdef', applied: true } }));
  ipcMain.handle('platform:delete-key', () => ok(true));
  ipcMain.handle('platform:rename-key', () => ok(true));
  ipcMain.handle('platform:logout', () => ok(true));
  ipcMain.handle('update:status', () => ok(world.update));
  ipcMain.handle('update:check', () => ok(world.update));
  ipcMain.handle('update:install', () => ok(true));
  ipcMain.handle('window:minimize', () => ok(true));
  ipcMain.handle('window:focus-main', () => ok(true));
  ipcMain.handle('window:toggle-maximize', () => ok(false));
  ipcMain.handle('window:close', () => ok(true));
  ipcMain.handle('window:is-maximized', () => ok(false));
  ipcMain.handle('dialog:message', () => ok({ response: 0 }));
}

const PROBE = [
  '(() => {',
  '  const q = (s) => document.querySelector(s);',
  '  return {',
  '    sessions: document.querySelectorAll(".session-item").length,',
  '    messages: document.querySelectorAll(".msg").length,',
  '    folds: document.querySelectorAll(".fold").length,',
  '    approvals: document.querySelectorAll(".approval-panel").length,',
  '    approvalText: q(".approval-panel") ? q(".approval-panel").innerText.replace(/\\s+/g, " ").trim() : null,',
  '    tables: document.querySelectorAll(".md-table").length,',
  '    codeBlocks: document.querySelectorAll(".md-pre").length,',
  '    ad: q("#ad-slot") ? q("#ad-slot").innerText.slice(0, 50) : null,',
  '    balance: q("#balance-text") ? q("#balance-text").textContent : null,',
  '    todayUsage: q("#usage-text") ? q("#usage-text").textContent : null,',
  '    reasoning: (() => { const c = q("#reasoning-control"); const s = q("#reasoning-slider"); return c && s ? { hidden: c.hidden, value: s.value, max: s.max, label: q("#reasoning-value").textContent } : null; })(),',
  '    permission: (() => { const s = q("#permission-slider"); return s ? { value: s.value, max: s.max, label: q("#permission-value").textContent, disabled: s.disabled } : null; })(),',
  '    model: q("#model-name") ? q("#model-name").textContent : null,',
  '    title: q("#chat-title") ? q("#chat-title").textContent : null,',
  '    profile: q("#profile-sub") ? q("#profile-sub").textContent : null,',
  '    railHidden: q("#app").classList.contains("rail-hidden"),',
  '    adCaption: q("#ad-slot") ? q("#ad-slot").innerText.replace(/\\s+/g, " ").trim().slice(0, 60) : null,',
  '    adFrame: (() => { const el = q(".ad-frame"); if (!el) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), ratio: +(r.width / r.height).toFixed(2) }; })(),',
  '    adImage: (() => { const el = q(".ad-img"); if (!el) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), fit: getComputedStyle(el).objectFit, src: el.getAttribute("src").slice(0, 24) }; })(),',
  '    adDots: document.querySelectorAll(".ad-dot").length,',
  '  };',
  '})()',
].join('\n');

/** Richer probe: geometry + modal content, so layout is verifiable without looking at PNGs. */
const PANEL_PROBE = [
  '(() => {',
  '  const box = (s) => { const el = document.querySelector(s); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };',
  '  const txt = (s) => { const el = document.querySelector(s); return el ? el.innerText.replace(/\\s+/g, " ").trim().slice(0, 240) : null; };',
  '  return {',
  '    rail: box(".rail"), ad: box("#ad-slot"), adAfterList: (() => {',
  '      const ad = document.querySelector("#ad-slot"); const list = document.querySelector("#session-list"); const foot = document.querySelector(".rail-foot");',
  '      if (!ad || !list || !foot) return null;',
  '      return { adBelowList: ad.getBoundingClientRect().top >= list.getBoundingClientRect().bottom - 2, adAboveFoot: ad.getBoundingClientRect().bottom <= foot.getBoundingClientRect().top + 2 };',
  '    })(),',
  '    composer: box(".composer"), stream: box(".stream"),',
  '    modalTitle: txt(".card-title"), modalTabs: [...document.querySelectorAll(".tab")].map((t) => t.textContent.trim()),',
  '    balanceAmount: txt(".balance-amount"),',
  '    usageSummary: txt(".usage-summary"),',
  '    keyRows: document.querySelectorAll(".key-row").length,',
  '    keyNames: [...document.querySelectorAll(".key-name")].map((n) => n.textContent.trim()),',
  '    pricingRows: document.querySelectorAll(".pricing-grid").length,',
  '    pricingSample: txt(".pricing-grid"),',
  '    fields: [...document.querySelectorAll(".field label")].map((l) => l.textContent.trim()).slice(0, 12),',
  '    modelOptions: [...document.querySelectorAll(".model-option .m-name")].map((n) => n.textContent.trim()),',
  '  };',
  '})()',
].join('\n');

app.whenReady().then(async () => {
  registerStubIpc();
  console.log('RESOURCES', JSON.stringify({
    renderer: fs.existsSync(page('index.html')),
    splash: fs.existsSync(page('splash.html')),
    preload: fs.existsSync(preload),
  }));
  // One window for the whole run: the app's real sequence (splash window → shell window) is
  // two windows, but a headless capture run keeps a single renderer for stability.
  const win = new BrowserWindow({ width: 1280, height: 840, show: false, backgroundColor: '#0b0e14', webPreferences: { preload, contextIsolation: true } });
  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.log('DID_FAIL_LOAD', code, description, url);
  });
  win.webContents.on('console-message', (details) => {
    console.log('RENDERER_CONSOLE', details?.level, String(details?.message ?? '').slice(0, 400));
  });
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.log('PRELOAD_ERROR', preloadPath, String(error));
  });

  try {
    await win.loadFile(page('splash.html'));
    setTimeout(() => win.webContents.send('boot:state', { phase: 'install', percent: 63, label: '正在安装运行组件' }), 250);
    await new Promise((resolve) => setTimeout(resolve, Math.max(400, SPLASH_MS)));
    win.setSize(420, 300);
    await new Promise((resolve) => setTimeout(resolve, 250));
    fs.writeFileSync(shot('-splash'), (await capture(win)).toPNG());
    console.log('SPLASH captured');
  } catch (error) {
    console.log('SPLASH_ERROR', String(error));
  }

  win.setSize(1280, 840);
  console.log('LOADING', page('index.html'), 'exists', fs.existsSync(page('index.html')));
  try {
    await win.loadFile(page('index.html'));
    console.log('LOADED ok');
  } catch (error) {
    console.log('LOAD_ERROR', String(error));
  }
  await new Promise((resolve) => setTimeout(resolve, 2200));
  try {
    console.log('UI PROBE', JSON.stringify(await win.webContents.executeJavaScript(PROBE), null, 2));
  } catch (error) {
    console.log('PROBE_ERROR', String(error));
  }
  try {
    await win.webContents.executeJavaScript(`(() => {
      const slider = document.getElementById('reasoning-slider');
      slider.value = slider.max;
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    console.log('REASONING SLIDER', JSON.stringify(await win.webContents.executeJavaScript(PROBE), null, 2));
  } catch (error) {
    console.log('REASONING_ERROR', String(error));
  }
  try {
    await win.webContents.executeJavaScript(`(() => {
      const slider = document.getElementById('permission-slider');
      slider.value = '0';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    console.log('PERMISSION SLIDER', JSON.stringify(await win.webContents.executeJavaScript(PROBE), null, 2));
  } catch (error) {
    console.log('PERMISSION_ERROR', String(error));
  }
  try {
    fs.writeFileSync(SHOT, (await capture(win)).toPNG());
  } catch (error) {
    console.log('SHOT_ERROR', String(error));
  }
  process.on('unhandledRejection', (reason) => console.log('REJECTION', String(reason)));

  await win.webContents.executeJavaScript('document.getElementById("open-profile").click()');
  await new Promise((resolve) => setTimeout(resolve, 1600));
  console.log('ACCOUNT PANEL', JSON.stringify(await win.webContents.executeJavaScript(PANEL_PROBE), null, 2));
  win.webContents.send('platform:state', {
    ...world,
    platform: { signedIn: false, activeKeyName: null, lastBalance: null, lastUsage: null, lastKeys: null },
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const disabledBeforeLogin = await win.webContents.executeJavaScript('document.getElementById("new-key-name")?.disabled');
  win.webContents.send('platform:state', world);
  await new Promise((resolve) => setTimeout(resolve, 100));
  console.log('ACCOUNT LOGIN TRANSITION', JSON.stringify(await win.webContents.executeJavaScript(`(() => ({
    disabledBeforeLogin: ${JSON.stringify(disabledBeforeLogin)},
    nameDisabledAfterLogin: document.getElementById('new-key-name')?.disabled,
    manualDisabledAfterLogin: document.getElementById('manual-key-input')?.disabled,
  }))()`), null, 2));
  await win.webContents.executeJavaScript(`(() => {
    const input = document.getElementById('manual-key-input');
    input.value = 'sk-focus-preserved-value';
    input.focus();
  })()`);
  win.webContents.send('platform:state', world);
  await new Promise((resolve) => setTimeout(resolve, 100));
  console.log('ACCOUNT INPUT', JSON.stringify(await win.webContents.executeJavaScript(`(() => ({
    active: document.activeElement?.id,
    value: document.getElementById('manual-key-input')?.value,
    disabled: document.getElementById('manual-key-input')?.disabled,
    readOnly: document.getElementById('manual-key-input')?.readOnly,
  }))()`), null, 2));
  fs.writeFileSync(shot('-account'), (await capture(win)).toPNG());

  await win.webContents.executeJavaScript('document.querySelector("[data-tab=models]").click()');
  await new Promise((resolve) => setTimeout(resolve, 1200));
  console.log('MODELS PANEL', JSON.stringify(await win.webContents.executeJavaScript(PANEL_PROBE), null, 2));
  fs.writeFileSync(shot('-models'), (await capture(win)).toPNG());

  await win.webContents.executeJavaScript('document.querySelector("[data-tab=general]").click()');
  await new Promise((resolve) => setTimeout(resolve, 1000));
  console.log('GENERAL PANEL', JSON.stringify(await win.webContents.executeJavaScript(PANEL_PROBE), null, 2));
  fs.writeFileSync(shot('-general'), (await capture(win)).toPNG());

  await win.webContents.executeJavaScript('document.querySelector("[data-tab=about]").click()');
  await new Promise((resolve) => setTimeout(resolve, 500));
  console.log('ABOUT FEEDBACK', JSON.stringify(await win.webContents.executeJavaScript(`(() => ({
    email: document.querySelector('[data-action=feedback-email]')?.textContent.trim(),
    versionText: document.querySelector('.card:nth-of-type(2) .card-sub')?.textContent.trim(),
  }))()`), null, 2));

  await win.webContents.executeJavaScript('document.getElementById("model-chip").click()');
  await new Promise((resolve) => setTimeout(resolve, 700));
  console.log('MODEL POPOVER', JSON.stringify(await win.webContents.executeJavaScript(PANEL_PROBE), null, 2));
  fs.writeFileSync(shot('-popover'), (await capture(win)).toPNG());

  await win.webContents.executeJavaScript('document.getElementById("modal-close").click()');
  await new Promise((resolve) => setTimeout(resolve, 400));
  console.log('MODEL POPOVER OUTSIDE CLICK', JSON.stringify(await win.webContents.executeJavaScript(`(() => {
    document.getElementById('model-chip').click();
    const opened = !document.getElementById('model-popover').hidden;
    document.getElementById('stream').click();
    return { opened, closedAfterOutsideClick: document.getElementById('model-popover').hidden };
  })()`), null, 2));
  await win.webContents.executeJavaScript(`(() => {
    state.streaming = false;
    const slider = document.getElementById('permission-slider');
    slider.value = '2';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const permissionReminder = await win.webContents.executeJavaScript(`(() => ({
    visible: !document.getElementById('permission-warning').hidden,
    label: document.getElementById('permission-warning').textContent.trim(),
    preset: state.permissionMode,
    saved: state.ui.defaultPermission,
    blocked: Boolean(document.querySelector('[role="alertdialog"]')),
  }))()`);
  require('node:assert/strict').equal(permissionReminder.visible, true);
  require('node:assert/strict').equal(permissionReminder.preset, 'danger-full-access');
  require('node:assert/strict').equal(permissionReminder.saved, 'danger-full-access');
  require('node:assert/strict').equal(permissionReminder.blocked, false);
  console.log('FULL ACCESS REMINDER', JSON.stringify(permissionReminder, null, 2));
  fs.writeFileSync(shot('-permission-warning'), (await capture(win)).toPNG());
  const stopStarted = await win.webContents.executeJavaScript(`(async () => {
    App.activateSession('session-demo');
    App.receiveTranscript('session-demo', { ...state.transcript, sessionId: 'session-demo', running: true });
    document.getElementById('stop-btn').click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      visible: !document.getElementById('stop-btn').hidden,
      disabled: document.getElementById('stop-btn').disabled,
      text: document.getElementById('stop-btn').textContent,
      stopping: state.stopping,
    };
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 220));
  const stopFinished = await win.webContents.executeJavaScript(`(() => ({
    hidden: document.getElementById('stop-btn').hidden,
    stopping: state.stopping,
    streaming: state.streaming,
  }))()`);
  console.log('STOP BUTTON', JSON.stringify({ started: stopStarted, finished: stopFinished }, null, 2));
  console.log('DEFAULT CONVERSATION CONTROLS', JSON.stringify(await win.webContents.executeJavaScript(`(async () => {
    state.activeSessionId = null;
    state.streaming = true;
    await App.loadSelection();
    App.renderStreamingState();
    const slider = document.getElementById('reasoning-slider');
    const changed = await App.chooseSelection('deepseek-official', 'deepseek-v4-pro', 'high');
    return { hidden: slider.hidden, controlHidden: document.getElementById('reasoning-control').hidden, disabled: slider.disabled, changed, pending: state.pendingSelection };
  })()`), null, 2));
  await win.webContents.executeJavaScript('document.getElementById("new-chat").click()');
  await new Promise((resolve) => setTimeout(resolve, 700));
  console.log('NEW CONVERSATION INPUT', JSON.stringify(await win.webContents.executeJavaScript(`(() => {
    const input = document.getElementById('input');
    return { active: document.activeElement?.id, disabled: input.disabled, readOnly: input.readOnly, sendDisabled: document.getElementById('send-btn').disabled, sessionId: state.activeSessionId };
  })()`), null, 2));
  // Sample the visible caption a few times across one rotation period: the slot must cycle
  // through every configured ad and come back around.
  const adProbe = '(() => { const cap = document.querySelector(".ad-title"); return cap ? cap.textContent : null; })()';
  const seen = [];
  for (let i = 0; i < 7; i += 1) {
    seen.push(await win.webContents.executeJavaScript(adProbe));
    await new Promise((resolve) => setTimeout(resolve, 900));
  }
  const unique = [...new Set(seen.filter(Boolean))];
  console.log('AD ROTATION', JSON.stringify({ samples: seen, unique, rotated: unique.length > 1 }, null, 2));

  console.log('screenshots written:', SHOT, shot('-splash'), shot('-account'), shot('-models'), shot('-general'));
  app.quit();
});
