# DeepSeek Desktop 0.3.1

本版同步发布 Windows、Mac Apple 芯片和 Mac Intel 安装包。

## 新增

- 左上角可切换“工作台（Harness）”与“网页版（免费）”。网页版直接运行隔离的 DeepSeek 官方页面，使用自己的登录和会话列表；切换模式不会刷新或销毁另一边的长对话。
- 工作台输入框下显示当前会话上下文已使用 Token、总量与百分比，接近上限时提示。
- 工作台支持直接粘贴图片；输入框左下角新增“+”，可一次选择多个图片或文件随消息发送。
- Windows、Apple 芯片与 Intel Mac 使用同一源码和公开 CI 测试后同步发布。

## 隐私与安全说明

- 网页版只加载 DeepSeek 官方页面，不读取或注入登录令牌，不向远程页面暴露 Node、preload 或桌面 IPC。网页版消息、附件、搜索和分享由 DeepSeek 官方服务处理。
- Windows 暂无 Authenticode 代码签名，可能显示“未知发布者”。Mac 仅为 ad-hoc 签名，无 Apple Developer ID 和公证；首次打开请在确认下载来源和哈希后按 README 操作，不要关闭系统安全功能。
- 三个平台都验证 Ed25519 更新清单；发布页提供 SHA-256、构建信息、SBOM 和 GitHub 来源证明。Mac 更新仍需下载 DMG 后手动替换应用。

详细使用、网络连接、数据保存和已知边界见 README、PRIVACY.md、NETWORK.md 与 SECURITY.md。
