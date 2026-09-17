# 维护者发布流程

## 自动构建，单独批准更新

1. 修改版本、用户说明和测试，检查无真实凭据或用户数据；推送版本 tag。
2. 等公开 Windows CI 全部通过。Release 上传由该 tag 源码构建的 ZIP、原生更新器、哈希、SBOM 和 `unsigned-update.json`，并生成 GitHub 来源证明。不从 OSS 取旧二进制充当构建产物。
3. 从 GitHub 下载并核对来源证明、提交、包内版本、哈希和测试结果；保留真实 Windows 人工验证记录。未完成的验证要明确列出。
4. 只在持有发布私钥的维护机签名：

```sh
node build/sign-update.js unsigned-update.json /absolute/private/update-signing.pem latest.json
node build/verify-update.js latest.json
```

私钥必须位于仓库外，不上传到服务器、聊天、GitHub 或 CI；单独做加密离线备份。公钥与 key ID 在源码中。密钥丢失、轮换或泄露需要单独的迁移发布与用户公告，不临时绕过验证。

5. 把已签名清单保存至 `updates/latest.json` 与按版本归档的 JSON，推送以公开审查。`publish-update.yml` 会验证签名并把清单附到对应 Release。
6. 将 **同一份 CI 产物** 上传至 OSS `uulucky-pic/han/deepseek/`，核对 CDN 下载哈希；最后上传 `latest.json`，避免先公布不存在的包。签名失败或产物未通过测试时不更新线上清单。

注意：Windows Authenticode、GitHub 构建来源证明和更新清单 Ed25519 是不同层次；当前前者未配置，不得宣称已验证 Windows 发布者。旧客户端首次迁移的信任边界见 SECURITY.md。

## Windows 代码签名尚需发行者提供

- 确定以个人还是公司法定身份申请、所在国家/地区和期望显示的发行者名称；名称必须经过服务商核验，不能随意填写品牌冒充法定主体。
- 选择支持该地区与主体的公共信任代码签名 CA/云签名服务；公司通常需要营业执照、注册信息、地址、可核验联系方式和授权经办人，个人方案通常需要身份证明。具体材料由所选服务商确认，直接提交给服务商，不在 Issue 或聊天发送。
- 准备订阅/证书预算、身份验证与回访、硬件 Token/HSM 或合规云密钥托管。现代公共信任代码签名通常要求受保护的密钥，不能假定获得可随意导出的 PFX。
- CI 使用专用最小权限身份、受保护环境与人工批准；签名客户端、更新器等自有 EXE，加入时间戳，签名后再打 ZIP、计算哈希、生成来源证明和清单签名。

Microsoft Artifact Signing 的公共信任资格受国家/地区、主体和账号条件限制，应先核实是否符合，不默认中国个人/公司可申请。证书也不保证立即获得 SmartScreen 信誉或不再出现任何警告。

官方资料：[Microsoft 申请前提](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)、[发行者名称与服务 FAQ](https://learn.microsoft.com/en-us/azure/artifact-signing/faq)、[DigiCert 硬件密钥要求](https://knowledge.digicert.com/alerts/code-signing-changes-in-2023)。
