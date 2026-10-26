'use strict';
/**
 * On-device text recognition for images sent to a text-only model. The kernel replaces such
 * images with "[image omitted …]", so without this the agent sees nothing. macOS uses the
 * Vision framework through JavaScript for Automation; Windows uses Windows.Media.Ocr through
 * Windows PowerShell. Both ship with the OS — nothing is downloaded, nothing leaves the
 * machine. Any failure just yields no text; sending never depends on OCR.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_TEXT = 6000;
const TIMEOUT_MS = 20000;

const MAC_SCRIPT = `ObjC.import('Foundation');
ObjC.import('Vision');
function run(argv) {
  const handler = $.VNImageRequestHandler.alloc.initWithURLOptions($.NSURL.fileURLWithPath(argv[0]), $.NSDictionary.dictionary);
  const request = $.VNRecognizeTextRequest.alloc.init;
  request.recognitionLevel = 0;
  request.usesLanguageCorrection = true;
  request.recognitionLanguages = $(['zh-Hans', 'zh-Hant', 'en-US']);
  if (!handler.performRequestsError($([request]), $())) return '';
  const lines = [];
  const results = request.results;
  for (let i = 0; i < results.count; i++) {
    const candidate = results.objectAtIndex(i).topCandidates(1).firstObject;
    if (candidate) lines.push(candidate.string.js);
  }
  return lines.join('\\n');
}
`;

// Read from stdin (`-Command -`), so no script file and no execution-policy override is needed.
const WINDOWS_SCRIPT = `$Path = $env:DSD_OCR_IMAGE
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, [Type]$type) { $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { exit 3 }
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$result.Lines | ForEach-Object { $_.Text }
`;

const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };

function ocrSupported(platform = process.platform) {
  return platform === 'darwin' || platform === 'win32';
}

function runScript(command, args, timeoutMs, { input, env } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    let child;
    try {
      child = spawn(command, args, {
        windowsHide: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
        ...(env ? { env: { ...process.env, ...env } } : {}),
      });
    } catch { finish(''); return; }
    if (input !== undefined) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
    const timer = setTimeout(() => { child.kill(); finish(''); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { if (out.length < MAX_TEXT * 4) out += chunk; });
    child.on('error', () => { clearTimeout(timer); finish(''); });
    child.on('close', (code) => { clearTimeout(timer); finish(code === 0 ? out : ''); });
  });
}

/** Recognised text for one image (bytes + media type), or '' when unavailable. */
async function recognizeText(bytes, mediaType, { platform = process.platform, timeoutMs = TIMEOUT_MS } = {}) {
  if (!ocrSupported(platform) || !EXT[mediaType]) return '';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsd-ocr-'));
  try {
    const image = path.join(dir, `image${EXT[mediaType]}`);
    fs.writeFileSync(image, bytes);
    let text;
    if (platform === 'darwin') {
      const script = path.join(dir, 'ocr.js');
      fs.writeFileSync(script, MAC_SCRIPT, 'utf8');
      text = await runScript('/usr/bin/osascript', ['-l', 'JavaScript', script, image], timeoutMs);
    } else {
      const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      text = await runScript(shell, ['-NoProfile', '-NonInteractive', '-Command', '-'], timeoutMs,
        { input: WINDOWS_SCRIPT, env: { DSD_OCR_IMAGE: image } });
    }
    const clean = String(text).replace(/\r/g, '').split('\n').map((line) => line.trimEnd()).filter(Boolean).join('\n');
    return clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT)}\n…（已截断）` : clean;
  } catch {
    return '';
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The text appended to a prompt for images a text-only model cannot see. */
function ocrAppendix(results) {
  const blocks = results.map(({ name, text }) => (text
    ? `[图片「${name}」中的文字（本机 OCR 识别，当前模型无法直接看图，可能有识别误差）]\n${text}`
    : `[图片「${name}」：当前模型无法直接看图，本机 OCR 也没有识别到文字]`));
  return blocks.length ? `\n\n${blocks.join('\n\n')}` : '';
}

// Official models whose pinned-kernel defaults accept images (dsh-llm-deepseek DEFAULT_MODELS);
// the integration test fails if a kernel update changes that list.
const BUILTIN_IMAGE_MODELS = new Set(['deepseek-flash', 'deepseek-v4-flash-vision-exp']);

/**
 * Whether the selected official model only takes text. A user's `llm-deepseek` settings
 * override wins; otherwise the pinned defaults apply. Custom providers are left alone.
 */
function isTextOnlySelection(current, deepseekSettings) {
  if (current?.provider !== 'deepseek-official' || !current?.model) return false;
  const overrides = Array.isArray(deepseekSettings?.models) ? deepseekSettings.models : null;
  if (overrides?.length) {
    const model = overrides.find((item) => item.id === current.model);
    return Boolean(model) && !(model.inputModalities ?? ['text']).includes('image');
  }
  return !BUILTIN_IMAGE_MODELS.has(current.model) && !/vision/i.test(current.model);
}

module.exports = { ocrSupported, recognizeText, ocrAppendix, isTextOnlySelection, BUILTIN_IMAGE_MODELS };
