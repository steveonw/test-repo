#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
WASM_DIR="$PROJECT_ROOT/build/wasm"
LAUNCHERS="$PROJECT_ROOT/build/launchers"
BUNDLE_NAME="${READALOUD_BUNDLE_NAME:-ReadAloudUSB}"
OUTPUT_ROOT="$PROJECT_ROOT/dist/$BUNDLE_NAME"

if [[ ! -d "$WASM_DIR" ]]; then
  printf 'Missing WASM build. Run scripts/build_wasm.sh first.\n' >&2
  exit 1
fi
if [[ ! -d "$LAUNCHERS" ]]; then
  printf 'Missing launchers. Run scripts/build_launchers.sh first.\n' >&2
  exit 1
fi

rm -rf "$OUTPUT_ROOT"
mkdir -p \
  "$OUTPUT_ROOT/shared" \
  "$OUTPUT_ROOT/platform/linux" \
  "$OUTPUT_ROOT/START - MACOS.app/Contents/MacOS" \
  "$OUTPUT_ROOT/START - MACOS.app/Contents/Resources" \
  "$OUTPUT_ROOT/LICENSES"

cp -R "$WASM_DIR"/. "$OUTPUT_ROOT/shared"/

if [[ -d "$PROJECT_ROOT/build/voices" ]]; then
  cp -R "$PROJECT_ROOT/build/voices" "$OUTPUT_ROOT/voices"
fi
cp "$PROJECT_ROOT/web/start-here.html" "$OUTPUT_ROOT/START HERE.html"
cp "$PROJECT_ROOT/web/manual.html" "$OUTPUT_ROOT/HOW TO USE.html"
cp "$PROJECT_ROOT/LICENSES/NOTICE.txt" "$OUTPUT_ROOT/LICENSES/NOTICE.txt"

# Optional docx-import addon (spec 3.6): opt-in, off by default. The feature
# exists on a drive only if addons/docx/ does; the base build ships without it.
if [ "${INCLUDE_DOCX:-0}" = "1" ]; then
  MAMMOTH_VERSION="1.8.0"
  mkdir -p "$OUTPUT_ROOT/addons/docx"
  curl -fsSL --retry 3 --retry-all-errors \
    "https://unpkg.com/mammoth@${MAMMOTH_VERSION}/mammoth.browser.min.js" \
    -o "$OUTPUT_ROOT/addons/docx/mammoth.browser.min.js"
  curl -fsSL --retry 3 --retry-all-errors \
    "https://unpkg.com/mammoth@${MAMMOTH_VERSION}/LICENSE" \
    -o "$OUTPUT_ROOT/addons/docx/LICENSE.txt"
  {
    echo ""
    echo "addons/docx: mammoth.js ${MAMMOTH_VERSION} (BSD-2-Clause)"
    echo "  https://github.com/mwilliamson/mammoth.js — license in addons/docx/LICENSE.txt"
  } >> "$OUTPUT_ROOT/LICENSES/NOTICE.txt"
  echo "docx addon included (mammoth ${MAMMOTH_VERSION})"
fi
cp "$LAUNCHERS/readaloud-windows-x64.exe" "$OUTPUT_ROOT/START - WINDOWS.exe"
cp "$LAUNCHERS/readaloud-linux-x64" "$OUTPUT_ROOT/platform/linux/readaloud-server"
cp "$LAUNCHERS/readaloud-linux-arm64" "$OUTPUT_ROOT/platform/linux/readaloud-server-arm64"
cp "$LAUNCHERS/readaloud-macos-universal" "$OUTPUT_ROOT/START - MACOS.app/Contents/MacOS/readaloud"
cp "$PROJECT_ROOT/packaging/macos/Info.plist" "$OUTPUT_ROOT/START - MACOS.app/Contents/Info.plist"
cp "$PROJECT_ROOT/packaging/linux/start-linux.sh" "$OUTPUT_ROOT/START - LINUX.sh"
cp "$PROJECT_ROOT/README-USB.txt" "$OUTPUT_ROOT/README.txt"

chmod +x \
  "$OUTPUT_ROOT/START - LINUX.sh" \
  "$OUTPUT_ROOT/platform/linux/readaloud-server" \
  "$OUTPUT_ROOT/platform/linux/readaloud-server-arm64" \
  "$OUTPUT_ROOT/START - MACOS.app/Contents/MacOS/readaloud"

(
  cd "$OUTPUT_ROOT"
  find . -type f ! -name SHA256SUMS.txt -print0 \
    | sort -z \
    | xargs -0 sha256sum > SHA256SUMS.txt
)

rm -f "$PROJECT_ROOT/dist/$BUNDLE_NAME.zip"
(
  cd "$PROJECT_ROOT/dist"
  zip -q -r -9 "$BUNDLE_NAME.zip" "$BUNDLE_NAME"
)

printf 'USB folder: %s\n' "$OUTPUT_ROOT"
printf 'ZIP archive: %s\n' "$PROJECT_ROOT/dist/$BUNDLE_NAME.zip"
