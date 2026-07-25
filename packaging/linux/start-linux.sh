#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ARCH="$(uname -m)"
case "$ARCH" in
  aarch64|arm64) SOURCE="$SCRIPT_DIR/platform/linux/readaloud-server-arm64" ;;
  *)             SOURCE="$SCRIPT_DIR/platform/linux/readaloud-server" ;;
esac
SHARED="$SCRIPT_DIR/shared"
CACHE_ROOT="${XDG_CACHE_HOME:-$HOME/.cache}/readaloud-portable"
LOCAL_SERVER="$CACHE_ROOT/readaloud-server"

if [[ ! -f "$SOURCE" ]]; then
  printf 'Read Aloud is incomplete: %s is missing.\n' "$SOURCE" >&2
  read -r -p 'Press Enter to close.' _ || true
  exit 1
fi

mkdir -p "$CACHE_ROOT"
cp "$SOURCE" "$LOCAL_SERVER"
chmod 700 "$LOCAL_SERVER"

exec "$LOCAL_SERVER" --shared "$SHARED"
