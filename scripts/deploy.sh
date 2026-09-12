#!/bin/bash
# Deploy built app.asar to installed AgentTower location
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TARGET="/Users/new/AgentTowerTest/AgentTower.app/Contents/Resources/app.asar"
SOURCE="$PROJECT_DIR/dist/mac-arm64/AgentTower.app/Contents/Resources/app.asar"

if [ ! -f "$SOURCE" ]; then
  echo "Error: $SOURCE not found. Run 'npm run build' first."
  exit 1
fi

if [ ! -f "$TARGET" ]; then
  echo "Error: Target app not found at $TARGET"
  exit 1
fi

cp "$SOURCE" "$TARGET"
echo "Deployed: $SOURCE -> $TARGET"
echo "Please restart AgentTower to see changes."
