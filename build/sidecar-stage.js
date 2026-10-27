'use strict';
/**
 * Build the dmuse sidecar (the Celium half of the phone remote) into vendor/dmuse, where the
 * app looks for it and electron-builder picks it up as an extra resource.
 *
 *   node build/sidecar-stage.js [--platform darwin|win32] [--arch arm64|x64]
 *
 * CELIUM_SRC points at the Celium source tree (default: ../celium-dmuse-phase0) and GO at the
 * Go toolchain the tree requires. The build is pure Go (no cgo), so any host can produce every
 * target; the defaults are this machine's platform and architecture.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : fallback;
};
const platform = arg('platform', process.platform);
const arch = arg('arch', process.arch);
const goos = { darwin: 'darwin', win32: 'windows', linux: 'linux' }[platform];
const goarch = { arm64: 'arm64', x64: 'amd64' }[arch];
if (!goos || !goarch) throw new Error(`unsupported target ${platform}-${arch}`);

const root = path.join(__dirname, '..');
const source = path.resolve(process.env.CELIUM_SRC || path.join(root, '..', 'celium-dmuse-phase0'));
if (!fs.existsSync(path.join(source, 'cmd', 'dmuse-sidecar'))) throw new Error(`no Celium source with cmd/dmuse-sidecar at ${source}`);
const out = path.join(root, 'vendor', 'dmuse', platform === 'win32' ? 'dmuse-sidecar.exe' : 'dmuse-sidecar');
fs.mkdirSync(path.dirname(out), { recursive: true });
execFileSync(process.env.GO || 'go', ['build', '-trimpath', '-ldflags=-s -w', '-o', out, './cmd/dmuse-sidecar'], {
  cwd: source,
  stdio: 'inherit',
  env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: '0' },
});
console.log(`dmuse sidecar for ${platform}-${arch}: ${out} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
