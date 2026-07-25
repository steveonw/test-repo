#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
"$PROJECT_ROOT/scripts/build_launchers.sh"
"$PROJECT_ROOT/scripts/build_wasm.sh"
"$PROJECT_ROOT/scripts/assemble_usb.sh"
