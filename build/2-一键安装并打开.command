#!/bin/bash
set -euo pipefail

APP_NAME="Diga Agent.app"
TARGET_APP="/Applications/${APP_NAME}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_APP="${SCRIPT_DIR}/${APP_NAME}"

if [ ! -d "$SOURCE_APP" ]; then
  osascript -e 'display dialog "没有在当前 DMG 里找到 Diga Agent.app。请从打开的 Diga Agent DMG 里运行这个脚本。" buttons {"OK"} default button "OK" with icon caution'
  exit 1
fi

osascript -e 'display dialog "Diga Agent 当前未做 Apple 开发者签名。这个脚本会把 App 安装到 Applications，并移除 macOS quarantine 标记，避免出现“已损坏，无法打开”。" buttons {"取消", "继续安装"} default button "继续安装" cancel button "取消" with icon note'

osascript -e 'display notification "正在安装 Diga Agent 到 Applications..." with title "Diga Agent"'

if [ -d "$TARGET_APP" ]; then
  rm -rf "$TARGET_APP"
fi

/usr/bin/ditto "$SOURCE_APP" "$TARGET_APP"
/usr/bin/xattr -dr com.apple.quarantine "$TARGET_APP" 2>/dev/null || true
/usr/bin/xattr -dr com.apple.quarantine "$SOURCE_APP" 2>/dev/null || true

/usr/bin/open "$TARGET_APP"

