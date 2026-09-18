# 构建与验证

本项目源码可查看，不是 OSI 开源许可。自行构建的用途仍受 [LICENSE](LICENSE) 约束；未修改源码的安全检查不等于获得修改、商业使用或分发权。

## Windows 干净构建

使用 Node.js **24.15.0**、npm、Go **1.27.1**，在 Windows x64 PowerShell 中：

```powershell
npm ci
npm run runtime:stage
npm test
npm run test:integration
$env:GO111MODULE='off'
go test ./build/update-bootstrap
npm run dist:portable
npm run test:packaged
```

`runtime:stage` 从 Node 官方源获取固定 ZIP 并验证固定 SHA-256，通过 `build/kernel/package-lock.json` 安装固定 Harness 及依赖。`vendor/`、`dist/`、`node_modules/`、内部 `docs/` 不提交。

## 自动构建

[Windows build, test and release](https://github.com/uulucky/deepseekdesktop/actions/workflows/release.yml) 在 push、PR、手动触发及版本 tag 时执行。同一源码构建结果发布为 GitHub Actions artifacts；仅本仓库版本 tag 的通过测试产物会发布为 Release 并生成 GitHub 构建来源证明。PR 不获得发布私钥或 OSS 凭据。

公开内容包括 Windows 构建日志、契约测试、全新临时 Harness 的真实接口测试、打包后 UI 冒烟截图、原生更新器测试、`SHA256SUMS.txt`、`build-info.json` 与 `sbom.cdx.json`。测试不访问维护者的真实 Key、对话或支付账号。

多任务回归使用回环地址上的可控 SSE 模拟模型：保持 A 流未结束时新建并运行 B，交错接收响应，停止 A 后确认 B 继续完成。真实 Harness 集成和 Windows 打包 UI 都执行这个场景；另有乱序 RPC、快速切换、草稿恢复、后台批准与消息去重契约测试。没有向真实模型发送测试问题或产生 API 费用。

打包测试覆盖本版完整 ZIP 的本地更新解包、文件替换和数据保留；**不是所有旧版本升级链路、杀毒软件和 Windows 配置的认证**。需要真实账户的登录、充值和付费响应不在无人值守 CI 中执行。

## 本地测试

```sh
npm ci
npm test
npm ci --prefix build/kernel --ignore-scripts
npm run test:integration
```

非 Windows 系统可以运行契约和隔离 Harness 测试，不能据此宣称通过 Windows 端到端测试。旧 `node test/smoke.js` 入口也会启动隔离内核，不再默认连接本机 3080 或读取现有对话。

## 产物验证

Release ZIP 与自动更新分发的是同一 CI 构建文件。可执行：

```sh
gh attestation verify DeepSeekDesktop-0.2.21-portable.zip --repo uulucky/deepseekdesktop
node build/verify-update.js latest.json
```

`gh` 是 GitHub CLI。校验值单独用于文件完整性；请同时核对来源证明对应的仓库、workflow 和提交。`build-info.json` 写入源码提交、构建时间、依赖摘要与 workflow URL。构建包含时间信息、平台打包器及上游下载资源，**尚未声明逐字节可重现构建**。

参考：[GitHub artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)。
