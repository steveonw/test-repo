# Read Aloud Portable Builder

This project builds one USB-ready folder for Windows x64, macOS Intel/Apple
Silicon, and Linux x64. The three operating systems use small native launchers;
the large browser application, Sherpa WebAssembly engine, and converted Piper
`en_US-amy-medium` voice are shared once.

## What is already included

- A pure-Go loopback server/launcher.
- Cross-build scripts for Windows, Linux, macOS x64, and macOS arm64.
- A universal macOS Mach-O packer, so the Mac app contains both architectures.
- A proofreading UI: paste text, press **F8**, and listen continuously from
  the cursor with follow-along sentence highlighting. The next sentence is
  synthesized while the current one plays, so reading has no gaps. Selecting
  text reads only the selection.
- Proofreading aids: an adjustable pause between spoken sentences (also used
  as the WAV export gap), writing checks that count repeated words, double
  spaces, and doubled punctuation, live document stats (word and sentence
  counts, average sentence length, approximate reading grade), and text size
  and line spacing controls.
- Step mode, sentence replay (F7), and flag-while-listening (F9/F10): a
  clickable flag panel with context snippets, dotted markers behind the text,
  and anchors that follow sentences through edits and moves (an exportable
  report included), and a focus mode that dims all but the spoken sentence.
- Writing-check underlines drawn behind the text, plus unbalanced bracket and
  unmatched quote counts.
- A portable settings string (and optional settings.txt auto-loaded from the
  drive) covering pacing, display, theme, and a pronunciation dictionary that
  changes only how words are spoken; session files bundle draft, flags, and
  settings. A bundled Atkinson Hyperlegible font option and a light/dark/auto
  theme toggle round out accessibility.
- Two model families, one engine: Piper VITS packages (model + tokens) and
  KittenTTS packages (model + tokens + voices.bin, several speakers per file)
  both run on the same shared runtime, and can be switched between live. The
  voice maker sniffs a downloaded model's family automatically so a package
  cannot be mislabelled.
- One portable application, many voices: compatible voice packages live in a
  voices/ folder next to shared/, are validated by the launcher, and appear in
  a dropdown. Switching voices reloads a fresh engine worker; audio caches are
  strictly per-voice. Installing a new voice means copying one folder onto the
  drive — nothing is compiled, and the shared engine is never rebuilt.
- Reliability hardening: the page keeps the launcher alive while open and
  warns clearly if the drive disappears mid-session; corrupted bundle files
  are detected at launch and explained in plain language; very large drafts
  keep typing responsive. Three committed test layers (logic, stress, and
  real-browser) run in CI before and after every build.
- Threaded synthesis: the WASM engine adapts its inference threads to the
  host machine at runtime (up to 4 on multi-core computers, exactly the
  classic single-threaded behavior on one core), cutting latency on long
  sentences. The builder's `tts_threads` input (or `READALOUD_TTS_THREADS=1`)
  restores a fully single-threaded build.
- Narration export: render the whole draft, then export one WAV file with
  natural sentence and paragraph pauses, or a compact MP3 encoded on-device,
  optionally with an Audacity label track of sentence timings. Each rendered sentence is cached by
  its exact text, so after edits, **Render / Update** re-records only the
  sentences that changed.
- A Linux wrapper that copies the small native launcher to `~/.cache` before
  running, avoiding common exFAT/no-execute issues.
- A GitHub Actions builder that downloads the official converted Amy model,
  builds Sherpa WASM, and uploads the finished USB ZIP.

## Fastest build: GitHub Actions

1. Put this project in a GitHub repository.
2. Open **Actions**.
3. Run **Build Read Aloud USB**.
4. Download the `ReadAloudUSB` artifact.
5. Extract `ReadAloudUSB.zip` and copy the folder to an exFAT USB drive.

The build uses internet access, but the finished app does not.

## Local build

Requirements:

- Git
- Go 1.22+
- Python 3
- CMake and a build tool
- Emscripten SDK (`emcc` available in `PATH`)
- curl, tar, bzip2, and zip

Then run:

```bash
./scripts/build_all.sh
```

Output:

```text
dist/ReadAloudUSB/
dist/ReadAloudUSB.zip
```

## Resulting USB layout

```text
ReadAloudUSB/
├── START HERE.html
├── START - WINDOWS.exe
├── START - MACOS.app
├── START - LINUX.sh
├── shared/
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   ├── sherpa-onnx-tts.js
│   ├── sherpa-onnx-tts.worker.js
│   ├── *.wasm
│   └── *.data
├── platform/linux/readaloud-server
├── LICENSES/
├── README.txt
└── SHA256SUMS.txt
```

## macOS signing

The builder creates a functional universal `.app`, but it cannot use your Apple
Developer identity automatically. For smooth distribution to nontechnical Mac
users, sign, notarize, and staple the app on a Mac. A helper is provided:

```bash
./scripts/sign_macos.sh \
  "Developer ID Application: Your Name (TEAMID)" \
  dist/ReadAloudUSB
```

Then submit a ZIP of the app with Apple's `notarytool` and staple the accepted
ticket. A private unsigned build can instead use macOS's one-time **Open
Anyway** approval.

## Reproducibility controls

Defaults are pinned in `scripts/build_wasm.sh`:

- Sherpa tag: `v1.13.4`
- Voice: official Sherpa-converted `vits-piper-en_US-amy-medium`

Override them only deliberately:

```bash
SHERPA_TAG=v1.13.4 AMY_MODEL_URL=https://... ./scripts/build_all.sh
```

## Runtime privacy

The launcher binds only to `127.0.0.1`. The browser loads local files from that
loopback server. Text is passed only to the in-page WASM worker, and rendered
audio is held in this tab's memory; a WAV file is written only when the user
chooses Export.

## Switching between voice editions

This edition uses its own localhost origin (`127.0.0.1:17391`) and revalidates browser assets before use. This prevents the browser from mixing cached Amy and Lessac files when both portable editions are installed on the same computer.

Open the matching `START` launcher. Do not open `shared/index.html` directly with `file://`; browsers block the module worker and WASM data loading in that mode.
