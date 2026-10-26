'use strict';
/**
 * Startup animation choice. The built-in whale scene is the default; a user may instead pick
 * one image or video, which is copied into `<data>/splash/` under a generated name. The splash
 * window only ever receives a file URL that this module resolved inside that folder, so a
 * renderer-written setting can never point the splash at an arbitrary path.
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const STYLES = ['whale', 'custom'];
const KINDS = {
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.gif': 'image',
  '.mp4': 'video', '.webm': 'video',
};
const MAX_BYTES = 200 * 1024 * 1024;
const STORED_NAME = /^custom-\d+\.(png|jpe?g|webp|gif|mp4|webm)$/;

function splashStyle(value) {
  return STYLES.includes(value) ? value : 'whale';
}

function artDir(root) {
  return path.join(root, 'splash');
}

/** `{ url, kind }` for the splash window, or null when the whale should play. */
function resolveSplashArt(store, root) {
  if (splashStyle(store?.get('splashStyle', 'whale')) !== 'custom') return null;
  const name = store.get('splashArt', null);
  if (typeof name !== 'string' || !STORED_NAME.test(name)) return null;
  const file = path.join(artDir(root), name);
  try {
    if (!fs.statSync(file).isFile()) return null;
  } catch { return null; }
  return { url: pathToFileURL(file).href, kind: KINDS[path.extname(name).toLowerCase()] };
}

/** Copy a user-picked file into the splash folder and drop any earlier copy. */
function importSplashArt(source, root) {
  const ext = path.extname(String(source ?? '')).toLowerCase();
  if (!KINDS[ext]) throw new Error('仅支持 PNG、JPG、WebP、GIF 图片或 MP4、WebM 视频');
  const stat = fs.statSync(source);
  if (!stat.isFile()) throw new Error('请选择一个文件');
  if (stat.size > MAX_BYTES) throw new Error('文件不能超过 200 MB');
  const dir = artDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const name = `custom-${Date.now()}${ext}`;
  const target = path.join(dir, name);
  fs.copyFileSync(source, target);
  removeStoredArt(root, name);
  return { file: name, name: path.basename(source).slice(0, 120), kind: KINDS[ext] };
}

/** Delete stored custom art, optionally keeping the one just imported. */
function removeStoredArt(root, keep = null) {
  let entries = [];
  try { entries = fs.readdirSync(artDir(root)); } catch { return; }
  for (const entry of entries) {
    if (entry === keep || !STORED_NAME.test(entry)) continue;
    try { fs.rmSync(path.join(artDir(root), entry), { force: true }); } catch { /* best effort */ }
  }
}

module.exports = { STYLES, KINDS, MAX_BYTES, splashStyle, resolveSplashArt, importSplashArt, removeStoredArt };
