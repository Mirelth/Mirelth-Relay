#!/usr/bin/env bash
# Wails 跨平台构建入口。macOS 上只能直接构建 darwin；
# linux/windows 需要对应平台的 runner 与 CGO 工具链（GTK/WebKit2GTK 或 MinGW）。
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
export PATH="$ROOT/.toolchain/go/bin:$ROOT/.toolchain/bin:$PATH"
export GOPROXY="${GOPROXY:-https://goproxy.cn,direct}"
export GOPATH="${GOPATH:-$ROOT/.toolchain/gopath}"
export GOMODCACHE="$GOPATH/pkg/mod"
export CGO_ENABLED=1

PLATFORM="${1:-$(go env GOOS)/$(go env GOARCH)}"

if [ ! -x "$ROOT/.toolchain/go/bin/go" ]; then
  echo "缺少本地 Go 工具链：$ROOT/.toolchain/go" >&2
  echo "请下载 https://go.dev/dl/ 对应平台的包并解压到该目录，或直接使用系统 Go + wails CLI。" >&2
  exit 1
fi
command -v wails >/dev/null || go install github.com/wailsapp/wails/v2/cmd/wails@v2.17.1

echo "==> 构建前端"
(cd frontend && npm install --registry="${NPM_REGISTRY:-https://registry.npmmirror.com}" && npm run build)

echo "==> wails build -platform $PLATFORM"
case "$PLATFORM" in
  darwin/*)
    wails build -platform "$PLATFORM" -o Relay
    ;;
  linux/*)
    echo "提示：Linux 构建需要 libgtk-3-dev libwebkit2gtk-4.1-dev；请在 Linux runner 上执行。"
    wails build -platform "$PLATFORM" -o relay
    ;;
  windows/*)
    echo "提示：Windows 构建需要 Windows runner 或 MinGW 交叉工具链；当前 macOS 无法直接产出。"
    wails build -platform "$PLATFORM" -o Relay.exe
    ;;
  *)
    echo "未知平台：$PLATFORM" >&2
    exit 1
    ;;
esac

echo "==> 产物：$ROOT/build/bin/"
ls -lh "$ROOT/build/bin/"
