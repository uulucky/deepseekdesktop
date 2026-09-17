'use strict';
/**
 * Runs the portable-mode probe under Electron with the flags a headless machine needs.
 *
 *   node build/run-probe.js
 */
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const electron = require('electron');
const entry = path.join(__dirname, 'app', 'portable-probe.js');
const args = [
  entry,
  '--no-sandbox',
  '--disable-gpu',
  `--user-data-dir=${process.env.DSH_PROBE_USER_DATA || path.join(os.tmpdir(), 'deepseek-desktop-probe')}`,
];

const child = spawn(electron, args, { stdio: 'inherit' });
child.on('close', (code) => process.exit(code ?? 1));
