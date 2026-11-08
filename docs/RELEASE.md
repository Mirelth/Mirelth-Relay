# 发布流程（Go + Wails）

Relay 现在只有一个运行时：根目录的 Go 程序 + `frontend/` 前端（Wails 打包进同一个可执行文件）。
Electron 打包链路已移除，历史上传的 `agent-tower-*` 安装包是旧产物，不再更新。

## 1. 本地构建

```bash
# macOS / Windows：用本机 Wails 工具链
./scripts/build-wails.sh

# 只要二进制、不要安装包
wails build -o relay
```

`scripts/build-wails.sh` 会先用 `frontend/` 的 npm 脚本构建前端，再调 `wails build`。
首次构建需要本机装有 Wails CLI（脚本会在缺省时 `go install wails@v2.17.1`）。

跨平台注意事项：

- **macOS**：只能在本机构建 darwin 产物；需要 Xcode Command Line Tools。
- **Windows**：需要 MinGW-w64 与 WebView2 SDK。
- **Linux**：需要 `libgtk-3-dev`、`libwebkit2gtk-4.1-dev`、`pkg-config`。

## 2. 版本号

版本号在两处，必须同步：

| 位置 | 字段 |
|---|---|
| 根 `config.go` | `appVersion` |
| `frontend/package.json` | `version` |

## 3. 产物与目录

`wails build` 默认输出到 `build/bin/`（已在 `.gitignore` 中忽略）。典型产物：

- macOS：`build/bin/relay.app`（可再打 dmg）
- Windows：`build/bin/relay.exe`
- Linux：`build/bin/relay`

## 4. 上传与 latest.json

应用内「检查更新」读取发行版的 `latest.json`（地址在 `config.go` 的 `defaultUpdateURL`，
可在设置里覆盖）。模板见 `release/latest.json`，字段：

```json
{
  "version": "1.4.0",
  "notes": "本次更新内容",
  "assets": {
    "darwin-arm64": "https://…/relay-1.4.0-arm64.dmg",
    "win-x64": "https://…/relay-1.4.0-setup.exe",
    "linux-x64": "https://…/relay-1.4.0.AppImage"
  }
}
```

上传步骤：

1. 打 tag 并推送（CI 的 `tag_push` 只在 Linux runner 上跑 `wails build` 验证编译）。
2. 本地产出 mac/win 产物（CI 没有对应 runner）。
3. 把三个平台的安装包与 `latest.json` 上传到发行版页面。

## 5. 发版检查清单

- [ ] `go vet ./...` 与 `go test ./...` 全绿
- [ ] `cd frontend && tsc --noEmit && vite build` 通过
- [ ] `config.go` 的 `appVersion` 与 `frontend/package.json` 的 `version` 一致
- [ ] `release/latest.json` 的 `version` / `assets` 已更新
- [ ] 三平台产物都能启动，且首次启动能完成一次扫描（仪表盘有数据）
- [ ] 网关页能启动、`/v1/models` 有返回

## 6. 签名

当前产物未做代码签名：

- macOS 首次打开如被拦截：右键 App → 打开，或 `xattr -cr /Applications/Relay.app`
- Windows SmartScreen：更多信息 → 仍要执行

需要正式签名时，在本地对 `build/bin/` 下的产物签名后再上传，签名证书不入库。
