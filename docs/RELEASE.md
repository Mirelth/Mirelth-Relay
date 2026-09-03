# 发布新版本

仓库与发行版入口：<https://cnb.cool/WeiGuangXunTu/AgentTower/-/releases>。

## 流程总览

```
git tag v1.2.3 && git push --tags
       ↓
CNB CI 并行跑 build-mac / build-win / build-linux
       ↓
CI 自动创建 release v1.2.3（草稿）并上传未签名产物
       ↓
./scripts/release.sh v1.2.3
   ├─ 下载 CI 产物到 ./dist/
   ├─ 签名 macOS（钥匙串里有 Developer ID 时自动签）
   ├─ 签名 Windows（certs/agenttower.p12 + signtool 在 PATH 时自动签）
   ├─ 重新上传到 release（覆盖未签名版）
   ├─ 上传 latest.json
   └─ 标记 release 为 latest
```

签名在本地做（macOS 钥匙串里的 Developer ID 证书不能放到云端 CI），CI 只跑无签名的 `electron-builder --publish never`，把未签名产物上传到 release 等开发者本地签名后覆盖。

## 前置

- macOS 钥匙串里有 CNB token（`security add-internet-password -s cnb.cool -w <token>`，账号名固定为 `cnb`）；或在 `~/.zshrc` 里 `export CNB_TOKEN=...`。
- 钥匙串里有 Developer ID Application 证书（没证书也能跑，签名步骤会跳过，发布出去的 dmg 是未签名的）。
- Windows 代码签名：把 `agenttower.p12` 放到 `certs/`，`export AGENTTOWER_CERT_PASSWORD=...`，并确保 `signtool` 在 PATH（没配也能跑，签名步骤跳过）。
- API 请求**必须带** `Accept: application/json` 头，否则返回 errcode 406。
- 完整接口定义：<https://api.cnb.cool/swagger.json>。

## 发布步骤

### 1. 触发 CI 构建

```bash
# 先在 package.json 里把 version 改好
git add package.json
git commit -m "chore: bump version to 1.2.3"
git tag v1.2.3
git push origin main --follow-tags
```

push tag 后，`.cnb.yml` 里的 `tag_push` 触发器并行启动三个 pipeline：

- **build-mac**（macos-14）：`npx electron-builder --mac --arm64 --x64 --publish never`，产出 2 个 dmg + latest-mac.yml
- **build-win**（windows-2022）：`npx electron-builder --win --x64 --publish never`，产出 exe + latest.yml
- **build-linux**（ubuntu-latest）：`npx electron-builder --linux --publish never`，产出 AppImage + deb

每个 pipeline 用 `git:release`（`latest: false`，草稿态）创建 release，然后 `cnbcool/attachments` 上传自己平台的产物。三个 pipeline 都完成后，release 里就有了全平台未签名产物。

到 <https://cnb.cool/WeiGuangXunTu/AgentTower/-/builds> 等三个 pipeline 全绿。如果某个平台红了，先 fix 再重打 tag。

### 2. 跑发布脚本

```bash
./scripts/release.sh v1.2.3
```

脚本做的事（详见 `scripts/release.sh`）：

1. `GET /-/releases/tags/v1.2.3` 拿 RID
2. 遍历 release 的 assets 列表，逐个 `GET /-/releases/download/v1.2.3/<filename>` 下载到 `./dist/`
3. 签名 macOS dmg（自动检测钥匙串里有没有 Developer ID Application 证书）
4. 签名 Windows exe（如果 `certs/agenttower.p12` + signtool 都到位）
5. 准备 `./dist/latest.json`（基于 `release/latest.json` 模板，填新版本号/日期/下载链接）
6. 逐个上传到 release（带 `overwrite: true` 覆盖未签名版）
7. `PATCH /-/releases/$RID` 把 `make_latest` 设为 `"true"`
8. 打印最终 release 的资产清单

可选 flag：
- `--skip-sign`：跳过签名步骤，只下载 + 重传（适合调试或不需要签名的发布）
- `--from-local`：不下载 CI 产物，直接用 `./dist/` 下已签好的文件（适合手动下载场景）

### 3. 更新 README 下载区

打开 `README.md`，把「下载」区里三个链接的文件名版本号改成新版本（`1.2.3`）。

### 4. 验证应用内检查更新

启动 AgentTower → 菜单「检查更新」→ 应该拉取到 `<https://cnb.cool/.../-/releases/latest/download/latest.json>` 并提示新版本。如果提示「版本源请求失败」，说明 `latest.json` 没传或字段错了，重跑 release.sh。

## 为什么签名不在 CI 里

- macOS 钥匙串里的 Developer ID 证书不能放到云端 CI runner（安全要求 + Apple 政策），所以 CI 只跑无签名的 `electron-builder --publish never`，签名留在开发者本地（`scripts/release.sh` 第 3 步）做。
- Windows 的 `.pfx/.p12` 虽然可以 base64 编码塞进 CI 密钥，但因为签名是「先下载到本地再覆盖回 release」的设计，不如直接在本地一次签完更省时。

如果将来要给 CI 加签名（比如企业证书能放到专用 runner），最简单的扩展点：
- mac：在 `build-mac` pipeline 的 `build` 阶段前注入 `CSC_LINK` / `CSC_KEY_PASSWORD` 等环境变量
- win：在 `build-win` pipeline 同理

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
