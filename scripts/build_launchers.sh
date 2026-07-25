#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$PROJECT_ROOT/build/launchers"
mkdir -p "$BUILD_DIR"

VERSION="${READALOUD_VERSION:-0.1.0}"
BASE_LDFLAGS="-s -w -X main.buildVersion=$VERSION"

printf 'Building Windows x64 launcher...\n'
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 \
  go build -trimpath -buildvcs=false -ldflags "$BASE_LDFLAGS -H=windowsgui" \
  -o "$BUILD_DIR/readaloud-windows-x64.exe" "$PROJECT_ROOT/cmd/launcher"

printf 'Building Linux x64 launcher...\n'
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
  go build -trimpath -buildvcs=false -ldflags "$BASE_LDFLAGS" -o "$BUILD_DIR/readaloud-linux-x64" "$PROJECT_ROOT/cmd/launcher"
chmod +x "$BUILD_DIR/readaloud-linux-x64"

printf 'Building Linux arm64 launcher...\n'
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 \
  go build -trimpath -buildvcs=false -ldflags "$BASE_LDFLAGS" -o "$BUILD_DIR/readaloud-linux-arm64" "$PROJECT_ROOT/cmd/launcher"
chmod +x "$BUILD_DIR/readaloud-linux-arm64"

printf 'Building macOS x64 launcher...\n'
CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 \
  go build -trimpath -buildvcs=false -ldflags "$BASE_LDFLAGS" -o "$BUILD_DIR/readaloud-macos-x64" "$PROJECT_ROOT/cmd/launcher"

printf 'Building macOS arm64 launcher...\n'
CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 \
  go build -trimpath -buildvcs=false -ldflags "$BASE_LDFLAGS" -o "$BUILD_DIR/readaloud-macos-arm64" "$PROJECT_ROOT/cmd/launcher"

printf 'Creating universal macOS launcher...\n'
python3 "$PROJECT_ROOT/scripts/make_fat_macho.py" \
  --x86_64 "$BUILD_DIR/readaloud-macos-x64" \
  --arm64 "$BUILD_DIR/readaloud-macos-arm64" \
  --output "$BUILD_DIR/readaloud-macos-universal"

printf 'Launchers written to %s\n' "$BUILD_DIR"
