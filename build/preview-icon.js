'use strict';
/**
 * Renders the generated icon as ASCII art so its shape can be eyeballed in a terminal
 * (useful when the review environment cannot display images).
 *
 *   node build/preview-icon.js [size]
 */
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'make-icon.js'), 'utf8')
  .replace(/^main\(\);$/m, 'module.exports = { render };');
const mod = { exports: {} };
new Function('require', 'module', 'exports', '__dirname', source)(require, mod, mod.exports, __dirname);

const sizes = process.argv[2] ? [Number(process.argv[2])] : [16, 24, 40];

for (const size of sizes) {
  const rgba = mod.exports.render(size);
  const lines = [];
  for (let y = 0; y < size; y += 1) {
    let line = '';
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      const a = rgba[i + 3];
      if (a < 40) line += ' ';
      else if (r > 190 && g > 190 && b > 190) line += '#';
      else if (a > 200) line += '+';
      else line += '.';
    }
    lines.push(line);
  }
  console.log('--- ' + size + 'px ---');
  console.log(lines.join('\n'));
}
