#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
GIT_TOP_LEVEL="$(git -C "$PROJECT_ROOT" rev-parse --path-format=absolute --show-toplevel)"

if [[ "$PROJECT_ROOT" != "$GIT_TOP_LEVEL" ]]; then
  echo "Refusing to package outside the Computer History repository: $PROJECT_ROOT" >&2
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

SIGNING_IDENTITY="${COMPUTER_HISTORY_CODESIGN_IDENTITY:-}"
if [[ -n "$SIGNING_IDENTITY" ]]; then
  codesign --force --deep --options runtime --timestamp=none \
    --sign "$SIGNING_IDENTITY" "$APP_DIR"
else
  codesign --force --deep --sign - \
    --identifier com.ziwen.computer-history.desktop.agent \
    --requirements '=designated => identifier "com.ziwen.computer-history.desktop.agent"' \
    "$APP_DIR"
fi

echo "$APP_DIR"
