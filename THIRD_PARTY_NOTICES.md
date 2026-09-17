# 第三方组件

本项目自身的限制性个人使用许可不限制第三方组件原许可授予的权利。

主要组件：

| 组件 | 用途 | 上游许可 |
| --- | --- | --- |
| Electron 44.4.1 | 桌面窗口、Chromium 与 Node 集成 | MIT；Chromium 等依赖另有许可 |
| Node.js 24.15.0 | 运行本地 Harness | MIT 及其内嵌第三方声明 |
| `@deepseek-ai/dsh` 0.1.5-rc.1 | Harness 服务与工具执行 | MIT |
| ws 8.21.3 | 本地 WebSocket 客户端 | MIT |
| yaml 2.9.0 | 凭据配置兼容 | ISC |
| Go 标准库 | 原生更新程序 | BSD 风格许可 |

完整依赖版本以根目录及 `build/kernel/` 的 `package-lock.json` 为准。Release 提供 `sbom.cdx.json`（CycloneDX 格式，记录依赖与包完整性元数据）。这不是漏洞扫描报告，也不保证所有传递组件都无风险。

便携包保留 Electron 的 `LICENSE.electron.txt`、`LICENSES.chromium.html`，Node 和 Harness 依赖各自目录中的许可证。第三方名称、图标和商标归各权利人；不表示官方认可本客户端。
