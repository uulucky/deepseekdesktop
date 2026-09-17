'use strict';
/**
 * Preload for the hidden DSH web view.
 *
 * The harness Web UI is loaded off-screen and is the *content source* for the app shell:
 * this script keeps a live, structured mirror of what that page is showing (conversation
 * list and transcript) and forwards it to the main process over a console-message channel,
 * which is the only bridge that survives the page's own CSP and navigations.
 *
 * The user never sees this window: it is never shown, it is skipped by the taskbar and it is
 * muted, while the visible shell renders the same content in a ChatGPT-style layout.
 */
const { ipcRenderer } = require('electron');

const CHANNEL_PREFIX = '__DSH_MIRROR__:';
const SNAPSHOT_INTERVAL_MS = 1200;
const MAX_ITEMS = 60;
const MAX_TEXT = 4000;

/** Emit one structured message to the main process. */
function emit(payload) {
  try {
    console.log(CHANNEL_PREFIX + JSON.stringify({ at: Date.now(), href: location.href, ...payload }));
  } catch { /* ignore */ }
}

/** Read an element's visible text, normalized and capped. */
function textOf(element, limit = MAX_TEXT) {
  if (!element) return '';
  const raw = (element.innerText || element.textContent || '').replace(/\u00a0/g, ' ');
  const text = raw.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return text.length > limit ? text.slice(0, limit) : text;
}

/** Ask the page which DOM nodes look like the conversation list / message stream. */
function readSessionList() {
  const items = [];
  const nodes = document.querySelectorAll('[class*="session" i] a, [class*="session" i] [role="button"], nav [role="listitem"], [data-session-id]');
  nodes.forEach((node) => {
    const text = textOf(node, 200);
    if (!text) return;
    const id = node.getAttribute('data-session-id') || node.closest('[data-session-id]')?.getAttribute('data-session-id') || null;
    items.push({ id, title: text, selected: node.getAttribute('aria-current') === 'true' || /active|selected/i.test(node.className || '') });
  });
  return items.slice(0, MAX_ITEMS);
}

/** Heuristic transcript mirror: the widest scroll container's direct children. */
function readTranscript() {
  const scrollers = [...document.querySelectorAll('div,main,section')]
    .filter((element) => element.scrollHeight > element.clientHeight + 40 && element.clientHeight > 200);
  const container = scrollers.sort((a, b) => b.clientHeight * b.clientWidth - a.clientHeight * a.clientWidth)[0];
  if (!container) return { messages: [], role: null };
  const messages = [];
  for (const child of [...container.children].slice(-MAX_ITEMS)) {
    const text = textOf(child);
    if (!text) continue;
    const aria = child.getAttribute('aria-label') || '';
    const role = /assistant|deepseek|模型|助手/i.test(aria) ? 'assistant'
      : /user|你|我/i.test(aria) ? 'user' : 'unknown';
    messages.push({ role, text, html: child.innerHTML.length < 200000 ? child.innerHTML : null });
  }
  return { messages, role: container.getAttribute('class') || null };
}

/** One full mirror frame: what the hidden page currently shows. */
function snapshot() {
  try {
    const { messages } = readTranscript();
    emit({ type: 'snapshot', sessions: readSessionList(), messages, title: document.title });
  } catch (error) {
    emit({ type: 'error', message: String(error && error.message ? error.message : error) });
  }
}

/** Report that the harness Web UI itself finished booting. */
function announceReady() {
  const hasRoot = Boolean(document.querySelector('#root, #app, [data-dsh-root]'));
  emit({ type: 'ready', hasRoot, title: document.title });
}

window.addEventListener('DOMContentLoaded', () => {
  announceReady();
  snapshot();
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; snapshot(); }, SNAPSHOT_INTERVAL_MS);
  };
  try {
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  } catch { /* observation is best-effort */ }
  setInterval(snapshot, 15000);
});

window.addEventListener('error', (event) => emit({ type: 'page-error', message: String(event.message ?? '') }));
ipcRenderer.on('dsh:command', (_event, command) => emit({ type: 'ack', command }));
