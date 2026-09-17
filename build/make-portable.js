'use strict';
/**
 * Packs the portable distribution: takes the built win-unpacked tree, adds the launchers and
 * the read-me, then writes a single .zip that Windows Explorer extracts natively.
 *
 *   npx electron-builder --win --dir      # produces dist/win-unpacked
 *   node build/make-portable.js           # produces dist/<Product>-<version>-portable(.zip)
 *
 * The ZIP is written in-process (store + deflate) so no system zip tool is needed and the
 * build behaves identically on macOS, Linux, Windows and CI.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const UNPACKED = path.join(ROOT, 'dist', 'win-unpacked');
const DIST = path.join(ROOT, 'dist');
// ASCII, hyphenated names: no spaces, so the folder and archive survive cmd.exe, PowerShell,
// mail clients and download managers without quoting surprises.
const SLUG = 'DeepSeekDesktop';
const FOLDER = `${SLUG}-${pkg.version}-portable`;
const STAGE = path.join(DIST, FOLDER);

if (!fs.existsSync(UNPACKED)) {
  console.error('win-unpacked not found — run: npx electron-builder --win --dir');
  process.exit(1);
}

fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
fs.cpSync(UNPACKED, STAGE, { recursive: true });
for (const file of fs.readdirSync(path.join(__dirname, 'portable'))) {
  fs.copyFileSync(path.join(__dirname, 'portable', file), path.join(STAGE, file));
}
// Keep the user-visible archive legally self-contained. The packaged app also carries the
// same source license inside app.asar via electron-builder.json.
fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(STAGE, 'LICENSE.txt'));
for (const file of ['PRIVACY.md','NETWORK.md','SECURITY.md','THIRD_PARTY_NOTICES.md']) {
  fs.copyFileSync(path.join(ROOT,file),path.join(STAGE,file));
}
fs.copyFileSync(path.join(DIST,'build-info.json'),path.join(STAGE,'build-info.json'));
fs.copyFileSync(path.join(DIST,'sbom.cdx.json'),path.join(STAGE,'sbom.cdx.json'));
// The marker keeps portable mode active even when the exe is started directly, without the
// .cmd launcher (double-clicking the exe must behave the same way).
fs.writeFileSync(path.join(STAGE, 'portable.flag'), 'portable\n');

// -------------------------------------------------------------------------------- zip

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[i] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}

/** Every file below a directory, as {name, data} with forward-slash names. */
function collect(dir, prefix = '') {
  const entries = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    const name = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) entries.push(...collect(full, name));
    else entries.push({ name, data: fs.readFileSync(full) });
  }
  return entries;
}

// DOS timestamp 2026-01-01 00:00 so repeated builds are byte-stable.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

function localHeader(entry, compressed) {
  const name = Buffer.from(entry.name, 'utf8');
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6); // UTF-8 names (Chinese file names)
  header.writeUInt16LE(8, 8);      // deflate
  header.writeUInt16LE(DOS_TIME, 10);
  header.writeUInt16LE(DOS_DATE, 12);
  header.writeUInt32LE(crc32(entry.data), 14);
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(entry.data.length, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  return { header, name };
}

function centralHeader(entry, compressed, offset) {
  const name = Buffer.from(entry.name, 'utf8');
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(8, 10);
  header.writeUInt16LE(DOS_TIME, 12);
  header.writeUInt16LE(DOS_DATE, 14);
  header.writeUInt32LE(crc32(entry.data), 16);
  header.writeUInt32LE(compressed.length, 20);
  header.writeUInt32LE(entry.data.length, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(offset, 42);
  return { header, name };
}

function writeZip(file, entries) {
  const pieces = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const compressed = zlib.deflateRawSync(entry.data, { level: entry.level ?? 6 });
    const local = localHeader(entry, compressed);
    pieces.push(local.header, local.name, compressed);
    central.push({ entry, compressed, offset });
    offset += local.header.length + local.name.length + compressed.length;
  }
  const centralStart = offset;
  for (const item of central) {
    const header = centralHeader(item.entry, item.compressed, item.offset);
    pieces.push(header.header, header.name);
    offset += header.header.length + header.name.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(offset - centralStart, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  pieces.push(end);
  fs.writeFileSync(file, Buffer.concat(pieces));
  return offset + end.length;
}

const entries = collect(STAGE).map((entry) => ({ ...entry, name: `${FOLDER}/${entry.name}` }));
const zipFile = path.join(DIST, `${FOLDER}.zip`);
const bytes = writeZip(zipFile, entries);
console.log(`portable folder : ${STAGE}`);
console.log(`portable zip    : ${zipFile}`);
console.log(`zip size        : ${(bytes / 1024 / 1024).toFixed(1)} MB (${entries.length} files)`);

// --------------------------------------------------------------------- native update bootstrap
// 0.2.6-0.2.10 attempted an Electron -> detached PowerShell handoff. Some Windows systems
// accepted CreateProcess and then killed the child with its parent, leaving no updater log.
// Current clients download and start this hash-pinned native bootstrap directly, then wait for
// its ready-file acknowledgement before quitting. The legacy ZIP remains for old manifests;
// the repair ZIP lets affected old clients cross the broken handoff once.
const BOOTSTRAP = path.join(DIST, 'update-bootstrap.exe');
const REPAIR_BOOTSTRAP = path.join(DIST, 'update-repair.exe');
const payloadSha256 = crypto.createHash('sha256').update(fs.readFileSync(zipFile)).digest('hex');
const payloadUrl = `https://img.uulucky.com/han/deepseek/${path.basename(zipFile)}`;
const ldflags = [
  '-s', '-w',
  `-X=main.payloadURL=${payloadUrl}`,
  `-X=main.payloadSHA256=${payloadSha256}`,
];
const go = spawnSync('go', [
  'build', '-trimpath', '-ldflags', [
    ...ldflags, '-H=windowsgui',
  ].join(' '), '-o', BOOTSTRAP,
  './build/update-bootstrap',
], {
  cwd: ROOT,
  env: { ...process.env, GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0', GO111MODULE: 'off' },
  encoding: 'utf8',
});
if (go.status !== 0 || !fs.existsSync(BOOTSTRAP)) {
  console.error(go.stdout || '');
  console.error(go.stderr || 'unable to compile update bootstrap');
  process.exit(go.status || 1);
}
const repairGo = spawnSync('go', [
  'build', '-trimpath', '-ldflags', ldflags.join(' '), '-o', REPAIR_BOOTSTRAP,
  './build/update-bootstrap',
], {
  cwd: ROOT,
  env: { ...process.env, GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0', GO111MODULE: 'off' },
  encoding: 'utf8',
});
if (repairGo.status !== 0 || !fs.existsSync(REPAIR_BOOTSTRAP)) {
  console.error(repairGo.stdout || '');
  console.error(repairGo.stderr || 'unable to compile console repair bootstrap');
  process.exit(repairGo.status || 1);
}
const publishedBootstrap = path.join(DIST, `${SLUG}-${pkg.version}-update-bootstrap.exe`);
fs.copyFileSync(BOOTSTRAP, publishedBootstrap);
const updateFile = path.join(DIST, `${SLUG}-${pkg.version}-update.zip`);
const updateEntries = [
  { name: 'u/DeepSeek Desktop.exe', data: fs.readFileSync(BOOTSTRAP), level: 6 },
];
const updateBytes = writeZip(updateFile, updateEntries);
const repairCommand = `@echo off\r\n` +
  `setlocal EnableExtensions\r\n` +
  `title DeepSeek Desktop ${pkg.version} Update Repair\r\n` +
  `set "HERE=%~dp0"\r\n` +
  `set "APP_ROOT=%~dp0"\r\n` +
  `if exist "%APP_ROOT%DeepSeek Desktop.exe" goto found\r\n` +
  `echo [ERROR] DeepSeek Desktop.exe was not found.\r\n` +
  `echo Extract ALL repair files into the CURRENT DeepSeekDesktop folder, beside DeepSeek Desktop.exe.\r\n` +
  `pause\r\nexit /b 2\r\n` +
  `:found\r\n` +
  `echo Application: %APP_ROOT%\r\n` +
  `echo Closing DeepSeek Desktop...\r\n` +
  `taskkill /F /IM "DeepSeek Desktop.exe" /T >nul 2>&1\r\n` +
  `timeout /T 3 /NOBREAK >nul\r\n` +
  `set "PAYLOAD=%APP_ROOT%data\\update\\update-payload-${pkg.version}.zip"\r\n` +
  `set "READY=%APP_ROOT%data\\update\\repair-${pkg.version}.ready"\r\n` +
  `del /F /Q "%READY%" >nul 2>&1\r\n` +
  `echo Starting the visible native updater. Do not close this window...\r\n` +
  `"%HERE%update-repair.exe" --app-root "%APP_ROOT%" --payload "%PAYLOAD%" --exe-name "DeepSeek Desktop.exe" --ready-file "%READY%"\r\n` +
  `set "RESULT=%ERRORLEVEL%"\r\n` +
  `if not "%RESULT%"=="0" (\r\n` +
  `  echo [ERROR] Native updater returned %RESULT%.\r\n` +
  `  echo Log: %APP_ROOT%data\\logs\\update-bootstrap.log\r\n` +
  `  pause\r\n  exit /b %RESULT%\r\n` +
  `)\r\n` +
  `echo [SUCCESS] Update completed. Confirm that the restarted app shows version ${pkg.version}.\r\n` +
  `echo Log: %APP_ROOT%data\\logs\\update-bootstrap.log\r\n` +
  `pause\r\n` +
  `exit /b 0\r\n`;
const repairReadme = [
  `DeepSeek Desktop ${pkg.version} update repair`,
  '',
  '1. Extract ALL files from this ZIP into the CURRENT folder containing DeepSeek Desktop.exe.',
  '2. Double-click repair-update.cmd.',
  '3. Keep the CMD window open. Download and extraction progress is printed in the window.',
  '4. User login information, local conversations, and the data folder are preserved.',
  '',
  'Diagnostic log: data\\logs\\update-bootstrap.log',
  '',
  'License: https://github.com/uulucky/deepseekdesktop/blob/main/LICENSE',
].join('\r\n') + '\r\n';
const repairFile = path.join(DIST, `${SLUG}-${pkg.version}-update-repair.zip`);
const repairBytes = writeZip(repairFile, [
  { name: 'repair-update.cmd', data: Buffer.from(repairCommand, 'utf8'), level: 6 },
  { name: 'update-repair.exe', data: fs.readFileSync(REPAIR_BOOTSTRAP), level: 6 },
  { name: 'readme.txt', data: Buffer.from(repairReadme, 'utf8'), level: 6 },
]);
console.log(`update bootstrap: ${BOOTSTRAP}`);
console.log(`repair bootstrap: ${REPAIR_BOOTSTRAP}`);
console.log(`published exe   : ${publishedBootstrap}`);
console.log(`update zip      : ${updateFile}`);
console.log(`update zip size : ${(updateBytes / 1024 / 1024).toFixed(1)} MB (${updateEntries.length} files)`);
console.log(`repair zip      : ${repairFile}`);
console.log(`repair zip size : ${(repairBytes / 1024 / 1024).toFixed(1)} MB (3 files)`);
