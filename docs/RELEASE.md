# 发布新版本

仓库与发行版入口：<https://cnb.cool/WeiGuangXunTu/AgentTower/-/releases>。

## 流程总览

```
git tag v1.2.3 && git push --tags
       ↓
CNB CI 只跑 build-linux（公开 runner 只有 Linux）
       ↓
CI 自动创建 release v1.2.3（草稿）+ 上传 Linux 产物（AppImage/deb）
       ↓
开发者本地：
  npm run build:mac   # 产出 2 个 dmg
  npm run build:win   # 产出 1 个 setup.exe
       ↓
./scripts/release.sh v1.2.3 --from-local
   ├─ 签名 macOS dmg（钥匙串里有 Developer ID 时自动签）
   ├─ 签名 Windows exe（certs/agenttower.p12 + signtool 在 PATH 时自动签）
   ├─ 重新上传到 release（覆盖未签名版 + 补齐 mac/win 产物）
   ├─ 上传 latest.json
   └─ 标记 release 为 latest
```

### 为什么只有 Linux 走 CI

CNB 公开 runner 只有 Linux（`cnb:arch:amd64` / `cnb:arch:arm64:v8`），macOS / Windows 没有公开 runner。
要 mac/win 必须自建 runner（CI 厂商配置的 mac/win 物理机），本仓库未配置。
所以 tag_push 阶段只跑 `build-linux`；mac/win 安装包由开发者本地 `npm run build:mac` / `build:win` 产出，再用 `scripts/release.sh --from-local` 上传。

### 签名为什么在本地

- macOS 钥匙串里的 Developer ID 证书不能放到云端 CI runner（安全要求 + Apple 政策）；
- Windows 的 `.pfx/.p12` 虽然能 base64 编码塞 CI，但「先下载到本地再覆盖回 release」的设计不如一次本地签完更省时。

## 前置

- macOS 钥匙串里有 CNB token（`security add-internet-password -s cnb.cool -w <token>`，账号名固定为 `cnb`）；或在 `~/.zshrc` 里 `export CNB_TOKEN=...`。
- 钥匙串里有 Developer ID Application 证书（没证书也能跑，签名步骤会跳过，发布出去的 dmg 是未签名的）。
- Windows 代码签名：把 `agenttower.p12` 放到 `certs/`，`export AGENTTOWER_CERT_PASSWORD=...`，并确保 `signtool` 在 PATH（没配也能跑，签名步骤跳过）。
- API 请求**必须带** `Accept: application/json` 头，否则返回 errcode 406。
- 完整接口定义：<https://api.cnb.cool/swagger.json>。

## 发布步骤

### 1. 触发 CI 构建（仅 Linux）

```bash
# 先在 package.json 里把 version 改好
git add package.json
git commit -m "chore: bump version to 1.2.3"
git tag v1.2.3
git push origin main --follow-tags
```

push tag 后，`.cnb.yml` 里的 `tag_push` 只启动一个 pipeline：

- **build-linux**（runner.tags=`cnb:arch:amd64`）：`npx electron-builder --linux --publish never`，产出 AppImage + deb + latest-linux.yml

pipeline 用 `git:release`（`latest: false`，草稿态）创建 release，然后 `cnbcool/attachments` 上传 Linux 产物。

到 <https://cnb.cool/WeiGuangXunTu/AgentTower/-/builds> 等 build-linux 全绿。红了先 fix 再重打 tag（`git tag -d v1.2.3 && git push origin :refs/tags/v1.2.3 && git tag v1.2.3 && git push --tags`）。

### 2. 本地构建 mac/win 产物

```bash
# macOS（arm64 + x64）
npm run build:mac
# 产出：dist/agent-tower-1.2.3-arm64.dmg  +  agent-tower-1.2.3-x64.dmg  +  latest-mac.yml

# Windows（x64）
npm run build:win
# 产出：dist/agent-tower-1.2.3-setup.exe  +  latest.yml
```

如果只发 Linux，跳过这一步直接跑第 3 步的 release.sh（不带 `--from-local`，脚本会下载 CI 产物再签名——Linux 不签，只重传）。

### 3. 跑发布脚本

```bash
# 签名 mac/win 并把本地 + CI 产物一起覆盖到 release
./scripts/release.sh v1.2.3 --from-local
```

`--from-local` 表示不下载 CI 产物，直接用 `./dist/` 现有文件（本步第 2 步已产出的 dmg/exe + 第 1 步可能另外下载的 Linux 产物）。

脚本做的事（详见 `scripts/release.sh`）：

1. `GET /-/releases/tags/v1.2.3` 拿 RID
2. **（带 `--from-local` 时跳过下载）**遍历 release 的 assets 列表，逐个 `GET /-/releases/download/v1.2.3/<filename>` 下载到 `./dist/`
3. 签名 macOS dmg（自动检测钥匙串里有没有 Developer ID Application 证书）
4. 签名 Windows exe（如果 `certs/agenttower.p12` + signtool 都到位）
5. 准备 `./dist/latest.json`（基于 `release/latest.json` 模板，填新版本号/日期/下载链接）
6. 逐个上传到 release（带 `overwrite: true` 覆盖未签名版）
7. `PATCH /-/releases/$RID` 把 `make_latest` 设为 `"true"`
8. 打印最终 release 的资产清单

可选 flag：
- `--skip-sign`：跳过签名步骤，只下载 + 重传（适合调试或不需要签名的发布）
- `--from-local`：不下载 CI 产物，直接用 `./dist/` 下已签好的文件（mac/win 本地构建场景）

### 4. 更新 README 下载区

打开 `README.md`，把「下载」区里三个链接的文件名版本号改成新版本（`1.2.3`）。

### 5. 验证应用内检查更新

启动 AgentTower → 菜单「检查更新」→ 应该拉取到 `<https://cnb.cool/.../-/releases/latest/download/latest.json>` 并提示新版本。如果提示「版本源请求失败」，说明 `latest.json` 没传或字段错了，重跑 release.sh。

## 纯 Linux 发布的简化流（不需要 mac/win 时）

如果只发 Linux（例如发 RC），可以完全跳过第 2 步：

```bash
git tag v1.2.3-rc1 && git push --tags
# 等 CI 在 release/v1.2.3-rc1/ 里上传 Linux 产物
./scripts/release.sh v1.2.3-rc1
# 脚本会下载 CI 产物（只有 Linux 三个文件）→ 没 mac/win 跳过签名 → 重传 → 标 latest
```

## 给 CI 加 mac/win 签名（如果以后配置了自建 runner）

最简单的扩展点（在 `.cnb.yml` 加上对应 OS runner + 注入签名环境变量）：

- macOS：跑 `macos-14` runner，构建脚本前 export `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`；`electron-builder.yml` 已配 `notarize: ${env.APPLE_ID}`，无需改 yml
- Windows：跑 `windows-2022` runner，构建脚本前 export `CSC_LINK`（file:// 路径或 base64）+ `CSC_KEY_PASSWORD`

但这条路要先有自建 mac/win runner 才能跑——CNB 不提供公开 runner。

## 手动 API（不推荐，保留备查）

`scripts/release.sh` 的实现就是按下面几步做的——脚本失败时可手动重跑：

```bash
TOKEN=$(security find-internet-password -s cnb.cool -w)
API=https://api.cnb.cool/WeiGuangXunTu/AgentTower

# 1) 找 release
RID=$(curl -fsS -u "cnb:$TOKEN" -H "Accept: application/json" $API/-/releases/tags/v1.2.3 \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 2) 下载每个 asset
curl -fsS -o agent-tower-1.2.3-arm64.dmg $API/-/releases/download/v1.2.3/agent-tower-1.2.3-arm64.dmg
# ... 其他文件同理

# 3) 签名（macOS）
codesign --force --options runtime --deep --sign "Developer ID Application" agent-tower-1.2.3-arm64.dmg

# 4) 上传（覆盖）
SZ=$(stat -f%z agent-tower-1.2.3-arm64.dmg)
url_json=$(curl -fsS -u "cnb:$TOKEN" -H "Content-Type: application/json" -H "Accept: application/json" \
  -d "{\"asset_name\":\"agent-tower-1.2.3-arm64.dmg\",\"size\":$SZ,\"ttl\":0,\"overwrite\":true}" \
  $API/-/releases/$RID/asset-upload-url)
upload_url=$(echo "$url_json" | python3 -c "import json,sys;print(json.load(sys.stdin)['upload_url'])")
verify_url=$(echo "$url_json" | python3 -c "import json,sys;print(json.load(sys.stdin)['verify_url'])")
curl -T agent-tower-1.2.3-arm64.dmg "$upload_url"
curl -u "cnb:$TOKEN" -H "Accept: application/json" -X POST "$verify_url"

# 5) 标记 latest
curl -fsS -u "cnb:$TOKEN" -H "Accept: application/json" -X PATCH -H "Content-Type: application/json" \
  -d '{"make_latest":"true"}' $API/-/releases/$RID
```
