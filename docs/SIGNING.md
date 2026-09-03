# 发布签名指南

当前所有发行包都是未签名的：macOS 会被 Gatekeeper 拦首次启动，Windows 会弹 SmartScreen 蓝屏警告。本文件说明拿到证书后如何启用签名，以及买哪种证书的决策依据。

## 快速启用（拿到证书后照抄）

```bash
# macOS：钥匙串已导入 Developer ID Application 证书
export APPLE_ID=you@example.com
export APPLE_APP_SPECIFIC_PASSWORD=abcd-efgh-ijkl-mnop   # appleid.apple.com 生成
export APPLE_TEAM_ID=ABCDE12345                           # Account → Membership
npm run build:mac

# Windows：把 .pfx 放 certs/agenttower.p12（已在 .gitignore）
export CSC_LINK="file://$PWD/certs/agenttower.p12"
export CSC_KEY_PASSWORD=证书密码
npm run build:win
```

`electron-builder.yml` 已配好 `hardenedRuntime: true`（公证前置）与 `notarize: ${env.APPLE_ID}`（环境变量驱动，yml 不必改）。Windows 同样靠 CSC_LINK 触发，yml 里 `certificateFile` 仅作开发机本地签备选。完整流程与故障排查见下文。

## macOS：Apple Developer + 公证（路径唯一，决策简单）

| 步骤 | 说明 |
|---|---|
| 1. 加入 Apple Developer Program | <https://developer.apple.com/programs/>，**¥688/年**，个人实名即可（用真名，Gatekeeper 详情里会显示它）。注册审核一般当天～几天 |
| 2. 创建证书 | Mac 钥匙串访问 → 证书助理 → 从证书颁发机构请求证书（CSR）→ developer.apple.com/account → Certificates → 新建 **Developer ID Application** → 下载 `.p12` 双击导入登录钥匙串 |
| 3. 生成 App 专用密码 | <https://appleid.apple.com> → 登录与安全 → App 专用密码 |
| 4. 启用配置 | `electron-builder.yml` 中 `mac.notarize` 改为 `true`；构建时提供三个环境变量：`APPLE_ID`（Apple ID 邮箱）、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`（账号页面 Tenures 里的 10 位 Team ID） |
| 5. 构建并验证 | `npm run build:mac`（有证书钥匙串会自动签名）。验证：`codesign -dv --verbose=4 dist/mac-arm64/AgentTower.app`；`spctl -a -vv -t install <dmg>`；`stapler validate <dmg>` |

签名+公证后，用户下载 dmg 直接双击打开，无任何拦截提示。
注意：公证要求上传走苹果服务器，国内网络偶尔超时，重试即可；每次 `--mac` 构建会签 arm64/x64 两个产物。

## Windows：先理解机制，再选购买路径

SmartScreen 的判定 = **证书类型 + 下载信誉**。这不是玄学：

- **EV 证书 / Trusted Signing**：签名后基本立即全网放行；
- **OV 证书**：早期下载量少时可能仍弹（但可"仍要执行"），积累下载信誉后自动消失；
- **无证书**：永远弹蓝屏。

### 采购选项（按适合度排序）

| 路径 | 主体要求 | 价格 | 备注 |
|---|---|---|---|
| 国内 CA（GDCA 时代证 / CFCA / 安心签等，签名.cn 等渠道在售） | 企业或个体工商户（要营业执照） | 约 ¥1500–3500/年 | 交付 USBKey 或云证书；驱动在 macOS 上用不了，但证书可导出 `.pfx`，用 electron-builder 内置的跨平台签名即可，无需 Windows 机器 |
| **Certum Code Signing (OV)** | 个人可申请；开源项目有专门的低价 Open Source 计划 | 约 €80–250/年 | 可导出 `.p12`，对独立开发者最务实；开源计划要求公开源码构建、可被审计 |
| SSL.com / Sectigo / DigiCert 经销商 | 一般需组织主体 | ¥3000–8000/年 | 贵但信誉积累快 |
| Azure Trusted Signing | 需通过组织验证（个体工商户+域名邮箱可行） | $9.99/月 | 云 HSM 无 `.pfx` 文件，需在其 CI 集成里签，与 CNB 流水线配合度差，暂不推荐 |
| SignPath Foundation | 真·开源项目（OSI 许可 + 公开仓库 + 审核） | 免费 | 本项目若愿意挂开源许可可申请 |

### 拿到 `.pfx/.p12` 之后

1. 证书文件放 `certs/`（已在 `.gitignore`，永不入库）；密码走环境变量。
2. 本地构建：
   ```bash
   CSC_LINK=file://$PWD/certs/agenttower.p12 CSC_KEY_PASSWORD=*** npm run build:win
   ```
   （或启用 `electron-builder.yml` 里注释掉的 `certificateFile` 配置。）
3. CI 构建：CNB 流水线用**密钥仓库** `imports` 注入环境变量（语法见 docs.cnb.cool/zh/build/env.md），同样只传环境变量，不传证书文件进公开仓库。
4. 验证：
   ```powershell
   signtool verify /pa /v agent-tower-x.y.z-setup.exe
   ```
   属性页应出现"数字签名"标签，署名与证书主体一致。

## 发版检查清单（签名时代）

1. 升级 `package.json` 版本号；
2. `npm run build:win` + `npm run build:mac`；
3. 逐个验证签名（codesign / spctl / signtool）；
4. 按 `docs/RELEASE.md` 上传新 tag 的 Release 与全部资产（含 `.blockmap`）；
5. 更新 README 下载区链接与版本描述。

## 安全红线

- `.pfx`/`.p12` 与私钥密码**不进 git、不进聊天明文、不备份到网盘明文**；
- 泄露的证书会被滥用签名恶意软件，CA 会吊证，损失的不只是钱；
- Apple 的 App 专用密码可随时吊销，Team ID 无保密需求。
