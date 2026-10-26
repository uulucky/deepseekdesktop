'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const media = require('../src/main/modules/media-tools');
const ocr = require('../src/main/modules/image-ocr');

// PATH keeps the user's order, appends only existing folders, and never duplicates.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsd-media-'));
const sep = process.platform === 'win32' ? ';' : ':';
const env = { [process.platform === 'win32' ? 'Path' : 'PATH']: ['/first', '/second'].join(sep) };
const augmented = media.augmentedPath(env, [dir, dir, path.join(dir, 'missing')]);
assert.deepEqual(Object.keys(augmented), Object.keys(env), 'keeps the platform spelling of PATH');
const parts = Object.values(augmented)[0].split(sep);
assert.deepEqual(parts.slice(0, 2), ['/first', '/second']);
assert.equal(parts.filter((item) => item === dir).length, 1);
assert.equal(parts.includes(path.join(dir, 'missing')), false);

// A fake ffmpeg on the search path is found and described for the prompt.
const fake = path.join(dir, process.platform === 'win32' ? 'ffmpeg.cmd' : 'ffmpeg');
fs.writeFileSync(fake, process.platform === 'win32' ? '@echo ffmpeg version 9.9-test\r\n' : '#!/bin/sh\necho "ffmpeg version 9.9-test"\n');
fs.chmodSync(fake, 0o755);
const found = media.detectMediaTools({ PATH: dir, Path: dir });
assert.equal(found.ffmpeg.path, fake);
assert.equal(found.ffprobe === null || typeof found.ffprobe.path === 'string', true);
assert.match(media.mediaPromptNote({ ffmpeg: { path: fake }, ffprobe: null }), /ffprobe is NOT installed.*ffmpeg -hide_banner -i/);
assert.match(media.mediaPromptNote({ ffmpeg: null, ffprobe: null }), /install|winget|brew/);
assert.match(media.installCommand(), /^(brew install ffmpeg|winget install --id Gyan\.FFmpeg -e)$/);
fs.rmSync(dir, { recursive: true, force: true });

// Which selections get OCR: official text-only models, honoring a user's settings override.
assert.equal(ocr.isTextOnlySelection({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }), true);
assert.equal(ocr.isTextOnlySelection({ provider: 'deepseek-official', model: 'deepseek-flash' }), false);
assert.equal(ocr.isTextOnlySelection({ provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' }), false);
assert.equal(ocr.isTextOnlySelection({ provider: 'custom', model: 'anything' }), false, 'custom providers are left alone');
assert.equal(ocr.isTextOnlySelection(null), false);
assert.equal(ocr.isTextOnlySelection({ provider: 'deepseek-official', model: 'deepseek-flash' },
  { models: [{ id: 'deepseek-flash', inputModalities: ['text'] }] }), true, 'a text-only override wins');
assert.match(ocr.ocrAppendix([{ name: 'a.png', text: '你好' }, { name: 'b.png', text: '' }]), /「a\.png」[\s\S]*你好[\s\S]*「b\.png」.*没有识别到文字/);
assert.equal(ocr.ocrAppendix([]), '');

(async () => {
  assert.equal(await ocr.recognizeText(Buffer.from('x'), 'image/bmp'), '', 'unsupported types are skipped');
  assert.equal(await ocr.recognizeText(Buffer.from('not an image'), 'image/png', { timeoutMs: 15000 }), '', 'bad images yield no text, never throw');
  if (ocr.ocrSupported()) {
    // The README screenshot carries the app's own UI text; OS OCR must read some of it.
    const text = await ocr.recognizeText(fs.readFileSync(path.join(__dirname, '..', 'desktop.png')), 'image/png', { timeoutMs: 30000 });
    console.log(`  OCR on ${process.platform}: ${text.length} chars`);
    if (process.platform === 'darwin') assert.match(text, /DeepSeek/i);
  }
  console.log('PASS media: PATH augmentation, ffmpeg detection and prompt note, text-only model detection and on-device image OCR');
})().catch((error) => { console.error(error); process.exit(1); });
