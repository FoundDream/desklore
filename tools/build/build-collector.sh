#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
GIT_TOP_LEVEL="$(git -C "$PROJECT_ROOT" rev-parse --path-format=absolute --show-toplevel)"
NATIVE_ROOT="$PROJECT_ROOT/native/collector"

if [[ "$PROJECT_ROOT" != "$GIT_TOP_LEVEL" ]]; then
  echo "Refusing to package outside the DeskLore repository: $PROJECT_ROOT" >&2
  exit 1
fi

cd "$PROJECT_ROOT"
swift build --package-path "$NATIVE_ROOT" -c release --product DeskLoreCollector
BIN_DIR="$(swift build --package-path "$NATIVE_ROOT" -c release --show-bin-path)"

if [[ ! -x "$BIN_DIR/DeskLoreCollector" ]]; then
  echo "Missing release executable: $BIN_DIR/DeskLoreCollector" >&2
  exit 1
fi

APP_DIR="$PROJECT_ROOT/dist/DeskLore Collector.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"

mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"
install -m 755 "$BIN_DIR/DeskLoreCollector" "$MACOS_DIR/DeskLoreCollector"
install -m 644 "$NATIVE_ROOT/Resources/Info.plist" "$CONTENTS_DIR/Info.plist"
install -m 644 "$PROJECT_ROOT/resources/branding/icon.icns" "$RESOURCES_DIR/icon.icns"

SIGNING_IDENTITY="${DESKLORE_CODESIGN_IDENTITY:-}"
if [[ -n "$SIGNING_IDENTITY" ]]; then
  codesign --force --deep --options runtime --timestamp=none \
    --sign "$SIGNING_IDENTITY" "$APP_DIR"
else
  codesign --force --deep --sign - \
    --identifier com.desklore.collector \
    --requirements '=designated => identifier "com.desklore.collector"' \
    "$APP_DIR"
fi

echo "$APP_DIR"
