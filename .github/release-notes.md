# DeepSeek Desktop 0.3.5

Windows、Mac Apple 芯片和 Mac Intel 同步发布。

## 修复与改进

- 修复 Windows 正常关闭客户端时，账号子窗口回调可能聚焦已经销毁的主窗口，弹出“主进程发生 JavaScript 错误”的问题。
- 主窗口开始关闭即进入退出状态；账号刷新、窗口聚焦以及后台状态推送均避免访问正在销毁的 WebContents。打包回归测试覆盖账号子窗口仍打开时关闭主窗口。
- 三端同版本构建以保持共用签名更新清单一致；Mac 功能没有额外变化。

## 延续功能与安全提示

工作台仍支持余额、官方充值、推理及权限滑块、上下文用量、图片/文件附件、多任务与对话管理；网页版继续在隔离的容器内加载 DeepSeek 官方服务。默认 Full Access，请留意输入区风险提示。

Windows 暂无 Authenticode 代码签名；Mac 仅为 ad-hoc 签名，没有 Apple Developer ID 或公证。请从可信来源下载并核对 SHA-256；Mac 更新需手动替换应用。隐私、网络连接和许可边界见 README、PRIVACY.md、NETWORK.md、SECURITY.md。
