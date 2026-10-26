'use strict';
/**
 * Reuse Agent Skills the user already has for Claude and Codex. The Harness "standard"
 * preset watches `<DSH_HOME>/skills`, so enabling a skill only places a link to its folder
 * there (a junction on Windows, which needs no administrator rights); the kernel picks it up
 * live. Only links this module created are ever removed — never a real folder or the source.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_SKILLS_PER_SOURCE = 300;
const LINK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function skillSources(home = os.homedir()) {
  return [
    { id: 'claude', label: 'Claude', root: path.join(home, '.claude', 'skills'), depth: 4 },
    { id: 'codex', label: 'Codex', root: path.join(home, '.codex', 'skills'), depth: 3 },
    { id: 'codex-plugins', label: 'Codex 插件', root: path.join(home, '.codex', 'plugins', 'cache'), depth: 6 },
  ];
}

function linkRoot(dataRoot) {
  return path.join(dataRoot, 'harness', 'skills');
}

/** `name` and `description` from YAML frontmatter, tolerant of quotes and folded lines. */
function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const fields = {};
  for (const key of ['name', 'description']) {
    const line = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(match[1]);
    if (!line) continue;
    let value = line[1].trim();
    if (/^[>|][-+]?$/.test(value)) {
      const rest = match[1].slice(line.index + line[0].length).split(/\r?\n/);
      value = rest.filter((row, index) => index > 0 && /^\s+\S/.test(row)).map((row) => row.trim()).join(' ');
    }
    fields[key] = value.replace(/^(["'])([\s\S]*)\1$/, '$2').trim();
  }
  return fields;
}

function walk(root, depth, found) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  if (entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md')) {
    found.push(root);
    return;
  }
  if (depth <= 0) return;
  for (const entry of entries) {
    if (found.length >= MAX_SKILLS_PER_SOURCE) return;
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
      walk(path.join(root, entry.name), depth - 1, found);
    }
  }
}

function linkTargetOf(link) {
  try {
    if (!fs.lstatSync(link).isSymbolicLink()) return null;
    return fs.realpathSync(link);
  } catch { return null; }
}

/** Every importable skill, with whether its link is currently in place. */
function listSkills(dataRoot, home) {
  const target = linkRoot(dataRoot);
  const skills = [];
  for (const source of skillSources(home)) {
    const dirs = [];
    walk(source.root, source.depth, dirs);
    for (const dir of dirs) {
      let meta = {};
      try { meta = frontmatter(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8').slice(0, 16384)); } catch { continue; }
      const linkName = path.basename(dir);
      if (!LINK_NAME.test(linkName)) continue;
      let real = dir;
      try { real = fs.realpathSync(dir); } catch { /* keep the walked path */ }
      skills.push({
        id: `${source.id}:${path.relative(source.root, dir).split(path.sep).join('/')}`,
        source: source.label,
        name: (meta.name || linkName).slice(0, 80),
        description: (meta.description || '').replace(/\s+/g, ' ').slice(0, 220),
        linkName,
        path: dir,
        enabled: linkTargetOf(path.join(target, linkName)) === real,
      });
    }
  }
  // Folders the user put there by hand are shown, never touched.
  let own = [];
  try {
    own = fs.readdirSync(target, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(target, entry.name, 'SKILL.md')))
      .map((entry) => entry.name);
  } catch { /* no skills folder yet */ }
  return { skills, localOnly: own, folder: target };
}

/** Link or unlink one skill picked from `listSkills`; ids from anywhere else are refused. */
function setSkillEnabled(dataRoot, id, enabled, home) {
  const { skills } = listSkills(dataRoot, home);
  const skill = skills.find((item) => item.id === id);
  if (!skill) throw new Error('找不到这个技能，请刷新列表后重试');
  const target = linkRoot(dataRoot);
  const link = path.join(target, skill.linkName);
  if (enabled) {
    if (skill.enabled) return listSkills(dataRoot, home);
    let exists = false;
    try { fs.lstatSync(link); exists = true; } catch { /* free */ }
    if (exists) throw new Error(`已有同名技能「${skill.linkName}」，请先停用它`);
    fs.mkdirSync(target, { recursive: true });
    fs.symlinkSync(skill.path, link, process.platform === 'win32' ? 'junction' : 'dir');
  } else if (skill.enabled) {
    try {
      fs.unlinkSync(link);
    } catch (error) {
      // Windows reports a directory junction as a directory to unlink().
      if (process.platform === 'win32' && ['EPERM', 'EISDIR'].includes(error.code)) fs.rmdirSync(link);
      else throw error;
    }
  }
  return listSkills(dataRoot, home);
}

module.exports = { skillSources, frontmatter, listSkills, setSkillEnabled, linkRoot };
