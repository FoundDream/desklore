#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
EXPECTED_ROOT="/Users/ziwen/code/computer-history"

if [[ "$PROJECT_ROOT" != "$EXPECTED_ROOT" ]]; then
  echo "Refusing to package from unexpected project root: $PROJECT_ROOT" >&2
  exit 1
fi

cd "$PROJECT_ROOT"
swift build -c release --product ComputerHistoryApp
BIN_DIR="$(swift build -c release --show-bin-path)"

if [[ ! -x "$BIN_DIR/ComputerHistoryApp" ]]; then
  echo "Missing release executable: $BIN_DIR/ComputerHistoryApp" >&2
  exit 1
fi

APP_DIR="$PROJECT_ROOT/dist/Computer History.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"

mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"
install -m 755 "$BIN_DIR/ComputerHistoryApp" "$MACOS_DIR/ComputerHistoryApp"
install -m 644 "$PROJECT_ROOT/Resources/Info.plist" "$CONTENTS_DIR/Info.plist"

# Accessibility and Screen Recording permissions are bound to the app's code
# requirement. A default ad-hoc signature reduces that requirement to a changing
# CDHash, so every rebuilt binary looks like a different app to TCC. An explicit
# identifier requirement keeps local development builds stable across updates.
SIGNING_IDENTITY="${COMPUTER_HISTORY_CODESIGN_IDENTITY:-}"
if [[ -n "$SIGNING_IDENTITY" ]]; then
  codesign --force --deep --options runtime --timestamp=none \
    --sign "$SIGNING_IDENTITY" "$APP_DIR"
else
  codesign --force --deep --sign - \
    --identifier com.ziwen.computer-history \
    --requirements '=designated => identifier "com.ziwen.computer-history"' \
    "$APP_DIR"
fi

echo "$APP_DIR"
