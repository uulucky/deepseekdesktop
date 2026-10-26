# DeepSeek Desktop 0.5.1

Windows、Mac Apple 芯片和 Mac Intel 同步发布。

## 新功能

- **安全护栏**：Full Access 下，递归删除系统或主目录、`git reset --hard` / `clean -f` / 强制推送、格式化磁盘、下载脚本直接执行、读取 SSH 密钥与云凭据等少数高风险操作会先在对话里弹出确认卡片；拒绝后 Agent 收到被拦截的结果。其余命令照常执行，权限设置不变，可在“设置 → 通用”关闭。
- **设置 → 扩展**：启用本机 Claude、Codex 已有的 Agent Skills（只建链接，不改原技能）；添加 MCP 服务器，内置 Playwright 浏览器自动化预设；精选插件显示在当前内核上的实测结论，“免费多引擎联网搜索”可一键安装（固定版本、核对完整性、不运行依赖安装脚本）。
- **媒体与图片**：本地服务自动补全 Homebrew、winget 等常见路径并告诉 Agent ffmpeg/ffprobe 的实际位置；只支持文字的模型收到图片时，用系统自带文字识别在本机提取文字随消息发送（可关闭）。
- **界面**：蓝色胖鲸启动动画（可换成自己的图片或视频）；提示消息移到右上角不再遮挡发送按钮；推理调到“最大”时提示更慢、更费 tokens。

## 延续功能与安全提示

工作台仍支持余额、官方充值、推理及权限滑块、上下文用量、图片/文件附件、多任务与对话管理；网页版继续在隔离的容器内加载 DeepSeek 官方服务。默认 Full Access，请留意输入区风险提示；安全护栏基于命令文本匹配，不是沙箱。

Windows 暂无 Authenticode 代码签名；Mac 仅为 ad-hoc 签名，没有 Apple Developer ID 或公证。请从可信来源下载并核对 SHA-256；Mac 更新需手动替换应用。隐私、网络连接和许可边界见 README、PRIVACY.md、NETWORK.md、SECURITY.md。
