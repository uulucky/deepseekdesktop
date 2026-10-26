'use strict';
/**
 * Progress-only splash. It deliberately shows a percentage and a generic status line and
 * nothing about which components are being fetched or installed. The whale scene is pure
 * CSS; the phase attribute only lets a failed start freeze and mute it.
 */
const bar = document.getElementById('bar');
const percent = document.getElementById('percent');
const label = document.getElementById('label');
const hint = document.getElementById('hint');
const errorBox = document.getElementById('error');

function render(state) {
  if (!state) return;
  if (state.phase) document.body.dataset.phase = state.phase;
  const value = Math.max(0, Math.min(100, Number(state.percent ?? 0)));
  bar.style.width = value + '%';
  percent.textContent = Math.round(value) + '%';
  if (state.label) label.textContent = state.label;
  if (state.phase === 'error') {
    errorBox.style.display = 'block';
    errorBox.textContent = state.error ? `启动失败：${state.error}` : '启动失败';
    hint.textContent = '可以关闭后重试，或到设置中查看日志。';
  }
  if (state.phase === 'stopped') {
    errorBox.style.display = 'block';
    errorBox.textContent = state.error ? `启动失败：${state.error}` : '启动失败：本地服务已停止';
    hint.textContent = '请关闭程序后重试；若仍失败，请发送 data\\logs 中最新的日志文件。';
  }
  if (state.reused) hint.textContent = '检测到已在运行的服务，正在连接…';
  if (state.phase === 'ready') {
    hint.textContent = '准备完成，正在打开界面…';
    bar.style.width = '100%';
    percent.textContent = '100%';
  }
}

/**
 * User-chosen artwork arrives as a query string the main process built from its own data
 * folder. Anything unexpected, or a file that fails to decode, leaves the whale in place.
 */
function showCustomArt() {
  const params = new URLSearchParams(location.search);
  const url = params.get('art');
  const kind = params.get('kind');
  if (!url || !url.startsWith('file:') || !['image', 'video'].includes(kind)) return;
  const media = document.createElement(kind === 'video' ? 'video' : 'img');
  media.className = 'art';
  media.setAttribute('aria-hidden', 'true');
  const reveal = () => document.body.classList.add('has-art');
  if (kind === 'video') {
    media.muted = true;
    media.loop = true;
    media.playsInline = true;
    media.autoplay = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    media.addEventListener('loadeddata', reveal, { once: true });
  } else {
    media.alt = '';
    media.addEventListener('load', reveal, { once: true });
  }
  media.addEventListener('error', () => media.remove(), { once: true });
  media.src = url;
  document.querySelector('.shade').before(media);
}

showCustomArt();
window.deepseek.events.onBootState(render);
window.deepseek.app.bootState().then(render).catch(() => {});
