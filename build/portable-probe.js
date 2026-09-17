'use strict';
/**
 * Portable-mode test. Boots a real Electron app whose "executable folder" carries a
 * \`portable.flag\` marker, and asserts that every state path (config, runtime, logs) resolves
 * inside that folder instead of the per-user application-data directory.
 *
 *   electron build/app/portable-probe.js --no-sandbox
 *
 * The probe itself is unpackaged, so DEEPSEEK_DESKTOP_PORTABLE_ROOT stands in for "the folder
 * holding the executable" — the same override an operator uses to move the data folder.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

const ROOT = path.join(os.tmpdir(), 'deepseek-portable-probe');
const MARKER = path.join(ROOT, 'portable.flag');

/** Isolate this run from whatever is on disk before the app reads its environment. */
function prepare() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(path.join(os.tmpdir(), 'deepseek-portable-override'), { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(MARKER, 'portable\n');
  delete process.env.DEEPSEEK_DESKTOP_HOME;
  process.env.DEEPSEEK_DESKTOP_PORTABLE_ROOT = ROOT;
}
prepare();

const util = require(path.join(__dirname, 'src', 'main', 'modules', 'util.js'));
const results = [];
const check = (name, condition, detail) => results.push({ name, ok: Boolean(condition), detail });

app.whenReady().then(() => {
  check('portable mode is detected from the marker', util.isPortable());
  check('data root sits beside the executable', util.DIRS.root === path.join(ROOT, 'data'), util.DIRS.root);
  check('config lives in the portable root', util.DIRS.config.startsWith(ROOT), util.DIRS.config);
  check('logs live in the portable root', util.DIRS.logs.startsWith(ROOT), util.DIRS.logs);
  check('kernel runtime lives in the portable root', util.DIRS.dshPrefix.startsWith(ROOT), util.DIRS.dshPrefix);

  util.ensureDirs();
  util.log('portable-probe', 'log line from the portable probe');
  check('a log file is created inside the portable root', fs.existsSync(util.logFilePath()) && util.logFilePath().startsWith(ROOT), util.logFilePath());

  // Without the marker (and without the explicit flag) the app must fall back to app data.
  delete process.env.DEEPSEEK_DESKTOP_PORTABLE_ROOT;
  fs.rmSync(MARKER, { force: true });
  check('without the marker the app is not portable', util.isPortable() === false, util.DIRS.root);

  // An explicit home override wins over everything, for operators who redirect state.
  process.env.DEEPSEEK_DESKTOP_PORTABLE_ROOT = ROOT;
  const override = path.join(os.tmpdir(), 'deepseek-portable-override');
  process.env.DEEPSEEK_DESKTOP_HOME = override;
  check('DEEPSEEK_DESKTOP_HOME overrides portable mode', util.DIRS.root === override, util.DIRS.root);

  for (const item of results) console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name} — ${item.detail}`);
  const failed = results.filter((item) => !item.ok).length;
  console.log(failed === 0 ? 'PORTABLE MODE OK' : `${failed} CHECK(S) FAILED`);
  app.exit(failed === 0 ? 0 : 1);
});
