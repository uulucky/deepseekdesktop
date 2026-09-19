# DeepSeek Desktop

[![Windows and Mac build and tests](https://github.com/uulucky/deepseekdesktop/actions/workflows/release.yml/badge.svg)](https://github.com/uulucky/deepseekdesktop/actions/workflows/release.yml)

第三方 DeepSeek 桌面客户端：把本地 Agent 工作台、DeepSeek 官方网页版、余额、充值、API Key 和权限控制集中在一个界面。**不是 DeepSeek 官方产品，也未获得官方背书。**

当前版本：**0.3.3**。支持 Windows 10/11 x64、macOS 14+ Apple 芯片与 Intel。

[GitHub 下载页](https://github.com/uulucky/deepseekdesktop/releases/latest) · [Windows 国内下载](https://img.uulucky.com/han/deepseek/DeepSeekDesktop-0.3.3-portable.zip) · [Mac Apple 芯片](https://img.uulucky.com/han/deepseek/DeepSeekDesktop-0.3.3-mac-arm64.dmg) · [Mac Intel](https://img.uulucky.com/han/deepseek/DeepSeekDesktop-0.3.3-mac-x64.dmg) · [隐私与广告](PRIVACY.md) · [网络连接](NETWORK.md) · [安全与验证](SECURITY.md)

GitHub 与国内 OSS/CDN 镜像提供同一份公开 CI 产物；镜像和软件内更新在审核、签名及校验完成后上线。可核对 [SHA-256 校验值](https://img.uulucky.com/han/deepseek/0.3.3-SHA256SUMS.txt) 和 Release 内的 `build-info.json`。仓库当前开发代码可能包含未发布功能，请以 Release 对应 tag 查看已发布源码。

![DeepSeek Desktop 软件界面](desktop.png)

## 主要功能

- **双模式**：左上角在“工作台（Harness）”与“网页版（免费）”之间切换。网页版直接加载隔离的 DeepSeek 官方页面，登录和对话由官方页面处理；两个模式的会话、滚动位置和未关闭页面状态互不混用。
- **上下文与附件**：工作台输入框下显示当前会话上下文 Token 用量；可直接粘贴图片，或点左下角“+”选择图片和文件后随消息发送。
- **余额与当天用量**：每 10 分钟自动刷新，可手动刷新；金额、Token 和请求数以平台可返回数据为准，不是逐秒计费仪表。
- **软件内充值**：在应用内打开 DeepSeek 官方充值页面，由官方及其支付服务处理付款；客户端维护者不代收款。
- **推理滑块**：按当前模型支持的档位选择推理等级。
- **中文行动摘要**：执行前简短说明准备做什么，后续说明已确认的进展和下一步；摘要展开显示，思考原文与工具详情默认折叠。
- **权限滑块**：发送按钮旁切换 Read Only、Workspace Write、Full Access；默认 Full Access，输入区持续显示风险提醒，记住你选择的档位。
- **多任务对话**：一个会话运行时可以继续新建、发送和切换其他会话；各自保留草稿、模型、权限和运行状态，停止只作用于当前会话。
- **对话管理**：支持重命名、内容搜索、非破坏性归档、添加文件夹工作区，以及从现有对话创建独立新对话。
- **Key 管理**：登录后创建并配置新 Key，或粘贴已有完整 Key；本地绑定失败时保留一次性完整 Key 供复制和重试。
- **本地记录与更新**：每小时检查更新。Windows 便携版确认后自动安装并重启；Mac 下载匹配芯片的 DMG 后手动替换应用，数据独立保存。

DeepSeek API 的使用可能产生服务商费用；客户端下载或个人许可免费不等于 API 免费。

## 开始使用

### Mac

目标为 macOS 14+，分别支持 Apple 芯片（M 系列）与 Intel；可在苹果菜单 →“关于本机”查看芯片类型。不走 App Store，没有 Apple Developer ID 签名或 Apple 公证。

1. 下载与你的芯片匹配的 DMG，核对来源与校验值，打开后把 `DeepSeek Desktop.app` 拖入“应用程序”。不要长期从安装盘内运行。
2. 在“应用程序”中打开。如果提示开发者无法验证或 Apple 无法检查恶意软件，先取消；**确认来源可信且文件完整后**，进入“系统设置 → 隐私与安全性 → 仍要打开”，按系统提示确认。该入口可能只在尝试打开后短时间出现。参考 [Apple 官方说明](https://support.apple.com/zh-cn/102445)。
3. 在账户设置里登录或配置 API Key。默认 Full Access 有常驻风险提醒，可通过滑块改为只读/工作区。macOS 文件夹、自动化等系统授权仍由系统单独控制，Full Access 不会绕过它们。
4. 数据默认在 `~/Library/Application Support/DeepSeek Desktop/`，实际路径见“设置 → 关于”。关闭窗口后程序仍可留在 Dock；**Cmd+Q 完全退出**。更新时先退出，再把新应用拖入“应用程序”替换，不要删除数据目录。

当前仅使用 ad-hoc 本地签名维持应用包完整性，不代表 Apple 验证发行者或审核安全；**不能保证每台受管理的 Mac 都允许打开**。如果提示“已损坏”或明确的恶意软件警告，请停止打开，重新下载并核对哈希、反馈系统版本；不要关闭 Gatekeeper、SIP 或杀毒软件。更新后可能需要再次允许打开或确认钥匙串访问；登录态通常保留，但系统策略可能要求重新登录。Mac 首版不提供静默自动覆盖/重启更新。

### Windows

1. 从上方入口下载完整便携 ZIP，按 [安全说明](SECURITY.md) 核对校验值和 GitHub 构建来源。
2. 完整解压到自己可写的目录，不要直接在 ZIP 预览中运行。
3. 双击 `DeepSeek Desktop.exe`，在账户设置中登录或配置 API Key。
4. 查看输入区的 Full Access 提醒：此模式可以直接执行命令和修改文件。如果只需要阅读分析，可先把权限滑块移到只读；需要限定写入范围时选择工作区。默认工作目录是 `data/workspace/`。

包内自带 Node 与固定版本 Harness，不需要另装它们。更新设计为保留数据，重要内容仍请备份。**不要把运行过、包含 `data/` 的软件目录分享给别人。**

## 下载前请了解

| 项目 | 当前情况 |
| --- | --- |
| Windows 发行者 | 暂无 Authenticode 证书，可能显示未知发布者；不宣称已通过系统或第三方安全认证 |
| Mac 发行者 | ad-hoc 签名，无 Developer ID / Apple 公证；首次打开需用户单独允许 |
| 发布透明度 | 公开 Windows、Apple 芯片与 Intel 原生构建、测试日志、来源证明、SHA-256、依赖清单；不是字节级可重现构建承诺 |
| 更新 | 三个平台均验证 Ed25519 清单；Windows 安装前校验文件 SHA-256，Mac 打开已签名清单中的下载地址，手动核对文件并替换 |
| 数据 | 对话在本机；模型请求可发送上下文与工具内容；API Key 本地文件可能明文 |
| 广告 | 内置远程广告位，目前无关闭开关；从 uulucky 域名拉取配置与图片，点击打开外站 |
| 许可 | 源码可查看，个人非商业免费；公司、组织与工作用途需授权；不允许修改或再分发自有代码 |

## 权限与安全

Read Only 用于阅读分析；Workspace Write 允许修改工作目录；Full Access 取消 Harness 沙箱限制，可能影响工作目录外的文件和系统。Full Access 不绕过 UAC，也不适合把不可信任务当普通聊天直接执行。权限并不意味着没有网络访问。

没有保存过权限偏好时，默认 Full Access。输入区会持续提示其风险，不通过反复弹窗打断操作。三个档位都能保存为新对话默认值；重启或打开旧对话不会擅自更改该对话的权限。已有的只读、工作区偏好也会保留。**专用工作目录不限制 Full Access 的访问范围。** 详见 [SECURITY.md](SECURITY.md)。

## 0.3.3 更新

- 中文问题的“行动摘要”由本地展示层兜底为简体中文，直接展开说明准备做什么、已确认的进展和下一步；模型偶尔输出的英文进展保留在折叠原文中供核对，不再冒充中文摘要。
- 继续修复“网页版（免费）”的浏览器兼容：保留真实操作系统和 Chromium 版本，移除 Electron 与客户端产品名称。429 时按服务器 `Retry-After` 倒计时（未提供时等待 60 秒），在网页版可见时只自动重试一次，再次失败后停止请求。
- 网页恢复绕过错误页缓存但保留 Cookie、站点存储和登录态；403 验证页面继续留在客户端内供用户处理，连接失败也可在软件内重新连接。错误页不再提供跳转默认浏览器的入口。
- 工作台继续支持上下文用量、粘贴图片、“+”选择多文件、多任务、对话管理、权限滑块和黑窗口恢复。对话完整记录由 Harness 保存，本地界面为稳定性只挂载最近 240 条记录。

网页版依赖 DeepSeek 官方服务；客户端不会绕过账号、验证码、网络出口或官方访问策略。真实账号环境仍可能因官方规则收到 403/429，遇到持续拒绝时请等待倒计时结束，不要反复重启刷新。

### 如何同时运行多个任务

1. 在一个会话中发送任务后，点击左侧“新建对话”（或 Ctrl/Cmd+N），继续发送另一个任务，无需等待前一个结束。
2. 点击侧栏会话查看进度；“待批准”表示需要进入该会话处理权限请求。任务在后台完成后显示“已完成”，查看后清除该提示。
3. “停止”只停止当前显示的会话，其他任务继续。切换时会保留各自的未发送草稿；草稿仅保留到本次软件关闭。

并行任务分别消耗 API 用量，共享本机资源；如果多个任务可能修改同一批文件，请避免同时写入。各会话的 Full Access 风险提醒和独立权限选择仍然有效。完全退出软件或安装更新会结束本地运行服务；Mac 仅关闭主窗口不会退出应用。

项目仍处于早期阶段。CI 不使用真实账号充值或付费推理，不能覆盖所有 Windows/杀毒软件组合；欢迎提交可复现问题，而非把 Star 或下载量当作质量认证。

## 架构与参与

工作台 Electron 界面通过经过来源校验的 IPC 连接主进程；主进程通过本机认证 HTTP/WebSocket 与 Harness 通信，由 Harness 调用模型和执行工具。官方网页版运行在无 Node、无 preload、启用沙箱的独立远程页面容器中；仅共享专用的持久化 DeepSeek 登录分区，不获得桌面客户端 IPC。账户页面连接 DeepSeek 官方平台；广告与更新连接维护者的服务。

源码：`src/main/`（启动、账号、更新、IPC）、`src/preload/`（桥接）、`src/renderer/`（界面）、`build/`（构建与更新器）、`test/`（测试）。

[构建与测试](BUILDING.md) · [维护者发布流程](RELEASING.md) · [第三方组件](THIRD_PARTY_NOTICES.md) · [提交问题](https://github.com/uulucky/deepseekdesktop/issues)

问题反馈与商业授权：**489583561@qq.com**。报告问题请提供版本和脱敏复现，不要提供密码、Key 或完整私人对话。

## 许可

采用 [DeepSeek Desktop Personal Use License 1.0](LICENSE)，属于 **source-available（源码可查看）**，不是 OSI 定义的开源软件。自然人可免费运行未修改的软件用于个人非商业用途；公司、组织、工作及商业用途需书面许可。不允许修改、衍生或重新分发本项目自有代码；第三方组件依各自许可。
