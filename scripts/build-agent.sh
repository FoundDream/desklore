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
swift build -c release --product ComputerHistoryAgent
BIN_DIR="$(swift build -c release --show-bin-path)"

if [[ ! -x "$BIN_DIR/ComputerHistoryAgent" ]]; then
  echo "Missing release executable: $BIN_DIR/ComputerHistoryAgent" >&2
  exit 1
fi

APP_DIR="$PROJECT_ROOT/dist/Computer History Agent.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"

mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"
install -m 755 "$BIN_DIR/ComputerHistoryAgent" "$MACOS_DIR/ComputerHistoryAgent"
install -m 644 "$PROJECT_ROOT/Resources/Info.plist" "$CONTENTS_DIR/Info.plist"

# Keep the former Swift app identifier so existing local Accessibility grants
# can follow the native collector across the Electron migration.
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
