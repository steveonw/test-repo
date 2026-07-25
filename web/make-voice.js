'use strict';
// Voice package maker + test bench. Works anywhere as a maker/validator;
// the live Test button needs the engine, so it activates only when this
// page is opened through the Read Aloud launcher (cross-origin isolated).

const $ = (id) => document.getElementById(id);
let modelBuf = null, tokensBuf = null, voicesBuf = null, cfg = null;
let sniffedKitten = false;   // model header says model_type=kitten-tts

/* ---------- CRC32 + store-only zip writer (no dependencies) ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function makeZip(files) { // [{name, data:Uint8Array}] -> Blob (store-only)
  const enc = new TextEncoder();
  const chunks = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(8, 0, true); // stored
    head.setUint32(14, crc, true);
    head.setUint32(18, f.data.length, true);
    head.setUint32(22, f.data.length, true);
    head.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(head.buffer), name, f.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true); c.setUint16(6, 20, true);
    c.setUint16(10, 0, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, f.data.length, true);
    c.setUint32(24, f.data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) cdSize += c.length;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, cdStart, true);
  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], {type: 'application/zip'});
}

/* ------------------------- manifest + rules ------------------------- */
const ID_RULE = /^[a-z0-9][a-z0-9-]{0,63}$/;
function isKitten() { return !!voicesBuf; }

function buildManifest(id, name, config, opts = {}) {
  const kitten = opts.kitten !== undefined ? opts.kitten : isKitten();
  const base = {
    schemaVersion: 1, id, name,
    language: (config && config.language && (config.language.name_english || config.language.name)) || 'English',
    locale: ((config && config.language && config.language.code) || 'en-US').replace('_', '-'),
    engine: kitten ? 'sherpa-kitten' : 'sherpa-vits',
    architecture: kitten ? 'kitten' : 'vits',
    model: 'model.onnx', tokens: 'tokens.txt',
    quality: (config && config.audio && config.audio.quality) || (id.split('-').pop() || 'medium'),
    quantization: 'none',
    // KittenTTS runs at 24 kHz; piper medium/high at 22.05 kHz. The engine
    // reads the true rate from the model either way — this is metadata.
    sampleRate: (config && config.audio && config.audio.sample_rate) || (kitten ? 24000 : 22050),
    minimumRuntimeVersion: '1',
  };
  if (kitten) {
    base.voices = 'voices.bin';
    base.speakerId = Number(opts.speakerId !== undefined ? opts.speakerId : ($('speakerId') ? $('speakerId').value : 0)) || 0;
  }
  return base;
}
function validateAll() {
  const id = $('voiceId').value.trim();
  const kitten = isKitten();
  const checks = [
    ['A model file (.onnx) is loaded', !!modelBuf],
    ['The model looks big enough to be real', !!modelBuf && modelBuf.byteLength > 1000000],
    ['A tokens.txt file is loaded', !!tokensBuf && tokensBuf.byteLength > 0],
    ['The id uses only lowercase letters, digits, and hyphens', ID_RULE.test(id)],
    ['A display name is set', $('voiceName').value.trim().length > 0],
  ];
  if (sniffedKitten || kitten) {
    // A kitten model without its style rows will load and then fail, so this
    // is a hard requirement rather than a suggestion.
    checks.push(['KittenTTS model — voices.bin (style rows) is loaded', !!voicesBuf]);
    checks.push(['voices.bin looks like real style data', !!voicesBuf && voicesBuf.byteLength > 100000]);
  } else {
    checks.push(['Piper config found (exact sample rate and language)', !!cfg, true]);
  }
  const fam = $('family');
  if (fam) {
    fam.textContent = kitten
      ? 'KittenTTS package — model + tokens + voices.bin'
      : (sniffedKitten ? 'looks like KittenTTS — add voices.bin' : 'Piper VITS package — model + tokens');
    fam.className = 'family ' + (kitten ? 'kitten' : (sniffedKitten ? 'warnfam' : 'vits'));
  }
  const spk = $('speakerRow');
  if (spk) spk.hidden = !kitten;
  $('checks').innerHTML = checks.map(([label, ok, soft]) =>
    `<li class="${ok ? 'ok' : (soft ? 'soft' : 'bad')}">${ok ? '✓' : (soft ? '•' : '✗')} ${label}${(!ok && soft) ? ' — defaults will be used' : ''}</li>`).join('');
  const hardOk = checks.filter((c) => !c[2]).every((c) => c[1]);
  $('downloadBtn').disabled = !hardOk;
  $('testBtn').disabled = !hardOk || !window.crossOriginIsolated;
  return hardOk;
}

// ONNX stores metadata as plain strings in the protobuf, and writes
// metadata_props at the TAIL of the file (after the weights), so both ends are
// scanned. Far lighter than parsing protobuf in the browser.
function sniffArchitecture(buf) {
  const dec = new TextDecoder('latin1');
  const win = 65536;
  const n = buf.byteLength;
  const head = dec.decode(new Uint8Array(buf, 0, Math.min(n, win)));
  const tail = n > win ? dec.decode(new Uint8Array(buf, n - win, win)) : '';
  return /kitten-tts/i.test(head) || /kitten-tts/i.test(tail);
}

async function readFile(file, kind) {
  const buf = await file.arrayBuffer();
  if (kind === 'model') {
    modelBuf = buf;
    try { sniffedKitten = sniffArchitecture(buf); } catch (_) { sniffedKitten = false; }
  }
  if (kind === 'tokens') tokensBuf = buf;
  if (kind === 'voices') voicesBuf = buf;
  if (kind === 'config') {
    try { cfg = JSON.parse(new TextDecoder().decode(buf)); } catch (_) { cfg = null; }
  }
  validateAll();
}
for (const [inputId, kind] of [['modelFile', 'model'], ['tokensFile', 'tokens'], ['voicesFile', 'voices'], ['configFile', 'config']]) {
  $(inputId).addEventListener('change', () => {
    const f = $(inputId).files && $(inputId).files[0];
    if (f) readFile(f, kind);
  });
}
$('voiceName').addEventListener('input', () => {
  const auto = $('voiceName').value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!$('voiceId').dataset.touched) $('voiceId').value = auto;
  validateAll();
});
$('voiceId').addEventListener('input', () => { $('voiceId').dataset.touched = '1'; validateAll(); });

$('downloadBtn').addEventListener('click', () => {
  const id = $('voiceId').value.trim();
  const manifest = buildManifest(id, $('voiceName').value.trim(), cfg);
  const enc = new TextEncoder();
  const files = [
    {name: `voices/${id}/voice.json`, data: enc.encode(JSON.stringify(manifest, null, 1) + '\n')},
    {name: `voices/${id}/model.onnx`, data: new Uint8Array(modelBuf)},
    {name: `voices/${id}/tokens.txt`, data: new Uint8Array(tokensBuf)},
  ];
  if (voicesBuf) files.push({name: `voices/${id}/voices.bin`, data: new Uint8Array(voicesBuf)});
  const blob = makeZip(files);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${id}-voice-package.zip`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  $('status').textContent = `Package ready: unzip it at the top level of the Read Aloud drive (it contains voices/${id}/), then relaunch.`;
});

/* --------------------------- test bench ---------------------------- */
let testWorker = null;
let audioCtx = null;
$('testBtn').addEventListener('click', () => {
  if (testWorker) testWorker.terminate();
  $('status').textContent = 'Loading the engine with this voice…';
  testWorker = new Worker('sherpa-onnx-tts.worker.js', {type: 'module'});
  testWorker.onmessage = (e) => {
    const m = e.data || {};
    if (m.type === 'sherpa-onnx-tts-progress') $('status').textContent = `Loading… ${String(m.status || '').slice(0, 60)}`;
    else if (m.type === 'sherpa-onnx-tts-ready') {
      $('status').textContent = 'Voice loaded — speaking the test sentence…';
      testWorker.postMessage({type: 'generate', text: $('testText').value || 'This is a test of the new voice.', speed: 1});
    } else if (m.type === 'sherpa-onnx-tts-result') {
      audioCtx = audioCtx || new AudioContext();
      const buf = audioCtx.createBuffer(1, m.samples.length, m.sampleRate);
      buf.getChannelData(0).set(m.samples);
      const src = audioCtx.createBufferSource();
      src.buffer = buf; src.connect(audioCtx.destination); src.start();
      window.__testSamples = m.samples.length;
      $('status').textContent = `Spoke ${(m.samples.length / m.sampleRate).toFixed(1)}s of audio at ${m.sampleRate} Hz. If it sounds right, download the package.`;
    } else if (m.type === 'error') {
      $('status').textContent = `This voice failed to load: ${m.message}. It may not be a compatible Piper VITS model.`;
    }
  };
  testWorker.onerror = (e) => { $('status').textContent = `Engine error: ${e.message || 'could not start'}`; };
  testWorker.postMessage({
    type: 'init',
    arch: isKitten() ? 'kitten' : 'vits',
    speakerId: $('speakerId') ? Number($('speakerId').value) || 0 : 0,
    modelData: modelBuf.slice(0),
    tokensData: tokensBuf.slice(0),
    voicesData: voicesBuf ? voicesBuf.slice(0) : null,
  });
});

if (!window.crossOriginIsolated) {
  $('benchNote').textContent = 'Testing is available when this page is opened through the Read Aloud launcher (start the app, then open make-voice.html at the same address). Package building works everywhere.';
}
window.__mv = {makeZip, buildManifest, crc32, ID_RULE, sniffArchitecture}; // for the test suite
validateAll();
