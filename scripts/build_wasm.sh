#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="${READALOUD_WORK_DIR:-$PROJECT_ROOT/build/work}"
SHERPA_TAG="${SHERPA_TAG:-v1.13.4}"
VOICE_ID="${VOICE_ID:-vits-piper-en_US-amy-medium}"
VOICE_ID_SHORT="${VOICE_ID_SHORT:-${VOICE_ID##*en_US-}}"
VOICE_QUALITY="${VOICE_QUALITY:-${VOICE_ID_SHORT##*-}}"
VOICE_DISPLAY_NAME="${VOICE_DISPLAY_NAME:-Amy Medium}"
MODEL_FILENAME="${MODEL_FILENAME:-en_US-amy-medium.onnx}"
MODEL_URL="${MODEL_URL:-https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-amy-medium.tar.bz2}"
REPO_DIR="$WORK_DIR/sherpa-onnx"
MODEL_ARCHIVE="$WORK_DIR/${VOICE_ID}.tar.bz2"
OUTPUT_DIR="$PROJECT_ROOT/build/wasm"

for command in git curl tar emcc cmake python3; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'Missing required build command: %s\n' "$command" >&2
    exit 1
  fi
done

rm -rf "$REPO_DIR" "$OUTPUT_DIR"
mkdir -p "$WORK_DIR" "$OUTPUT_DIR"

printf 'Cloning sherpa-onnx %s...\n' "$SHERPA_TAG"
git clone --depth 1 --branch "$SHERPA_TAG" https://github.com/k2-fsa/sherpa-onnx.git "$REPO_DIR"

printf 'Downloading converted %s model...\n' "$VOICE_DISPLAY_NAME"
curl --fail --location --retry 4 --retry-delay 3 \
  --output "$MODEL_ARCHIVE" "$MODEL_URL"

MODEL_UNPACK="$WORK_DIR/model-unpack"
rm -rf "$MODEL_UNPACK"
mkdir -p "$MODEL_UNPACK"
tar -xjf "$MODEL_ARCHIVE" -C "$MODEL_UNPACK"

MODEL_FILE="$(find "$MODEL_UNPACK" -type f -name "$MODEL_FILENAME" -print -quit)"
TOKENS_FILE="$(find "$MODEL_UNPACK" -type f -name 'tokens.txt' -print -quit)"
ESPEAK_DIR="$(find "$MODEL_UNPACK" -type d -name 'espeak-ng-data' -print -quit)"

if [[ -z "$MODEL_FILE" || -z "$TOKENS_FILE" || -z "$ESPEAK_DIR" ]]; then
  printf 'The %s archive did not contain the expected model, tokens, and espeak-ng-data.\n' "$VOICE_DISPLAY_NAME" >&2
  exit 1
fi

ASSETS="$REPO_DIR/wasm/tts/assets"
find "$ASSETS" -mindepth 1 -maxdepth 1 ! -name README.md -exec rm -rf {} +
cp -R "$ESPEAK_DIR" "$ASSETS/espeak-ng-data"

# Package the voice for the portable voices/ folder instead of baking it.
VOICES_OUT="$PROJECT_ROOT/build/voices/$VOICE_ID_SHORT"
rm -rf "$VOICES_OUT"
mkdir -p "$VOICES_OUT"
cp "$MODEL_FILE" "$VOICES_OUT/model.onnx"
cp "$TOKENS_FILE" "$VOICES_OUT/tokens.txt"
cat > "$VOICES_OUT/voice.json" <<VJSON
{
  "schemaVersion": 1,
  "id": "$VOICE_ID_SHORT",
  "name": "$VOICE_DISPLAY_NAME",
  "language": "English",
  "locale": "en-US",
  "engine": "sherpa-vits",
  "architecture": "vits",
  "model": "model.onnx",
  "tokens": "tokens.txt",
  "quality": "$VOICE_QUALITY",
  "quantization": "none",
  "sampleRate": 22050,
  "minimumRuntimeVersion": "1"
}
VJSON

# Inference threading: the wasm glue is already built with -pthread and a
# worker pool, but sherpa's session config pins numThreads to 1. Patch the
# session to use READALOUD_TTS_THREADS (default 4) and grow the pthread pool
# to cover ONNX Runtime's intra-op workers. Set READALOUD_TTS_THREADS=1 to
# reproduce the previous single-threaded inference exactly.
TTS_THREADS="${READALOUD_TTS_THREADS:-4}"
if ! [[ "$TTS_THREADS" =~ ^[0-9]+$ ]] || (( TTS_THREADS < 1 || TTS_THREADS > 16 )); then
  printf 'READALOUD_TTS_THREADS must be 1-16, got %s\n' "$TTS_THREADS" >&2
  exit 1
fi
if (( TTS_THREADS > 1 )); then
  # Both the worker pool and the inference thread count adapt to the host
  # machine at runtime: a single-core PC runs exactly like the classic
  # single-threaded build (no ORT worker threads, minimal pool), while
  # multi-core machines use up to READALOUD_TTS_THREADS. Fixed sizes deadlock
  # pthread bootstrap on weak single-core hosts.
  # Python, not sed: the replacement contains '&', which sed treats as a
  # whole-match metacharacter and silently mangles.
  python3 - "$REPO_DIR/wasm/tts/CMakeLists.txt" "$REPO_DIR/wasm/tts/sherpa-onnx-tts.js" "$TTS_THREADS" <<'PYPATCH'
import sys
cmake_path, js_path, threads = sys.argv[1], sys.argv[2], int(sys.argv[3])

cmake = open(cmake_path).read()
old = "-sPTHREAD_POOL_SIZE=4"
assert cmake.count(old) == 1, "pool flag not found or not unique"
pool = f"'-sPTHREAD_POOL_SIZE=Math.min({threads + 4},((navigator&&navigator.hardwareConcurrency)||1)+2)'"
open(cmake_path, "w").write(cmake.replace(old, pool, 1))

js = open(js_path).read()
old = "numThreads: 1,"
assert js.count(old) == 1, "numThreads default not found or not unique"
new = f"numThreads: Math.min({threads}, (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 1),"
open(js_path, "w").write(js.replace(old, new, 1))
PYPATCH
  grep -q -- "-sPTHREAD_POOL_SIZE=Math.min" "$REPO_DIR/wasm/tts/CMakeLists.txt" || {
    printf 'Failed to patch the pthread pool size.\n' >&2; exit 1; }
  grep -q "numThreads: Math.min($TTS_THREADS," "$REPO_DIR/wasm/tts/sherpa-onnx-tts.js" || {
    printf 'Failed to patch the inference thread count.\n' >&2; exit 1; }
fi
sed -i 's/make -j2/make -j"$(nproc)"/' "$REPO_DIR/build-wasm-simd-tts.sh"

# Multi-voice build: the engine carries only voice-independent data (espeak),
# exports FS so voice files can be written at runtime, and sherpa's guard
# demanding a baked model is relaxed.
python3 - "$REPO_DIR/wasm/tts/CMakeLists.txt" <<'PYMV'
import sys
p = sys.argv[1]
s = open(p).read()
s = s.replace("message(FATAL_ERROR \"Please read", "message(STATUS \"Multi-voice build; see", 1)
old = "'addFunction','removeFunction']"
assert old in s, "exports anchor missing"
s = s.replace(old, "'addFunction','removeFunction','FS']", 1)
open(p, "w").write(s)
PYMV

printf 'Building SIMD WebAssembly TTS for %s (%s inference threads)...\n' "$VOICE_DISPLAY_NAME" "$TTS_THREADS"
(
  cd "$REPO_DIR"
  ./build-wasm-simd-tts.sh
)

GENERATED="$REPO_DIR/build-wasm-simd-tts/install/bin/wasm/tts"
if [[ ! -d "$GENERATED" ]]; then
  printf 'Sherpa build completed without the expected output directory: %s\n' "$GENERATED" >&2
  exit 1
fi

cp -R "$GENERATED"/. "$OUTPUT_DIR"/
cp "$PROJECT_ROOT/web/index.html" "$OUTPUT_DIR/index.html"
cp "$PROJECT_ROOT/web/app.js" "$OUTPUT_DIR/app.js"
cp "$PROJECT_ROOT/web/style.css" "$OUTPUT_DIR/style.css"
cp "$PROJECT_ROOT/web/mp3-worker.js" "$OUTPUT_DIR/mp3-worker.js"
cp "$PROJECT_ROOT/web/sherpa-onnx-tts.worker.js" "$OUTPUT_DIR/sherpa-onnx-tts.worker.js"
cp "$PROJECT_ROOT/web/make-voice.html" "$OUTPUT_DIR/make-voice.html"
cp "$PROJECT_ROOT/web/make-voice.js" "$OUTPUT_DIR/make-voice.js"
cp -R "$PROJECT_ROOT/web/vendor" "$OUTPUT_DIR/vendor"
if [[ -d "$PROJECT_ROOT/web/fonts" ]]; then
  cp -R "$PROJECT_ROOT/web/fonts" "$OUTPUT_DIR/fonts"
fi

for required in index.html app.js style.css sherpa-onnx-tts.js sherpa-onnx-tts.worker.js; do
  if [[ ! -f "$OUTPUT_DIR/$required" ]]; then
    printf 'Missing generated file: %s\n' "$required" >&2
    exit 1
  fi
done

if ! compgen -G "$OUTPUT_DIR/*.wasm" >/dev/null; then
  printf 'No .wasm file was generated.\n' >&2
  exit 1
fi
if ! compgen -G "$OUTPUT_DIR/*.data" >/dev/null; then
  printf 'No Emscripten .data package was generated.\n' >&2
  exit 1
fi

cat > "$OUTPUT_DIR/VOICE-EDITION.txt" <<META
Voice edition: $VOICE_DISPLAY_NAME
Sherpa model ID: $VOICE_ID
Model filename: $MODEL_FILENAME
Model source: $MODEL_URL
Sherpa tag: $SHERPA_TAG
Inference threads: $TTS_THREADS
META

printf 'WASM application written to %s\n' "$OUTPUT_DIR"
