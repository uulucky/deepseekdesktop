# 安全说明与漏洞反馈

安全问题请发至 **489583561@qq.com**。请提供版本、系统版本、最小复现与已脱敏的日志。不要在公开 Issue 或邮件中发送真实 API Key、密码、会话 Cookie 或完整私密对话。发现凭据泄露时先在官方平台撤销凭据。

## 当前边界

- 这是可以执行命令、读取文件、调用外部服务的 Agent 客户端，不是仅显示聊天文字的浏览器。
- 没有保存过权限偏好时默认 Full Access，默认工作目录为 `data/workspace/`；旧的自选目录和低权限偏好保留。Workspace Write 可修改工作目录；Full Access 取消 Harness 沙箱限制，但不会绕过 Windows 账户权限/UAC。**专用工作目录不是 Full Access 的隔离边界。**
- Full Access 在输入区持续显示风险提醒，不通过阻塞弹窗或单次批准打断操作。三个档位都能保存为新会话默认值；重启、打开或发送旧会话不会自动更改权限。此默认值偏向操作便利，不是最小权限配置；处理不可信内容前请主动选择只读/工作区或使用隔离环境。
- 权限由固定版本 Harness 执行。沙箱可能有上游缺陷，不能当成针对恶意代码的绝对隔离；高风险任务适合专用账户或虚拟机。
- Electron 页面使用 context isolation、关闭 Node integration；特权 IPC 校验来源页面和主 frame，广告图片受 CSP/域名限制。它们减少攻击面，但不等于通过独立渗透审计。
- 本地凭据文件可能明文，详见 [隐私说明](PRIVACY.md)。

## 三种不同的验证

1. **SHA-256**：检测文件是否与清单一致，本身不证明发行者身份。
2. **更新清单 Ed25519 签名**：当前客户端内置公钥，拒绝无签名、未知密钥或篡改的清单；签名覆盖版本、下载地址、大小、哈希等整个清单内容。私钥不放在 GitHub、CI 或 OSS，维护者在本机离线批准 CI 产物后签名。仅攻破 OSS 而没有私钥，不能给已信任此公钥的客户端发布新包。
3. **GitHub 构建来源证明**：Release 产物由公开 Windows workflow 从相应提交构建，附来源证明、构建信息、依赖清单和校验值。可以验证构建身份；它不证明源码没有漏洞，也不证明字节级可重现。

Windows EXE **目前没有 Authenticode 代码签名**，“已验证的发布者”和 SmartScreen 信誉问题尚未解决。更新签名和 GitHub 来源证明不能代替 Windows 发行者证书。请只使用自己能核实的下载来源，不要为运行软件关闭系统安全软件。

首次安装时仍需要信任项目提供的公钥与程序；从不支持签名的旧客户端第一次升级，无法追溯增强旧客户端的验证能力，建议通过 GitHub Release 校验下载。拒绝降到已安装版本以下，不等于具备完整 TUF 防冻结、撤销与多方阈值签名体系。离线/阻断网络时，无法保证及时发现更新。

## 验证下载

在 Release 下载 ZIP、`SHA256SUMS.txt` 和 `build-info.json`。PowerShell：

```powershell
Get-FileHash .\DeepSeekDesktop-0.2.20-portable.zip -Algorithm SHA256
gh attestation verify .\DeepSeekDesktop-0.2.20-portable.zip --repo uulucky/deepseekdesktop
```

核对哈希、来源仓库、workflow 及源码提交，而不是仅看文件名。详情见 [构建与验证](BUILDING.md)。源码内公钥位于 `src/main/modules/update-keys.json`。

## 支持范围与未覆盖事项

优先修复当前发行版的问题。CI 覆盖契约、隔离内核、打包启动、输入、权限提醒与保存、模型菜单、原生解包与数据保留。它不登录真实账户、不充值、不调用付费模型；真实支付、不同杀毒软件、企业组策略和所有 Windows 机器仍需要真实用户验证。Star、下载数和测试通过都不是安全认证。

分支保护、签名发布者证书、独立安全审计、维护者账户安全同样重要；未配置的项目不能宣传为已启用。
