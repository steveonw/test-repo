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

if [[ ! -f "$SOURCE" ]]; then
  printf 'Read Aloud is incomplete: %s is missing.\n' "$SOURCE" >&2
  read -r -p 'Press Enter to close.' _ || true
  exit 1
fi

mkdir -p "$CACHE_ROOT"
SOURCE_HASH="$(sha256sum "$SOURCE" | awk '{print $1}')"
LOCAL_SERVER="$CACHE_ROOT/readaloud-server-${ARCH}-${SOURCE_HASH:0:16}"

# A running executable cannot safely be overwritten on Linux (ETXTBSY).
# Content-addressed filenames let an identical second launch reuse the cached
# copy, while a new build receives a new path. Populate new cache entries via
# a temporary file so concurrent launches never see a partial executable.
if [[ ! -x "$LOCAL_SERVER" ]]; then
  TEMP_SERVER="$(mktemp "$CACHE_ROOT/.readaloud-server.XXXXXX")"
  trap 'rm -f "$TEMP_SERVER"' EXIT
  cp "$SOURCE" "$TEMP_SERVER"
  chmod 700 "$TEMP_SERVER"
  mv -f "$TEMP_SERVER" "$LOCAL_SERVER"
  trap - EXIT
fi

exec "$LOCAL_SERVER" --shared "$SHARED"
