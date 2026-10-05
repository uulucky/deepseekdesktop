# Microsoft Store 渠道

当前准备提交 0.3.5.0（Windows x64），并非已通过微软审核的承诺。MSIX 身份为 `11C53232.deepseek`，产品 ID `9NMC44LMCNH1`，发布者为北京艾特阿尔法科技有限责任公司。第三方 DeepSeek 客户端，不是 DeepSeek 官方产品。

## 构建

在 Windows 安装官方 Node.js 和 Windows SDK，使用本仓库锁定依赖：

```powershell
npm.cmd ci
npm.cmd test
powershell -NoProfile -File build/store-package.ps1 -PortableZip C:\path\DeepSeekDesktop-0.3.5-portable.zip -OutputDirectory C:\path\fresh-store-build -SourceCommit <本次源码的完整 Git 提交 SHA>
```

脚本先校验已公开的便携 ZIP SHA-256 与原始版本/源码身份，再保留该包的 Electron、Node、Harness 原生组件，仅重打包商店适配后的应用代码和公开说明。MakeAppx 执行完整包验证，不跳过验证。输出无签名 MSIX 和 `store-build-info.json`；Partner Center 接收后由 Microsoft Store 签名。验证本机安装时需要独立测试签名，不得上传私钥或把本机测试证书描述为微软发行者认证。

## 渠道区别

- MSIX 安装目录只读；所有账号登录态、Key 配置、会话和日志均保存在当前用户的包专属 LocalState 中。商店更新不自动覆盖这些数据；重置或卸载可能清除它们，重要记录需自行备份。
- 商店版不调用 OSS 的 EXE 自更新器。设置中的更新操作打开 Microsoft Store；便携版继续使用自己的签名更新清单。
- 使用 `runFullTrust` 运行 Electron 与内置 Harness 子进程，允许用户授权的文件/命令任务。没有申请其他受限能力。Full Access 默认启用且持续提示，用户可以切换只读或工作区；Windows/UAC 安全控制仍生效。
- 个人非商业使用免费；工作、公司和组织用途需要书面授权。DeepSeek API 费用与客户端许可分开，由 DeepSeek 收取。
- 包含远程广告位；维护者日志和备份保留 30 天。详见 [隐私说明](PRIVACY.md) 和 [网络连接](NETWORK.md)。

商店认证结论以 Partner Center 的实际状态为准。发布时保存 MSIX 校验值、准确源码 SHA、远程构建和安装测试记录，不重写已发布的便携版 tag。
