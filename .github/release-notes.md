# DeepSeek Desktop 0.3.4

Windows、Mac Apple 芯片和 Mac Intel 同步发布。

## 修复与改进

- 修复 `ask_user_question` 只显示“运行中”却无法回答：工作台现在显示问题卡片，支持单选、多选、自定义输入、多题、跳过及取消，答案会回传给当前任务。侧栏标记“待回答”，切换会话或界面重绘不会丢失草稿。
- 修复 Mac 点击红色关闭按钮时偶发的原生崩溃；正常关闭只隐藏窗口，Dock 可恢复，Cmd+Q 完全退出。
- Mac 启动时识别并清理经严格核实的本应用残留 Harness 进程，避免旧进程占用会话锁造成“继续对话”失败，不影响正常运行的进程或用户自行运行的 Harness。
- 右上角新增“分享客户端”，可复制官方下载页链接。

## 延续功能与安全提示

工作台仍支持余额、官方充值、推理及权限滑块、上下文用量、图片/文件附件、多任务与对话管理；网页版继续在隔离的容器内加载 DeepSeek 官方服务。默认 Full Access，请留意输入区风险提示。

Windows 暂无 Authenticode 代码签名；Mac 仅为 ad-hoc 签名，没有 Apple Developer ID 或公证。请从可信来源下载并核对 SHA-256；Mac 更新需手动替换应用。隐私、网络连接和许可边界见 README、PRIVACY.md、NETWORK.md、SECURITY.md。
