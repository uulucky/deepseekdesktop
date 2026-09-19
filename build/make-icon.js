'use strict';
/**
 * Generates the application icon (build/icon.ico + build/icon.png) with no image dependency.
 *
 * The mark is a rounded square with the same gradient as the in-app brand tile and a white
 * "D". Pixels are written into an RGBA buffer and encoded as PNG through zlib; the .ico wraps
 * the 256x256 PNG (Vista+ format) plus BMP entries for the smaller sizes Windows asks for.
 *
 *   node build/make-icon.js
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT_DIR = __dirname;

// ---------------------------------------------------------------------------- drawing

/**
 * The "D" mark is described as geometry rather than a pixel grid so it stays clean at every
 * size: a flat left spine plus a bowl stroked as a circular arc. Coordinates are fractions of
 * the icon size and are converted per render.
 */
const MARK = {
  // A slightly heavier weight than a typical UI glyph: at 16px the strokes must survive the
  // rasteriser, and the spine's right edge intentionally overlaps the bowl so the two merge.
  spine: { x: 0.235, y: 0.225, width: 0.135, height: 0.55, radius: 0.055 },
  bowl: { cx: 0.355, cy: 0.5, radius: 0.265, stroke: 0.115 },
};

/** Blend src over dst (both straight RGBA, 0..255). */
function over(dst, src, alpha) {
  const a = (src[3] / 255) * alpha;
  const outA = a + (dst[3] / 255) * (1 - a);
  if (outA <= 0) return [0, 0, 0, 0];
  return [
    Math.round((src[0] * a + dst[0] * (dst[3] / 255) * (1 - a)) / outA),
    Math.round((src[1] * a + dst[1] * (dst[3] / 255) * (1 - a)) / outA),
    Math.round((src[2] * a + dst[2] * (dst[3] / 255) * (1 - a)) / outA),
    Math.round(outA * 255),
  ];
}

/** Signed distance to a rounded rectangle (negative inside). */
function roundRectDistance(x, y, size, radius) {
  const half = size / 2;
  const dx = Math.abs(x - half) - (half - radius);
  const dy = Math.abs(y - half) - (half - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

/** Anti-aliased coverage from a signed distance (negative inside). */
function coverage(distance, feather = 0.75) {
  return Math.max(0, Math.min(1, 0.5 - distance / feather));
}

/** Signed distance to a rounded rectangle given as fractions of the icon size. */
function spineDistance(px, py, size) {
  const cx = (MARK.spine.x + MARK.spine.width / 2) * size;
  const cy = (MARK.spine.y + MARK.spine.height / 2) * size;
  const halfW = (MARK.spine.width / 2) * size;
  const halfH = (MARK.spine.height / 2) * size;
  const radius = MARK.spine.radius * size;
  const dx = Math.abs(px - cx) - (halfW - radius);
  const dy = Math.abs(py - cy) - (halfH - radius);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - radius;
}

/** Signed distance to the bowed right side (a stroked arc clipping at the spine). */
function bowlDistance(px, py, size) {
  const cx = MARK.bowl.cx * size;
  const cy = MARK.bowl.cy * size;
  const radius = MARK.bowl.radius * size;
  const half = (MARK.bowl.stroke / 2) * size;
  const distance = Math.abs(Math.hypot(px - cx, py - cy) - radius) - half;
  // Clip to the right half-plane through the bowl centre.
  return Math.max(distance, cx - px);
}

/** Render the icon at the requested size into an RGBA buffer. */
function render(size) {
  const buffer = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  // The mark is described in fractions of the icon size (see MARK), so it scales cleanly.

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const tile = coverage(roundRectDistance(px, py, size, radius));
      if (tile <= 0) continue;

      // Brand gradient, matching the in-app tile (#5a78ff → #3550e0).
      const t = (px / size) * 0.55 + (py / size) * 0.45;
      const gradient = [
        Math.round(0x5a + (0x35 - 0x5a) * t),
        Math.round(0x78 + (0x50 - 0x78) * t),
        Math.round(0xff + (0xe0 - 0xff) * t),
        255,
      ];
      let pixel = [gradient[0], gradient[1], gradient[2], Math.round(tile * 255)];

      // White "D": spine + bowl, each anti-aliased.
      const feather = Math.max(0.6, size / 160);
      const markCoverage = Math.max(
        coverage(spineDistance(px, py, size), feather),
        coverage(bowlDistance(px, py, size), feather),
      );
      if (markCoverage > 0) pixel = over(pixel, [255, 255, 255, 255], markCoverage * tile);
      const index = (y * size + x) * 4;
      buffer[index] = pixel[0];
      buffer[index + 1] = pixel[1];
      buffer[index + 2] = pixel[2];
      buffer[index + 3] = pixel[3];
    }
  }
  return buffer;
}

// ------------------------------------------------------------------------- encoding

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Encode an RGBA buffer as a PNG. */
function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A BMP (DIB) entry for the .ico, 32-bit with an AND mask. */
function encodeBmp(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // height doubled: XOR + AND mask
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = ((size - 1 - y) * size + x) * 4;
      const dst = (y * size + x) * 4;
      pixels[dst] = rgba[src + 2];
      pixels[dst + 1] = rgba[src + 1];
      pixels[dst + 2] = rgba[src];
      pixels[dst + 3] = rgba[src + 3];
    }
  }
  const maskStride = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskStride * size);
  return Buffer.concat([header, pixels, mask]);
}

/** Assemble an .ico from prepared entries. */
function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = 6 + entries.length * 16;
  const directory = [];
  for (const entry of entries) {
    const item = Buffer.alloc(16);
    item[0] = entry.size >= 256 ? 0 : entry.size;
    item[1] = entry.size >= 256 ? 0 : entry.size;
    item[2] = 0;
    item[3] = 0;
    item.writeUInt16LE(1, 4);
    item.writeUInt16LE(32, 6);
    item.writeUInt32LE(entry.data.length, 8);
    item.writeUInt32LE(offset, 12);
    offset += entry.data.length;
    directory.push(item);
  }
  return Buffer.concat([header, ...directory, ...entries.map((entry) => entry.data)]);
}

function main() {
  const png256 = encodePng(render(256), 256);
  fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), png256);
  fs.writeFileSync(path.join(OUT_DIR, 'icon-mac.png'), encodePng(render(1024), 1024));
  const entries = [
    { size: 256, data: png256 },
    ...[64, 48, 32, 16].map((size) => ({ size, data: encodeBmp(render(size), size) })),
  ];
  const ico = encodeIco(entries);
  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico);
  console.log(`icon.ico ${ico.length} bytes, icon.png ${png256.length} bytes`);
}

main();
