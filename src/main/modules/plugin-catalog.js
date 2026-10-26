'use strict';
/**
 * Curated Harness plugins, reviewed for the desktop. Only plugins that act inside the kernel
 * (tools, search, messaging, memory) are listed: the desktop draws its own UI, so plugins
 * that only add to the Harness web front end (pets, widgets, themes) would do nothing here.
 *
 * Every row pins an exact version and its npm `dist.integrity`, plus the lowest kernel the
 * plugin declares support for. Installing is deliberately not offered yet: third-party
 * plugins run with the kernel's permissions, and none of these has been exercised against
 * the desktop's pinned kernel. Until then the panel is a reviewed reading list with status.
 */

const CATALOG = [
  {
    name: 'dsh-free-search',
    version: '0.9.15',
    integrity: 'sha512-T6YxSR4NOK3c7ivdqDxrOdgdORGYBFmGbM7oZNpFUVZg2KIbU0f4TSOO99wjG0NnSrwqjdc1i/yK8pviZHtVhA==',
    license: 'MIT',
    title: '免费多引擎联网搜索',
    description: '为 DeepSeek 增加 Bing、DuckDuckGo、SearXNG 等多个免费搜索引擎，补充内置联网搜索。',
    minKernel: '0.1.7-rc.1',
    homepage: 'https://github.com/DDDMUC/dsh-free-search',
  },
  {
    name: '@xmanrui/dsh-im',
    version: '5.6.0',
    integrity: 'sha512-YSpRGQ2QhH94JP3byUtGJacGcXW+iLzy5lz+Dkv5QLySPVCGawkxNuCq/gX8NpWrrEQXc04tMUfVZxfpmuwo+w==',
    license: 'MIT',
    title: '聊天工具接入',
    description: '把微信、飞书、企业微信、钉钉、QQ、Telegram 等接入 DeepSeek，在聊天软件里下达任务。体积约 24 MB。',
    minKernel: '0.2.0-rc.2',
    homepage: 'https://github.com/xmanrui/dsh-im',
  },
  {
    name: '@dfy-plugins/dsh-image-generation',
    version: '0.1.4',
    integrity: 'sha512-u7OePbCwA5lGfBu/jTcWK2YuE/O2ZmuqtXswZsdcXxsvGlx36X8MWQTBMo69v1Ens+GrgUYAOtnp6UCN5XMw8w==',
    license: 'MIT',
    title: '图像生成与编辑',
    description: '提供生成和编辑图片的工具，需要自行配置第三方图像模型的 API Key。',
    minKernel: '0.1.7-alpha.1',
    homepage: 'https://github.com/xiaoxiao44443/dfy-dsh-plugins',
  },
  {
    name: '@openviking/dsh-memory-plugin',
    version: '0.5.29',
    integrity: 'sha512-HO8Mm3Cft1JLz3UAxEwWIWBPXt2Jf6HRogXQ5pUZ9cX0zfmAUprqPKbMjZAPAsl5Kd9TzBe1YFaOMMgWbTTWag==',
    license: 'Apache-2.0',
    title: '长期记忆（OpenViking）',
    description: '跨会话记住你的偏好和项目背景。需要另外部署火山引擎 OpenViking 服务。',
    minKernel: '0.1.0-rc.6',
    homepage: 'https://github.com/volcengine/OpenViking',
  },
];

/** Not listed on purpose: they extend the Harness web UI, which the desktop does not show. */
const WEB_UI_ONLY = ['dsh-pet', 'dsh-whale-widget', '@linxin666/dsh-client-ui-git-graph', 'dsh-plugin-wallpaper-engine'];

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value ?? '').trim());
  if (!match) return null;
  return { core: match.slice(1, 4).map(Number), pre: match[4] ? match[4].split('.') : [] };
}

/** Semver precedence: negative when a < b. Unparseable versions sort first. */
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return left ? 1 : right ? -1 : 0;
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] - right.core[index];
  }
  if (!left.pre.length || !right.pre.length) return right.pre.length - left.pre.length;
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    const x = left.pre[index];
    const y = right.pre[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny && Number(x) !== Number(y)) return Number(x) - Number(y);
    if (nx !== ny) return nx ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function describeCatalog(kernelVersion) {
  return {
    kernelVersion: kernelVersion ?? null,
    plugins: CATALOG.map(({ integrity, ...plugin }) => ({
      ...plugin,
      compatible: Boolean(kernelVersion) && compareVersions(kernelVersion, plugin.minKernel) >= 0,
    })),
    webUiOnly: [...WEB_UI_ONLY],
  };
}

module.exports = { CATALOG, WEB_UI_ONLY, compareVersions, describeCatalog };
