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
codesign --force --deep --sign - "$APP_DIR"

echo "$APP_DIR"
