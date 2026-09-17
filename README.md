# DeepSeek Desktop

[![Windows build and tests](https://github.com/uulucky/deepseekdesktop/actions/workflows/release.yml/badge.svg)](https://github.com/uulucky/deepseekdesktop/actions/workflows/release.yml)

面向 Windows 的第三方 DeepSeek 桌面客户端：余额、充值、API Key、本地对话和 Agent 权限集中在一个界面。**不是 DeepSeek 官方产品，也未获得官方背书。**

当前版本：**0.2.20 · Windows 10/11 x64 · 便携版**。

[GitHub 下载](https://github.com/uulucky/deepseekdesktop/releases/latest) · [隐私与广告](PRIVACY.md) · [网络连接](NETWORK.md) · [安全与验证](SECURITY.md)

国内 OSS/CDN 镜像与软件内更新源尚待同步到本版，请先从 GitHub 下载。同步完成并校验后会恢复国内下载入口。

![DeepSeek Desktop 软件界面](desktop.png)

## 主要功能

- **余额与当天用量**：每 10 分钟自动刷新，可手动刷新；金额、Token 和请求数以平台可返回数据为准，不是逐秒计费仪表。
- **软件内充值**：在应用内打开 DeepSeek 官方充值页面，由官方及其支付服务处理付款；客户端维护者不代收款。
- **推理滑块**：按当前模型支持的档位选择推理等级。
- **权限滑块**：发送按钮旁切换 Read Only、Workspace Write、Full Access；默认 Full Access，输入区持续显示风险提醒，记住你选择的档位。
- **Key 管理**：登录后创建并配置新 Key，或粘贴已有完整 Key；本地绑定失败时保留一次性完整 Key 供复制和重试。
- **本地记录与更新**：便携模式数据保存在 `data/`，每小时检查更新，用户确认后安装并重启。

DeepSeek API 的使用可能产生服务商费用；客户端下载或个人许可免费不等于 API 免费。

## 开始使用

1. 从上方入口下载完整便携 ZIP，按 [安全说明](SECURITY.md) 核对校验值和 GitHub 构建来源。
2. 完整解压到自己可写的目录，不要直接在 ZIP 预览中运行。
3. 双击 `DeepSeek Desktop.exe`，在账户设置中登录或配置 API Key。
4. 查看输入区的 Full Access 提醒：此模式可以直接执行命令和修改文件。如果只需要阅读分析，可先把权限滑块移到只读；需要限定写入范围时选择工作区。默认工作目录是 `data/workspace/`。

包内自带 Node 与固定版本 Harness，不需要另装它们。更新设计为保留数据，重要内容仍请备份。**不要把运行过、包含 `data/` 的软件目录分享给别人。**

## 下载前请了解

| 项目 | 当前情况 |
| --- | --- |
| Windows 发行者 | 暂无 Authenticode 证书，可能显示未知发布者；不宣称已通过系统或第三方安全认证 |
| 发布透明度 | 公开 Windows 源码构建、测试日志、构建来源证明、SHA-256、依赖清单；不是字节级可重现构建承诺 |
| 自动更新 | 内置公钥验证 Ed25519 清单，再验证文件 SHA-256；首次安装仍需核实来源 |
| 数据 | 对话在本机；模型请求可发送上下文与工具内容；API Key 本地文件可能明文 |
| 广告 | 内置远程广告位，目前无关闭开关；从 uulucky 域名拉取配置与图片，点击打开外站 |
| 许可 | 源码可查看，个人非商业免费；公司、组织与工作用途需授权；不允许修改或再分发自有代码 |

## 权限与安全

Read Only 用于阅读分析；Workspace Write 允许修改工作目录；Full Access 取消 Harness 沙箱限制，可能影响工作目录外的文件和系统。Full Access 不绕过 UAC，也不适合把不可信任务当普通聊天直接执行。权限并不意味着没有网络访问。

没有保存过权限偏好时，默认 Full Access。输入区会持续提示其风险，不通过反复弹窗打断操作。三个档位都能保存为新对话默认值；重启或打开旧对话不会擅自更改该对话的权限。已有的只读、工作区偏好也会保留。**专用工作目录不限制 Full Access 的访问范围。** 详见 [SECURITY.md](SECURITY.md)。

## 当前版本改进

0.2.20 恢复默认 Full Access，以持续可见的风险提醒代替阻塞确认；修正权限保存与重启、新建对话的一致性。保留签名更新清单、公开 Windows 源码构建与隔离测试、IPC 来源校验，以及隐私、广告与网络连接说明。

项目仍处于早期阶段。CI 不使用真实账号充值或付费推理，不能覆盖所有 Windows/杀毒软件组合；欢迎提交可复现问题，而非把 Star 或下载量当作质量认证。

## 架构与参与

Electron 界面通过经过来源校验的 IPC 连接主进程；主进程通过本机认证 HTTP/WebSocket 与 Harness 通信，由 Harness 调用模型和执行工具。账户页面连接 DeepSeek 官方平台；广告与更新连接维护者的服务。

源码：`src/main/`（启动、账号、更新、IPC）、`src/preload/`（桥接）、`src/renderer/`（界面）、`build/`（构建与更新器）、`test/`（测试）。

[构建与测试](BUILDING.md) · [维护者发布流程](RELEASING.md) · [第三方组件](THIRD_PARTY_NOTICES.md) · [提交问题](https://github.com/uulucky/deepseekdesktop/issues)

问题反馈与商业授权：**489583561@qq.com**。报告问题请提供版本和脱敏复现，不要提供密码、Key 或完整私人对话。

## 许可

采用 [DeepSeek Desktop Personal Use License 1.0](LICENSE)，属于 **source-available（源码可查看）**，不是 OSI 定义的开源软件。自然人可免费运行未修改的软件用于个人非商业用途；公司、组织、工作及商业用途需书面许可。不允许修改、衍生或重新分发本项目自有代码；第三方组件依各自许可。
