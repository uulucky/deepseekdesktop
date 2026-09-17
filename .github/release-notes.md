Windows 10/11 x64 便携版。下载 portable.zip 后完整解压，再运行 DeepSeek Desktop.exe。

此版本增加：

- Ed25519 签名更新清单、文件哈希验证，签名私钥不存放在 OSS 或 CI。
- 公开 Windows 源码构建与测试、GitHub 来源证明、构建信息、SBOM 和 SHA256SUMS。
- 真实隔离 Harness 测试、打包后输入/权限确认/菜单/启动与原生更新解包测试。
- 默认只读和专用工作目录；Full Access 不作为新对话默认权限保存。
- 完整隐私、网络连接、远程广告、许可与安全边界说明，收紧 IPC 和远程图片来源。

Windows 程序暂未 Authenticode 签名；源码可查看而非标准开源。CI 不登录真实账户、充值或调用付费模型。请阅读 README、PRIVACY.md 和 SECURITY.md。

unsigned-update.json 仅供维护者审核签名，客户端不接受未签名更新清单。审核后将另附已签名 latest.json。OSS 镜像须在校验后同步，发布初期请优先使用本页资产。
