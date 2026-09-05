#!/usr/bin/env bash
# scripts/release.sh — 把 CI 打包的产物下载、签名、再上传到正式 release
#
# 用法：
#   ./scripts/release.sh v1.2.3                   # 下载 + 签名 + 重传 + 标 latest
#   ./scripts/release.sh v1.2.3 --skip-sign       # 下载 + 重传（不签名）
#   ./scripts/release.sh v1.2.3 --from-local      # 不下载，直接用 ./dist/ 下已签好的文件
#
# 完整流程：
#   1) git tag v1.2.3 && git push --tags        → CNB CI 跑三平台构建
#   2) CI 自动把未签名产物上传到 release/v1.2.3/（带 description=CI 草稿）
#   3) ./scripts/release.sh v1.2.3              → 下载→签名→重传→latest.json→标记 latest
#
# 签名：
#   - macOS：自动检测钥匙串里的 Developer ID 证书并签名 dmg（codesign --deep --force --options runtime）
#   - Windows：如果 certs/agenttower.p12 存在且设置 AGENTTOWER_CERT_PASSWORD，则用 signtool 签名
#   - Linux：未配置（按需扩展 GPG 签名）

set -euo pipefail

TAG="${1:-}"
shift || true
SKIP_SIGN=0
FROM_LOCAL=0
for arg in "$@"; do
  case "$arg" in
    --skip-sign) SKIP_SIGN=1 ;;
    --from-local) FROM_LOCAL=1 ;;
    *) echo "未知参数: $arg" >&2; exit 1 ;;
  esac
done

if [[ -z "$TAG" ]]; then
  echo "用法: $0 <tag> [--skip-sign] [--from-local]" >&2
  exit 1
fi

API="https://api.cnb.cool/WeiGuangXunTu/AgentTower"
DIST_DIR="$(cd "$(dirname "$0")/.." && pwd)/dist"
VERSION="${TAG#v}"

TOKEN="${CNB_TOKEN:-$(security find-internet-password -s cnb.cool -w 2>/dev/null || true)}"
if [[ -z "$TOKEN" ]]; then
  echo "未找到 CNB TOKEN：先 security add-internet-password -s cnb.cool -w <token>，或 export CNB_TOKEN=..." >&2
  exit 1
fi

API_AUTH=(-u "cnb:$TOKEN" -H "Accept: application/json")

# ---------- 1) 找到 release ----------
echo "→ 查 release $TAG"
RELEASE_JSON=$(curl -fsS "${API_AUTH[@]}" "$API/-/releases/tags/$TAG")
RID=$(echo "$RELEASE_JSON" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "  RID=$RID"

# ---------- 2) 准备 dist/ ----------
mkdir -p "$DIST_DIR"

if [[ $FROM_LOCAL -eq 0 ]]; then
  echo "→ 下载 CI 产物到 $DIST_DIR"
  # 列出所有资产
  ASSETS=$(echo "$RELEASE_JSON" | python3 -c "
import json,sys
d = json.load(sys.stdin)
for a in d.get('assets', []):
    print(a['name'])
")
  for name in $ASSETS; do
    # latest.json 不下载（要本地用模板生成新的）
    if [[ "$name" == "latest.json" ]]; then continue; fi
    echo "  ↓ $name"
    curl -fsS -o "$DIST_DIR/$name" "$API/-/releases/download/$TAG/$name"
  done
else
  echo "→ --from-local：跳过下载，用 $DIST_DIR 现有文件"
fi

# ---------- 3) 签名（macOS） ----------
if [[ $SKIP_SIGN -eq 0 ]] && [[ "$(uname)" == "Darwin" ]]; then
  echo "→ 签名 macOS dmg（如钥匙串里有 Developer ID 证书）"
  if security find-identity -p codesigning | grep -q "Developer ID Application"; then
    for dmg in "$DIST_DIR"/*.dmg; do
      [[ -f "$dmg" ]] || continue
      echo "  codesign --force --options runtime --deep --sign \"Developer ID Application\" $dmg"
      codesign --force --options runtime --deep --sign "Developer ID Application" "$dmg"
    done
  else
    echo "  钥匙串里没找到 Developer ID 证书，跳过签名（产出会以未签名状态上传）"
  fi
fi

# ---------- 4) 签名（Windows） ----------
if [[ $SKIP_SIGN -eq 0 ]] && [[ -f "$(dirname "$0")/../certs/agenttower.p12" ]]; then
  echo "→ 签名 Windows exe（如 signtool 可用）"
  if command -v signtool >/dev/null 2>&1; then
    : "${AGENTTOWER_CERT_PASSWORD:?需要 export AGENTTOWER_CERT_PASSWORD}"
    for exe in "$DIST_DIR"/*-setup.exe; do
      [[ -f "$exe" ]] || continue
      echo "  signtool sign /f certs/agenttower.p12 /p \$AGENTTOWER_CERT_PASSWORD $exe"
      signtool sign /f "$(dirname "$0")/../certs/agenttower.p12" /p "$AGENTTOWER_CERT_PASSWORD" "$exe"
    done
  else
    echo "  signtool 不在 PATH，跳过签名"
  fi
fi

# ---------- 5) 准备 latest.json ----------
echo "→ 准备 latest.json"
TEMPLATE="$(cd "$(dirname "$0")/.." && pwd)/release/latest.json"
if [[ -f "$TEMPLATE" ]]; then
  # 复制模板，按本 tag 改字段
  python3 -c "
import json
d = json.load(open('$TEMPLATE'))
d['version'] = '$VERSION'
d['publishedAt'] = '$(date +%Y-%m-%d)'
d['downloads'] = {
  'macArm':   'https://cnb.cool/WeiGuangXunTu/AgentTower/-/releases/download/$TAG/agent-tower-$VERSION-arm64.dmg',
  'macIntel': 'https://cnb.cool/WeiGuangXunTu/AgentTower/-/releases/download/$TAG/agent-tower-$VERSION-x64.dmg',
  'win':      'https://cnb.cool/WeiGuangXunTu/AgentTower/-/releases/download/$TAG/agent-tower-$VERSION-setup.exe',
}
json.dump(d, open('$DIST_DIR/latest.json', 'w'), ensure_ascii=False, indent=2)
print(f'  字段：version={d[\"version\"]}  publishedAt={d[\"publishedAt\"]}')
"
else
  echo "  找不到模板 $TEMPLATE，跳过 latest.json 上传" >&2
fi

# ---------- 6) 重传所有文件（覆盖） ----------
echo "→ 重传文件到 release"
upload_file() {
  local f="$1"
  local name=$(basename "$f")
  local sz=$(stat -f%z "$f")
  echo "  ↑ $name ($sz bytes)"
  local url_json
  url_json=$(curl -fsS "${API_AUTH[@]}" -H "Content-Type: application/json" \
    -d "{\"asset_name\":\"$name\",\"size\":$sz,\"ttl\":0,\"overwrite\":true}" \
    "$API/-/releases/$RID/asset-upload-url")
  local upload_url verify_url
  upload_url=$(echo "$url_json" | python3 -c "import json,sys;print(json.load(sys.stdin)['upload_url'])")
  verify_url=$(echo "$url_json" | python3 -c "import json,sys;print(json.load(sys.stdin)['verify_url'])")
  curl -fsS -T "$f" "$upload_url" > /dev/null
  curl -fsS "${API_AUTH[@]}" -X POST "$verify_url" > /dev/null
}

# 只上传本版本的文件（避免把旧版本产物也传上去）
for f in "$DIST_DIR"/*-$VERSION* "$DIST_DIR"/*_$VERSION*; do
  [[ -f "$f" ]] || continue
  upload_file "$f"
done
[[ -f "$DIST_DIR/latest.json" ]] && upload_file "$DIST_DIR/latest.json"

# ---------- 7) 标记为 latest ----------
echo "→ 标记 release 为 latest"
curl -fsS "${API_AUTH[@]}" -X PATCH -H "Content-Type: application/json" \
  -d '{"make_latest":"true"}' \
  "$API/-/releases/$RID" > /dev/null

# ---------- 8) 验证 ----------
echo "→ 验证 release"
curl -fsS "${API_AUTH[@]}" "$API/-/releases/tags/$TAG" | python3 -c "
import json,sys
d = json.load(sys.stdin)
print(f'  name: {d[\"name\"]}')
print(f'  tag:  {d[\"tag_name\"]}')
print(f'  latest: {d.get(\"make_latest\", \"?\")}')
print(f'  assets: {len(d.get(\"assets\", []))}')
for a in d.get('assets', []):
    print(f'    - {a[\"name\"]}  ({a[\"size\"]} bytes)')
"

echo "✅ 完成：https://cnb.cool/WeiGuangXunTu/AgentTower/-/releases/tag/$TAG"
