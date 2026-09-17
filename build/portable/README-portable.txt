DeepSeek Desktop · Windows x64 便携版

完整解压后运行 DeepSeek Desktop.exe 或 Run-DeepSeek.cmd。
自带 Node 和固定版本 Harness，无需另外安装；模型和账户功能需要联网。
这是第三方客户端，不是 DeepSeek 官方产品。

权限
Read Only：新用户默认只读。
Workspace Write：允许修改所选工作目录。
Full Access：移除 Harness 沙箱限制；需要确认，不绕过 Windows UAC。
Full Access 不作为新会话默认值保存，重启后旧会话再次打开/发送前会降为只读。
新用户的默认工作目录为 data/workspace；设置中可以选择自己的文件夹。

数据与广告
便携模式的数据保存在 data：harness 中有会话与凭据，chromium 中有网页登录状态，
config 中有设置和账户缓存，logs 中有日志。API Key 本地文件可能明文。
软件有远程广告位，目前没有关闭开关。具体域名、频率、留存边界见 PRIVACY.md 和 NETWORK.md。
不要分享运行过的 data 文件夹；备份时请妥善保护其中的凭据与工作文件。
无法使用便携目录时可能回退到用户数据目录，实际路径可在 设置 → 关于 查看。

验证与更新
每小时检查签名清单，点击更新才下载；更新设计为保留 data，重要资料请自行备份。
此版本没有 Windows Authenticode 证书，可能显示未知发布者。
请核实 GitHub Release 来源、SHA-256 和构建来源证明。不要关闭杀毒软件或盲目加入白名单；
遇到安全警报可停止运行并反馈。安全边界与验证方法见 SECURITY.md。

卸载与退出
关闭软件后可删除程序和自己的数据目录；删除前确认 data/workspace 中的文件不再需要。
退出平台登录不会撤销 API Key，不会删除对话。需要停用 Key 时在 DeepSeek 平台撤销。
系统、浏览器和防护软件可能保留各自缓存或运行记录，不承诺零残留。

许可与反馈
个人非商业用途可免费运行未修改的软件；企业、组织、工作用途需要书面许可。
不允许修改或重新分发自有代码；第三方组件遵循各自许可。完整条款见 LICENSE.txt。
项目：https://github.com/uulucky/deepseekdesktop
反馈与授权：489583561@qq.com
