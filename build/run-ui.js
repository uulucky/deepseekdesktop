'use strict';
/**
 * Cross-platform runner for the UI harness.
 *
 * Electron is launched with the flags a headless capture needs, plus a user-data directory
 * inside the workspace. On a locked-down machine (containers, CI, the dev sandbox used while
 * building this) Chromium's OS sandbox cannot initialise, so \`--no-sandbox\` keeps the
 * screenshot run working; it has no effect on the packaged app.
 */
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const electron = require('electron');
const entry = path.join(__dirname, 'app', 'test-main.js');
const args = [
  entry,
  '--no-sandbox',
  '--disable-gpu',
  `--user-data-dir=${process.env.DSH_UI_USER_DATA || path.join(os.tmpdir(), 'deepseek-desktop-ui')}`,
  ...process.argv.slice(2),
];

const child = spawn(electron, args, {
  stdio: 'inherit',
  env: {
    ...process.env,
    // Shots land next to the sources, not inside the throwaway copy.
    DSH_UI_SHOT: process.env.DSH_UI_SHOT || path.join(__dirname, 'ui-shot.png'),
  },
});
child.on('close', (code) => process.exit(code ?? 1));
