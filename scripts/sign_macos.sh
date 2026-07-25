#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  printf 'Usage: %s "Developer ID Application: Name (TEAMID)" path/to/ReadAloudUSB\n' "$0" >&2
  exit 2
fi

IDENTITY="$1"
USB_ROOT="$2"
APP="$USB_ROOT/START - MACOS.app"

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf 'Mac signing must be performed on macOS.\n' >&2
  exit 1
fi

codesign --force --options runtime --timestamp --sign "$IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

cat <<'TEXT'
The app is signed. To notarize, create a ZIP with ditto, submit it with
`xcrun notarytool submit`, wait for acceptance, then run `xcrun stapler staple`.
Apple credentials are intentionally not stored in this project.
TEXT
