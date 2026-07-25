# Read Aloud Portable — 1.1 Specification

**Status:** planning approved, no code written yet.
**Constraints preserved:** fully offline at runtime, one USB folder, loopback launcher only (`127.0.0.1`), draft lives in memory, no AI features beyond the TTS engine itself, no network dependencies added.
**Explicitly out of scope:** grammar checking (Harper etc.), word-level highlighting, Hemingway/consistency analysis, docx *export*, DSP/formant pitch shifting, emotional/podcast delivery, anything from the `test` / `test 2` repositories.

---

## Part 1 — Voice system

### 1.1 Fix the hard-coded speaker bug (prerequisite)

`web/app.js` line 438 currently sends `sid: 0` with every generate request, which overrides the package's configured speaker because the worker only falls back to its stored `speakerId` when `sid` is undefined (`web/sherpa-onnx-tts.worker.js` line 130). Change the generate message to pass the app's selected speaker explicitly:

```js
worker.postMessage({type: 'generate', text: seg.text, sid: currentSpeaker, speed: seg.speed});
```

`currentSpeaker` is new state (see 1.2). For plain VITS voices it is always `0`.

### 1.2 One Kitten folder, all speakers, switched live

The engine already loads the entire `voices.bin` (every style row) at init and accepts a per-request `sid`, and the worker already reports `numSpeakers` in its ready message (worker line 122) — `app.js` currently discards it. Changes:

- **`web/app.js`** — store `numSpeakers` from the ready message on `currentVoice`; add `currentSpeaker` state (default `0`, or the package's `speakerId` if it declares one); add `switchSpeaker(n)` which sets `currentSpeaker`, stops playback, and does **not** reload the worker — the next generate call simply carries the new `sid`. Speaker switching is near-instant by design.
- **`cmd/launcher/voices.go`** — `voice.json` schema v2 (see Part 5): optional `speakers` array of `{id, name}`. Validation: ids in `0–255`, unique, names non-empty. `VoiceInfo` gains `Speakers []SpeakerInfo` passed through `/api/voices`. A package with the old scalar `speakerId` is treated as **locked** to that one speaker (back-compat: existing per-speaker folders behave exactly as today).
- **Name resolution order:** `speakers` array from `voice.json` → else auto-generate `"Voice 1" … "Voice N"` from the worker's `numSpeakers`. The launcher never needs to open the model.
- **`web/make-voice.js` / `make-voice.html`** — delete the speaker number input (`make-voice.html` lines 51–54) and the forced `speakerId` in the manifest builder (`make-voice.js` lines 86–88, 212). A Kitten package is emitted as all-speakers by default. Optional (nice-to-have): a small editable name table prefilled with `Voice 1…N`, written into `speakers`; skippable without penalty.
- **Audition in the maker** gains a speaker dropdown fed by the test worker's `numSpeakers`, so each speaker can be heard before download.

### 1.3 Cache keys carry speaker and delivery

`web/app.js` line 315 currently keys cached audio as `voiceId | speed | text`. New key:

```
voiceId + '#' + sid + '#' + deliveryPreset + '|' + engineSpeed.toFixed(2) + '|' + spokenText
```

Consequences: each speaker and each delivery preset caches independently, so flipping between already-rendered variants replays instantly (free A/B listening); incremental narration re-render keeps working per variant; `switchVoice()` still clears everything on a *package* change, but `switchSpeaker()` clears nothing.

### 1.4 Two-dropdown picker + layout guard

- **`web/index.html`** — the Voice `<select>` (line 66) lists **packages only**. A second `Speaker` `<select>` sits beside it, rendered only when the active voice has more than one speaker; hidden entirely for VITS packages. Wire `input` → `switchSpeaker`.
- **`web/style.css`** — root cause of the overflow: `.controls` (line 182) is flex and only wraps under the narrow-screen media query (line 295), while a native `<select>` sizes to its widest option. Fix: `flex-wrap: wrap` on `.controls` at all widths, plus `max-width: 16em; text-overflow: ellipsis;` on both voice-area selects so no future voice name can push the sliders out of the bar.

### 1.5 De-brand Amy → "Read Aloud Portable"

Runtime strings already use `voiceName()`; the branding lives in exactly four places:

- `cmd/launcher/main.go` line 27 `appName = "ReadAloud Amy Medium"` → `"Read Aloud Portable"`; line 28 `editionID = "amy-medium"` → `"portable"` (port/origin separation per edition is obsolete once one edition holds all voices — keep the current port, drop the per-voice framing).
- `web/start-here.html` line 49 — replace "The Amy model…" with "The speech engine and the voices folder live there…".
- `README-USB.txt` — replace the Amy walkthrough with "the default voice"; add the new notes from 3.7.
- Startup voice selection: `pickDefaultVoice()` (`app.js` lines 143–150) already honors `voice.json` `"default": true` before the `amy-medium` fallback. Keep the fallback last for old drives; the shipped Amy package simply sets `default: true`.

---

## Part 2 — Tweaking

### 2.1 Pitch slider (both families)

Playback-rate method, applied **after** synthesis so it is identical for Piper and Kitten:

- New `Pitch` range input in the Playback group, `0.85 – 1.15`, step `0.01`, default `1.00`, shown as `-15% … +15%`.
- Playback path: `AudioBufferSourceNode.playbackRate = pitch`. To keep reading pace equal to the Speed slider, the speed sent to the engine becomes `engineSpeed = uiSpeed / pitch`.
- **Caching honesty:** because `engineSpeed` is part of the cache key, moving the pitch slider re-synthesizes upcoming sentences exactly like moving the speed slider does today — same UX cost, none extra. Previously rendered (speed, pitch) combinations stay cached and replay instantly.
- **Export path:** cached samples are at `engineSpeed`; when `pitch ≠ 1.00`, WAV/MP3 export resamples each sentence by `pitch` (linear resample or `OfflineAudioContext`) so the exported file matches what was heard. Audacity label timings use post-resample durations.
- Stored in the portable settings string (Part 5).

### 2.2 Delivery toggle — "Natural / Steady" (Piper only)

Two fixed presets instead of a slider, exposed as a two-button segmented control that appears only for VITS voices (mirror of the Kitten-only Speaker dropdown):

- **Natural** = engine defaults: `noiseScale 0.667`, `noiseScaleW 0.8`.
- **Steady** = flattened prosody starting point: `noiseScale 0.25`, `noiseScaleW 0.35` — tune by ear before release; values live in one constant, not scattered.
- **Worker change (the only real work):** VITS currently initializes via the wrapper's built-in defaults (`createOfflineTts(Module)`, worker line 121). Add an explicit `vitsConfig(noiseScale, noiseScaleW)` parallel to the existing `kittenConfig()` — same full config object shape, VITS paths filled, `numThreads: threadCount()` preserved so the threading patch is not lost. Init message gains `delivery` and the two values.
- Pressing the other preset behaves like a voice switch: worker terminate + restart (~2–3 s), status shows `Loading Amy (Steady)…`. Because delivery is in the cache key (1.3), sentences already rendered under both presets flip instantly.
- `lengthScale` stays untouched — the Speed slider owns pace.
- Stored in settings string; ignored (and hidden) for Kitten voices.

---

## Part 3 — Privacy & files

Design rule for this whole part: **the app never writes to the host machine.** The only write targets are the browser's memory and the drive the launcher started from. Everything opt-in defaults to off.

### 3.1 Unsaved-work warning

`app.js` line 1732 `beforeunload` currently only tears down audio. Add: when the draft is non-empty **and** differs from the last saved/loaded session snapshot, set `event.returnValue` to trigger the browser's native leave-page prompt. Track dirtiness with a hash of draft + flags updated on save/load. Writes nothing, ever; active on every machine with no configuration.

### 3.2 Launcher save API — all saves land on the drive

New loopback-only endpoints in the Go launcher (same origin, same port):

- `POST /api/save` with JSON `{kind: "session" | "report" | "text" | "audio", name, dataBase64}` → writes to `<drive>/saves/<kind>/<sanitized-name>`. Reuse the `safeAssetName`-style filename validation from `voices.go`; reject path separators outright; create folders on demand.
- Response surfaces disk errors in plain language (drive removed, write-protected, full) so the existing "drive disappeared" UX pattern extends naturally.
- **Front-end change:** Session save, flag report, WAV/MP3 export, and the new Save-as-.txt all call `/api/save` instead of triggering browser downloads. This closes the one leak 1.0 actually has — those buttons currently drop files into the *host's* Downloads folder. Browser-download remains as automatic fallback only if `/api/save` is unreachable, with a status-line warning saying where the file went.

### 3.3 Save-to-drive button + opt-in autosave

- A visible **Save to drive** button in the Session group: one click, one session file to `saves/session/`, nothing else.
- **Autosave toggle, default OFF**, in the Session group: when enabled, writes the session to `saves/session/autosave.raSession` every 60 s and on Esc-stop. While enabled, a small persistent indicator (e.g., a dot + "autosaving to drive") stays visible so it is always obvious the machine is *not* in leave-no-trace mode. State stored in the settings string, so a personal drive can enable it once while the default stays paranoid.
- On launch, if `saves/session/autosave.raSession` exists, offer a non-blocking "Restore last session?" prompt; never auto-load.

### 3.4 Text out

Two buttons in the Export group: **Copy all** (clipboard, zero files) and **Save as .txt** (via `/api/save`, kind `text`). The draft is plain text, so paragraphs and blank lines survive as-is; no formatting logic needed.

### 3.5 Drag-drop import — `.txt` / `.md`

Drop target = the editor. `FileReader` → string → confirm-replace prompt if the draft is dirty → into the textarea. Memory-only; no temp files; `.md` is imported verbatim (no rendering — the paste-cleanup pass in 4.4 handles quote/dash normalization on request).

### 3.6 docx import as an optional addon

Modeled on the voices pattern: feature exists only if the folder exists.

- `addons/docx/` on the drive contains a bundled, offline docx text extractor (mammoth.js, BSD-2 — record in `LICENSES/`).
- Launcher: serve `/addons/` statically; add `GET /api/addons` returning present addon ids.
- App: probe `/api/addons` at startup; only then accept `.docx` drops, lazy-loading the script from `/addons/docx/`. Extraction is raw text (no styling), entirely in memory. Delete the folder → the code path never loads. Base build ships **without** the folder; the builder gains an opt-in flag to include it.

### 3.7 README honesty notes

Two additions to `README-USB.txt` (and a line in `start-here.html`):

- **Windows SmartScreen:** unsigned exe from a USB stick → "More info → Run anyway" walkthrough, mirroring the existing macOS Gatekeeper note.
- **Truthful privacy scope:** one sentence stating the tool writes nothing to the computer, but the computer's own clipboard history (e.g., Win+V, clipboard managers) and OS-level features are outside its control.

---

## Part 4 — UI & session quality of life

### 4.1 Controls regrouping

Restructure the flat ~20-control page (`index.html` lines 58–162) into a minimal always-visible bar plus four collapsible sections (`<details>` elements — no JS framework, state remembered in the settings string):

- **Main bar (always visible):** Read, Stop, Voice, Speaker *(contextual)*, Delivery *(contextual)*, Speed.
- **Playback:** pitch, volume, sentence gap, step mode, focus mode.
- **Display:** text size, line spacing, font, theme.
- **Export:** render/update, WAV, MP3, labels toggle, Copy all, Save as .txt, progress/eta info.
- **Session:** save to drive, open session, autosave toggle + indicator, settings string box, quit.

Flag controls stay attached to the editor where they are — they are part of reading, not settings.

### 4.2 "?" shortcut overlay

Pressing `?` (outside the textarea) or clicking a small `?` button opens a dismissable overlay listing F8 / F7 / F9 / F10 / Esc / Space / `?` with one-line descriptions. Pure HTML/CSS, `Esc` or click closes, never shown automatically.

### 4.3 Re-rendered sentence tint

The narration cache already knows exactly which sentence keys were newly synthesized during a Render/Update pass. Give those sentences a brief distinct tint on the existing underline layer (fade over ~2 s or until the next render), as a quiet "this one was re-recorded" signal. No new data structures — a transient set of keys painted by the same backdrop renderer.

### 4.4 Paste cleanup

On paste (and available as a one-shot "Clean up text" action for imported files): normalize curly quotes → straight, en/em dashes → `-`/`--` (configurable off), strip soft hyphens and zero-width characters, collapse exotic whitespace to plain spaces, preserve paragraph breaks exactly. Runs on the pasted region only, never the whole draft, and is undoable (single `document.execCommand`-compatible insertion so native textarea undo survives).

### 4.5 Volume slider

`GainNode` inserted in the playback chain, range 0–100%, default 100%, in the Playback group and the settings string. Exports stay at unity gain (volume is a listening preference, not an authoring one) — noted in the UI tooltip.

### 4.6 Progress readout

During continuous reading, the status line shows `Sentence 12 of 87` (data already exists as `playPos` / `segments.length`); during narration render, keep the existing per-sentence progress. No time estimates in v1.1 — sentence counts are honest, ETAs drift.

### 4.7 Resume marker — handled like a flag

Per decision: resume works **like F10, to a point** — it is a reserved bookmark that rides the existing flag-anchor machinery rather than a separate position store:

- When playback is stopped with Esc (not when it finishes naturally), a single reserved anchor of kind `resume` is placed/moved to that sentence. It renders in the flag panel as a pinned first row (`▸ Resume — "…context snippet…"`) and as a visually distinct marker behind the text.
- Because it is an anchor, it survives edits and moves exactly like flags do, and it serializes into session files with zero new format work.
- Clicking it places the cursor at that sentence (same behavior as clicking any flag), after which F8 reads from there — no new keybinding, no auto-jump on load.
- There is only ever one; starting playback from it (or placing the cursor elsewhere and reading past it) clears it. It is excluded from the flag report export.

---

## Part 5 — Schema & format changes

### `voice.json` — schema v2

```json
{
  "schemaVersion": 2,
  "id": "kitten-nano",
  "name": "Kitten Nano",
  "engine": "sherpa-kitten",
  "architecture": "kitten",
  "model": "model.onnx",
  "tokens": "tokens.txt",
  "voices": "voices.bin",
  "speakers": [ {"id": 0, "name": "Voice 1"}, {"id": 1, "name": "Voice 2"} ],
  "default": false,
  "sampleRate": 24000,
  "quality": "nano",
  "quantization": "none",
  "minimumRuntimeVersion": "1"
}
```

Rules: `speakers` optional (absent → auto-name from `numSpeakers`); scalar `speakerId` still accepted and means "locked to that speaker" (v1 back-compat); `speakers` and `speakerId` together is a validation error; schemaVersion 1 packages remain fully valid.

### Settings string additions

New keys appended to the existing portable settings format, all with safe defaults so old strings still apply cleanly: `pitch` (1.00), `volume` (1.0), `delivery` (`natural`), `speaker` (0, remembered per voice id), `autosave` (off), `sections` (collapsed-state bitmask). `settings.txt` auto-load behavior unchanged.

### Session file additions

Sessions already bundle draft + flags + settings; the resume anchor arrives for free as a flag of kind `resume`. Old session files load unchanged (no resume row shown).

---

## Part 6 — Build order, testing, done-criteria

### Phases (each independently shippable)

1. **Foundation:** 1.1 sid fix, 1.3 cache keys, 3.1 close warning, 4.6 progress readout, 4.5 volume. *(Small, no schema changes, immediately safer.)*
2. **Voices:** 1.2 multi-speaker packages, 1.4 picker + CSS guard, 1.5 de-branding, maker changes. *(Delivers the repo's namesake feature.)*
3. **Tweaking:** 2.1 pitch, 2.2 delivery toggle (includes the explicit vitsConfig worker change).
4. **Files & privacy:** 3.2 save API, 3.3 save/autosave, 3.4 text out, 3.5 drag-drop, 3.7 README notes.
5. **UI polish:** 4.1 regrouping, 4.2 overlay, 4.3 tint, 4.4 paste cleanup, 4.7 resume marker.
6. **Addon:** 3.6 docx import (last; independent of everything else).

### Test updates (existing three layers)

- **Logic (Go):** `voices_test.go` — v2 `speakers` validation (valid, duplicate ids, out-of-range, speakers+speakerId conflict, v1 passthrough); new tests for `/api/save` filename sanitization and path traversal rejection; `/api/addons` presence detection.
- **Stress:** unchanged; add one case for cache growth across speaker × delivery combinations to confirm eviction still bounds memory.
- **Real-browser:** speaker switch mid-read produces different audio without a worker reload; delivery flip after render replays instantly from cache; pitch changes export duration correctly; beforeunload prompt fires only when dirty; save lands on the drive, not in Downloads; drag-drop replaces draft only after confirm.

### Done means

A drive built from this spec: plays all Kitten speakers from one folder and switches them instantly; never writes to the host machine by default and warns before losing work; carries no Amy branding outside the Amy voice package itself; and every 1.0 package, session file, and settings string still works unmodified.
