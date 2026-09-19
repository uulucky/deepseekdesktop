待发布说明草稿：Mac 支持已加入源码，暂不分配版本号、不发布安装包或更新清单。用户要求与其他功能一并发布。以下内容仅供下次正式发布前核对。

计划增加 Mac 直接下载版，同时保留 Windows 便携版；支持 macOS 14+。

- Apple 芯片（M 系列）选择 `mac-arm64.dmg`；Intel 选择 `mac-x64.dmg`。将应用拖入“应用程序”。另提供相同内容的 Mac ZIP。
- 不走 App Store，无 Apple Developer ID 或 Apple 公证，仅 ad-hoc 签名。确认下载可信后，如系统拦截，请到“系统设置 → 隐私与安全性 → 仍要打开”。不要求关闭系统安全保护；企业策略可能不允许打开。
- Mac 自带匹配架构的 Node 和 Harness；适配系统菜单，数据默认在 `~/Library/Application Support/DeepSeek Desktop/`，不在 `.app` 内。Cmd+Q 完全退出。
- 每小时检查已签名版本清单。Mac 下载后退出软件并手动替换应用，数据保留；系统可能再次要求允许打开、钥匙串授权或重新登录。Windows 保留原有自动更新/重启。
- 保留余额、软件内官方充值、中文行动摘要、推理和权限滑块、多任务、会话管理、黑窗口恢复。默认 Full Access 并常驻提示风险，不绕过 macOS 系统权限。

公开 CI 在 Windows、Apple 芯片和 Intel 原生机器上构建、启动和测试各自完整安装包；包括多任务、崩溃恢复、正常退出和替换后的数据保留。使用本地模拟模型，不验证真实登录/充值，不代表覆盖所有 Mac 的 Gatekeeper、钥匙串或企业策略。

Windows 未 Authenticode 签名；源码可查看而非标准开源。下载前阅读 README、PRIVACY.md、SECURITY.md。总 SHA256SUMS、分平台 build-info/SBOM 与 GitHub 来源证明一同提供。

unsigned-update.json 仅供维护者审核签名，客户端不接受未签名清单。审核后另附 latest.json；国内 OSS 镜像在校验后上线，发布初期优先下载本页资产。
