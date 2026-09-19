# 网络连接清单

适用版本：0.2.24；以下是客户端内置路径，不是模型工具所有可能请求的白名单。

| 目的 | 目标 | 触发方式 | 发送的数据 |
| --- | --- | --- | --- |
| 本地 Harness HTTP / WebSocket | `127.0.0.1`，默认 3080，冲突时换端口 | 启动、对话和设置操作 | 本地认证 Cookie、会话和工具协议；不是远程上传 |
| 模型推理与 Key 验证 | `api.deepseek.com`，或用户配置的服务端点 | 发消息、验证 Key 等 | API Key；推理时包含提示词、上下文与相关工具内容 |
| 登录、余额、用量、Key、充值 | `platform.deepseek.com` | 登录/手动操作；账户约每 10 分钟刷新 | 平台会话信息、Key 名称、相关账户请求；生成或删除 Key 会改变账户状态 |
| 模型价格目录 | `api-docs.deepseek.com/zh-cn/quick_start/pricing` | 启动时按日缓存、手动同步 | 普通 HTTPS 请求，不附加账户凭据 |
| 广告配置 | `www.uulucky.com/dsad.json` | 启动及约每 30 分钟 | 普通 HTTPS 请求，不附加对话或账户凭据 |
| 广告图片 | `img.uulucky.com` | 展示/轮播广告，受缓存影响 | 图片路径；客户端设置无 Referrer |
| 更新清单 | `img.uulucky.com/han/deepseek/latest.json` | 启动后、每小时、手动检查 | 普通 HTTPS 请求；本机比较版本 |
| 更新程序、ZIP、Mac DMG | `img.uulucky.com/han/deepseek/` | 用户点击更新/下载 | Windows 先验清单签名再验文件哈希；Mac 验清单后交给浏览器下载，用户自行核对文件哈希 |
| 项目、隐私说明、下载 | `github.com/uulucky/deepseekdesktop` 及 GitHub 下载域名 | 用户点击链接或手动下载 | 浏览器正常请求，由 GitHub 处理 |

DeepSeek 网页登录和充值可能访问官方页面引用的验证码、CDN、支付方等域名；这些由官方网页决定，不能仅凭此表当作完整防火墙策略。点击广告会访问所展示的外部目标，例如 DeepSeek 官网、400 电话服务或阿里云市场；不点击时客户端不会为了预览而抓取这些目标网页。

用户配置的第三方模型、MCP、浏览器和命令有独立网络行为。Full Access 不是网络隔离模式，Read Only 也不承诺阻止网络访问。

行动摘要使用同一次模型响应，不新增翻译接口、第三方域名或后台补译请求；只有本地展示解析，不向广告/更新服务器发送摘要和思考原文。

## 构建和高级维护

公开 Windows 和 Mac 安装包自带 Node 和固定版本 Harness；缺失运行组件时会报错要求重新下载完整包，不会自动改用未审查的 `dsh@latest`。开发模式或用户主动指定内核更新源时，维护功能仍可从 npm/镜像/本地路径安装组件，应自行信任该来源。

CI 从 GitHub、`registry.npmjs.org`、`nodejs.org` 获取源码、锁定依赖和 Node；Electron 与 electron-builder 的构建资源也会从其官方 GitHub 发布源下载。各平台 Node 压缩包的 SHA-256 固定在源码中；npm 依赖由两个 lockfile 的 integrity 校验。它们是构建网络连接，不是用户正常启动的必需连接。

可以用系统资源监视器或防火墙观察实际请求。禁用广告/更新域名可能导致图片缺失或无法升级；禁用模型服务会导致无法获得回答。没有把网络阻断错误当成账户余额为零。
