'use strict';

const draft = document.getElementById('draft');
const backdrop = document.getElementById('backdrop');
const backdropContent = document.getElementById('backdropContent');
const readButton = document.getElementById('readButton');
const stopButton = document.getElementById('stopButton');
const clearButton = document.getElementById('clearButton');
const renderButton = document.getElementById('renderButton');
const exportButton = document.getElementById('exportButton');
const narrationInfo = document.getElementById('narrationInfo');
const speed = document.getElementById('speed');
const speedValue = document.getElementById('speedValue');
const gap = document.getElementById('gap');
const gapValue = document.getElementById('gapValue');
const fontScale = document.getElementById('fontScale');
const fontValue = document.getElementById('fontValue');
const lineSpacing = document.getElementById('lineSpacing');
const spacingValue = document.getElementById('spacingValue');
const lintInfo = document.getElementById('lintInfo');
const statsInfo = document.getElementById('statsInfo');
const fontSelect = document.getElementById('fontSelect');
const themeSelect = document.getElementById('themeSelect');
const stepToggle = document.getElementById('stepToggle');
const focusToggle = document.getElementById('focusToggle');
const exportMp3Button = document.getElementById('exportMp3Button');
const labelsToggle = document.getElementById('labelsToggle');
const flagsRow = document.getElementById('flagsRow');
const flagsInfo = document.getElementById('flagsInfo');
const flagPanel = document.getElementById('flagPanel');
const flagPanelToggle = document.getElementById('flagPanelToggle');
const flagReportButton = document.getElementById('flagReportButton');
const flagClearButton = document.getElementById('flagClearButton');
const settingsBox = document.getElementById('settingsBox');
const settingsShow = document.getElementById('settingsShow');
const settingsApply = document.getElementById('settingsApply');
const settingsCopy = document.getElementById('settingsCopy');
const settingsDownload = document.getElementById('settingsDownload');
const sessionSave = document.getElementById('sessionSave');
const sessionOpen = document.getElementById('sessionOpen');
const sessionFile = document.getElementById('sessionFile');
const quitButton = document.getElementById('quitButton');
const voiceSelect = document.getElementById('voiceSelect');
const speakerRow = document.getElementById('speakerRow');
const speakerSelect = document.getElementById('speakerSelect');
const volume = document.getElementById('volume');
const volumeValue = document.getElementById('volumeValue');
const pitch = document.getElementById('pitch');
const pitchValue = document.getElementById('pitchValue');
const deliveryRow = document.getElementById('deliveryRow');
const deliveryNatural = document.getElementById('deliveryNatural');
const deliverySteady = document.getElementById('deliverySteady');
const copyAllButton = document.getElementById('copyAllButton');
const saveTxtButton = document.getElementById('saveTxtButton');
const autosaveToggle = document.getElementById('autosaveToggle');
const autosaveDot = document.getElementById('autosaveDot');
const restoreBanner = document.getElementById('restoreBanner');
const restoreYes = document.getElementById('restoreYes');
const restoreNo = document.getElementById('restoreNo');
const importBanner = document.getElementById('importBanner');
const importName = document.getElementById('importName');
const importYes = document.getElementById('importYes');
const importNo = document.getElementById('importNo');
const helpButton = document.getElementById('helpButton');
const helpOverlay = document.getElementById('helpOverlay');
const helpClose = document.getElementById('helpClose');
const tidyButton = document.getElementById('tidyButton');
const cleanPasteToggle = document.getElementById('cleanPasteToggle');
const resumeToggle = document.getElementById('resumeToggle');
const playbackGroup = document.getElementById('playbackGroup');
const displayGroup = document.getElementById('displayGroup');
const editorStack = document.querySelector('.editor-stack');

let awaitingStep = false;
// Each flag anchors to its sentence text plus surrounding context, so it can
// survive edits: exact match first, then word-overlap similarity, rebinding
// its anchor when a confident match is found.
let flagIdCounter = 0;
const flags = new Map(); // id -> {text, before, after}

// Unsaved-work tracking: the draft is "clean" when it matches the last
// saved or opened session (or the empty startup state). Writes nothing.
let cleanSnapshot = '';
function sessionFingerprint() {
  return draft.value + '\u0000' + JSON.stringify([...flags.values()]);
}
const CONTEXT_CHARS = 40;
let pronunciationDict = []; // [pattern, replacement] pairs, longest first
let compiledDict = [];
let lintRanges = [];
const selectionInfo = document.getElementById('selectionInfo');
const statusDot = document.getElementById('statusDot');
const statusTitle = document.getElementById('statusTitle');
const statusDetail = document.getElementById('statusDetail');

let ready = false;
let audioContext = null;
let gainNode = null; // listening volume only; exports stay at unity gain
let currentSource = null;
let worker = null;
const openedDirectly = window.location.protocol === 'file:';

/* ------------------------- Voice packages ------------------------- */

let voiceCatalog = [];
let invalidVoices = [];
let currentVoice = null;
let currentSpeaker = 0;   // sid sent with every generate; multi-speaker packages change it live
let deliveryPreset = 'natural'; // Phase 3 wires the Natural/Steady toggle to this
let speakerChoice = {};   // voiceId -> remembered speaker, carried in the settings string

// Delivery presets (Piper VITS only): "natural" is the engine's defaults;
// "steady" flattens prosody for an even proofreading cadence. Kitten's
// character lives in its speaker rows, so the toggle never applies there.
const DELIVERY_PRESETS = {
  natural: {noiseScale: 0.667, noiseScaleW: 0.8},
  steady: {noiseScale: 0.25, noiseScaleW: 0.35},
};

// Pitch is applied after synthesis (playbackRate), so it works identically
// for both families. The engine speed is compensated so the reading pace
// always matches the Speed slider.
function pitchFactor() {
  const p = Number(pitch.value);
  return Number.isFinite(p) ? Math.min(1.15, Math.max(0.85, p)) : 1;
}

function pitchLabel() {
  const pct = Math.round((pitchFactor() - 1) * 100);
  return (pct > 0 ? '+' : '') + pct + '%';
}

// Linear resample by the pitch factor: identical audio to playing the cached
// samples at playbackRate=p, baked into exported files so the WAV/MP3 matches
// what was heard. Gaps are wall-clock silence and are never resampled.
function pitchResample(samples, p) {
  if (Math.abs(p - 1) < 1e-6) return samples;
  const outLen = Math.max(1, Math.round(samples.length / p));
  const out = new Float32Array(outLen);
  const step = outLen > 1 ? (samples.length - 1) / (outLen - 1) : 0;
  for (let i = 0; i < outLen; i++) {
    const x = i * step;
    const i0 = Math.floor(x);
    const frac = x - i0;
    const a = samples[i0];
    const b = samples[Math.min(samples.length - 1, i0 + 1)];
    out[i] = a + (b - a) * frac;
  }
  return out;
}

// The speakers a voice offers: the package's named list when it declares one,
// otherwise auto-named from the engine's reported speaker count.
function speakerListFor(voice) {
  if (!voice || voice.lockedSpeaker) return [];
  if (Array.isArray(voice.speakers) && voice.speakers.length) return voice.speakers;
  const n = voice.numSpeakers || 0;
  if (n < 2) return [];
  return Array.from({length: n}, (_, i) => ({id: i, name: `Voice ${i + 1}`}));
}

function renderSpeakerSelect() {
  const list = speakerListFor(currentVoice);
  if (list.length < 2) {
    speakerRow.hidden = true;
    speakerSelect.textContent = '';
    return;
  }
  speakerSelect.textContent = '';
  for (const s of list) {
    const opt = document.createElement('option');
    opt.value = String(s.id);
    opt.textContent = s.name;
    speakerSelect.appendChild(opt);
  }
  if (!list.some((s) => s.id === currentSpeaker)) currentSpeaker = list[0].id;
  speakerSelect.value = String(currentSpeaker);
  speakerRow.hidden = false;
}

// Switching speakers never reloads the engine: the whole voices.bin is already
// loaded, so the next generate call simply carries a different sid. The cache
// keys include the speaker, so nothing is cleared and A/B replay is instant.
function renderDeliveryToggle() {
  const vits = currentVoice && currentVoice.architecture === 'vits';
  deliveryRow.hidden = !vits;
  deliveryNatural.classList.toggle('active', deliveryPreset === 'natural');
  deliverySteady.classList.toggle('active', deliveryPreset === 'steady');
}

// Flipping delivery restarts the engine (the noise values are constructor
// config), but never clears the cache: the preset is part of every sentence
// key, so anything already rendered under both presets flips back instantly.
function switchDelivery(preset) {
  if (!DELIVERY_PRESETS[preset] || preset === deliveryPreset) return;
  deliveryPreset = preset;
  if (!currentVoice || currentVoice.architecture !== 'vits') {
    renderDeliveryToggle();
    return;
  }
  stopAll({restarting: true});
  if (worker) worker.terminate();
  requestQueue.length = 0;
  runToken++;
  startVoice(currentVoice);
  renderDeliveryToggle();
  refreshNarrationInfo();
  describeSelection();
}

function switchSpeaker(id) {
  const n = Number(id);
  const list = speakerListFor(currentVoice);
  if (!list.some((s) => s.id === n) || n === currentSpeaker) return;
  stopAll({restarting: true});
  currentSpeaker = n;
  speakerChoice[currentVoice.id] = n;
  const name = (list.find((s) => s.id === n) || {}).name || `Voice ${n + 1}`;
  setStatus('ready', `${voiceName()} — ${name}`, 'Press F8 to listen with this speaker. Rendered sentences per speaker stay cached.');
  refreshNarrationInfo();
  describeSelection();
  updateButtons();
}
let preferredVoiceId = null;

function voiceName() {
  return currentVoice ? currentVoice.name : 'The voice';
}

// Sherpa's C++ exits the worker outright on a corrupt model instead of
// throwing, so no error event ever arrives. The watchdog notices when load
// messages stop flowing and reports the failure instead of loading forever.
let loadWatchdogTimer = null;
const LOAD_WATCHDOG_MS = (typeof window !== 'undefined' && window.__RA_LOAD_WATCHDOG_MS) || 150000;

function loadFailureDetail(fallback) {
  if (integrityProblem) {
    return `${integrityProblem}. A damaged file is the most likely cause — re-copy the Read Aloud bundle to this drive and try again.`;
  }
  const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
  if (!isolated) {
    return 'This page is not cross-origin isolated, which the voice engine requires. Open Read Aloud through its START launcher rather than another web server.';
  }
  return fallback;
}

function armLoadWatchdog() {
  if (loadWatchdogTimer) clearTimeout(loadWatchdogTimer);
  loadWatchdogTimer = setTimeout(() => {
    loadWatchdogTimer = null;
    if (ready) return;
    setStatus('error', 'Could not load the voice',
      loadFailureDetail(`${voiceName()} stopped responding while loading. The voice model may be damaged or incompatible — try another voice or re-copy this package.`));
    updateButtons();
  }, LOAD_WATCHDOG_MS);
}

function clearLoadWatchdog() {
  if (loadWatchdogTimer) { clearTimeout(loadWatchdogTimer); loadWatchdogTimer = null; }
}

function startVoice(voice) {
  currentVoice = voice;
  currentSpeaker = voice.speakerId || 0;
  if (!voice.lockedSpeaker && Number.isInteger(speakerChoice[voice.id])) {
    currentSpeaker = speakerChoice[voice.id]; // clamped against numSpeakers on ready
  }
  renderSpeakerSelect();
  renderDeliveryToggle();
  ready = false;
  armLoadWatchdog();
  worker = new Worker('sherpa-onnx-tts.worker.js', {type: 'module'});
  worker.onmessage = handleWorkerMessage;
  worker.onerror = handleWorkerError;
  const preset = DELIVERY_PRESETS[deliveryPreset] || DELIVERY_PRESETS.natural;
  worker.postMessage({
    type: 'init',
    modelUrl: voice.modelUrl,
    tokensUrl: voice.tokensUrl,
    voicesUrl: voice.voicesUrl || '',
    arch: voice.architecture || 'vits',
    speakerId: currentSpeaker,
    noiseScale: preset.noiseScale,
    noiseScaleW: preset.noiseScaleW,
    debug: new URLSearchParams(location.search).get('debug') === '1',
    voiceId: voice.id,
  });
  const steadyTag = voice.architecture === 'vits' && deliveryPreset === 'steady' ? ' (Steady)' : '';
  setStatus('loading', `Loading ${voice.name}${steadyTag}…`, 'Reading the offline voice from this drive.');
  updateButtons();
}

function switchVoice(id) {
  const voice = voiceCatalog.find((v) => v.id === id);
  if (!voice || (currentVoice && currentVoice.id === id)) return;
  stopAll({restarting: true});
  if (worker) worker.terminate();
  sentenceCache.clear();
  cacheBytes = 0;
  requestQueue.length = 0;
  runToken++;
  startVoice(voice);
  refreshNarrationInfo();
  describeSelection();
}

function pickDefaultVoice() {
  if (!voiceCatalog.length) return null;
  return voiceCatalog.find((v) => v.id === preferredVoiceId) ||
    voiceCatalog.find((v) => v.default) ||
    voiceCatalog.find((v) => v.id === 'amy-medium') ||
    voiceCatalog[0];
}

function renderVoiceSelect() {
  voiceSelect.textContent = '';
  for (const v of voiceCatalog) {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = v.name + (v.quality ? ` (${v.quality})` : '');
    voiceSelect.appendChild(opt);
  }
  if (currentVoice) voiceSelect.value = currentVoice.id;
  voiceSelect.disabled = voiceCatalog.length < 2;
}

function loadVoiceCatalog() {
  if (openedDirectly || typeof fetch !== 'function') return;
  fetch('/api/voices', {cache: 'no-store'})
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (!data) throw new Error('no catalog');
      voiceCatalog = Array.isArray(data.voices) ? data.voices : [];
      invalidVoices = Array.isArray(data.invalid) ? data.invalid : [];
      if (!voiceCatalog.length) {
        const why = invalidVoices.length
          ? ` Found ${invalidVoices.length} invalid package${invalidVoices.length === 1 ? '' : 's'}: ` +
            invalidVoices.map((iv) => `${iv.dir} (${iv.reason})`).join('; ') + '.'
          : '';
        setStatus('error', 'No voices installed',
          `Copy a voice package folder (voice.json, model.onnx, tokens.txt) into the "voices" folder next to "shared" on this drive.${why}`);
        return;
      }
      const chosen = pickDefaultVoice();
      startVoice(chosen);
      renderVoiceSelect();
      if (invalidVoices.length) {
        setStatus('loading', `Loading ${chosen.name}…`,
          `Note: ${invalidVoices.length} voice package${invalidVoices.length === 1 ? ' was' : 's were'} skipped (${invalidVoices.map((iv) => iv.dir).join(', ')}).`);
      }
    })
    .catch(() => {
      setStatus('error', 'Could not list voices', 'The launcher did not answer /api/voices. Start Read Aloud with its START launcher.');
    });
}

/* ---------------------------------------------------------------- *
 * Sentence segmentation
 * ---------------------------------------------------------------- */

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'rev', 'sr', 'jr', 'st', 'vs', 'etc',
  'cf', 'al', 'fig', 'no', 'vol', 'pp', 'approx', 'dept', 'est', 'inc',
  'ltd', 'co', 'mt', 'ft', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul',
  'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
]);
const TERMINATORS = '.!?\u2026';
const CLOSERS = "\"')]}\u2019\u201d";
const MAX_CHUNK = 600;

function segmentText(text, from, to) {
  const spans = [];
  let start = from;

  const flush = (s, e) => {
    let a = s;
    let b = e;
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    if (a < b) spans.push({start: a, end: b});
  };

  for (let i = from; i < to; i++) {
    const ch = text[i];
    if (ch === '\n') {
      flush(start, i);
      start = i + 1;
      continue;
    }
    if (!TERMINATORS.includes(ch)) continue;

    let j = i + 1;
    while (j < to && TERMINATORS.includes(text[j])) j++;
    const punctEnd = j;
    while (j < to && CLOSERS.includes(text[j])) j++;

    if (j < to && !/\s/.test(text[j])) {
      i = j - 1;
      continue;
    }

    if (ch === '.' && punctEnd === i + 1) {
      let w = i;
      while (w > from && /[A-Za-z0-9.]/.test(text[w - 1])) w--;
      const token = text.slice(w, i);
      const atLineStart = w === from || text[w - 1] === '\n';
      if (/^\d{1,3}$/.test(token) && atLineStart) {
        i = j - 1;
        continue;
      }
      if (/^[A-Za-z]/.test(token)) {
        const lower = token.toLowerCase();
        if (token.length === 1 || lower.includes('.') || ABBREVIATIONS.has(lower)) {
          i = j - 1;
          continue;
        }
      }
    }

    flush(start, j);
    start = j;
    i = j - 1;
  }
  flush(start, to);

  const out = [];
  for (const span of spans) chunkLong(text, span, out);
  return out;
}

function chunkLong(text, span, out) {
  let s = span.start;
  while (span.end - s > MAX_CHUNK) {
    let cut = -1;
    for (let k = s + MAX_CHUNK; k > s + 40; k--) {
      if (/\s/.test(text[k])) {
        cut = k;
        break;
      }
    }
    if (cut < 0) cut = s + MAX_CHUNK;
    out.push({start: s, end: cut});
    s = cut;
    while (s < span.end && /\s/.test(text[s])) s++;
  }
  if (s < span.end) out.push({start: s, end: span.end});
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compilePronunciationDict() {
  compiledDict = pronunciationDict
    .filter((e) => e[0])
    .sort((a, b) => b[0].length - a[0].length)
    .map(([from, to]) => {
      const head = /^[A-Za-z0-9]/.test(from) ? '\\b' : '';
      const tail = /[A-Za-z0-9]$/.test(from) ? '\\b' : '';
      return [new RegExp(head + escapeRegExp(from) + tail, 'g'), to];
    });
}

function applyPronunciation(spoken) {
  for (const [re, to] of compiledDict) spoken = spoken.replace(re, to);
  return spoken;
}

function buildSegments(text, from, to) {
  // Engine speed divides by pitch so the audible pace, after the playbackRate
  // shift, always equals the Speed slider. The key uses this engine speed, so
  // pitch changes invalidate exactly like speed changes do.
  const spd = Number(speed.value) / pitchFactor();
  return segmentText(text, from, to).map((s) => {
    const spoken = applyPronunciation(text.slice(s.start, s.end).replace(/\s+/g, ' ').trim());
    return {
      start: s.start,
      end: s.end,
      text: spoken,
      speed: spd,
      key: (currentVoice ? currentVoice.id : 'none') + '#' + currentSpeaker + '#' + deliveryPreset +
        '|' + spd.toFixed(2) + '|' + spoken,
    };
  });
}

/* ---------------------------------------------------------------- *
 * Sentence audio cache
 *
 * Content-addressed: the key is the exact spoken text plus the speed
 * it was generated at. When the draft is edited and re-rendered,
 * unchanged sentences are cache hits and are never sent to the engine
 * again -- only changed or new sentences are synthesized. Reordering
 * or moving sentences costs nothing. The cache backs both F8 playback
 * (instant replay of anything already rendered) and WAV export.
 * ---------------------------------------------------------------- */

const sentenceCache = new Map(); // key -> {samples: Float32Array, sampleRate}
let cacheBytes = 0;
const CACHE_LIMIT_BYTES = 800 * 1024 * 1024;

function protectedCacheKeys() {
  // Never evict what is about to play: stranding segments[playPos] can
  // deadlock the generator's look-ahead window on book-length documents (P3-1).
  const keep = new Set();
  if (mode !== 'idle') {
    if (segments[playPos]) keep.add(segments[playPos].key);
    if (segments[playPos + 1]) keep.add(segments[playPos + 1].key);
  }
  return keep;
}

function cacheStore(key, audio) {
  if (sentenceCache.has(key)) return;
  sentenceCache.set(key, audio);
  cacheBytes += audio.samples.length * 4;
  // Evict oldest entries when over the soft cap, but never while a
  // full render is in progress (export needs every sentence present),
  // and never the sentence about to play or the one after it (P3-1).
  if (mode !== 'rendering') {
    const keep = protectedCacheKeys();
    for (const [k, v] of sentenceCache) {
      if (cacheBytes <= CACHE_LIMIT_BYTES) break;
      if (keep.has(k)) continue;
      sentenceCache.delete(k);
      cacheBytes -= v.samples.length * 4;
    }
  }
}

/* ---------------------------------------------------------------- *
 * Engine pipeline
 *
 * One activity at a time: mode is 'idle', 'playing' (F8 continuous
 * read with follow-along highlight), or 'rendering' (walking every
 * sentence into the cache for export, no audio output). The worker is
 * FIFO and does not echo request metadata, so requestQueue maps each
 * result back to its request; results from a cancelled run are still
 * cached (they are valid audio for their key) but never played.
 * ---------------------------------------------------------------- */

let mode = 'idle';
let segments = [];
let playPos = 0;
let genPos = 0;
let runToken = 0;
let sourceToken = 0;
let renderReused = 0;
const requestQueue = [];

function setStatus(kind, title, detail) {
  statusDot.className = `dot ${kind}`;
  statusTitle.textContent = title;
  statusDetail.textContent = detail;
}

function updateButtons() {
  readButton.disabled = !ready || mode !== 'idle';
  stopButton.disabled = mode === 'idle';
  if (mode !== 'idle') {
    renderButton.disabled = true;
    exportButton.disabled = true;
    exportMp3Button.disabled = true;
  } else {
    refreshNarrationInfo();
  }
}

function describeSelection() {
  const startSel = draft.selectionStart;
  const endSel = draft.selectionEnd;
  if (startSel !== endSel) {
    const count = draft.value.slice(startSel, endSel).trim().length;
    selectionInfo.textContent = count > 0
      ? `${count} characters selected. F8 reads just the selection.`
      : 'The selection contains no readable text.';
  } else {
    selectionInfo.textContent = 'F8 reads aloud from the cursor to the end. Esc stops.';
  }
}

function pumpGenerator() {
  if (mode === 'idle' || !worker) return;
  if (requestQueue.some((r) => r.token === runToken)) return; // one in flight

  if (mode === 'playing') {
    while (
      genPos < segments.length &&
      genPos <= playPos + 1 &&
      sentenceCache.has(segments[genPos].key)
    ) genPos++;
    if (genPos >= segments.length || genPos > playPos + 1) return;
    // If any queued request (even from a cancelled run) covers this key,
    // its result will land in the cache shortly -- don't synthesize twice.
    if (requestQueue.some((r) => r.key === segments[genPos].key)) return;
    postGenerate(genPos++);
    return;
  }

  // rendering
  let advanced = false;
  while (genPos < segments.length && sentenceCache.has(segments[genPos].key)) {
    renderReused++;
    genPos++;
    advanced = true;
  }
  if (advanced) showRenderProgress();
  if (genPos >= segments.length) {
    finishRender();
    return;
  }
  if (requestQueue.some((r) => r.key === segments[genPos].key)) return;
  postGenerate(genPos++);
}

let requestId = 0;

function postGenerate(index) {
  const seg = segments[index];
  const id = ++requestId;
  requestQueue.push({id, token: runToken, index, key: seg.key});
  worker.postMessage({type: 'generate', id, text: seg.text, sid: currentSpeaker, speed: seg.speed});
}

// Results and errors are matched to their request by echoed id, so a dropped
// or reordered reply can never shift audio onto the wrong sentence (P1-1).
// Replies without an id (older workers, test harnesses) fall back to FIFO.
function takeRequest(message) {
  if (message && message.id !== undefined) {
    const i = requestQueue.findIndex((r) => r.id === message.id);
    return i >= 0 ? requestQueue.splice(i, 1)[0] : null;
  }
  return requestQueue.shift() || null;
}

function handleResult(message) {
  const req = takeRequest(message);
  if (!req) return;
  cacheStore(req.key, {samples: message.samples, sampleRate: message.sampleRate});
  // A result is useful whichever run requested it: the cache is
  // content-addressed, so even a cancelled run's result can complete
  // the sentence the current run is waiting on. But it must never *start*
  // audio while a deliberate pause is in progress: the gap timer or the
  // step-mode wait owns the start in those states (P1-2).
  if (mode === 'playing') {
    if (!currentSource && !startingSource && !gapTimer && !awaitingStep &&
        segments[playPos] && sentenceCache.has(segments[playPos].key)) {
      void playSegment();
    }
  } else if (mode === 'rendering' && req.token === runToken) {
    const doneSeg = segments[req.index];
    if (doneSeg) freshTint.push({s: doneSeg.start, e: doneSeg.end});
    showRenderProgress();
  }
  pumpGenerator();
}

/* --------------------------- F8 playback ------------------------- */

function startReading() {
  if (!ready) return;
  if (!worker) {
    setStatus('error', 'Start with the launcher', 'Do not open shared/index.html directly. Open START - WINDOWS.exe, START - MACOS.app, or START - LINUX.sh.');
    return;
  }
  if (mode !== 'idle') stopAll({restarting: true});

  const text = draft.value;
  if (!text.trim()) {
    setStatus('error', 'Nothing to read', 'Paste text or place the cursor first.');
    return;
  }

  const selStart = draft.selectionStart;
  const selEnd = draft.selectionEnd;
  if (selStart !== selEnd) {
    segments = buildSegments(text, selStart, selEnd);
  } else {
    const all = buildSegments(text, 0, text.length);
    const first = all.findIndex((s) => s.end > selStart);
    segments = first >= 0 ? all.slice(first) : [];
  }
  if (!segments.length) {
    setStatus('error', 'Nothing to read', 'The selection contains no readable text.');
    return;
  }

  mode = 'playing';
  playPos = 0;
  genPos = 0;
  renderHighlight(segments[0]);
  setStatus('loading', 'Generating speech…', 'The first sentence is being prepared.');
  updateButtons();
  syncFocusClass();
  pumpGenerator();
  if (!currentSource && sentenceCache.has(segments[playPos].key)) void playSegment();
}

function syncFocusClass() {
  editorStack.classList.toggle('focus-live', focusToggle.checked && mode === 'playing');
}

let startingSource = false;

async function playSegment() {
  // Only one start may be in flight, and never on top of playing audio:
  // the guard is re-checked after the await because resume() opens a window
  // where playback can move on or a second start can arrive (P1-3).
  if (startingSource || currentSource) return;
  startingSource = true;
  try {
  const pos = playPos;
  const seg = segments[pos];
  if (!seg) return;
  const audio = sentenceCache.get(seg.key);
  if (!audio) return;
  clearResumeIfReached(seg);
  renderHighlight(seg);

  audioContext ??= new AudioContext();
  if (!gainNode) {
    gainNode = audioContext.createGain();
    gainNode.gain.value = Number(volume.value);
    gainNode.connect(audioContext.destination);
  }
  await audioContext.resume();
  if (mode !== 'playing' || pos !== playPos || currentSource) return;

  const buffer = audioContext.createBuffer(1, audio.samples.length, audio.sampleRate);
  buffer.getChannelData(0).set(audio.samples);
  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = pitchFactor();
  source.connect(gainNode);
  currentSource = source;
  const token = ++sourceToken;
  source.onended = () => {
    if (token === sourceToken) advance();
  };

  setStatus(
    'speaking',
    segments.length > 1 ? `Reading ${playPos + 1} of ${segments.length}` : 'Speaking…',
    'Press Esc or Stop to interrupt. F8 restarts from the cursor.'
  );
  updateButtons();
  source.start();
  pumpGenerator();
  } finally {
    startingSource = false;
  }
}

let gapTimer = null;

function advance() {
  currentSource = null;
  playPos++;
  if (playPos >= segments.length) {
    finishReading();
    return;
  }
  const proceed = () => {
    if (currentSource || startingSource) return; // something already started
    if (sentenceCache.has(segments[playPos].key)) {
      void playSegment();
    } else {
      renderHighlight(segments[playPos]);
      setStatus('loading', `Generating ${playPos + 1} of ${segments.length}…`, 'The next sentence is being prepared.');
      updateButtons();
      pumpGenerator();
    }
  };
  if (stepToggle.checked) {
    awaitingStep = true;
    renderHighlight(segments[playPos]);
    pumpGenerator(); // keep synthesis busy while waiting
    setStatus('ready', `Paused before ${playPos + 1} of ${segments.length}`, 'Press F8 (or Space outside the text box) for the next sentence. F7 replays. Esc stops.');
    updateButtons();
    return;
  }
  const gapMs = Math.round(Number(gap.value) * 1000);
  if (gapMs > 0) {
    renderHighlight(segments[playPos]); // show the upcoming sentence during the pause
    pumpGenerator();                    // keep synthesis busy through the gap
    gapTimer = setTimeout(() => {
      gapTimer = null;
      if (mode === 'playing') proceed();
    }, gapMs);
  } else {
    proceed();
  }
}

function stepAdvance() {
  if (!awaitingStep || mode !== 'playing') return;
  awaitingStep = false;
  if (sentenceCache.has(segments[playPos].key)) {
    void playSegment();
  } else {
    setStatus('loading', `Generating ${playPos + 1} of ${segments.length}…`, 'The next sentence is being prepared.');
    pumpGenerator();
  }
}

function replayCurrent() {
  if (mode === 'playing') {
    if (gapTimer) {
      clearTimeout(gapTimer);
      gapTimer = null;
      playPos = Math.max(0, playPos - 1);
      void playSegment();
      return;
    }
    if (awaitingStep) {
      awaitingStep = false;
      playPos = Math.max(0, playPos - 1);
      void playSegment();
      return;
    }
    if (currentSource) {
      sourceToken++;
      const source = currentSource;
      currentSource = null;
      source.onended = null;
      try { source.stop(); } catch (_) { /* already stopped */ }
      void playSegment();
    }
    return;
  }
  // Idle: read the sentence at the cursor, once.
  if (!ready || !worker) return;
  const text = draft.value;
  if (!text.trim()) return;
  const all = buildSegments(text, 0, text.length);
  const idx = all.findIndex((seg) => seg.end > draft.selectionStart);
  if (idx < 0) return;
  segments = [all[idx]];
  mode = 'playing';
  playPos = 0;
  genPos = 0;
  renderHighlight(segments[0]);
  setStatus('loading', 'Generating speech…', 'The sentence at the cursor is being prepared.');
  updateButtons();
  syncFocusClass();
  pumpGenerator();
  if (!currentSource && sentenceCache.has(segments[0].key)) void playSegment();
}

function currentFlagTarget() {
  if (mode === 'playing' && segments.length) {
    return segments[Math.min(playPos, segments.length - 1)];
  }
  const text = draft.value;
  if (!text.trim()) return null;
  const all = buildSegments(text, 0, text.length);
  const idx = all.findIndex((seg) => seg.end > draft.selectionStart);
  return idx >= 0 ? all[idx] : null;
}

function wordSimilarity(a, b) {
  const wa = new Set((a.toLowerCase().match(/[a-z0-9']+/g)) || []);
  const wb = new Set((b.toLowerCase().match(/[a-z0-9']+/g)) || []);
  if (!wa.size || !wb.size) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return (2 * shared) / (wa.size + wb.size);
}

function captureFlag(text, seg) {
  return {
    text: text.slice(seg.start, seg.end),
    before: text.slice(Math.max(0, seg.start - CONTEXT_CHARS), seg.start),
    after: text.slice(seg.end, seg.end + CONTEXT_CHARS),
  };
}

// Resolve every flag to its current place in the draft.
// Returns [{id, flag, seg|null, state: 'exact'|'edited'|'lost'}] in document
// order, lost flags last. Confident fuzzy matches rebind the stored anchor,
// so a flag follows its sentence through successive edits.
function resolveFlags() {
  const text = draft.value;
  const all = buildSegments(text, 0, text.length);
  const byText = new Map();
  for (const seg of all) {
    const raw = text.slice(seg.start, seg.end);
    if (!byText.has(raw)) byText.set(raw, []);
    byText.get(raw).push(seg);
  }
  const taken = new Set();
  const resolved = [];
  for (const [id, flag] of flags) {
    let seg = null;
    let state = 'lost';
    const exact = (byText.get(flag.text) || []).filter((s) => !taken.has(s.start));
    if (exact.length === 1) {
      seg = exact[0];
      state = 'exact';
    } else if (exact.length > 1) {
      // several identical sentences: pick by surrounding context
      let best = exact[0];
      let bestScore = -1;
      for (const cand of exact) {
        const score =
          wordSimilarity(text.slice(Math.max(0, cand.start - CONTEXT_CHARS), cand.start), flag.before) +
          wordSimilarity(text.slice(cand.end, cand.end + CONTEXT_CHARS), flag.after);
        if (score > bestScore) { bestScore = score; best = cand; }
      }
      seg = best;
      state = 'exact';
    } else {
      // sentence was edited: best word-overlap candidate wins
      let best = null;
      let bestScore = 0;
      for (const cand of all) {
        if (taken.has(cand.start)) continue;
        let score = wordSimilarity(text.slice(cand.start, cand.end), flag.text);
        if (score < 0.4) continue;
        score += 0.15 * wordSimilarity(text.slice(Math.max(0, cand.start - CONTEXT_CHARS), cand.start), flag.before);
        score += 0.15 * wordSimilarity(text.slice(cand.end, cand.end + CONTEXT_CHARS), flag.after);
        if (score > bestScore) { bestScore = score; best = cand; }
      }
      if (best && bestScore >= 0.55) {
        seg = best;
        state = 'edited';
        if (bestScore >= 0.8) Object.assign(flag, captureFlag(text, best)); // self-heal the anchor
      }
    }
    if (seg) taken.add(seg.start);
    resolved.push({id, flag, seg, state});
  }
  resolved.sort((a, b) => {
    if (!a.seg && !b.seg) return 0;
    if (!a.seg) return 1;
    if (!b.seg) return -1;
    return a.seg.start - b.seg.start;
  });
  return resolved;
}

// ---- Resume marker (spec 4.7): a reserved bookmark riding the flag anchors.
// Placed when reading stops, it survives edits like any flag, serializes into
// sessions for free, and clears itself once its sentence is read again.
function resumeFlagId() {
  for (const [id, flag] of flags) if (flag.kind === 'resume') return id;
  return null;
}

function userFlagCount() {
  return flags.size - (resumeFlagId() !== null ? 1 : 0);
}

function setResumeFlag(seg) {
  const old = resumeFlagId();
  if (old !== null) flags.delete(old);
  flags.set(++flagIdCounter, {...captureFlag(draft.value, seg), kind: 'resume'});
  refreshFlags();
}

// Reading the marked sentence again (from it, or straight past it) retires
// the marker.
function clearResumeIfReached(seg) {
  const id = resumeFlagId();
  if (id === null || !seg) return;
  const r = resolveFlags().find((x) => x.id === id);
  if (r && r.seg && r.seg.start < seg.end && r.seg.end > seg.start) {
    flags.delete(id);
    refreshFlags();
  }
}

function toggleFlag() {
  const seg = currentFlagTarget();
  if (!seg) return;
  const raw = draft.value.slice(seg.start, seg.end);
  // Cheap coverage check first: exact text, then fuzzy against stored flags.
  // Full document resolution is reserved for the panel, F10, and reports.
  let coveringId = null;
  for (const [id, flag] of flags) {
    if (flag.kind === 'resume') continue;
    if (flag.text === raw) { coveringId = id; break; }
  }
  if (coveringId === null) {
    let bestScore = 0;
    for (const [id, flag] of flags) {
      if (flag.kind === 'resume') continue;
      const score = wordSimilarity(flag.text, raw);
      if (score > bestScore) { bestScore = score; coveringId = id; }
    }
    if (bestScore < 0.92) coveringId = null;
  }
  if (coveringId !== null) {
    flags.delete(coveringId);
  } else {
    flags.set(++flagIdCounter, captureFlag(draft.value, seg));
  }
  refreshFlags();
}

let flagUiTimer = null;

function refreshFlags() {
  const n = userFlagCount();
  const hasResume = resumeFlagId() !== null;
  flagsRow.hidden = flags.size === 0;
  flagsInfo.textContent = n
    ? `⚑ ${n} flagged sentence${n === 1 ? '' : 's'} — F10 jumps to the next`
    : (hasResume ? '▸ Resume point saved — open the panel to jump back' : '');
  if (flags.size === 0) flagPanel.hidden = true;
  flagPanelToggle.textContent = flagPanel.hidden ? 'Show' : 'Hide';
  // The panel and backdrop markers need full flag resolution; coalesce bursts
  // (rapid F9 presses, bulk session loads) into one deferred update.
  if (flagUiTimer) return;
  flagUiTimer = setTimeout(() => {
    flagUiTimer = null;
    if (!flagPanel.hidden) renderFlagPanel();
    if (mode === 'idle') syncIdleBackdrop();
  }, 30);
}

function renderFlagPanel() {
  const resolved = resolveFlags();
  resolved.sort((a, b) => (b.flag.kind === 'resume' ? 1 : 0) - (a.flag.kind === 'resume' ? 1 : 0));
  flagPanel.textContent = '';
  for (const r of resolved) {
    const li = document.createElement('li');
    li.className = r.state === 'lost' ? 'flag-lost' : (r.state === 'edited' ? 'flag-edited' : '');
    if (r.flag.kind === 'resume') li.className += ' flag-resume';
    const span = document.createElement('span');
    span.className = 'flag-text';
    const shown = (r.seg ? draft.value.slice(r.seg.start, r.seg.end) : r.flag.text);
    const ctxBefore = r.flag.before.trim().slice(-18);
    span.innerHTML = (ctxBefore ? `<span class="flag-ctx">…${escapeHtml(ctxBefore)} </span>` : '') +
      escapeHtml(shown.length > 120 ? shown.slice(0, 117) + '…' : shown);
    li.appendChild(span);
    if (r.state !== 'exact') {
      const badge = document.createElement('span');
      badge.className = 'flag-badge';
      badge.textContent = r.state === 'edited' ? 'updated' : 'not found';
      li.appendChild(badge);
    }
    const remove = document.createElement('button');
    remove.className = 'flag-remove';
    remove.type = 'button';
    remove.textContent = '✕';
    remove.title = 'Remove this flag';
    remove.addEventListener('click', (ev) => {
      ev.stopPropagation();
      flags.delete(r.id);
      refreshFlags();
    });
    li.appendChild(remove);
    if (r.seg) {
      li.addEventListener('click', () => jumpToFlag(r.id));
    }
    flagPanel.appendChild(li);
  }
}

function jumpToFlag(id) {
  const r = resolveFlags().find((x) => x.id === id);
  if (!r || !r.seg || mode !== 'idle') return;
  draft.setSelectionRange(r.seg.start, r.seg.end);
  draft.focus();
  renderHighlight(r.seg);
  setTimeout(() => { if (mode === 'idle') syncIdleBackdrop(); }, 900);
  describeSelection();
}

function nextFlag() {
  if (!flags.size || mode !== 'idle') return;
  const placed = resolveFlags().filter((r) => r.seg && r.flag.kind !== 'resume');
  if (!placed.length) return;
  const target = placed.find((r) => r.seg.start > draft.selectionEnd) || placed[0];
  jumpToFlag(target.id);
}

function flagReport() {
  const resolved = resolveFlags().filter((r) => r.flag.kind !== 'resume');
  const lines = resolved.map((r, i) => {
    const body = r.seg ? draft.value.slice(r.seg.start, r.seg.end) : r.flag.text;
    const note = r.state === 'lost' ? ' [no longer found in the draft]' : '';
    return `${i + 1}. ${body}${note}`;
  });
  void saveOrDownload('report', 'read-aloud-flags.txt',
    new Blob([`Flagged sentences (${userFlagCount()})\n\n` + lines.join('\n\n') + '\n'], {type: 'text/plain'}), 'Flag report saved');
}

function finishReading() {
  const last = segments[segments.length - 1];
  mode = 'idle';
  runToken++;
  segments = [];
  clearHighlight();
  if (last) draft.setSelectionRange(last.end, last.end);
  setStatus('ready', 'Finished reading', 'Place the cursor and press F8 to read again.');
  updateButtons();
  syncFocusClass();
  syncIdleBackdrop();
  describeSelection();
}

/* ------------------------ Render and export ---------------------- */

// Sentences newly synthesized by the last Render / Update pass get a brief
// tint on the backdrop (spec 4.3) — a quiet "this one was re-recorded".
const TINT_MS = window.__RA_TINT_MS || 2200;
let freshTint = [];      // [{s, e}] spans in draft offsets
let freshTintUntil = 0;  // wall-clock expiry, set when the render finishes
let freshTintDocLen = 0; // spans are only valid while the text is unchanged

function startRender() {
  if (!ready) return;
  if (!worker) {
    setStatus('error', 'Start with the launcher', 'Do not open shared/index.html directly. Open START - WINDOWS.exe, START - MACOS.app, or START - LINUX.sh.');
    return;
  }
  if (mode !== 'idle') stopAll({restarting: true});

  const text = draft.value;
  if (!text.trim()) {
    setStatus('error', 'Nothing to render', 'Paste text first.');
    return;
  }
  segments = buildSegments(text, 0, text.length);
  if (!segments.length) {
    setStatus('error', 'Nothing to render', 'The draft contains no readable text.');
    return;
  }

  mode = 'rendering';
  playPos = 0;
  genPos = 0;
  renderReused = 0;
  freshTint = [];
  freshTintDocLen = text.length;
  updateButtons();
  showRenderProgress();
  pumpGenerator();
}

function showRenderProgress() {
  if (mode !== 'rendering') return;
  const total = segments.length;
  const current = Math.min(genPos, total - 1);
  setStatus(
    'loading',
    `Rendering ${Math.min(genPos + 1, total)} of ${total}…`,
    renderReused > 0
      ? `${renderReused} unchanged sentence${renderReused === 1 ? '' : 's'} reused. Esc cancels.`
      : 'Every sentence is stored, so edits only re-render what changed. Esc cancels.'
  );
  if (segments[current]) renderHighlight(segments[current]);
}

function finishRender() {
  const total = segments.length;
  mode = 'idle';
  runToken++;
  segments = [];
  if (freshTint.length) {
    freshTintUntil = Date.now() + TINT_MS;
    setTimeout(() => { freshTint = []; if (mode === 'idle') syncIdleBackdrop(); }, TINT_MS + 60);
  }
  syncIdleBackdrop();
  setStatus(
    'ready',
    'Narration ready',
    `${total} sentence${total === 1 ? '' : 's'} rendered, ${renderReused} reused. Export a WAV or keep editing.`
  );
  updateButtons();
  describeSelection();
}

function narrationState() {
  const text = draft.value;
  if (!text.trim()) return {total: 0, missing: 0, segs: []};
  const segs = buildSegments(text, 0, text.length);
  let missing = 0;
  for (const s of segs) {
    if (!sentenceCache.has(s.key)) missing++;
  }
  return {total: segs.length, missing, segs};
}

function refreshNarrationInfo() {
  const {total, missing} = narrationState();
  if (!total) {
    narrationInfo.textContent = 'Paste text, render it once, then export a WAV. Edits only re-render changed sentences.';
  } else if (missing === 0) {
    narrationInfo.textContent = `All ${total} sentence${total === 1 ? '' : 's'} rendered. Ready to export.`;
  } else if (missing === total) {
    narrationInfo.textContent = `${total} sentence${total === 1 ? '' : 's'} to render.`;
  } else {
    narrationInfo.textContent = `${missing} of ${total} sentences changed and need rendering.`;
  }
  renderButton.disabled = !ready || mode !== 'idle' || total === 0 || missing === 0;
  exportButton.disabled = !ready || mode !== 'idle' || total === 0 || missing > 0;
  exportMp3Button.disabled = exportButton.disabled;
  if (total > 0 && missing === 0) renderButton.disabled = true;
}

function buildNarrationPcm() {
  const {total, missing, segs} = narrationState();
  if (!total || missing > 0) {
    refreshNarrationInfo();
    return null;
  }
  const text = draft.value;
  const sampleRate = sentenceCache.get(segs[0].key).sampleRate;
  const gapSeconds = Number(gap.value);
  const SENTENCE_GAP = Math.round(sampleRate * gapSeconds);
  const PARAGRAPH_GAP = Math.round(sampleRate * (gapSeconds + 0.4));
  const CHUNK_GAP = Math.round(sampleRate * Math.min(0.12, gapSeconds));

  const parts = [];
  const labels = [];
  let totalSamples = 0;
  segs.forEach((seg, i) => {
    if (i > 0) {
      const prev = segs[i - 1];
      const prevChar = text[prev.end - 1] || '';
      const between = text.slice(prev.end, seg.start);
      let gapLen;
      if (!TERMINATORS.includes(prevChar) && !/[:;,]/.test(prevChar)) {
        gapLen = CHUNK_GAP; // continuation of a long split sentence
      } else if (/\n[^\S\n]*\n/.test(between)) {
        gapLen = PARAGRAPH_GAP;
      } else {
        gapLen = SENTENCE_GAP;
      }
      parts.push(gapLen);
      totalSamples += gapLen;
    }
    const audio = sentenceCache.get(seg.key);
    const rendered = pitchResample(audio.samples, pitchFactor());
    labels.push({
      t0: totalSamples / sampleRate,
      t1: (totalSamples + rendered.length) / sampleRate,
      text: seg.text,
    });
    parts.push(rendered);
    totalSamples += rendered.length;
  });

  const pcm = new Int16Array(totalSamples); // silence gaps stay zero
  let offset = 0;
  for (const part of parts) {
    if (typeof part === 'number') {
      offset += part;
      continue;
    }
    for (let i = 0; i < part.length; i++) {
      const v = Math.max(-1, Math.min(1, part[i]));
      pcm[offset++] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
  }
  return {pcm, sampleRate, totalSamples, total, labels};
}

function maybeExportLabels(labels) {
  if (!labelsToggle.checked || !labels.length) return;
  const lines = labels.map((l) => `${l.t0.toFixed(6)}\t${l.t1.toFixed(6)}\t${l.text}`);
  void saveOrDownload('text', 'read-aloud-narration-labels.txt',
    new Blob([lines.join('\n') + '\n'], {type: 'text/plain'}), 'Labels saved');
}

function exportWav() {
  const built = buildNarrationPcm();
  if (!built) return;
  const {pcm, sampleRate, totalSamples, total, labels} = built;

  const wav = new ArrayBuffer(44 + pcm.length * 2);
  const dv = new DataView(wav);
  const writeStr = (at, s) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(at + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  dv.setUint32(4, 36 + pcm.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);  // PCM
  dv.setUint16(22, 1, true);  // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  writeStr(36, 'data');
  dv.setUint32(40, pcm.length * 2, true);
  new Int16Array(wav, 44).set(pcm);

  void saveOrDownload('audio', 'read-aloud-narration.wav', new Blob([wav], {type: 'audio/wav'}), 'WAV exported');
  maybeExportLabels(labels);

  const seconds = Math.round(totalSamples / sampleRate);
  const mm = Math.floor(seconds / 60);
  const ss = String(seconds % 60).padStart(2, '0');
  setStatus('ready', 'WAV exported', `${total} sentence${total === 1 ? '' : 's'}, about ${mm}:${ss} of audio.`);
}

function exportMp3() {
  const built = buildNarrationPcm();
  if (!built) return;
  const {pcm, sampleRate, totalSamples, total, labels} = built;
  setStatus('loading', 'Encoding MP3…', 'The narration is being compressed on this computer.');
  exportMp3Button.disabled = true;
  const encoder = new Worker('mp3-worker.js');
  encoder.onmessage = (event) => {
    const msg = event.data || {};
    if (msg.type === 'progress') {
      const pct = msg.total ? Math.round((msg.done / msg.total) * 100) : 0;
      setStatus('loading', `Encoding MP3… ${pct}%`, 'The narration is being compressed on this computer.');
      return;
    }
    encoder.terminate();
    if (msg.type === 'error') {
      setStatus('error', 'MP3 encoding failed', String(msg.message || 'Unknown encoder error.'));
      refreshNarrationInfo();
      return;
    }
    void saveOrDownload('audio', 'read-aloud-narration.mp3', new Blob(msg.chunks, {type: 'audio/mpeg'}), 'MP3 exported');
    maybeExportLabels(labels);
    const seconds = Math.round(totalSamples / sampleRate);
    const mm = Math.floor(seconds / 60);
    const ss = String(seconds % 60).padStart(2, '0');
    setStatus('ready', 'MP3 exported', `${total} sentence${total === 1 ? '' : 's'}, about ${mm}:${ss} of audio at 64 kbps.`);
    refreshNarrationInfo();
  };
  encoder.onerror = () => {
    encoder.terminate();
    setStatus('error', 'MP3 encoding failed', 'The encoder worker could not start.');
    refreshNarrationInfo();
  };
  encoder.postMessage({pcm, sampleRate, kbps: 64}, [pcm.buffer]);
}

function downloadBlob(blob, name) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 30000);
}

function downloadText(name, textContent) {
  downloadBlob(new Blob([textContent], {type: 'text/plain'}), name);
}

/* ----------------------- Saving to the drive ---------------------- */
// Design rule: the app never writes to the host computer. All saves go
// through the launcher to <drive>/saves/<kind>/, next to the app itself.
// A browser download happens only when the drive cannot be written, and
// the status line then says exactly where the file went.

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error('could not read the data to save'));
    r.readAsDataURL(blob);
  });
}

// The launcher injects a per-run token into the served page; mutating
// requests must carry it, so a random website the person is browsing can
// never write to the drive or shut the app down (CSRF protection).
function runTokenHeader() {
  const meta = document.querySelector('meta[name="ra-token"]');
  return meta ? meta.content : '';
}

async function saveToDrive(kind, name, blob) {
  const dataBase64 = await blobToBase64(blob);
  const resp = await fetch('/api/save', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-RA-Token': runTokenHeader()},
    body: JSON.stringify({kind, name, dataBase64}),
  });
  let body = null;
  try { body = await resp.json(); } catch (_) { /* non-JSON error page */ }
  if (!resp.ok) throw new Error((body && body.error) || `save failed (${resp.status})`);
  return (body && body.saved) || `saves/${kind}/${name}`;
}

async function saveOrDownload(kind, name, blob, doneTitle) {
  if (openedDirectly || typeof fetch !== 'function') {
    downloadBlob(blob, name);
    return false;
  }
  try {
    const rel = await saveToDrive(kind, name, blob);
    setStatus('ready', doneTitle || 'Saved to the drive', `Written to ${rel} on this drive. Nothing was left on this computer.`);
    return true;
  } catch (err) {
    downloadBlob(blob, name);
    setStatus('ready', doneTitle || 'Saved', `The drive could not be written (${String(err.message || err)}), so ${name} went to this computer's Downloads folder instead.`);
    return false;
  }
}

/* ----------------------------- Stop ------------------------------ */

function stopAll({restarting = false, keepCaret = false} = {}) {
  if (mode === 'idle' && !currentSource) return;
  if (!restarting) void autosaveNow();
  const wasPlaying = mode === 'playing';
  const seg = segments[playPos];
  runToken++;
  sourceToken++;
  if (currentSource) {
    const source = currentSource;
    currentSource = null;
    source.onended = null;
    try {
      source.stop();
    } catch (_) {
      // The source may already have stopped.
    }
  }
  if (gapTimer) {
    clearTimeout(gapTimer);
    gapTimer = null;
  }
  awaitingStep = false;
  mode = 'idle';
  segments = [];
  playPos = 0;
  genPos = 0;
  clearHighlight();
  if (!restarting) {
    if (wasPlaying && seg && !keepCaret) draft.setSelectionRange(seg.start, seg.start);
    if (wasPlaying && seg && resumeToggle.checked) setResumeFlag(seg);
    setStatus('ready', 'Stopped', wasPlaying ? 'Press F8 to resume from this sentence.' : 'Rendering cancelled. Finished sentences are kept.');
    updateButtons();
    describeSelection();
  }
  syncFocusClass();
  if (!restarting) syncIdleBackdrop();
}

/* ------------------------ Follow-along highlight ------------------ */

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderHighlight(seg) {
  const text = draft.value;
  backdropContent.innerHTML =
    escapeHtml(text.slice(0, seg.start)) +
    '<mark>' + escapeHtml(text.slice(seg.start, seg.end)) + '</mark>' +
    escapeHtml(text.slice(seg.end)) + '\n';
  const markEl = backdropContent.querySelector('mark');
  if (markEl) {
    const markTop = markEl.offsetTop;
    const markBottom = markTop + markEl.offsetHeight;
    const viewTop = draft.scrollTop;
    const viewBottom = viewTop + draft.clientHeight;
    if (markTop < viewTop + 8 || markBottom > viewBottom - 8) {
      const target = markTop - draft.clientHeight * 0.35;
      draft.scrollTop = Math.max(0, Math.min(target, draft.scrollHeight - draft.clientHeight));
    }
  }
  syncBackdropScroll();
}

function clearHighlight() {
  backdropContent.textContent = '';
  syncBackdropScroll();
}

function syncBackdropScroll() {
  backdrop.scrollTop = draft.scrollTop;
  backdrop.scrollLeft = draft.scrollLeft;
}

/* --------------------- Writing checks and stats ------------------- */

function mergeRanges(ranges) {
  ranges.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of ranges) {
    if (out.length && r[0] <= out[out.length - 1][1]) {
      out[out.length - 1][1] = Math.max(out[out.length - 1][1], r[1]);
    } else {
      out.push([r[0], r[1]]);
    }
  }
  return out;
}

function runLint() {
  const t = draft.value;
  lintRanges = [];
  if (!t.trim()) {
    lintInfo.textContent = '';
    return;
  }
  const ranges = [];
  let repeatedWords = 0;
  for (const m of t.matchAll(/\b([A-Za-z']+)([ \t]+)\1\b/gi)) {
    repeatedWords++;
    ranges.push([m.index, m.index + m[0].length]);
  }
  let doubleSpaces = 0;
  for (const m of t.matchAll(/\S( {2,})(?=\S)/g)) {
    doubleSpaces++;
    ranges.push([m.index + 1, m.index + 1 + m[1].length]);
  }
  let doubledPunct = 0;
  for (const m of t.matchAll(/,{2,}|;{2,}|:{2,}/g)) {
    doubledPunct++;
    ranges.push([m.index, m.index + m[0].length]);
  }
  for (const m of t.matchAll(/\.{2,}/g)) {
    if (m[0].length === 2) { // ".." but not "..." ellipses
      doubledPunct++;
      ranges.push([m.index, m.index + 2]);
    }
  }
  // Unbalanced brackets: high-confidence pairs only.
  const stack = [];
  const pairs = {')': '(', ']': '[', '}': '{'};
  let unbalanced = 0;
  for (const ch of t) {
    if (ch === '(' || ch === '[' || ch === '{') stack.push(ch);
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (stack.length && stack[stack.length - 1] === pairs[ch]) stack.pop();
      else unbalanced++;
    }
  }
  unbalanced += stack.length;
  const straightQuotes = (t.match(/"/g) || []).length;
  const openCurly = (t.match(/\u201c/g) || []).length;
  const closeCurly = (t.match(/\u201d/g) || []).length;
  const unmatchedQuotes = (straightQuotes % 2) + (openCurly === closeCurly ? 0 : 1);

  lintRanges = mergeRanges(ranges);
  const parts = [];
  if (repeatedWords) parts.push(`${repeatedWords} repeated word${repeatedWords === 1 ? '' : 's'}`);
  if (doubleSpaces) parts.push(`${doubleSpaces} double space${doubleSpaces === 1 ? '' : 's'}`);
  if (doubledPunct) parts.push(`${doubledPunct} doubled punctuation mark${doubledPunct === 1 ? '' : 's'}`);
  if (unbalanced) parts.push(`${unbalanced} unbalanced bracket${unbalanced === 1 ? '' : 's'}`);
  if (unmatchedQuotes) parts.push(`${unmatchedQuotes} unmatched quote${unmatchedQuotes === 1 ? '' : 's'}`);
  lintInfo.textContent = parts.length ? 'Check: ' + parts.join(' · ') : '';
}

function syncIdleBackdrop() {
  if (mode !== 'idle') return;
  const text = draft.value;
  const decorations = lintRanges.map(([a, b]) => ({s: a, e: b, cls: 'lint'}));
  if (freshTint.length && Date.now() < freshTintUntil && draft.value.length === freshTintDocLen) {
    for (const f of freshTint) decorations.push({s: f.s, e: f.e, cls: 'fresh'});
  }
  if (flags.size) {
    for (const r of resolveFlags()) {
      if (r.seg) decorations.push({s: r.seg.start, e: r.seg.end, cls: r.flag.kind === 'resume' ? 'resumemark' : 'flagmark'});
    }
  }
  if (!decorations.length) {
    clearHighlight();
    return;
  }
  // Flatten possibly-overlapping decorations into non-overlapping spans that
  // carry every class active over them.
  const points = [...new Set(decorations.flatMap((d) => [d.s, d.e]))].sort((a, b) => a - b);
  let html = '';
  let pos = 0;
  for (let i = 0; i < points.length; i++) {
    const from = points[i];
    const to = points[i + 1] !== undefined ? points[i + 1] : from;
    html += escapeHtml(text.slice(pos, from));
    pos = from;
    if (to <= from) continue;
    const classes = decorations.filter((d) => d.s < to && d.e > from).map((d) => d.cls);
    const unique = [...new Set(classes)];
    if (unique.length) {
      html += `<u class="${unique.join(' ')}">` + escapeHtml(text.slice(from, to)) + '</u>';
      pos = to;
    }
  }
  backdropContent.innerHTML = html + escapeHtml(text.slice(pos)) + '\n';
  syncBackdropScroll();
}

function countSyllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  let groups = (w.match(/[aeiouy]+/g) || []).length;
  if (w.endsWith('e') && !w.endsWith('le') && groups > 1) groups--;
  return Math.max(1, groups);
}

function updateStats() {
  const t = draft.value;
  if (!t.trim()) {
    statsInfo.textContent = '';
    return;
  }
  const segs = segmentText(t, 0, t.length);
  const sentences = segs.length;
  let words = 0;
  let syllables = 0;
  let longest = 0;
  for (const sSpan of segs) {
    const ws = t.slice(sSpan.start, sSpan.end).match(/[A-Za-z0-9']+/g) || [];
    words += ws.length;
    if (ws.length > longest) longest = ws.length;
    for (const word of ws) syllables += countSyllables(word);
  }
  if (!words || !sentences) {
    statsInfo.textContent = '';
    return;
  }
  const grade = 0.39 * (words / sentences) + 11.8 * (syllables / words) - 15.59;
  statsInfo.textContent =
    `${words.toLocaleString()} words · ${sentences} sentence${sentences === 1 ? '' : 's'} · ` +
    `avg ${(words / sentences).toFixed(1)} words each · longest ${longest} · ` +
    `reading grade ~${Math.max(0, grade).toFixed(1)}`;
}

/* --------------------- Server link and integrity ------------------ */

// While this tab is open, a periodic touch of a real file keeps the
// launcher's idle-shutdown timer armed only for after the tab closes.
// Two consecutive failures mean the drive (or server) is gone.
let serverLost = false;
let heartbeatMisses = 0;
let integrityProblem = null;

function heartbeat() {
  if (typeof fetch !== 'function') return;
  fetch('VOICE-EDITION.txt', {cache: 'no-store'})
    .then((r) => {
      if (!r.ok) throw new Error('bad status');
      heartbeatMisses = 0;
      serverLost = false;
    })
    .catch(() => {
      heartbeatMisses++;
      if (heartbeatMisses >= 2 && !serverLost) {
        serverLost = true;
        if (mode === 'idle') {
          setStatus('error', 'Lost contact with the drive',
            'The Read Aloud server is not answering — the USB drive may have been removed. Your text and any rendered audio are still in this tab; export anything you need before closing.');
        }
      }
    });
}

const HEARTBEAT_MS = (typeof window !== 'undefined' && window.__RA_HEARTBEAT_MS) || 2 * 60 * 1000; // well inside the idle window even under background-tab throttling
if (!openedDirectly) setInterval(heartbeat, HEARTBEAT_MS);

function checkIntegrity() {
  if (typeof fetch !== 'function' || openedDirectly) return;
  fetch('/health', {cache: 'no-store'})
    .then((r) => (r.ok ? r.text() : ''))
    .then((text) => {
      const m = /integrity:failed:(\d+)\/(\d+)/.exec(text);
      if (m) {
        integrityProblem = `${m[1]} of ${m[2]} files on this drive failed their integrity check`;
      }
    })
    .catch(() => { /* health is best-effort */ });
}

/* ----------------- Settings, theme, font, sessions ---------------- */

const darkQuery = typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null;

function applyTheme() {
  const setting = themeSelect.value;
  const resolved = setting === 'auto'
    ? (darkQuery && darkQuery.matches ? 'dark' : 'light')
    : setting;
  document.documentElement.dataset.theme = resolved;
}

if (darkQuery && typeof darkQuery.addEventListener === 'function') {
  darkQuery.addEventListener('change', () => {
    if (themeSelect.value === 'auto') applyTheme();
  });
}

function applyFont() {
  const family = fontSelect.value === 'hyper'
    ? '"Atkinson Hyperlegible", system-ui, sans-serif'
    : 'Georgia, "Times New Roman", serif';
  document.documentElement.style.setProperty('--editor-font', family);
  if (mode !== 'idle' && segments[Math.min(playPos, segments.length - 1)]) {
    renderHighlight(segments[Math.min(playPos, segments.length - 1)]);
  } else {
    syncIdleBackdrop();
  }
}

function currentSettings() {
  return {
    v: 1,
    speed: Number(speed.value),
    gap: Number(gap.value),
    fontScale: Number(fontScale.value),
    lineSpacing: Number(lineSpacing.value),
    font: fontSelect.value,
    theme: themeSelect.value,
    volume: Number(volume.value),
    pitch: Number(pitch.value),
    delivery: deliveryPreset,
    autosave: autosaveToggle.checked,
    sections: (playbackGroup.open ? 1 : 0) | (displayGroup.open ? 2 : 0),
    cleanPaste: cleanPasteToggle.checked,
    resume: resumeToggle.checked,
    step: stepToggle.checked,
    focus: focusToggle.checked,
    labels: labelsToggle.checked,
    voice: currentVoice ? currentVoice.id : (preferredVoiceId || undefined),
    speaker: Object.keys(speakerChoice).length ? {...speakerChoice} : undefined,
    dict: Object.fromEntries(pronunciationDict),
  };
}

function settingsString() {
  return 'RA1 ' + JSON.stringify(currentSettings());
}

const clampNum = (v, lo, hi, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

function applySettingsObject(obj) {
  if (!obj || typeof obj !== 'object') return false;
  speed.value = String(clampNum(obj.speed, 0.65, 1.45, Number(speed.value)));
  gap.value = String(clampNum(obj.gap, 0, 1.5, Number(gap.value)));
  fontScale.value = String(clampNum(obj.fontScale, 0.8, 1.6, Number(fontScale.value)));
  lineSpacing.value = String(clampNum(obj.lineSpacing, 1.3, 2.4, Number(lineSpacing.value)));
  if (obj.font === 'serif' || obj.font === 'hyper') fontSelect.value = obj.font;
  if (obj.theme === 'auto' || obj.theme === 'light' || obj.theme === 'dark') themeSelect.value = obj.theme;
  if (typeof obj.step === 'boolean') stepToggle.checked = obj.step;
  if (typeof obj.cleanPaste === 'boolean') cleanPasteToggle.checked = obj.cleanPaste;
  if (typeof obj.resume === 'boolean' && obj.resume !== resumeToggle.checked) {
    resumeToggle.checked = obj.resume;
    if (!obj.resume) {
      const rid = resumeFlagId();
      if (rid !== null) { flags.delete(rid); refreshFlags(); }
    }
  }
  if (Number.isInteger(obj.sections) && obj.sections >= 0 && obj.sections <= 3) {
    playbackGroup.open = (obj.sections & 1) !== 0;
    displayGroup.open = (obj.sections & 2) !== 0;
  }
  if (typeof obj.autosave === 'boolean' && obj.autosave !== autosaveToggle.checked) {
    autosaveToggle.checked = obj.autosave;
    applyAutosaveState();
  }
  if (typeof obj.focus === 'boolean') focusToggle.checked = obj.focus;
  if (typeof obj.labels === 'boolean') labelsToggle.checked = obj.labels;
  if (typeof obj.voice === 'string' && /^[a-z0-9-]{1,64}$/.test(obj.voice)) {
    preferredVoiceId = obj.voice;
    if (voiceCatalog.length && (!currentVoice || currentVoice.id !== obj.voice)) switchVoice(obj.voice);
  }
  if (obj.speaker && typeof obj.speaker === 'object' && !Array.isArray(obj.speaker)) {
    speakerChoice = {};
    for (const [k, v] of Object.entries(obj.speaker).slice(0, 50)) {
      const n = Number(v);
      if (/^[a-z0-9-]{1,64}$/.test(k) && Number.isInteger(n) && n >= 0 && n <= 4095) speakerChoice[k] = n;
    }
    if (currentVoice && !currentVoice.lockedSpeaker && Number.isInteger(speakerChoice[currentVoice.id])) {
      currentSpeaker = speakerChoice[currentVoice.id];
      if (currentVoice.numSpeakers && currentSpeaker >= currentVoice.numSpeakers) currentSpeaker = 0;
      renderSpeakerSelect();
    }
  }
  if (obj.dict && typeof obj.dict === 'object' && !Array.isArray(obj.dict)) {
    pronunciationDict = Object.entries(obj.dict)
      .filter(([k, v]) => typeof k === 'string' && typeof v === 'string' && k.length <= 80 && v.length <= 120)
      .slice(0, 200);
    compilePronunciationDict();
  }
  volume.value = String(clampNum(obj.volume, 0, 1, Number(volume.value)));
  pitch.value = String(clampNum(obj.pitch, 0.85, 1.15, Number(pitch.value)));
  if (obj.delivery === 'natural' || obj.delivery === 'steady') {
    if (obj.delivery !== deliveryPreset) switchDelivery(obj.delivery);
  }
  speedValue.value = `${Number(speed.value).toFixed(2)}×`;
  gapValue.value = `${Number(gap.value).toFixed(2)}s`;
  volumeValue.value = `${Math.round(Number(volume.value) * 100)}%`;
  pitchValue.value = pitchLabel();
  if (gainNode) gainNode.gain.value = Number(volume.value);
  applyEditorMetrics();
  applyTheme();
  applyFont();
  if (mode === 'idle') refreshNarrationInfo();
  return true;
}

function parseSettingsString(raw) {
  let text = String(raw || '').trim();
  if (!text) return null;
  if (text.startsWith('RA1')) text = text.slice(3).trim();
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function loadSettingsFile() {
  if (typeof fetch !== 'function') return;
  fetch('settings.txt', {cache: 'no-store'})
    .then((r) => (r.ok ? r.text() : null))
    .then((text) => {
      if (!text) return;
      const obj = parseSettingsString(text);
      if (obj && applySettingsObject(obj)) {
        setStatus(statusDot.className.includes('ready') ? 'ready' : statusDot.classList[1] || 'loading',
          statusTitle.textContent, 'Settings loaded from settings.txt on this drive.');
      }
    })
    .catch(() => { /* no settings file: perfectly fine */ });
}

function sessionJson() {
  return JSON.stringify({
    v: 1,
    kind: 'read-aloud-session',
    draft: draft.value,
    flags: [...flags.values()],
    settings: currentSettings(),
  }, null, 1) + '\n';
}

function saveSession() {
  void saveOrDownload('session', 'read-aloud-session.json',
    new Blob([sessionJson()], {type: 'application/json'}), 'Session saved');
  cleanSnapshot = sessionFingerprint();
}

/* ------------------------ Autosave (opt-in) ----------------------- */
// Off by default: on an untrusted computer the draft lives only in this
// tab's memory. Turning it on writes a rolling session file to the drive
// every minute and whenever reading stops, with a visible indicator so
// it is always obvious which mode the machine is in.

const AUTOSAVE_MS = window.__RA_AUTOSAVE_MS || 60000;
let autosaveTimer = null;
let autosaveWarned = false;

async function autosaveNow() {
  if (!autosaveToggle.checked || openedDirectly || !draft.value.trim()) return;
  try {
    await saveToDrive('session', 'autosave.raSession', new Blob([sessionJson()], {type: 'application/json'}));
    autosaveWarned = false;
  } catch (err) {
    if (!autosaveWarned) {
      autosaveWarned = true;
      setStatus(statusDot.classList[1] || 'ready', statusTitle.textContent,
        `Autosave could not write to the drive (${String(err.message || err)}).`);
    }
  }
}

function applyAutosaveState() {
  autosaveDot.hidden = !autosaveToggle.checked;
  if (autosaveTimer) { clearInterval(autosaveTimer); autosaveTimer = null; }
  if (autosaveToggle.checked) {
    autosaveTimer = setInterval(() => { void autosaveNow(); }, AUTOSAVE_MS);
    void autosaveNow();
  }
}

/* --------------------- Paste cleanup (spec 4.4) -------------------- */
// Straightens smart punctuation and strips invisible characters that trip
// TTS. Runs on the pasted region only; the Tidy button applies it to the
// whole draft. Paragraph breaks are always preserved exactly.

function cleanText(t) {
  return String(t)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/\u2014/g, '--')
    .replace(/[\u2013\u2012]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[\u00AD\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ');
}

// Insert while keeping native textarea undo when the browser allows it.
function insertCleaned(text) {
  let ok = false;
  try { ok = document.execCommand('insertText', false, text); } catch (_) { ok = false; }
  if (!ok) {
    draft.setRangeText(text, draft.selectionStart, draft.selectionEnd, 'end');
    draft.dispatchEvent(new Event('input', {bubbles: true}));
  }
}

function tidyDraft() {
  const cleaned = cleanText(draft.value);
  if (cleaned === draft.value) {
    setStatus('ready', 'Already tidy', 'No smart quotes or hidden characters found.');
    return;
  }
  stopAll({restarting: true});
  draft.focus();
  draft.setSelectionRange(0, draft.value.length);
  insertCleaned(cleaned);
  draft.setSelectionRange(0, 0);
  setStatus('ready', 'Text tidied', 'Quotes straightened and hidden characters removed. Undo reverses it.');
}

/* ------------------- Text out and file drop in -------------------- */

function copyAllText() {
  if (!draft.value.trim()) {
    setStatus('ready', 'Nothing to copy', 'The draft is empty.');
    return;
  }
  const words = draft.value.trim().split(/\s+/).length;
  const done = () => setStatus('ready', 'Copied', `${words} word${words === 1 ? '' : 's'} copied to the clipboard.`);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(draft.value).then(done).catch(() => fallbackCopy(done));
  } else {
    fallbackCopy(done);
  }
}

function fallbackCopy(done) {
  const s = draft.selectionStart, e = draft.selectionEnd;
  draft.focus();
  draft.select();
  try { document.execCommand('copy'); } catch (_) { /* nothing else to try */ }
  draft.setSelectionRange(s, e);
  done();
}

function saveDraftText() {
  if (!draft.value.trim()) {
    setStatus('ready', 'Nothing to save', 'The draft is empty.');
    return;
  }
  void saveOrDownload('text', 'read-aloud-draft.txt', new Blob([draft.value], {type: 'text/plain'}), 'Draft saved');
}

// Optional addons: features that exist only when their folder is on the
// drive (spec 3.6). The page learns which are present at boot and lazy-loads
// their code (same-origin, so the CSP allows it) on first use.
let installedAddons = new Set();

function probeAddons() {
  if (openedDirectly || typeof fetch !== 'function') return;
  fetch('/api/addons', {cache: 'no-store'})
    .then((r) => (r.ok ? r.json() : null))
    .then((body) => {
      if (body && Array.isArray(body.addons)) installedAddons = new Set(body.addons.map(String));
    })
    .catch(() => { /* no launcher, no addons */ });
}

let mammothLoading = null;

function loadDocxAddon() {
  if (window.mammoth) return Promise.resolve();
  if (mammothLoading) return mammothLoading;
  mammothLoading = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = 'addons/docx/mammoth.browser.min.js';
    el.onload = () => (window.mammoth ? resolve() : reject(new Error('the docx addon did not load')));
    el.onerror = () => reject(new Error('the docx addon could not be loaded from the drive'));
    document.head.appendChild(el);
  }).catch((err) => { mammothLoading = null; throw err; });
  return mammothLoading;
}

async function importDocx(file) {
  setStatus('loading', 'Reading the Word document…', 'The file is being converted in memory; nothing is uploaded.');
  try {
    await loadDocxAddon();
    const arrayBuffer = await file.arrayBuffer();
    const result = await window.mammoth.extractRawText({arrayBuffer});
    const text = String(result && result.value || '').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) {
      setStatus('error', 'Nothing readable found', 'That document appears to contain no text.');
      return;
    }
    offerImport(text, String(file.name || 'document.docx'));
  } catch (err) {
    setStatus('error', 'Could not read the Word document', String((err && err.message) || err));
  }
}

// Dropped files are read straight into memory — no upload, no temp files.
let pendingImport = null;

function applyImport(text, name) {
  stopAll({restarting: true});
  draft.value = text;
  flags.size && refreshFlags();
  runLint();
  updateStats();
  syncIdleBackdrop();
  updateButtons();
  describeSelection();
  refreshNarrationInfo();
  setStatus('ready', `Opened ${name}`, 'The file was read into memory only; nothing was copied onto this computer.');
}

function offerImport(text, name) {
  const dirty = draft.value.trim() && sessionFingerprint() !== cleanSnapshot;
  if (!dirty) {
    applyImport(text, name);
    return;
  }
  pendingImport = {text, name};
  importName.textContent = name;
  importBanner.hidden = false;
}

function handleDroppedFile(file) {
  if (!file) return;
  const name = String(file.name || 'file');
  if (/\.doc$/i.test(name)) {
    setStatus('ready', 'That is the older Word format', 'This .doc file predates .docx. Open it in Word (or LibreOffice) and use Save As → Word Document (.docx), then drop it here.');
    return;
  }
  if (/\.docx$/i.test(name)) {
    if (installedAddons.has('docx')) {
      void importDocx(file);
    } else {
      setStatus('ready', 'Word import is an optional addon', 'This drive does not have the docx addon installed. Drop a .txt or .md file, or add an addons/docx folder to the drive.');
    }
    return;
  }
  if (!/\.(txt|md)$/i.test(name)) {
    setStatus('ready', 'That file type cannot be opened', 'Drop a .txt or .md file onto the draft.');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => offerImport(String(reader.result || ''), name);
  reader.onerror = () => setStatus('error', 'Could not read the file', 'The dropped file could not be opened.');
  reader.readAsText(file);
}

/* --------------------- Autosave restore offer --------------------- */
// Never auto-load: an autosave from the drive is offered once, and the
// person decides.

function offerAutosaveRestore() {
  if (openedDirectly || typeof fetch !== 'function') return;
  fetch('/api/autosave', {cache: 'no-store'})
    .then((r) => (r.ok ? r.text() : null))
    .then((text) => {
      if (!text) return;
      let session = null;
      try { session = JSON.parse(text); } catch (_) { return; }
      if (!session || session.kind !== 'read-aloud-session') return;
      pendingRestore = text;
      restoreBanner.hidden = false;
    })
    .catch(() => { /* no autosave: perfectly fine */ });
}

let pendingRestore = null;

function openSessionData(text) {
  let session;
  try {
    session = JSON.parse(text);
  } catch (_) {
    setStatus('error', 'Could not open session', 'That file is not a Read Aloud session.');
    return;
  }
  if (!session || session.kind !== 'read-aloud-session') {
    setStatus('error', 'Could not open session', 'That file is not a Read Aloud session.');
    return;
  }
  stopAll({restarting: true});
  if (typeof session.draft === 'string') draft.value = session.draft;
  flags.clear();
  if (Array.isArray(session.flags)) {
    for (const f of session.flags.slice(0, 500)) {
      if (typeof f === 'string') {
        flags.set(++flagIdCounter, {text: f, before: '', after: ''}); // old session format
      } else if (f && typeof f.text === 'string') {
        const entry = {
          text: f.text.slice(0, 2000),
          before: String(f.before || '').slice(0, CONTEXT_CHARS * 2),
          after: String(f.after || '').slice(0, CONTEXT_CHARS * 2),
        };
        if (f.kind === 'resume' && resumeFlagId() === null) entry.kind = 'resume';
        flags.set(++flagIdCounter, entry);
      }
    }
  }
  if (session.settings) applySettingsObject(session.settings);
  refreshFlags();
  runLint();
  updateStats();
  syncIdleBackdrop();
  updateButtons();
  describeSelection();
  cleanSnapshot = sessionFingerprint();
  setStatus('ready', 'Session opened', 'Draft, flags, and settings were restored.');
}

/* --------------------- Worker wiring and events ------------------- */

function handleWorkerMessage(event) {
  const message = event.data || {};
  switch (message.type) {
    case 'sherpa-onnx-tts-progress': {
      // Emscripten fires trailing status callbacks after the engine is up;
      // without this guard they stomp the "ready" status back to "Loading",
      // leaving a working engine behind a stuck loading label.
      if (ready) break;
      armLoadWatchdog();
      const raw = String(message.status || 'Loading voice…');
      const match = raw.match(/Downloading data\.\.\. \((\d+)\/(\d+)\)/);
      if (match) {
        const received = Number(match[1]);
        const total = Number(match[2]);
        const percent = total > 0 ? Math.round((received / total) * 100) : 0;
        setStatus('loading', `Loading ${voiceName()}… ${percent}%`, 'Reading the offline model from this drive.');
      } else {
        setStatus('loading', `Loading ${voiceName()}…`, raw.replace('Running...', 'Initializing the voice model…'));
      }
      break;
    }
    case 'sherpa-onnx-tts-ready':
      ready = true;
      clearLoadWatchdog();
      if (currentVoice) {
        currentVoice.numSpeakers = Math.max(1, Number(message.numSpeakers) || 1);
        // Clamp a remembered or configured choice to what the model really has.
        if (currentSpeaker >= currentVoice.numSpeakers) currentSpeaker = 0;
      }
      renderSpeakerSelect();
      setStatus('ready', `${voiceName()} is ready`, integrityProblem
        ? `Warning: ${integrityProblem} — the voice loaded, but re-copy the bundle if anything sounds wrong.`
        : 'Place the cursor and press F8, or render the whole draft below.');
      updateButtons();
      break;
    case 'sherpa-onnx-tts-result':
      handleResult(message);
      break;
    case 'error': {
      const req = takeRequest(message);
      if (req && req.token === runToken && mode !== 'idle') {
        stopAll({restarting: true});
      }
      setStatus('error', 'Voice error', String(message.message || 'The speech engine failed.'));
      updateButtons();
      describeSelection();
      break;
    }
    default:
      break;
  }
}

function handleWorkerError(event) {
  ready = false;
  stopAll({restarting: true});
  clearLoadWatchdog();
  setStatus('error', 'Could not load the voice',
    loadFailureDetail(event.message || 'Check that the generated WASM files are present.'));
  updateButtons();
}

readButton.addEventListener('click', startReading);
stopButton.addEventListener('click', () => stopAll());
renderButton.addEventListener('click', startRender);
exportButton.addEventListener('click', exportWav);
exportMp3Button.addEventListener('click', exportMp3);
fontSelect.addEventListener('input', applyFont);
themeSelect.addEventListener('input', applyTheme);
focusToggle.addEventListener('input', syncFocusClass);
stepToggle.addEventListener('input', () => {
  if (!stepToggle.checked && awaitingStep) stepAdvance();
});
flagPanelToggle.addEventListener('click', () => {
  flagPanel.hidden = !flagPanel.hidden;
  refreshFlags();
});
flagReportButton.addEventListener('click', flagReport);
flagClearButton.addEventListener('click', () => {
  flags.clear();
  refreshFlags();
});
settingsShow.addEventListener('click', () => {
  settingsBox.value = settingsString();
});
settingsApply.addEventListener('click', () => {
  const obj = parseSettingsString(settingsBox.value);
  if (obj && applySettingsObject(obj)) {
    setStatus('ready', 'Settings applied', 'These reset on next launch unless saved as settings.txt.');
  } else {
    setStatus('error', 'Could not read settings', 'The settings text is not valid. Use "Show current" for a template.');
  }
});
settingsCopy.addEventListener('click', () => {
  settingsBox.value = settingsString();
  settingsBox.select();
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      void navigator.clipboard.writeText(settingsString());
    } else {
      document.execCommand('copy');
    }
  } catch (_) { /* the selected text can still be copied manually */ }
});
settingsDownload.addEventListener('click', () => {
  void saveOrDownload('text', 'settings.txt',
    new Blob([settingsString() + '\n'], {type: 'text/plain'}), 'Settings saved');
});
sessionSave.addEventListener('click', saveSession);
sessionOpen.addEventListener('click', () => sessionFile.click());
copyAllButton.addEventListener('click', copyAllText);
saveTxtButton.addEventListener('click', saveDraftText);
autosaveToggle.addEventListener('input', applyAutosaveState);
restoreYes.addEventListener('click', () => {
  restoreBanner.hidden = true;
  if (pendingRestore) openSessionData(pendingRestore);
  pendingRestore = null;
});
restoreNo.addEventListener('click', () => { restoreBanner.hidden = true; pendingRestore = null; });
importYes.addEventListener('click', () => {
  importBanner.hidden = true;
  if (pendingImport) applyImport(pendingImport.text, pendingImport.name);
  pendingImport = null;
});
importNo.addEventListener('click', () => { importBanner.hidden = true; pendingImport = null; });
function toggleHelp(force) {
  helpOverlay.hidden = force !== undefined ? !force : !helpOverlay.hidden;
}
helpButton.addEventListener('click', () => toggleHelp());
helpClose.addEventListener('click', () => toggleHelp(false));
helpOverlay.addEventListener('click', (e) => { if (e.target === helpOverlay) toggleHelp(false); });
tidyButton.addEventListener('click', tidyDraft);
resumeToggle.addEventListener('input', () => {
  if (!resumeToggle.checked) {
    const rid = resumeFlagId();
    if (rid !== null) { flags.delete(rid); refreshFlags(); }
  }
});
draft.addEventListener('paste', (e) => {
  if (!cleanPasteToggle.checked) return;
  const clip = e.clipboardData || window.clipboardData;
  const data = clip && clip.getData ? clip.getData('text/plain') : null;
  if (typeof data !== 'string' || !data) return;
  const cleaned = cleanText(data);
  if (cleaned === data) return; // nothing to fix: let the browser paste natively
  e.preventDefault();
  insertCleaned(cleaned);
});
draft.addEventListener('dragover', (e) => e.preventDefault());
draft.addEventListener('drop', (e) => {
  e.preventDefault();
  handleDroppedFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
});
sessionFile.addEventListener('change', () => {
  const file = sessionFile.files && sessionFile.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => openSessionData(String(reader.result || ''));
  reader.readAsText(file);
  sessionFile.value = '';
});
quitButton.addEventListener('click', () => {
  if (typeof fetch !== 'function') return;
  stopAll({restarting: true});
  fetch('/quit', {method: 'POST', headers: {'X-RA-Token': runTokenHeader()}})
    .catch(() => { /* the server may already be gone */ })
    .finally(() => {
      ready = false;
      setStatus('ready', 'Read Aloud stopped', 'The local server has shut down. You can close this tab now.');
      updateButtons();
    });
});
clearButton.addEventListener('click', () => {
  stopAll({restarting: true});
  draft.value = '';
  // A deliberate wipe drops the transient resume bookmark; user flags are
  // kept (they have their own Clear flags button) but repaint as nothing.
  const rid = resumeFlagId();
  if (rid !== null) flags.delete(rid);
  refreshFlags();
  draft.focus();
  runHeavyEditorWork(); // same pipeline as an edit: lint, stats, backdrop repaint
  if (ready) setStatus('ready', `${voiceName()} is ready`, 'Paste text, then press F8 or render the draft.');
  updateButtons();
  describeSelection();
});

voiceSelect.addEventListener('input', () => switchVoice(voiceSelect.value));
speakerSelect.addEventListener('input', () => switchSpeaker(speakerSelect.value));

volume.addEventListener('input', () => {
  volumeValue.value = `${Math.round(Number(volume.value) * 100)}%`;
  if (gainNode) gainNode.gain.value = Number(volume.value);
});

pitch.addEventListener('input', () => {
  pitchValue.value = pitchLabel();
  if (mode === 'idle') refreshNarrationInfo();
});

deliveryNatural.addEventListener('click', () => switchDelivery('natural'));
deliverySteady.addEventListener('click', () => switchDelivery('steady'));

speed.addEventListener('input', () => {
  speedValue.value = `${Number(speed.value).toFixed(2)}×`;
  if (mode === 'idle') refreshNarrationInfo();
});

gap.addEventListener('input', () => {
  gapValue.value = `${Number(gap.value).toFixed(2)}s`;
});

function applyEditorMetrics() {
  document.documentElement.style.setProperty('--font-scale', fontScale.value);
  document.documentElement.style.setProperty('--line-height', lineSpacing.value);
  fontValue.value = `${Math.round(Number(fontScale.value) * 100)}%`;
  spacingValue.value = Number(lineSpacing.value).toFixed(2);
  // Metrics changed, so re-anchor the highlight to the reflowed text.
  if (mode !== 'idle' && segments[Math.min(playPos, segments.length - 1)]) {
    renderHighlight(segments[Math.min(playPos, segments.length - 1)]);
  }
  syncBackdropScroll();
}

fontScale.addEventListener('input', applyEditorMetrics);
lineSpacing.addEventListener('input', applyEditorMetrics);

for (const eventName of ['select', 'keyup', 'click']) {
  draft.addEventListener(eventName, describeSelection);
}

const HEAVY_WORK_SYNC_LIMIT = 20000; // characters; larger drafts debounce
let heavyWorkTimer = null;

function runHeavyEditorWork() {
  refreshNarrationInfo();
  runLint();
  updateStats();
  syncIdleBackdrop();
  if (!flagPanel.hidden) renderFlagPanel(); // an open panel tracks edits live
}

draft.addEventListener('input', () => {
  if (mode !== 'idle') {
    stopAll({keepCaret: true});
    if (ready) setStatus('ready', `${voiceName()} is ready`, 'Press F8 to read, or render the draft below.');
    updateButtons();
  }
  describeSelection();
  if (draft.value.length <= HEAVY_WORK_SYNC_LIMIT) {
    if (heavyWorkTimer) { clearTimeout(heavyWorkTimer); heavyWorkTimer = null; }
    runHeavyEditorWork();
  } else {
    if (heavyWorkTimer) clearTimeout(heavyWorkTimer);
    heavyWorkTimer = setTimeout(() => {
      heavyWorkTimer = null;
      runHeavyEditorWork();
    }, 200);
  }
});

draft.addEventListener('scroll', syncBackdropScroll);

if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => {
    if (mode !== 'idle' && segments[Math.min(playPos, segments.length - 1)]) {
      renderHighlight(segments[Math.min(playPos, segments.length - 1)]);
    }
    syncBackdropScroll();
  }).observe(draft);
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !helpOverlay.hidden) {
    toggleHelp(false);
    event.preventDefault();
    return;
  }
  if (event.key === '?' && document.activeElement !== draft && document.activeElement !== settingsBox) {
    toggleHelp();
    event.preventDefault();
    return;
  }
  if (event.key === 'F8') {
    event.preventDefault();
    if (awaitingStep) stepAdvance();
    else startReading();
  } else if (event.key === 'F7') {
    event.preventDefault();
    replayCurrent();
  } else if (event.key === 'F9') {
    event.preventDefault();
    toggleFlag();
  } else if (event.key === 'F10') {
    event.preventDefault();
    nextFlag();
  } else if (event.key === ' ' && awaitingStep && document.activeElement !== draft) {
    event.preventDefault();
    stepAdvance();
  } else if (event.key === 'Escape') {
    stopAll();
  }
});

// beforeunload only asks; it must not tear anything down, because the user
// may cancel the close and keep working. Real teardown happens on pagehide,
// which only fires when the page is actually going away.
window.addEventListener('beforeunload', (event) => {
  if (draft.value.trim() && sessionFingerprint() !== cleanSnapshot) {
    event.preventDefault();
    event.returnValue = '';
  }
});

window.addEventListener('pagehide', () => {
  stopAll({restarting: true});
  if (worker) worker.terminate();
  if (audioContext) void audioContext.close();
});

describeSelection();
updateButtons();
runLint();
updateStats();
applyEditorMetrics();
applyTheme();
applyFont();
refreshFlags();
checkIntegrity();
loadSettingsFile();
loadVoiceCatalog();
probeAddons();
offerAutosaveRestore();
cleanSnapshot = sessionFingerprint();

if (openedDirectly) {
  setStatus('error', 'Start with the launcher', 'This page cannot load the voice from file://. Open the matching START launcher in the parent folder.');
}
