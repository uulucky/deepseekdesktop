# 构建与验证

本项目源码可查看，不是 OSI 开源许可。自行构建的用途仍受 [LICENSE](LICENSE) 约束；未修改源码的安全检查不等于获得修改、商业使用或分发权。

手机连接使用额外的 `dmuse-sidecar` 原生组件；CI按目标平台下载固定版本，并在暂存和生成构建信息时校验SHA-256，缺少组件或校验不符会终止构建。`build-info.json` 与SBOM记录其版本、下载来源与实际哈希。该Go组件的传递依赖未列入npm依赖清单，不能把这份SBOM称作完整的Go依赖审计。

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

Mac 使用匹配 CPU 的 macOS 机器和 Node 24.15.0，执行 `npm ci`、`npm run runtime:stage`、`npm test`、`npm run test:integration`、`npm run dist:mac`、`npm run test:packaged`。不需要 Apple 开发者账号；自有脚本通过锁定的 `@electron/osx-sign` 做 ad-hoc 签名，无公证、不访问开发者证书。不要在 ARM64 机器上把原生依赖复用为 Intel 包。支持 macOS 14+，CI 原生测试环境为 macOS 15 的 ARM64 与 Intel runner，不代表每个系统小版本都已验证。

Mac 的 DMG 和 ZIP 包含同一 `.app`。测试从正式 ZIP 解包，验证递归代码签名和 Node CPU 架构，实际启动 Electron/随包 Harness，执行输入、多任务、行动摘要、上下文投影、图片/文件附件、官方网页容器隔离与无刷新切换、渲染恢复、退出/重启及替换 `.app` 后独立数据和测试 Cookie 保留。官方网页测试使用本机回环夹具，不登录真实账号。测试不会为 CI 自动放行 Gatekeeper，也不能替代真实官方页面、首次安装、系统钥匙串或真实账户验证。

[Windows and Mac build, test and release](https://github.com/uulucky/deepseekdesktop/actions/workflows/release.yml) 在 push、PR、手动触发及版本 tag 时执行。同一源码构建结果发布为 GitHub Actions artifacts；仅本仓库版本 tag 的通过测试产物会发布为 Release 并生成 GitHub 构建来源证明。PR 不获得发布私钥或 OSS 凭据。

公开内容包括 Windows 构建日志、契约测试、全新临时 Harness 的真实接口测试、打包后 UI 冒烟截图、原生更新器测试、`SHA256SUMS.txt`、`build-info.json` 与 `sbom.cdx.json`。测试不访问维护者的真实 Key、对话或支付账号。

多任务回归使用回环地址上的可控 SSE 模拟模型：保持 A 流未结束时新建并运行 B，交错接收响应，停止 A 后确认 B 继续完成。真实 Harness 集成和 Windows 打包 UI 都执行这个场景；另有乱序 RPC、快速切换、草稿恢复、后台批准与消息去重契约测试。没有向真实模型发送测试问题或产生 API 费用。

打包测试覆盖本版完整 ZIP 的本地更新解包、文件替换和数据保留；**不是所有旧版本升级链路、杀毒软件和 Windows 配置的认证**。需要真实账户的登录、充值和付费响应不在无人值守 CI 中执行。

## 手机连接组件（dmuse sidecar）

`npm run sidecar:stage -- --platform <darwin|win32> --arch <arm64|x64>` 从 Celium 源码（`CELIUM_SRC`，默认同级目录 `celium-dmuse-phase0`）用纯 Go（不需要 cgo）编译 `vendor/dmuse/dmuse-sidecar`，打包时作为额外资源放进 `vendor/dmuse`。没有这个组件的构建仍可正常使用，只是“设置 → 手机连接”不可用。开发时可用 `DMUSE_SIDECAR` 指定组件路径，`DMUSE_SERVER`、`DMUSE_CONTROL_KEY` 指向本机协调服务器；`test/remote-sidecar.js` 在这些变量和 `DMUSE_PHONE`（手机模拟器）都设置时做端到端联调，否则跳过。开发 dmuse 手机 App 时，`node test/fixtures/remote-fake-desktop.js <电脑名>` 用真实的 sidecar 和网关加上模拟会话充当电脑（消息含「删除/delete」触发高风险确认，含「权限/permission」触发审批）。

## 本地测试

```sh
npm ci
npm test
npm ci --prefix build/kernel --ignore-scripts
npm run test:integration
```

测试结果只代表运行它的系统与架构；Mac 通过不能据此宣称 Windows 通过，反之亦然。旧 `node test/smoke.js` 入口也会启动隔离内核，不再默认连接本机 3080 或读取现有对话。

自动任务流程可单独运行 `npm run test:workflow`。契约测试覆盖依赖、验收证据、独立审查、有限返工、阻塞、取消和续跑；真实固定内核联调使用回环模拟模型和临时工作目录，实际创建及读取文件，并验证内核重启后不重放已通过的子任务，不调用付费模型。`npm test` 包含契约测试，`npm run test:integration` 包含此联调，`npm run ui:shot` 生成任务进度卡片截图。流程说明见 [TASK-WORKFLOWS.md](TASK-WORKFLOWS.md)。

## 产物验证

Release ZIP 与自动更新分发的是同一 CI 构建文件。可执行：

```sh
gh attestation verify DeepSeekDesktop-0.5.1-portable.zip --repo uulucky/deepseekdesktop
node build/verify-update.js latest.json
```

`gh` 是 GitHub CLI。校验值单独用于文件完整性；请同时核对来源证明对应的仓库、workflow 和提交。`build-info.json` 写入源码提交、构建时间、依赖摘要与 workflow URL。构建包含时间信息、平台打包器及上游下载资源，**尚未声明逐字节可重现构建**。

参考：[GitHub artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)。

Mac 产物另外提供 `mac-arm64-build-info.json` / `mac-x64-build-info.json`、对应 SBOM、分平台哈希清单。全部原生任务通过后合并更新描述与总 `SHA256SUMS.txt`，对 DMG、ZIP、更新器及元数据生成来源证明；正式发布不使用开发机临时打包结果。
