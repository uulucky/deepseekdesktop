'use strict';
/**
 * A small QR code encoder for the phone pairing invite: byte mode, error correction level M,
 * versions 1-19 (up to ~620 bytes), automatic mask selection. It exists so the pairing screen
 * needs no third-party package; the invite is ~200 ASCII bytes, which lands around version 10.
 * Every version used here was checked to decode with both macOS Vision and ZXing (the
 * scanner in the dmuse app); version 20 is left out because ZXing rejected it.
 */

// [EC codewords per block, blocks in group 1, data codewords per group-1 block,
//  blocks in group 2, data codewords per group-2 block] for level M, versions 1-20.
const BLOCKS_M = [
  null,
  [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0], [24, 2, 43, 0, 0],
  [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44],
  [30, 1, 50, 4, 51], [22, 6, 36, 2, 37], [22, 8, 37, 1, 38], [24, 4, 40, 5, 41], [24, 5, 41, 5, 42],
  [28, 7, 45, 3, 46], [28, 10, 46, 1, 47], [26, 9, 43, 4, 44], [26, 3, 44, 11, 45], [26, 3, 41, 13, 42],
];

const ALIGNMENT = [
  null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46],
  [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70],
  [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90],
];

const REMAINDER_BITS = [null, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0, 0, 0, 0, 3, 3, 3, 3, 3, 3, 3];

// GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function generator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function reedSolomon(data, degree) {
  const gen = generator(degree);
  const out = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ out.shift();
    out.push(0);
    for (let i = 0; i < degree; i++) out[i] ^= mul(gen[i + 1], factor);
  }
  return out;
}

function capacity(version) {
  const [, b1, d1, b2, d2] = BLOCKS_M[version];
  return b1 * d1 + b2 * d2;
}

function chooseVersion(length) {
  for (let v = 1; v <= 19; v++) {
    const countBits = v <= 9 ? 8 : 16;
    if (4 + countBits + length * 8 <= capacity(v) * 8) return v;
  }
  throw new Error('配对信息过长，无法生成二维码');
}

function dataCodewords(bytes, version) {
  const bits = [];
  const put = (value, n) => { for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const total = capacity(version) * 8;
  put(0, Math.min(4, total - bits.length));
  while (bits.length % 8) bits.push(0);
  const words = [];
  for (let i = 0; i < bits.length; i += 8) words.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0; words.length < capacity(version); pad++) words.push(pad % 2 ? 0x11 : 0xec);
  return words;
}

function interleave(words, version) {
  const [ec, b1, d1, b2, d2] = BLOCKS_M[version];
  const blocks = [];
  let offset = 0;
  for (let i = 0; i < b1 + b2; i++) {
    const size = i < b1 ? d1 : d2;
    const data = words.slice(offset, offset + size);
    offset += size;
    blocks.push({ data, ec: reedSolomon(data, ec) });
  }
  const out = [];
  for (let i = 0; i < Math.max(d1, d2); i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  for (let i = 0; i < ec; i++) for (const b of blocks) out.push(b.ec[i]);
  return out;
}

function bch(value, poly, polyDegree) {
  let v = value << polyDegree;
  const top = Math.floor(Math.log2(poly));
  while (v && Math.floor(Math.log2(v)) >= top) v ^= poly << (Math.floor(Math.log2(v)) - top);
  return (value << polyDegree) | v;
}

class Matrix {
  constructor(version) {
    this.size = version * 4 + 17;
    this.version = version;
    this.dark = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.reserved = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
  }

  set(r, c, dark) { this.dark[r][c] = dark; this.reserved[r][c] = true; }

  functionPatterns() {
    const n = this.size;
    for (const [r0, c0] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
      for (let r = -1; r <= 7; r++) {
        for (let c = -1; c <= 7; c++) {
          const rr = r0 + r;
          const cc = c0 + c;
          if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue;
          const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
          this.set(rr, cc, r >= 0 && r <= 6 && c >= 0 && c <= 6 && ring !== 2);
        }
      }
    }
    for (let i = 8; i < n - 8; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    const centers = ALIGNMENT[this.version];
    const last = centers.length - 1;
    centers.forEach((r, i) => {
      centers.forEach((c, j) => {
        // Only the three positions under the finder patterns are skipped; the ones on the
        // timing lines (from version 7) are drawn over them.
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) this.set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      });
    });
    // Format areas (filled per mask) and the always-dark module.
    for (let i = 0; i < 9; i++) {
      if (!this.reserved[8][i]) this.set(8, i, false);
      if (!this.reserved[i][8]) this.set(i, 8, false);
    }
    for (let i = 0; i < 8; i++) {
      this.set(8, n - 1 - i, false);
      this.set(n - 1 - i, 8, false);
    }
    this.set(n - 8, 8, true);
    if (this.version >= 7) {
      const bits = bch(this.version, 0x1f25, 12);
      for (let i = 0; i < 18; i++) {
        const dark = ((bits >>> i) & 1) === 1;
        const a = Math.floor(i / 3);
        const b = (i % 3) + n - 11;
        this.set(a, b, dark);
        this.set(b, a, dark);
      }
    }
  }

  placeData(codewords) {
    const n = this.size;
    const bits = [];
    for (const w of codewords) for (let i = 7; i >= 0; i--) bits.push((w >>> i) & 1);
    for (let i = 0; i < REMAINDER_BITS[this.version]; i++) bits.push(0);
    let index = 0;
    let upward = true;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let step = 0; step < n; step++) {
        const r = upward ? n - 1 - step : step;
        for (let k = 0; k < 2; k++) {
          const c = right - k;
          if (this.reserved[r][c]) continue;
          this.dark[r][c] = index < bits.length ? bits[index] === 1 : false;
          index++;
        }
      }
      upward = !upward;
    }
  }

  withMask(mask) {
    const n = this.size;
    const tests = [
      (r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
      (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
      (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
    ];
    const grid = this.dark.map((row, r) => row.map((dark, c) => (!this.reserved[r][c] && tests[mask](r, c) ? !dark : dark)));
    // Level M is 00; the 15-bit format word is masked with 0x5412.
    const format = bch((0b00 << 3) | mask, 0x537, 10) ^ 0x5412;
    const bit = (i) => ((format >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) grid[i][8] = bit(i);
    grid[7][8] = bit(6);
    grid[8][8] = bit(7);
    grid[8][7] = bit(8);
    for (let i = 9; i < 15; i++) grid[8][14 - i] = bit(i);
    for (let i = 0; i < 8; i++) grid[8][n - 1 - i] = bit(i);
    for (let i = 8; i < 15; i++) grid[n - 15 + i][8] = bit(i);
    grid[n - 8][8] = true;
    return grid;
  }
}

function penalty(grid) {
  const n = grid.length;
  let score = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < n; a++) {
      let run = 1;
      for (let b = 1; b < n; b++) {
        const cur = pass ? grid[b][a] : grid[a][b];
        const prev = pass ? grid[b - 1][a] : grid[a][b - 1];
        if (cur === prev) run++;
        else { if (run >= 5) score += run - 2; run = 1; }
      }
      if (run >= 5) score += run - 2;
    }
  }
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const v = grid[r][c];
      if (v === grid[r][c + 1] && v === grid[r + 1][c] && v === grid[r + 1][c + 1]) score += 3;
    }
  }
  const finder = [true, false, true, true, true, false, true];
  const matches = (get, i) => {
    for (let k = 0; k < 7; k++) if (get(i + k) !== finder[k]) return false;
    const light = (from) => { for (let k = 0; k < 4; k++) { const v = get(from + k); if (v === undefined || v) return false; } return true; };
    return light(i - 4) || light(i + 7);
  };
  for (let a = 0; a < n; a++) {
    for (let i = 0; i + 7 <= n; i++) {
      if (matches((k) => (k < 0 || k >= n ? false : grid[a][k]), i)) score += 40;
      if (matches((k) => (k < 0 || k >= n ? false : grid[k][a]), i)) score += 40;
    }
  }
  let darkCount = 0;
  for (const row of grid) for (const v of row) if (v) darkCount++;
  score += Math.floor(Math.abs((darkCount * 100) / (n * n) - 50) / 5) * 10;
  return score;
}

/** Encode text into a square boolean matrix (true = dark), without the quiet zone. */
function encode(text) {
  const bytes = [...Buffer.from(String(text), 'utf8')];
  const version = chooseVersion(bytes.length);
  const matrix = new Matrix(version);
  matrix.functionPatterns();
  matrix.placeData(interleave(dataCodewords(bytes, version), version));
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const grid = matrix.withMask(mask);
    const score = penalty(grid);
    if (!best || score < best.score) best = { grid, score };
  }
  return best.grid;
}

/** Render text as an SVG QR code with a four-module quiet zone. */
function toSvg(text, { moduleSize = 6 } = {}) {
  const grid = encode(text);
  const n = grid.length + 8;
  let path = '';
  grid.forEach((row, r) => row.forEach((dark, c) => { if (dark) path += `M${c + 4} ${r + 4}h1v1h-1z`; }));
  const px = n * moduleSize;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">`
    + `<rect width="${n}" height="${n}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

module.exports = { encode, toSvg };
