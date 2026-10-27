'use strict';
/**
 * Build the dmuse sidecar (the Celium half of the phone remote) from Celium source.
 *
 *   node build/sidecar-stage.js [--platform darwin|win32] [--arch arm64|x64]
 *       → vendor/dmuse/dmuse-sidecar(.exe) for local runs and packaging
 *   node build/sidecar-stage.js --release <dir>
 *       → dmuse-sidecar-<version>-<platform>-<arch>(.exe) for every shipped target,
 *         plus the SHA-256 lines to paste into build/runtime-pins.json
 *
 * CELIUM_SRC points at the Celium source tree (default: ../celium-dmuse-phase0) and GO at the
 * Go toolchain the tree requires. The build is pure Go (no cgo) with -trimpath, so any host can
 * produce every target. Release CI does not build it: it downloads the pinned binaries in
 * build/prebundle.js, because the Celium source is not public.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const pins = require('./runtime-pins.json');

const TARGETS = [['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64']];
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : fallback;
};

const root = path.join(__dirname, '..');
const source = path.resolve(process.env.CELIUM_SRC || path.join(root, '..', 'celium-dmuse-phase0'));
if (!fs.existsSync(path.join(source, 'cmd', 'dmuse-sidecar'))) throw new Error(`no Celium source with cmd/dmuse-sidecar at ${source}`);
const version = arg('version', pins.dmuseSidecarVersion || '0.0.0-dev');

function build(platform, arch, out) {
  const goos = { darwin: 'darwin', win32: 'windows', linux: 'linux' }[platform];
  const goarch = { arm64: 'arm64', x64: 'amd64' }[arch];
  if (!goos || !goarch) throw new Error(`unsupported target ${platform}-${arch}`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  execFileSync(process.env.GO || 'go', [
    'build', '-trimpath', `-ldflags=-s -w -X github.com/celium/celium/version.Version=${version}`, '-o', out, './cmd/dmuse-sidecar',
  ], { cwd: source, stdio: 'inherit', env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: '0' } });
  return crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex');
}

const release = arg('release', null);
if (release) {
  const hashes = {};
  for (const [platform, arch] of TARGETS) {
    const name = `dmuse-sidecar-${version}-${platform}-${arch}${platform === 'win32' ? '.exe' : ''}`;
    hashes[`${platform}-${arch}`] = build(platform, arch, path.join(path.resolve(release), name));
    console.log(`${name}  ${hashes[`${platform}-${arch}`]}`);
  }
  console.log(JSON.stringify({ dmuseSidecarVersion: version, dmuseSidecarSha256: hashes }, null, 2));
} else {
  const platform = arg('platform', process.platform);
  const arch = arg('arch', process.arch);
  const out = path.join(root, 'vendor', 'dmuse', platform === 'win32' ? 'dmuse-sidecar.exe' : 'dmuse-sidecar');
  build(platform, arch, out);
  console.log(`dmuse sidecar ${version} for ${platform}-${arch}: ${out} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
}
