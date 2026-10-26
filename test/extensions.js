'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bridge = require('../src/main/modules/skill-bridge');
const mcp = require('../src/main/modules/mcp-servers');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsd-ext-'));
const home = path.join(root, 'home');
const data = path.join(root, 'data');
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

// ── skills ────────────────────────────────────────────────────────────────
assert.deepEqual(bridge.frontmatter('---\nname: "pdf"\ndescription: >-\n  Read and\n  merge PDFs.\nlicense: x\n---\nbody'),
  { name: 'pdf', description: 'Read and merge PDFs.' });
write(path.join(home, '.claude/skills/synced/abc/pdf/SKILL.md'), '---\nname: pdf\ndescription: PDF helper\n---\n');
write(path.join(home, '.codex/skills/.system/imagegen/SKILL.md'), '---\nname: imagegen\ndescription: images\n---\n');
write(path.join(home, '.codex/plugins/cache/vendor/media/1.0/skills/ffmpeg/SKILL.md'), '---\nname: ffmpeg\n---\n');
write(path.join(home, '.claude/skills/node_modules/junk/SKILL.md'), '---\nname: junk\n---\n');

let view = bridge.listSkills(data, home);
assert.deepEqual(view.skills.map((skill) => skill.name).sort(), ['ffmpeg', 'imagegen', 'pdf']);
assert.ok(view.skills.every((skill) => !skill.enabled));
const pdf = view.skills.find((skill) => skill.name === 'pdf');
assert.equal(pdf.source, 'Claude');

view = bridge.setSkillEnabled(data, pdf.id, true, home);
assert.equal(view.skills.find((skill) => skill.id === pdf.id).enabled, true);
const link = path.join(data, 'harness/skills/pdf');
assert.ok(fs.lstatSync(link).isSymbolicLink());
assert.equal(fs.readFileSync(path.join(link, 'SKILL.md'), 'utf8').includes('PDF helper'), true);

// A same-named real folder the user made is never overwritten or removed.
write(path.join(data, 'harness/skills/imagegen/SKILL.md'), '---\nname: imagegen\n---\nmine');
const imagegen = view.skills.find((skill) => skill.name === 'imagegen');
assert.throws(() => bridge.setSkillEnabled(data, imagegen.id, true, home), /同名/);
bridge.setSkillEnabled(data, imagegen.id, false, home);
assert.equal(fs.readFileSync(path.join(data, 'harness/skills/imagegen/SKILL.md'), 'utf8').endsWith('mine'), true);
assert.deepEqual(bridge.listSkills(data, home).localOnly, ['imagegen']);

view = bridge.setSkillEnabled(data, pdf.id, false, home);
assert.equal(fs.existsSync(link), false, 'link removed');
assert.ok(fs.existsSync(path.join(home, '.claude/skills/synced/abc/pdf/SKILL.md')), 'source untouched');
assert.throws(() => bridge.setSkillEnabled(data, 'claude:../../etc', true, home), /找不到/);

// ── MCP servers ───────────────────────────────────────────────────────────
const config = path.join(data, 'config');
assert.deepEqual(mcp.mcpPatchEntries(config), [], 'no file, no rows');
assert.throws(() => mcp.normalizeServer({ name: 'bad name', transport: 'stdio', command: 'x' }), /名称/);
assert.throws(() => mcp.normalizeServer({ name: 'a', transport: 'ws', command: 'x' }), /连接方式/);
assert.throws(() => mcp.normalizeServer({ name: 'a', transport: 'stdio', command: '' }), /命令/);
assert.throws(() => mcp.normalizeServer({ name: 'a', transport: 'streamable-http', url: 'file:///etc/passwd' }), /http/);
assert.throws(() => mcp.normalizeServer({ name: 'a', transport: 'streamable-http', url: 'https://u:p@x.test/mcp' }), /账号密码/);
assert.throws(() => mcp.normalizeServer({ name: 'a', transport: 'stdio', command: 'x', env: { 'BAD-KEY': '1' } }), /环境变量/);

mcp.saveServer(config, { name: 'github', transport: 'stdio', command: 'npx', args: ['-y', 'gh-mcp'], env: { GITHUB_TOKEN: 'secret-token' } });
mcp.addPreset(config, 'browser');
assert.throws(() => mcp.addPreset(config, 'browser'), /已有/);
mcp.saveServer(config, { name: 'web', transport: 'streamable-http', url: 'http://localhost:3000/mcp', headers: { Authorization: 'Bearer t' } });
mcp.setServerEnabled(config, 'web', false);

const rows = mcp.mcpPatchEntries(config);
assert.deepEqual(rows.map((row) => row.id), ['desktop-mcp-github', 'desktop-mcp-browser'], 'disabled servers are not launched');
assert.equal(rows[0].name, '@deepseek-ai/dsh-mcp-client');
assert.deepEqual(rows[0].config, { serverName: 'github', transport: 'stdio', command: 'npx', args: ['-y', 'gh-mcp'],
  env: { GITHUB_TOKEN: 'secret-token' }, failOnStartupError: false });
assert.match(rows[1].config.args.join(' '), /@playwright\/mcp@\d+\.\d+\.\d+/, 'preset pins an exact version');

const described = JSON.stringify(mcp.describeServers(config));
assert.equal(described.includes('secret-token'), false, 'secrets never reach the renderer');
assert.equal(described.includes('Bearer t'), false);
assert.match(described, /GITHUB_TOKEN/);

// Hand-edited garbage is skipped instead of breaking the kernel launch.
fs.writeFileSync(path.join(config, 'mcp-servers.json'), JSON.stringify({ servers: [{ name: '../x', transport: 'stdio', command: 'rm' }, { name: 'ok', transport: 'stdio', command: 'node' }] }));
assert.deepEqual(mcp.mcpPatchEntries(config).map((row) => row.config.serverName), ['ok']);
mcp.removeServer(config, 'ok');
assert.deepEqual(mcp.mcpPatchEntries(config), []);

fs.rmSync(root, { recursive: true, force: true });
console.log('PASS extensions: Claude/Codex skills link and unlink without touching sources; MCP servers validate, stay secret and become launch rows');
