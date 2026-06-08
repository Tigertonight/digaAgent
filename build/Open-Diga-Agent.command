#!/bin/bash
set -euo pipefail

APP_PATH="/Applications/Diga Agent.app"

if [ ! -d "$APP_PATH" ]; then
  osascript -e 'display dialog "Please drag Diga Agent.app to the Applications folder first, then run this helper again." buttons {"OK"} default button "OK" with icon caution'
  exit 1
fi

xattr -dr com.apple.quarantine "$APP_PATH" 2>/dev/null || true
open "$APP_PATH"

