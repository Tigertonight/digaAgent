#!/bin/bash
set -euo pipefail

APP_NAME="Diga Agent.app"
TARGET_APP="/Applications/${APP_NAME}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_APP="${SCRIPT_DIR}/${APP_NAME}"

if [ ! -d "$SOURCE_APP" ]; then
  osascript -e 'display dialog "Cannot find Diga Agent.app next to this helper. Please run this command from the mounted Diga Agent DMG." buttons {"OK"} default button "OK" with icon caution'
  exit 1
fi

osascript -e 'display notification "Installing Diga Agent into Applications..." with title "Diga Agent"'

if [ -d "$TARGET_APP" ]; then
  rm -rf "$TARGET_APP"
fi

/usr/bin/ditto "$SOURCE_APP" "$TARGET_APP"
/usr/bin/xattr -dr com.apple.quarantine "$TARGET_APP" 2>/dev/null || true
/usr/bin/xattr -dr com.apple.quarantine "$SOURCE_APP" 2>/dev/null || true

/usr/bin/open "$TARGET_APP"
