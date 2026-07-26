const {JSDOM} = require('jsdom');
const fs = require('fs');
const dir = process.argv[2];
const port = process.argv[3];
const html = fs.readFileSync(`${dir}/web/index.html`, 'utf8');
const appjs = fs.readFileSync(`${dir}/web/app.js`, 'utf8');

// ---- segmenter unit suite ----
const begin = appjs.indexOf('const ABBREVIATIONS');
const end = appjs.indexOf('function buildSegments');
eval(appjs.slice(begin, end));
const seg = (t) => segmentText(t, 0, t.length).map(s => t.slice(s.start, s.end));
const unitCases = [
  ['Hello world. This is fine! Right?', ['Hello world.', 'This is fine!', 'Right?']],
  ['Mr. Smith met Dr. Jones. They left.', ['Mr. Smith met Dr. Jones.', 'They left.']],
  ['Use fruit, e.g. apples. Then stop.', ['Use fruit, e.g. apples.', 'Then stop.']],
  ['The U.S. economy grew. It slowed later.', ['The U.S. economy grew.', 'It slowed later.']],
  ['Pi is 3.14 exactly. Not really.', ['Pi is 3.14 exactly.', 'Not really.']],
  ['J. K. Rowling wrote it. I read it.', ['J. K. Rowling wrote it.', 'I read it.']],
  ['1. Introduction\n2. Body text here.', ['1. Introduction', '2. Body text here.']],
  ['Wait... maybe not. Fine.', ['Wait...', 'maybe not.', 'Fine.']],
  ['He said "Stop." Then he left.', ['He said "Stop."', 'Then he left.']],
  ['What?! No way. Yes.', ['What?!', 'No way.', 'Yes.']],
  ['Line one\nLine two\n\nLine three.', ['Line one', 'Line two', 'Line three.']],
  ['trailing text without period', ['trailing text without period']],
];
let unitPass = 0;
for (const [input, expected] of unitCases) {
  if (JSON.stringify(seg(input)) === JSON.stringify(expected)) unitPass++;
  else console.log('UNIT FAIL:', input, '→', JSON.stringify(seg(input)));
}
const long = 'word '.repeat(300) + 'end.';
const spans = segmentText(long, 0, long.length);
if (spans.every(s => s.end - s.start <= 600)) unitPass++; else console.log('UNIT FAIL: chunking');
console.log(`[${dir}] segmenter: ${unitPass}/${unitCases.length + 1}`);

// ---- shared harness ----
function makeWorld(preSeed) {
  const dom = new JSDOM(html, {url: `http://127.0.0.1:${port}/`, runScripts: 'outside-only'});
  const w = dom.window;
  const world = {w, workerInstance: null, mp3Worker: null, liveSources: [], exportedBlob: null, blobs: []};
  class MockWorker {
    constructor(script) {
      if (String(script).includes('mp3')) world.mp3Worker = this;
      else { world.workerInstance = this; world.ttsWorkers = (world.ttsWorkers || 0) + 1; }
      this.received = [];
      this.terminated = false;
    }
    postMessage(m) {
      if (m && m.type === 'init') { world.lastInit = m; return; }
      this.received.push(m);
    }
    terminate() { this.terminated = true; }
  }
  class MockAudioContext {
    async resume() {} async close() {}
    createBuffer(c, len) { return {getChannelData: () => new Float32Array(len)}; }
    createGain() {
      const g = {gain: {value: 1}, connect() {}};
      world.gainNodes = world.gainNodes || [];
      world.gainNodes.push(g);
      return g;
    }
    createBufferSource() {
      world.sourcesCreated = (world.sourcesCreated || 0) + 1;
      const s = {onended: null, playbackRate: {value: 1}, connect() {}, start() { world.liveSources.push(s); }, stop() { world.liveSources = world.liveSources.filter(x => x !== s); }};
      return s;
    }
    get destination() { return {}; }
  }
  w.Worker = MockWorker; w.AudioContext = MockAudioContext; w.ResizeObserver = class { observe() {} };
  w.URL.createObjectURL = (b) => { world.exportedBlob = b; world.blobs.push(b); return 'blob:test'; };
  w.fetch = (url, opts) => {
    world.fetches = world.fetches || [];
    world.fetches.push({url: String(url), opts});
    if (world.failFetches) return Promise.reject(new Error('drive gone'));
    if (String(url) === 'settings.txt' && world.settingsTxt) {
      return Promise.resolve({ok: true, text: () => Promise.resolve(world.settingsTxt)});
    }
    if (String(url) === '/api/voices') {
      const catalog = world.voiceCatalog || {voices: [
        {id: 'amy-medium', name: 'Amy', quality: '', sampleRate: 22050, architecture: 'vits',
         modelUrl: 'voices/amy-medium/model.onnx', tokensUrl: 'voices/amy-medium/tokens.txt'},
        {id: 'lessac-high', name: 'Lessac High', quality: 'high', sampleRate: 22050, architecture: 'vits',
         modelUrl: 'voices/lessac-high/model.onnx', tokensUrl: 'voices/lessac-high/tokens.txt'},
      ], invalid: []};
      return Promise.resolve({ok: true, json: () => Promise.resolve(catalog), text: () => Promise.resolve('')});
    }
    if (String(url) === '/api/save' && opts && opts.method === 'POST') {
      if (world.failSaves) return Promise.resolve({ok: false, status: 507, json: () => Promise.resolve({error: 'the drive is write-protected, so the file could not be saved'})});
      const req = JSON.parse(opts.body);
      req.headers = opts.headers || {};
      world.saves = world.saves || [];
      world.saves.push(req);
      return Promise.resolve({ok: true, json: () => Promise.resolve({saved: `saves/${req.kind}/${req.name}`})});
    }
    if (String(url) === '/api/addons') {
      return Promise.resolve({ok: true, json: () => Promise.resolve({addons: world.addonsList || []})});
    }
    if (String(url) === '/api/autosave') {
      return Promise.resolve({ok: true, text: () => Promise.resolve(world.autosaveFile || '{"none":true}')});
    }
    if (String(url) === '/health') {
      return Promise.resolve({ok: true, text: () => Promise.resolve(world.healthText || 'readaloud:abc\nintegrity:ok:9')});
    }
    if (String(url) === 'VOICE-EDITION.txt') {
      return Promise.resolve({ok: true, text: () => Promise.resolve('edition')});
    }
    return Promise.resolve({ok: false, text: () => Promise.resolve('')});
  };
  w.URL.revokeObjectURL = () => {};
  if (preSeed) preSeed(world);
  w.eval(appjs);
  return (async () => {
    for (let i = 0; i < 50 && !world.workerInstance; i++) await new Promise((r) => setTimeout(r, 5));
    return world;
  })();
}
const tick = () => new Promise(r => setTimeout(r, 0));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await tick(); };
const lastSave = (world, kind) => (world.saves || []).filter((x) => x.kind === kind).slice(-1)[0];
const saveBuf = (world, kind) => Buffer.from(lastSave(world, kind).dataBase64, 'base64');
const results = [];
const check = (n, c, x='') => { results.push([c, n]); if (!c) console.log('  detail:', x); };

(async () => {
  /* ============ playback suite ============ */
  {
    const world = await makeWorld();
    const {w} = world;
    const $ = (id) => w.document.getElementById(id);
    const sendResult = () => world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-result', samples: new Float32Array(8), sampleRate: 22050}});
    const endCurrent = () => { const s = world.liveSources.shift(); if (s && s.onended) s.onended(); };
    const markText = () => { const m = $('backdropContent').querySelector('mark'); return m ? m.textContent : null; };
    const key = (k) => w.document.dispatchEvent(new w.KeyboardEvent('keydown', {key: k}));

    world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-ready'}});
    world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-progress', status: ''}});
    check('late engine status cannot stomp ready label', /is ready/.test($('statusTitle').textContent), $('statusTitle').textContent);
    $('gap').value = '0';
    $('gap').dispatchEvent(new w.Event('input', {bubbles: true}));
    check('read button enabled after ready', !$('readButton').disabled);
    const draft = $('draft');
    draft.value = 'One one. Two two. Three three. Four four.';
    draft.setSelectionRange(9, 9);
    key('F8');
    check('first request is the cursor sentence', world.workerInstance.received.length === 1 && world.workerInstance.received[0].text === 'Two two.');
    sendResult(); await tick(); await tick();
    check('sentence 1 playing + highlighted', markText() === 'Two two.', markText());
    check('prefetch requested next sentence', world.workerInstance.received[1] && world.workerInstance.received[1].text === 'Three three.');
    check('status shows position', $('statusTitle').textContent === 'Reading 1 of 3');
    sendResult(); await tick();
    check('prefetch window holds at current+1', world.workerInstance.received.length === 2);
    endCurrent(); await tick(); await tick();
    check('advanced seamlessly', markText() === 'Three three.' && world.liveSources.length === 1);
    check('sentence 3 requested after advance', world.workerInstance.received.length === 3 && world.workerInstance.received[2].text === 'Four four.');
    key('Escape'); await tick();
    check('stop halts audio + clears highlight', world.liveSources.length === 0 && markText() === null);
    check('caret parked at stopped sentence', draft.selectionStart === draft.value.indexOf('Three three.'));
    key('F8'); await tick(); await tick();
    check('resume plays instantly from cache', world.liveSources.length === 1 && markText() === 'Three three.' && $('statusTitle').textContent === 'Reading 1 of 2', $('statusTitle').textContent);
    check('in-flight request deduped, not re-posted', world.workerInstance.received.length === 3, world.workerInstance.received.length);
    sendResult(); await tick();  // answers the pre-stop request; cached by key
    endCurrent(); await tick(); await tick();
    check('last sentence plays from recovered result', world.liveSources.length === 1 && markText() === 'Four four.', markText());
    endCurrent(); await tick();
    check('finishes cleanly', $('statusTitle').textContent === 'Finished reading' && draft.selectionStart === draft.value.length);
    draft.setSelectionRange(0, 8);
    key('F8'); await tick();
    check('selection mode reads only selection', world.workerInstance.received[world.workerInstance.received.length - 1].text === 'One one.');
    sendResult(); await tick(); await tick();
    check('single-segment status says Speaking', $('statusTitle').textContent === 'Speaking…', $('statusTitle').textContent);
    endCurrent(); await tick();
    draft.value = 'Alpha beta. Gamma delta.';
    draft.dispatchEvent(new w.Event('input', {bubbles: true}));
    draft.setSelectionRange(0, 0);
    key('F8'); sendResult(); await tick(); await tick();
    draft.setSelectionRange(5, 5);
    draft.dispatchEvent(new w.Event('input', {bubbles: true})); await tick();
    check('editing stops playback', $('stopButton').disabled && world.liveSources.length === 0);
    check('editing keeps user caret', draft.selectionStart === 5);
  }

  /* ============ narration suite ============ */
  {
    const world = await makeWorld();
    const {w} = world;
    const $ = (id) => w.document.getElementById(id);
    const SAMPLE_LEN = 100;
    const sendResult = () => world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-result', samples: new Float32Array(SAMPLE_LEN).fill(0.5), sampleRate: 22050}});
    const endCurrent = () => { const s = world.liveSources.shift(); if (s && s.onended) s.onended(); };
    const markText = () => { const m = $('backdropContent').querySelector('mark'); return m ? m.textContent : null; };
    const key = (k) => w.document.dispatchEvent(new w.KeyboardEvent('keydown', {key: k}));
    const drain = async (n) => { for (let i = 0; i < n; i++) { sendResult(); await tick(); } };

    world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-ready'}});
    const draft = $('draft');
    draft.value = 'First sentence here. Second sentence here.\n\nThird sentence here.';
    draft.dispatchEvent(new w.Event('input', {bubbles: true})); await tick();
    check('narration info counts sentences', $('narrationInfo').textContent === '3 sentences to render.', $('narrationInfo').textContent);
    check('render enabled, export disabled', !$('renderButton').disabled && $('exportButton').disabled);
    $('renderButton').click(); await tick();
    check('render progress + highlight', $('statusTitle').textContent === 'Rendering 1 of 3…' && markText() === 'First sentence here.');
    await drain(3);
    check('render finished', $('statusTitle').textContent === 'Narration ready', $('statusTitle').textContent);
    check('export enabled after render', !$('exportButton').disabled && $('renderButton').disabled);
    draft.value = 'First sentence here. Second sentence EDITED.\n\nThird sentence here.';
    draft.dispatchEvent(new w.Event('input', {bubbles: true})); await tick();
    check('change tracking: 1 of 3 flagged', $('narrationInfo').textContent === '1 of 3 sentences changed and need rendering.', $('narrationInfo').textContent);
    const before = world.workerInstance.received.length;
    $('renderButton').click(); await tick(); await drain(1);
    check('update sent exactly the edited sentence', world.workerInstance.received.length === before + 1 && world.workerInstance.received[before].text === 'Second sentence EDITED.');
    check('update reports 2 reused', $('statusDetail').textContent.includes('2 reused'), $('statusDetail').textContent);
    $('exportButton').click(); await settle();
    check('export saved a wav to the drive',
      lastSave(world, 'audio') !== undefined && lastSave(world, 'audio').name === 'read-aloud-narration.wav' &&
      $('statusDetail').textContent.includes('saves/audio/'), $('statusDetail').textContent);
    const buf = saveBuf(world, 'audio');
    const SENT = Math.round(22050 * 0.35), PARA = Math.round(22050 * 0.75);
    const expected = 100 + SENT + 100 + PARA + 100;
    check('WAV header + rate', buf.toString('ascii', 0, 4) === 'RIFF' && buf.readUInt32LE(24) === 22050);
    check('WAV length = audio + gaps', buf.length === 44 + expected * 2, buf.length);
    check('gaps silent, audio audible', buf.readInt16LE(44) > 16000 && buf.readInt16LE(44 + 150 * 2) === 0);
    $('gap').value = '0';
    $('gap').dispatchEvent(new w.Event('input', {bubbles: true}));
    const beforePlay = world.workerInstance.received.length;
    draft.setSelectionRange(0, 0);
    key('F8'); await tick(); await tick();
    check('cached playback instant, zero requests', world.workerInstance.received.length === beforePlay && world.liveSources.length === 1);
    endCurrent(); await tick(); await tick();
    check('cached advance gapless', world.liveSources.length === 1 && markText() === 'Second sentence EDITED.');
    key('Escape'); await tick();
    draft.value = 'Alpha alpha. Beta beta. Gamma gamma.';
    draft.dispatchEvent(new w.Event('input', {bubbles: true})); await tick();
    $('renderButton').click(); await tick(); await drain(1);
    key('Escape'); await tick();
    check('cancel keeps partial progress', $('narrationInfo').textContent === '2 of 3 sentences changed and need rendering.', $('narrationInfo').textContent);
    $('speed').value = '1.20';
    $('speed').dispatchEvent(new w.Event('input', {bubbles: true})); await tick();
    check('speed change invalidates all', $('narrationInfo').textContent === '3 sentences to render.', $('narrationInfo').textContent);
  }

  /* ============ tier-1 pack suite ============ */
  {
    const world = await makeWorld();
    const {w} = world;
    const $ = (id) => w.document.getElementById(id);
    const sendResult = () => world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-result', samples: new Float32Array(8), sampleRate: 22050}});
    const endCurrent = () => { const s = world.liveSources.shift(); if (s && s.onended) s.onended(); };
    const markText = () => { const m = $('backdropContent').querySelector('mark'); return m ? m.textContent : null; };
    const key = (k) => w.document.dispatchEvent(new w.KeyboardEvent('keydown', {key: k}));
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-ready'}});
    const draft = $('draft');

    // lint counts
    draft.value = 'The the cat  sat.. now,, ok... fine.';
    draft.dispatchEvent(new w.Event('input', {bubbles: true})); await tick();
    const lint = $('lintInfo').textContent;
    check('lint: repeated word counted', lint.includes('1 repeated word'), lint);
    check('lint: double space counted', lint.includes('1 double space'), lint);
    check('lint: doubled punctuation counted, ellipsis ignored', lint.includes('2 doubled punctuation marks'), lint);
    draft.value = 'A clean sentence here.';
    draft.dispatchEvent(new w.Event('input', {bubbles: true})); await tick();
    check('lint: silent when clean', $('lintInfo').textContent === '', $('lintInfo').textContent);

    // stats
    draft.value = 'One two three. Four five.';
    draft.dispatchEvent(new w.Event('input', {bubbles: true})); await tick();
    const stats = $('statsInfo').textContent;
    check('stats: words and sentences', stats.includes('5 words') && stats.includes('2 sentences'), stats);
    check('stats: average and grade shown', stats.includes('avg 2.5 words each') && stats.includes('reading grade'), stats);

    // font / spacing CSS variables
    $('fontScale').value = '1.2';
    $('fontScale').dispatchEvent(new w.Event('input', {bubbles: true}));
    $('lineSpacing').value = '2';
    $('lineSpacing').dispatchEvent(new w.Event('input', {bubbles: true}));
    const rootStyle = w.document.documentElement.style;
    check('font scale variable applied', rootStyle.getPropertyValue('--font-scale') === '1.2' && $('fontValue').value === '120%');
    check('line height variable applied', rootStyle.getPropertyValue('--line-height') === '2' && $('spacingValue').value === '2.00');

    // playback gap: pause between sentences, cancellable
    $('gap').value = '0.15';
    $('gap').dispatchEvent(new w.Event('input', {bubbles: true}));
    check('gap output formats', $('gapValue').value === '0.15s');
    draft.value = 'Alpha alpha. Beta beta.';
    draft.dispatchEvent(new w.Event('input', {bubbles: true}));
    draft.setSelectionRange(0, 0);
    key('F8'); sendResult(); await tick(); await tick(); // playing s1
    sendResult(); await tick();                           // s2 cached
    endCurrent(); await tick();
    check('gap: next sentence highlighted but not yet playing', world.liveSources.length === 0 && markText() === 'Beta beta.', markText());
    await sleep(220); await tick();
    check('gap: playback resumes after the pause', world.liveSources.length === 1, world.liveSources.length);
    endCurrent(); await tick();
    // gap cancellation on stop
    key('F8'); await tick(); await tick(); // instant from cache
    endCurrent(); await tick();            // now inside the gap window
    key('Escape'); await tick();
    await sleep(220); await tick();
    check('gap: Esc during pause cancels cleanly', world.liveSources.length === 0 && $('stopButton').disabled);

    // export honors the slider
    // both sentences already cached from playback: render correctly has nothing
    // to do (disabled) and export is available immediately
    check('playback cache satisfies narration directly', $('renderButton').disabled && !$('exportButton').disabled, $('narrationInfo').textContent);
    $('exportButton').click(); await settle();
    const buf2 = saveBuf(world, 'audio');
    const expected2 = 8 + Math.round(22050 * 0.15) + 8;
    check('export gap follows slider', buf2.length === 44 + expected2 * 2, buf2.length);
  }

  /* ============ tier-2 pack suite ============ */
  {
    const world = await makeWorld();
    const {w} = world;
    const $ = (id) => w.document.getElementById(id);
    const sendResult = () => world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-result', samples: new Float32Array(50).fill(0.4), sampleRate: 22050}});
    const endCurrent = () => { const s = world.liveSources.shift(); if (s && s.onended) s.onended(); };
    const markText = () => { const m = $('backdropContent').querySelector('mark'); return m ? m.textContent : null; };
    const key = (k) => w.document.dispatchEvent(new w.KeyboardEvent('keydown', {key: k}));
    const blobText = async (b) => Buffer.from(await b.arrayBuffer()).toString('utf8');

    world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-ready'}});
    const draft = $('draft');
    $('gap').value = '0';
    $('gap').dispatchEvent(new w.Event('input', {bubbles: true}));

    // --- theme + font ---
    $('themeSelect').value = 'dark';
    $('themeSelect').dispatchEvent(new w.Event('input', {bubbles: true}));
    check('theme toggle sets data-theme', w.document.documentElement.dataset.theme === 'dark');
    $('themeSelect').value = 'light';
    $('themeSelect').dispatchEvent(new w.Event('input', {bubbles: true}));
    check('theme back to light', w.document.documentElement.dataset.theme === 'light');
    $('fontSelect').value = 'hyper';
    $('fontSelect').dispatchEvent(new w.Event('input', {bubbles: true}));
    check('font select sets editor font var', w.document.documentElement.style.getPropertyValue('--editor-font').includes('Atkinson'));

    // --- settings blob: show, apply (with dict), pronunciation in requests ---
    $('settingsShow').click();
    check('show current produces RA1 blob', $('settingsBox').value.startsWith('RA1 {'), $('settingsBox').value.slice(0, 30));
    $('settingsBox').value = 'RA1 {"v":1,"speed":1.25,"gap":0.5,"dict":{"Dr.":"Doctor"}}';
    $('settingsApply').click();
    check('apply updates speed control', $('speed').value === '1.25' && $('speedValue').value === '1.25×');
    check('apply updates gap control', $('gap').value === '0.5' && $('gapValue').value === '0.50s');
    $('gap').value = '0';
    $('gap').dispatchEvent(new w.Event('input', {bubbles: true}));
    draft.value = 'Dr. Smith left early.';
    draft.dispatchEvent(new w.Event('input', {bubbles: true})); await tick();
    draft.setSelectionRange(0, 0);
    key('F8'); await tick();
    const req = world.workerInstance.received[world.workerInstance.received.length - 1];
    check('pronunciation dict rewrites spoken text only', req.text === 'Doctor Smith left early.' && draft.value.startsWith('Dr.'), req.text);
    sendResult(); await tick(); await tick();
    endCurrent(); await tick();

    // --- step mode ---
    $('stepToggle').checked = true;
    draft.value = 'Alpha one. Beta two. Gamma three.';
    draft.dispatchEvent(new w.Event('input', {bubbles: true})); await tick();
    draft.setSelectionRange(0, 0);
    key('F8'); sendResult(); await tick(); await tick(); // playing s1
    sendResult(); await tick();                           // s2 cached
    endCurrent(); await tick();
    check('step: waits after sentence with prompt', world.liveSources.length === 0 && $('statusTitle').textContent.startsWith('Paused before 2 of 3'), $('statusTitle').textContent);
    key('F8'); await tick(); await tick();
    check('step: F8 advances to next sentence', world.liveSources.length === 1 && markText() === 'Beta two.');
    // replay during play
    key('F7'); await tick(); await tick();
    check('replay restarts current sentence', world.liveSources.length === 1 && markText() === 'Beta two.');
    endCurrent(); await tick();
    // Space advance (focus not in textarea)
    draft.blur();
    key(' '); await tick(); await tick();
    check('step: Space advances when textarea unfocused', markText() === 'Gamma three.' || world.liveSources.length === 1);
    // --- flags during playback ---
    key('F9');
    check('flag toggles on with counter', !$('flagsRow').hidden && $('flagsInfo').textContent.includes('1 flagged'));
    key('Escape'); await tick();
    $('stepToggle').checked = false;
    // F10 jump + report
    key('F10');
    check('F10 selects the flagged sentence', draft.value.slice(draft.selectionStart, draft.selectionEnd) === 'Gamma three.', draft.value.slice(draft.selectionStart, draft.selectionEnd));
    $('flagReportButton').click(); await settle();
    const report = saveBuf(world, 'report').toString('utf8');
    check('flag report saved to drive with sentence', report.includes('Flagged sentences (1)') && report.includes('Gamma three.'));
    $('flagClearButton').click();
    check('clear flags hides row', $('flagsRow').hidden);

    // --- focus mode class ---
    $('focusToggle').checked = true;
    draft.setSelectionRange(0, 0);
    key('F8'); await tick(); await tick(); // cached, instant
    check('focus mode class applied while playing', w.document.querySelector('.editor-stack').classList.contains('focus-live'));
    key('Escape'); await tick();
    check('focus mode class removed on stop', !w.document.querySelector('.editor-stack').classList.contains('focus-live'));
    $('focusToggle').checked = false;

    // --- lint underlines + brackets ---
    draft.value = 'The the cat (sat on.';
    draft.dispatchEvent(new w.Event('input', {bubbles: true})); await tick();
    check('lint underline rendered in idle backdrop', $('backdropContent').querySelector('u.lint') !== null && $('backdropContent').querySelector('u.lint').textContent === 'The the');
    check('bracket lint counted', $('lintInfo').textContent.includes('1 unbalanced bracket'), $('lintInfo').textContent);

    // --- MP3 export + labels ---
    draft.value = 'First bit. Second bit.';
    draft.dispatchEvent(new w.Event('input', {bubbles: true})); await tick();
    $('renderButton').click(); await tick();
    // one extra result feeds the stale step-mode request the app correctly discards
    sendResult(); await tick(); sendResult(); await tick(); sendResult(); await tick();
    check('render done for export', !$('exportMp3Button').disabled, $('statusTitle').textContent);
    $('labelsToggle').checked = true;
    world.blobs.length = 0;
    $('exportMp3Button').click(); await tick();
    check('mp3 worker receives pcm', world.mp3Worker !== null && world.mp3Worker.received[0].pcm instanceof w.Int16Array === false /* transferred as Int16Array (node realm) */ || world.mp3Worker.received[0].sampleRate === 22050);
    world.mp3Worker.onmessage({data: {type: 'done', chunks: [new Int8Array([0xff, 0xfb, 0x90])]}});
    await settle();
    const mp3Save = lastSave(world, 'audio');
    const labelSave = lastSave(world, 'text');
    check('mp3 saved to drive', mp3Save !== undefined && mp3Save.name === 'read-aloud-narration.mp3');
    check('labels saved alongside', labelSave !== undefined && Buffer.from(labelSave.dataBase64, 'base64').toString('utf8').includes('\tFirst bit.'));

    // --- session save ---
    $('sessionSave').click(); await settle();
    const session = JSON.parse(saveBuf(world, 'session').toString('utf8'));
    check('session file contains draft + settings', session.kind === 'read-aloud-session' && session.draft === draft.value && session.settings.speed === 1.25);

    // --- quit ---
    world.fetches = [];
    $('quitButton').click(); await tick(); await tick();
    check('quit posts to /quit and reports shutdown', world.fetches.some((f) => f.url === '/quit' && f.opts && f.opts.method === 'POST') && $('statusTitle').textContent === 'Read Aloud stopped', $('statusTitle').textContent);
  }

  /* ============ settings.txt auto-load suite ============ */
  {
    const world = await makeWorld((wd) => { wd.settingsTxt = 'RA1 {"v":1,"speed":1.4,"theme":"dark","font":"hyper"}'; });
    const {w} = world;
    await tick(); await tick(); // let the fetch promise chain settle
    const $ = (id) => w.document.getElementById(id);
    check('settings.txt auto-load applied speed', $('speed').value === '1.4', $('speed').value);
    check('settings.txt auto-load applied theme', w.document.documentElement.dataset.theme === 'dark');
    check('settings.txt auto-load applied font', $('fontSelect').value === 'hyper');
  }

  /* ============ hardening suite ============ */
  {
    // integrity failure surfaces in the ready message
    const world = await makeWorld((wd) => { wd.healthText = 'readaloud:abc\nintegrity:failed:2/9'; });
    const {w} = world;
    const $ = (id) => w.document.getElementById(id);
    await tick(); await tick();
    world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-ready'}});
    check('integrity failure shown with ready', $('statusDetail').textContent.includes('2 of 9 files'), $('statusDetail').textContent);
  }
  {
    // heartbeat keeps pinging; two failures raise the drive-lost warning
    const world = await makeWorld((wd) => { wd.w.__RA_HEARTBEAT_MS = 40; });
    const {w} = world;
    const $ = (id) => w.document.getElementById(id);
    world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-ready'}});
    await new Promise((r) => setTimeout(r, 120));
    const pings = (world.fetches || []).filter((f) => f.url === 'VOICE-EDITION.txt').length;
    check('heartbeat touches a real file periodically', pings >= 2, pings);
    world.failFetches = true;
    await new Promise((r) => setTimeout(r, 160));
    check('drive-lost warning after repeated failures', $('statusTitle').textContent === 'Lost contact with the drive', $('statusTitle').textContent);
  }
  {
    // large drafts defer heavy work; small drafts stay synchronous
    const world = await makeWorld();
    const {w} = world;
    const $ = (id) => w.document.getElementById(id);
    world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-ready'}});
    const draft = $('draft');
    draft.value = 'Short one. Short two.';
    draft.dispatchEvent(new w.Event('input', {bubbles: true}));
    check('small drafts update stats synchronously', $('statsInfo').textContent.includes('2 sentences'), $('statsInfo').textContent);
    draft.value = ('A large document sentence. '.repeat(1200)) + 'Final marker sentence.';
    draft.dispatchEvent(new w.Event('input', {bubbles: true}));
    const immediately = $('statsInfo').textContent;
    check('large drafts defer heavy work', immediately.includes('2 sentences'), immediately.slice(0, 40));
    await new Promise((r) => setTimeout(r, 320));
    check('deferred work completes with correct stats', $('statsInfo').textContent.includes('1201 sentences'), $('statsInfo').textContent);
  }

  /* ============ flag panel suite ============ */
  {
    const world = await makeWorld();
    const {w} = world;
    const $ = (id) => w.document.getElementById(id);
    const key = (k) => w.document.dispatchEvent(new w.KeyboardEvent('keydown', {key: k}));
    world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-ready'}});
    const draft = $('draft');
    draft.value = 'Opening line here. The dragon guarded its hoard jealously. Closing line here.';
    draft.dispatchEvent(new w.Event('input', {bubbles: true})); await tick();
    const at = (t) => { draft.setSelectionRange(draft.value.indexOf(t), draft.value.indexOf(t)); };

    at('dragon');
    key('F9'); await new Promise((r) => setTimeout(r, 60));
    check('panel: flag created', $('flagsInfo').textContent.includes('1 flagged'));
    check('panel: backdrop shows the flag marker', $('backdropContent').querySelector('u.flagmark') !== null && $('backdropContent').querySelector('u.flagmark').textContent.includes('dragon'));

    // edit the flagged sentence: the flag must follow it
    draft.value = 'Opening line here. The dragon guarded its enormous hoard jealously. Closing line here.';
    draft.dispatchEvent(new w.Event('input', {bubbles: true})); await tick();
    $('flagPanelToggle').click(); await new Promise((r) => setTimeout(r, 60));
    const item = $('flagPanel').querySelector('li');
    check('panel: flag follows an edited sentence', item && item.textContent.includes('enormous'), item && item.textContent);

    // after confident rebind, a second render shows it as exact again
    $('flagPanelToggle').click(); $('flagPanelToggle').click(); await new Promise((r) => setTimeout(r, 60));
    const item2 = $('flagPanel').querySelector('li');
    check('panel: anchor self-heals after rebind', item2 && !item2.textContent.includes('updated'), item2 && item2.textContent);

    // move the sentence: flag follows position changes
    draft.value = 'Opening line here. Closing line here. The dragon guarded its enormous hoard jealously.';
    draft.dispatchEvent(new w.Event('input', {bubbles: true})); await tick();
    draft.setSelectionRange(0, 0);
    key('F10');
    check('panel: F10 follows a moved sentence', draft.value.slice(draft.selectionStart, draft.selectionEnd).includes('dragon'), draft.value.slice(draft.selectionStart, draft.selectionEnd));

    // click-to-jump from the panel
    draft.setSelectionRange(0, 0);
    await new Promise((r) => setTimeout(r, 60));
    const li = $('flagPanel').querySelector('li');
    li.dispatchEvent(new w.MouseEvent('click', {bubbles: true}));
    check('panel: clicking an item jumps to it', draft.value.slice(draft.selectionStart, draft.selectionEnd).includes('dragon'));

    // delete the sentence entirely: flag reports as lost, never crashes
    draft.value = 'Opening line here. Closing line here.';
    draft.dispatchEvent(new w.Event('input', {bubbles: true})); await tick();
    await new Promise((r) => setTimeout(r, 60));
    const lostItem = $('flagPanel').querySelector('li.flag-lost');
    check('panel: deleted sentence shows as not found', lostItem !== null && lostItem.textContent.includes('not found'), $('flagPanel').textContent);
    $('flagReportButton').click(); await settle();
    const report = saveBuf(world, 'report').toString('utf8');
    check('panel: report marks lost flags', report.includes('[no longer found in the draft]'), report);

    // per-item remove button
    const removeBtn = $('flagPanel').querySelector('.flag-remove');
    removeBtn.dispatchEvent(new w.MouseEvent('click', {bubbles: true}));
    check('panel: item remove button clears the flag', $('flagsRow').hidden);

    // session round-trip preserves anchors
    at && 0;
    draft.value = 'Alpha sentence one. Beta sentence two.';
    draft.dispatchEvent(new w.Event('input', {bubbles: true})); await tick();
    draft.setSelectionRange(0, 0);
    key('F9'); await tick();
    $('sessionSave').click(); await settle();
    const session = JSON.parse(saveBuf(world, 'session').toString('utf8'));
    check('panel: session stores anchored flags', Array.isArray(session.flags) && session.flags[0].text === 'Alpha sentence one.' && 'after' in session.flags[0], JSON.stringify(session.flags));
  }

  /* ============ multi-voice suite ============ */
  {
    const world = await makeWorld();
    const {w} = world;
    const $ = (id) => w.document.getElementById(id);
    check('voices: worker created from catalog with init', world.lastInit && world.lastInit.modelUrl === 'voices/amy-medium/model.onnx', JSON.stringify(world.lastInit));
    check('voices: dropdown lists both packages', $('voiceSelect').options.length === 2 && !$('voiceSelect').disabled);
    world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-ready'}});
    check('voices: default ready names the voice', $('statusTitle').textContent === 'Amy is ready', $('statusTitle').textContent);
    // render one sentence with Amy so the cache holds Amy audio
    const draft = $('draft');
    $('gap').value = '0'; $('gap').dispatchEvent(new w.Event('input', {bubbles: true}));
    draft.value = 'Cache isolation sentence.';
    draft.dispatchEvent(new w.Event('input', {bubbles: true})); await tick();
    $('renderButton').click(); await tick();
    world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-result', samples: new Float32Array(8), sampleRate: 22050}}); await tick();
    check('voices: rendered with Amy', $('narrationInfo').textContent.includes('Ready to export'), $('narrationInfo').textContent);
    // switch to Lessac
    const amyWorker = world.workerInstance;
    $('voiceSelect').value = 'lessac-high';
    $('voiceSelect').dispatchEvent(new w.Event('input', {bubbles: true})); await tick();
    check('voices: old worker terminated on switch', amyWorker.terminated === true);
    check('voices: fresh worker inits the new voice', world.ttsWorkers === 2 && world.lastInit.modelUrl === 'voices/lessac-high/model.onnx', JSON.stringify(world.lastInit));
    check('voices: switch shows loading state', $('statusTitle').textContent === 'Loading Lessac High…', $('statusTitle').textContent);
    check('voices: cache never crosses voices', $('narrationInfo').textContent.includes('1 sentence to render'), $('narrationInfo').textContent);
    world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-ready'}});
    check('voices: new voice ready by name', $('statusTitle').textContent === 'Lessac High is ready', $('statusTitle').textContent);
    world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-progress', status: ''}});
    check('voices: ready-race guard survives switching', /is ready/.test($('statusTitle').textContent));
    // switch back: repeated switching leaks nothing
    for (let i = 0; i < 10; i++) {
      $('voiceSelect').value = i % 2 ? 'lessac-high' : 'amy-medium';
      $('voiceSelect').dispatchEvent(new w.Event('input', {bubbles: true})); await tick();
    }
    check('voices: ten switches, every prior worker terminated', world.ttsWorkers === 12 && world.workerInstance.terminated === false);
  }
  {
    // no voices installed: a useful error, not a hang
    const world = await makeWorld((wd) => { wd.voiceCatalog = {voices: [], invalid: [{dir: 'broken', reason: 'missing voice.json'}]}; wd.expectNoWorker = true; });
    const {w} = world;
    const $ = (id) => w.document.getElementById(id);
    await tick(); await tick();
    check('voices: empty folder explains where packages go', $('statusTitle').textContent === 'No voices installed' && $('statusDetail').textContent.includes('voices'), $('statusTitle').textContent);
    check('voices: invalid package reported by name', $('statusDetail').textContent.includes('broken (missing voice.json)'), $('statusDetail').textContent);
  }

  {
    // an engine that dies silently mid-load must not load forever
    const world = await makeWorld((wd) => { wd.w.__RA_LOAD_WATCHDOG_MS = 60; wd.healthText = 'readaloud:abc\nintegrity:failed:1/3'; });
    const {w} = world;
    const $ = (id) => w.document.getElementById(id);
    await new Promise((r) => setTimeout(r, 160));
    check('watchdog: silent engine death becomes a clear error', $('statusTitle').textContent === 'Could not load the voice', $('statusTitle').textContent);
    check('watchdog: failure explains the likely damaged file', /integrity check/.test($('statusDetail').textContent), $('statusDetail').textContent);
  }
  {
    // and a voice that loads normally is never interrupted by it
    const world = await makeWorld((wd) => { wd.w.__RA_LOAD_WATCHDOG_MS = 60; });
    const {w} = world;
    const $ = (id) => w.document.getElementById(id);
    world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-ready'}});
    await new Promise((r) => setTimeout(r, 160));
    check('watchdog: never fires after a clean ready', /is ready/.test($('statusTitle').textContent), $('statusTitle').textContent);
  }

  /* ============ two model families ============ */
  {
    const world = await makeWorld((wd) => {
      wd.voiceCatalog = {voices: [
        {id: 'amy-medium', name: 'Amy', quality: '', sampleRate: 22050, architecture: 'vits',
         modelUrl: 'voices/amy-medium/model.onnx', tokensUrl: 'voices/amy-medium/tokens.txt'},
        {id: 'kitten-micro', name: 'Kitten Micro', quality: 'micro', sampleRate: 24000,
         architecture: 'kitten', speakerId: 3, lockedSpeaker: true,
         modelUrl: 'voices/kitten-micro/model.onnx', tokensUrl: 'voices/kitten-micro/tokens.txt',
         voicesUrl: 'voices/kitten-micro/voices.bin'},
      ], invalid: []};
    });
    const {w} = world;
    const $ = (id) => w.document.getElementById(id);
    check('families: vits voice inits without a voices file',
      world.lastInit.arch === 'vits' && !world.lastInit.voicesUrl, JSON.stringify(world.lastInit));
    world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-ready'}});
    $('voiceSelect').value = 'kitten-micro';
    $('voiceSelect').dispatchEvent(new w.Event('input', {bubbles: true})); await tick();
    check('families: kitten voice inits with arch, voices url and speaker',
      world.lastInit.arch === 'kitten' &&
      world.lastInit.voicesUrl === 'voices/kitten-micro/voices.bin' &&
      world.lastInit.speakerId === 3, JSON.stringify(world.lastInit));
    world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-ready'}});
    check('families: switching between families names the voice',
      $('statusTitle').textContent === 'Kitten Micro is ready', $('statusTitle').textContent);
  }

  /* ============ multi-speaker packages ============ */
  {
    const world = await makeWorld((wd) => {
      wd.voiceCatalog = {voices: [
        {id: 'amy-medium', name: 'Amy', quality: '', sampleRate: 22050, architecture: 'vits',
         modelUrl: 'voices/amy-medium/model.onnx', tokensUrl: 'voices/amy-medium/tokens.txt'},
        {id: 'kitten-multi', name: 'Kitten Multi', quality: 'nano', sampleRate: 24000,
         architecture: 'kitten',
         speakers: [{id: 0, name: 'Bella'}, {id: 1, name: 'Jasper'}, {id: 2, name: 'Nova'}],
         modelUrl: 'voices/kitten-multi/model.onnx', tokensUrl: 'voices/kitten-multi/tokens.txt',
         voicesUrl: 'voices/kitten-multi/voices.bin'},
        {id: 'kitten-locked', name: 'Locked Kitten', quality: 'micro', sampleRate: 24000,
         architecture: 'kitten', speakerId: 3, lockedSpeaker: true,
         modelUrl: 'voices/kitten-locked/model.onnx', tokensUrl: 'voices/kitten-locked/tokens.txt',
         voicesUrl: 'voices/kitten-locked/voices.bin'},
      ], invalid: []};
    });
    const {w} = world;
    const $ = (id) => w.document.getElementById(id);
    const key = (k) => w.document.dispatchEvent(new w.KeyboardEvent('keydown', {key: k}));
    const sendResult = () => world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-result', samples: new Float32Array(8), sampleRate: 24000}});
    const gen = () => world.workerInstance.received;

    world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-ready', numSpeakers: 1}});
    check('speakers: single-speaker voice hides the picker', $('speakerRow').hidden === true);

    $('voiceSelect').value = 'kitten-multi';
    $('voiceSelect').dispatchEvent(new w.Event('input', {bubbles: true})); await tick();
    check('speakers: unlocked kitten inits at speaker 0', world.lastInit.speakerId === 0, JSON.stringify(world.lastInit));
    const workersAfterLoad = world.ttsWorkers;
    world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-ready', numSpeakers: 8}});
    check('speakers: picker visible with the named speakers',
      $('speakerRow').hidden === false && $('speakerSelect').options.length === 3 &&
      $('speakerSelect').options[0].textContent === 'Bella', $('speakerSelect').innerHTML);

    $('gap').value = '0';
    $('gap').dispatchEvent(new w.Event('input', {bubbles: true}));
    const draft = $('draft');
    draft.value = 'Solo sentence.';
    draft.setSelectionRange(0, 0);
    key('F8');
    check('speakers: first read carries sid 0', gen().length === 1 && gen()[0].sid === 0, JSON.stringify(gen()));
    sendResult(); await tick(); await tick();
    key('Escape');

    $('speakerSelect').value = '1';
    $('speakerSelect').dispatchEvent(new w.Event('input', {bubbles: true})); await tick();
    check('speakers: switching speakers reloads nothing',
      world.ttsWorkers === workersAfterLoad && world.workerInstance.terminated === false, `workers=${world.ttsWorkers}`);
    check('speakers: status names the chosen speaker', /Jasper/.test($('statusTitle').textContent), $('statusTitle').textContent);

    draft.setSelectionRange(0, 0);
    key('F8');
    check('speakers: new speaker misses the old cache and generates with sid 1',
      gen().length === 2 && gen()[1].sid === 1, JSON.stringify(gen()));
    sendResult(); await tick(); await tick();
    key('Escape');

    $('speakerSelect').value = '0';
    $('speakerSelect').dispatchEvent(new w.Event('input', {bubbles: true})); await tick();
    draft.setSelectionRange(0, 0);
    key('F8'); await tick();
    check('speakers: switching back replays from cache with zero new requests',
      gen().length === 2 && world.liveSources.length === 1, `requests=${gen().length} live=${world.liveSources.length}`);
    key('Escape');

    $('settingsBox').value = 'RA1 {"speaker":{"kitten-multi":2}}';
    $('settingsApply').click(); await tick();
    check('speakers: settings apply selects the remembered speaker', $('speakerSelect').value === '2', $('speakerSelect').value);
    draft.setSelectionRange(0, 0);
    key('F8');
    check('speakers: reads with the speaker from settings', gen()[gen().length - 1].sid === 2, JSON.stringify(gen()));
    key('Escape');

    $('voiceSelect').value = 'kitten-locked';
    $('voiceSelect').dispatchEvent(new w.Event('input', {bubbles: true})); await tick();
    check('speakers: locked package inits with its pinned speaker', world.lastInit.speakerId === 3, JSON.stringify(world.lastInit));
    world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-ready', numSpeakers: 8}});
    check('speakers: locked package hides the picker even with many speakers', $('speakerRow').hidden === true);
    draft.setSelectionRange(0, 0);
    key('F8');
    check('speakers: locked package always generates its pinned sid',
      world.workerInstance.received[0].sid === 3, JSON.stringify(world.workerInstance.received));
  }

  /* ============ pitch and delivery ============ */
  {
    const world = await makeWorld((wd) => {
      wd.voiceCatalog = {voices: [
        {id: 'amy-medium', name: 'Amy', quality: '', sampleRate: 22050, architecture: 'vits',
         modelUrl: 'voices/amy-medium/model.onnx', tokensUrl: 'voices/amy-medium/tokens.txt'},
        {id: 'kitten-multi', name: 'Kitten Multi', quality: 'nano', sampleRate: 24000,
         architecture: 'kitten',
         speakers: [{id: 0, name: 'Bella'}, {id: 1, name: 'Jasper'}],
         modelUrl: 'voices/kitten-multi/model.onnx', tokensUrl: 'voices/kitten-multi/tokens.txt',
         voicesUrl: 'voices/kitten-multi/voices.bin'},
      ], invalid: []};
    });
    const {w} = world;
    const $ = (id) => w.document.getElementById(id);
    const key = (k) => w.document.dispatchEvent(new w.KeyboardEvent('keydown', {key: k}));
    const sendResult = (n = 100) => world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-result', samples: new Float32Array(n).fill(0.9), sampleRate: 22050}});
    const gen = () => world.workerInstance.received;

    world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-ready', numSpeakers: 1}});
    check('tuning: delivery toggle visible for a vits voice', $('deliveryRow').hidden === false);
    check('tuning: natural is the default preset', $('deliveryNatural').classList.contains('active'));
    check('tuning: vits init carries natural noise values',
      world.lastInit.noiseScale === 0.667 && world.lastInit.noiseScaleW === 0.8, JSON.stringify(world.lastInit));

    $('gap').value = '0';
    $('gap').dispatchEvent(new w.Event('input', {bubbles: true}));
    $('pitch').value = '1.10';
    $('pitch').dispatchEvent(new w.Event('input', {bubbles: true}));
    check('tuning: pitch label shows percent', $('pitchValue').value === '+10%', $('pitchValue').value);
    const draft = $('draft');
    draft.value = 'Solo sentence.';
    draft.setSelectionRange(0, 0);
    key('F8');
    check('tuning: engine speed compensates for pitch',
      gen().length === 1 && Math.abs(gen()[0].speed - 1 / 1.10) < 0.001, JSON.stringify(gen()));
    sendResult(); await tick(); await tick();
    key('Escape');
    $('pitch').value = '1.00';
    $('pitch').dispatchEvent(new w.Event('input', {bubbles: true}));
    draft.setSelectionRange(0, 0);
    key('F8');
    check('tuning: pitch change invalidates like a speed change',
      gen().length === 2 && Math.abs(gen()[1].speed - 1) < 0.001, JSON.stringify(gen()));
    sendResult(); await tick(); await tick();
    key('Escape');

    // pitched export: 100-sample sentence at +15% must shrink to 87 samples
    $('pitch').value = '1.15';
    $('pitch').dispatchEvent(new w.Event('input', {bubbles: true}));
    $('renderButton').click(); await tick();
    sendResult(); await tick(); await tick();
    $('exportButton').click(); await settle();
    const buf = saveBuf(world, 'audio');
    check('tuning: exported WAV is resampled by the pitch factor',
      buf.length === 44 + Math.round(100 / 1.15) * 2, `bytes=${buf.length}`);
    $('pitch').value = '1.00';
    $('pitch').dispatchEvent(new w.Event('input', {bubbles: true}));

    // delivery flip: engine restarts with steady values, no cache loss
    draft.setSelectionRange(0, 0);
    key('F8'); await tick();
    check('tuning: natural playback cached', world.liveSources.length === 1);
    key('Escape');
    const workersBefore = world.ttsWorkers;
    $('deliverySteady').click(); await tick();
    check('tuning: steady flip restarts the engine with steady values',
      world.ttsWorkers === workersBefore + 1 &&
      world.lastInit.noiseScale === 0.25 && world.lastInit.noiseScaleW === 0.35, JSON.stringify(world.lastInit));
    check('tuning: loading label names the preset', /\(Steady\)/.test($('statusTitle').textContent), $('statusTitle').textContent);
    world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-ready', numSpeakers: 1}});
    draft.setSelectionRange(0, 0);
    key('F8');
    check('tuning: steady is a fresh cache lane', gen().length === 1, JSON.stringify(gen()));
    sendResult(); await tick(); await tick();
    key('Escape');
    $('deliveryNatural').click(); await tick();
    world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-ready', numSpeakers: 1}});
    draft.setSelectionRange(0, 0);
    key('F8'); await tick();
    check('tuning: flipping back to natural replays instantly from cache',
      gen().length === 0 && world.liveSources.length === 1, `requests=${gen().length} live=${world.liveSources.length}`);
    key('Escape');

    $('settingsBox').value = 'RA1 {"delivery":"steady","pitch":1.05}';
    $('settingsApply').click(); await tick();
    check('tuning: settings apply flips delivery and pitch',
      world.lastInit.noiseScale === 0.25 && $('pitchValue').value === '+5%',
      `${JSON.stringify(world.lastInit)} ${$('pitchValue').value}`);
    world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-ready', numSpeakers: 1}});

    $('voiceSelect').value = 'kitten-multi';
    $('voiceSelect').dispatchEvent(new w.Event('input', {bubbles: true})); await tick();
    world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-ready', numSpeakers: 8}});
    check('tuning: kitten hides the delivery toggle', $('deliveryRow').hidden === true);
  }

  /* ============ files, autosave, restore ============ */
  {
    const world = await makeWorld((wd) => {
      wd.w.__RA_AUTOSAVE_MS = 25;
      wd.w.navigator.clipboard = {writeText: (t) => { wd.copied = t; return Promise.resolve(); }};
    });
    const {w} = world;
    const $ = (id) => w.document.getElementById(id);
    const key = (k) => w.document.dispatchEvent(new w.KeyboardEvent('keydown', {key: k}));
    world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-ready', numSpeakers: 1}});
    const draft = $('draft');

    check('files: no autosave file means no restore banner', $('restoreBanner').hidden === true);

    draft.value = 'Words to keep. More words here.';
    draft.dispatchEvent(new w.Event('input', {bubbles: true})); await tick();
    $('copyAllButton').click(); await settle();
    check('files: copy all puts the draft on the clipboard', world.copied === draft.value && /Copied/.test($('statusTitle').textContent), $('statusTitle').textContent);

    $('saveTxtButton').click(); await settle();
    check('files: draft saved as text on the drive',
      lastSave(world, 'text') !== undefined && lastSave(world, 'text').name === 'read-aloud-draft.txt' &&
      saveBuf(world, 'text').toString('utf8') === draft.value, JSON.stringify(lastSave(world, 'text')));

    // autosave: off by default, indicator appears, interval writes, stop writes
    check('files: autosave defaults off with hidden indicator', !$('autosaveToggle').checked && $('autosaveDot').hidden === true);
    $('autosaveToggle').checked = true;
    $('autosaveToggle').dispatchEvent(new w.Event('input', {bubbles: true}));
    check('files: indicator visible while autosave is on', $('autosaveDot').hidden === false);
    await new Promise((r) => setTimeout(r, 80)); await settle();
    const autosaves = (world.saves || []).filter((x) => x.name === 'autosave.raSession');
    check('files: autosave writes the rolling session on the drive', autosaves.length >= 1 &&
      JSON.parse(Buffer.from(autosaves[0].dataBase64, 'base64').toString('utf8')).draft === draft.value, `count=${autosaves.length}`);
    const beforeStop = (world.saves || []).filter((x) => x.name === 'autosave.raSession').length;
    $('gap').value = '0';
    $('gap').dispatchEvent(new w.Event('input', {bubbles: true}));
    draft.setSelectionRange(0, 0);
    key('F8'); await tick();
    world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-result', samples: new Float32Array(8), sampleRate: 22050}});
    await tick(); await tick();
    key('Escape'); await settle();
    check('files: stopping playback triggers an autosave',
      (world.saves || []).filter((x) => x.name === 'autosave.raSession').length > beforeStop);
    $('autosaveToggle').checked = false;
    $('autosaveToggle').dispatchEvent(new w.Event('input', {bubbles: true}));
    check('files: indicator hides when autosave turns off', $('autosaveDot').hidden === true);

    // drive failure: the save falls back to a download and says so
    world.failSaves = true;
    world.blobs.length = 0;
    $('saveTxtButton').click(); await settle();
    check('files: unreachable drive falls back to a download and says where',
      world.blobs.length === 1 && /Downloads folder/.test($('statusDetail').textContent), $('statusDetail').textContent);
    world.failSaves = false;

    // drag-drop: clean draft imports directly; wrong extension refused
    draft.value = '';
    draft.dispatchEvent(new w.Event('input', {bubbles: true})); await tick();
    const drop = (file) => {
      const ev = new w.Event('drop', {bubbles: true, cancelable: true});
      ev.dataTransfer = {files: [file]};
      draft.dispatchEvent(ev);
    };
    drop(new w.File(['Dropped draft text.'], 'chapter.md', {type: 'text/markdown'})); await settle();
    check('files: dropped markdown imported into memory', draft.value === 'Dropped draft text.' && /Opened chapter\.md/.test($('statusTitle').textContent), $('statusTitle').textContent);
    drop(new w.File(['x'], 'photo.png', {type: 'image/png'})); await settle();
    check('files: non-text drop refused', draft.value === 'Dropped draft text.' && /cannot be opened/.test($('statusTitle').textContent), $('statusTitle').textContent);

    // dirty draft: import waits for the banner decision
    draft.value = 'Unsaved precious work.';
    draft.dispatchEvent(new w.Event('input', {bubbles: true})); await tick();
    drop(new w.File(['Replacement text.'], 'new.txt', {type: 'text/plain'})); await settle();
    check('files: dirty draft raises the replace banner instead of importing',
      $('importBanner').hidden === false && draft.value === 'Unsaved precious work.', draft.value);
    $('importNo').click();
    check('files: cancel keeps the draft', $('importBanner').hidden === true && draft.value === 'Unsaved precious work.');
    drop(new w.File(['Replacement text.'], 'new.txt', {type: 'text/plain'})); await settle();
    $('importYes').click(); await tick();
    check('files: replace applies the dropped file', draft.value === 'Replacement text.');
  }

  /* ============ autosave restore offer ============ */
  {
    const restorable = JSON.stringify({v: 1, kind: 'read-aloud-session', draft: 'Restored words.', flags: [], settings: {v: 1, speed: 1.1}});
    const world = await makeWorld((wd) => { wd.autosaveFile = restorable; });
    const {w} = world;
    const $ = (id) => w.document.getElementById(id);
    world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-ready', numSpeakers: 1}});
    await settle();
    check('restore: banner offered when an autosave exists', $('restoreBanner').hidden === false);
    check('restore: nothing loads without consent', $('draft').value === '');
    $('restoreYes').click(); await tick();
    check('restore: restore loads draft and settings', $('draft').value === 'Restored words.' && $('speed').value === '1.1', $('draft').value);
    check('restore: banner gone after restoring', $('restoreBanner').hidden === true);
  }
  {
    const restorable = JSON.stringify({v: 1, kind: 'read-aloud-session', draft: 'Restored words.', flags: [], settings: {}});
    const world = await makeWorld((wd) => { wd.autosaveFile = restorable; });
    const {w} = world;
    const $ = (id) => w.document.getElementById(id);
    world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-ready', numSpeakers: 1}});
    await settle();
    $('restoreNo').click();
    check('restore: dismiss keeps the draft empty', $('restoreBanner').hidden === true && $('draft').value === '');
  }

  /* ============ phase 5 polish ============ */
  {
    const world = await makeWorld((wd) => { wd.w.__RA_TINT_MS = 120; });
    const {w} = world;
    const $ = (id) => w.document.getElementById(id);
    const key = (k, opts = {}) => w.document.dispatchEvent(new w.KeyboardEvent('keydown', {key: k, ...opts}));
    const sendResult = () => world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-result', samples: new Float32Array(8), sampleRate: 22050}});
    world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-ready', numSpeakers: 1}});
    const draft = $('draft');

    // grouped controls
    check('polish: playback and display groups exist and default open',
      $('playbackGroup').open === true && $('displayGroup').open === true);
    $('displayGroup').open = false;
    $('settingsShow').click();
    check('polish: collapsed state lands in the settings string', /"sections":1[,}]/.test($('settingsBox').value), $('settingsBox').value.slice(0, 200));
    $('settingsBox').value = 'RA1 {"sections":2}';
    $('settingsApply').click();
    check('polish: sections apply restores open state', $('playbackGroup').open === false && $('displayGroup').open === true);
    $('settingsBox').value = 'RA1 {"sections":3}';
    $('settingsApply').click();

    // help overlay
    check('polish: overlay hidden at start', $('helpOverlay').hidden === true);
    w.document.body.focus && w.document.body.focus();
    draft.blur();
    key('?');
    check('polish: ? opens the shortcut overlay', $('helpOverlay').hidden === false);
    key('Escape');
    check('polish: Esc closes the overlay without touching playback', $('helpOverlay').hidden === true);
    $('helpButton').click();
    check('polish: help button opens it too', $('helpOverlay').hidden === false);
    $('helpClose').click();
    check('polish: close button works', $('helpOverlay').hidden === true);

    // paste cleanup
    draft.focus();
    const pasteEv = new w.Event('paste', {bubbles: true, cancelable: true});
    pasteEv.clipboardData = {getData: () => '\u201CSmart\u201D \u2014 it\u2019s\u00ADhere\u2026'};
    draft.dispatchEvent(pasteEv);
    check('polish: paste is straightened and de-invisibled', draft.value === '"Smart" -- it\'shere...', JSON.stringify(draft.value));
    check('polish: cleaning paste prevents the raw default', pasteEv.defaultPrevented === true);
    $('cleanPasteToggle').checked = false;
    const pasteOff = new w.Event('paste', {bubbles: true, cancelable: true});
    pasteOff.clipboardData = {getData: () => '\u201CRaw\u201D'};
    draft.dispatchEvent(pasteOff);
    check('polish: toggle off leaves paste alone', pasteOff.defaultPrevented === false);
    $('cleanPasteToggle').checked = true;

    // tidy whole draft
    draft.value = 'Already \u2018quoted\u2019 text.';
    draft.dispatchEvent(new w.Event('input', {bubbles: true})); await tick();
    $('tidyButton').click(); await tick();
    check('polish: tidy cleans the whole draft', draft.value === "Already 'quoted' text.", JSON.stringify(draft.value));

    // fresh-render tint
    $('gap').value = '0';
    $('gap').dispatchEvent(new w.Event('input', {bubbles: true}));
    draft.value = 'First bit. Second bit.';
    draft.dispatchEvent(new w.Event('input', {bubbles: true})); await tick();
    $('renderButton').click(); await tick();
    sendResult(); await tick(); sendResult(); await tick(); sendResult(); await tick();
    check('polish: freshly rendered sentences carry the tint',
      $('backdropContent').querySelectorAll('u.fresh').length >= 1, $('backdropContent').innerHTML.slice(0, 200));
    await new Promise((r) => setTimeout(r, 240)); await tick();
    check('polish: tint fades after its moment', $('backdropContent').querySelector('u.fresh') === null);

    // resume marker lifecycle
    draft.value = 'Alpha one. Beta two. Gamma three.';
    draft.dispatchEvent(new w.Event('input', {bubbles: true})); await tick();
    draft.setSelectionRange(0, 0);
    key('F8');
    sendResult(); await tick(); await tick();
    key('Escape'); await new Promise((r) => setTimeout(r, 60));
    check('polish: stopping leaves a resume marker in the backdrop',
      $('backdropContent').querySelector('u.resumemark') !== null, $('backdropContent').innerHTML.slice(0, 200));
    check('polish: resume alone announces itself without a flag count',
      /Resume point saved/.test($('flagsInfo').textContent), $('flagsInfo').textContent);
    $('flagPanelToggle').click(); await new Promise((r) => setTimeout(r, 60));
    const firstItem = $('flagPanel').querySelector('li');
    check('polish: resume is the pinned first panel row', firstItem !== null && firstItem.className.includes('flag-resume'), $('flagPanel').innerHTML.slice(0, 200));
    $('flagReportButton').click(); await settle();
    check('polish: resume never appears in the report',
      saveBuf(world, 'report').toString('utf8').startsWith('Flagged sentences (0)') &&
      !saveBuf(world, 'report').toString('utf8').includes('Alpha one'), saveBuf(world, 'report').toString('utf8'));
    $('sessionSave').click(); await settle();
    const sess = JSON.parse(saveBuf(world, 'session').toString('utf8'));
    check('polish: resume rides in session files', sess.flags.some((f) => f.kind === 'resume'));
    draft.setSelectionRange(0, 0);
    key('F8'); await tick();
    check('polish: resuming reads from cache instantly', world.liveSources.length === 1);
    key('Escape'); await new Promise((r) => setTimeout(r, 60));
  }

  /* ============ clear leaves nothing behind ============ */
  {
    const world = await makeWorld();
    const {w} = world;
    const $ = (id) => w.document.getElementById(id);
    const key = (k) => w.document.dispatchEvent(new w.KeyboardEvent('keydown', {key: k}));
    const sendResult = () => world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-result', samples: new Float32Array(8), sampleRate: 22050}});
    world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-ready', numSpeakers: 1}});
    const draft = $('draft');
    $('gap').value = '0';
    $('gap').dispatchEvent(new w.Event('input', {bubbles: true}));
    draft.value = 'The the cat sat. Second sentence here.';
    draft.dispatchEvent(new w.Event('input', {bubbles: true})); await tick();
    draft.setSelectionRange(0, 0);
    key('F8');
    sendResult(); await tick(); await tick();
    key('F9'); // one user flag while playing
    key('Escape'); await new Promise((r) => setTimeout(r, 60));
    check('clear: decorations present before clearing',
      $('backdropContent').querySelector('u') !== null, $('backdropContent').innerHTML.slice(0, 120));
    $('clearButton').click(); await new Promise((r) => setTimeout(r, 60));
    check('clear: backdrop repainted empty — no stale underlines',
      $('backdropContent').querySelector('u') === null && $('backdropContent').textContent === '', $('backdropContent').innerHTML.slice(0, 120));
    check('clear: resume bookmark dropped by a deliberate wipe',
      !/Resume point saved/.test($('flagsInfo').textContent), $('flagsInfo').textContent);
    check('clear: user flags survive with their own button intact',
      /1 flagged/.test($('flagsInfo').textContent) && $('flagsRow').hidden === false, $('flagsInfo').textContent);
    $('flagClearButton').click();
    check('clear: clear-flags still hides the row afterwards', $('flagsRow').hidden === true);
  }

  /* ============ resume clears on replay ============ */
  {
    const world = await makeWorld();
    const {w} = world;
    const $ = (id) => w.document.getElementById(id);
    const key = (k) => w.document.dispatchEvent(new w.KeyboardEvent('keydown', {key: k}));
    const sendResult = () => world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-result', samples: new Float32Array(8), sampleRate: 22050}});
    world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-ready', numSpeakers: 1}});
    const draft = $('draft');
    $('gap').value = '0';
    $('gap').dispatchEvent(new w.Event('input', {bubbles: true}));
    draft.value = 'Solo sentence.';
    draft.dispatchEvent(new w.Event('input', {bubbles: true})); await tick();
    draft.setSelectionRange(0, 0);
    key('F8');
    sendResult(); await tick(); await tick();
    key('Escape'); await new Promise((r) => setTimeout(r, 60));
    check('resume: marker exists after stop', $('backdropContent').querySelector('u.resumemark') !== null);
    draft.setSelectionRange(0, 0);
    key('F8'); await tick(); await new Promise((r) => setTimeout(r, 60));
    check('resume: replaying its sentence clears the marker while reading',
      w.document.querySelectorAll('#backdropContent u.resumemark').length === 0);
    key('Escape');
  }

  /* ============ multi-speaker vits (libritts) ============ */
  {
    const world = await makeWorld((wd) => {
      wd.voiceCatalog = {voices: [
        {id: 'libritts-r-medium', name: 'LibriTTS-R', quality: 'medium', sampleRate: 22050, architecture: 'vits',
         speakers: [{id: 12, name: 'Warm Reader'}, {id: 337, name: 'Deep Narrator'}, {id: 903, name: 'Last Row'}],
         modelUrl: 'voices/libritts/model.onnx', tokensUrl: 'voices/libritts/tokens.txt'},
        {id: 'libritts-raw', name: 'LibriTTS Raw', quality: 'medium', sampleRate: 22050, architecture: 'vits',
         modelUrl: 'voices/libritts/model.onnx', tokensUrl: 'voices/libritts/tokens.txt'},
      ], invalid: []};
    });
    const {w} = world;
    const $ = (id) => w.document.getElementById(id);
    const key = (k) => w.document.dispatchEvent(new w.KeyboardEvent('keydown', {key: k}));
    const sendResult = () => world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-result', samples: new Float32Array(8), sampleRate: 22050}});
    const gen = () => world.workerInstance.received;

    world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-ready', numSpeakers: 904}});
    check('libritts: curated names shown for a multi-speaker vits voice',
      $('speakerRow').hidden === false && $('speakerSelect').options.length === 3 &&
      $('speakerSelect').options[1].textContent === 'Deep Narrator', $('speakerSelect').innerHTML.slice(0, 150));
    check('libritts: delivery toggle coexists with the speaker picker for vits',
      $('deliveryRow').hidden === false);

    $('gap').value = '0';
    $('gap').dispatchEvent(new w.Event('input', {bubbles: true}));
    const draft = $('draft');
    draft.value = 'Solo sentence.';
    draft.dispatchEvent(new w.Event('input', {bubbles: true})); await tick();
    $('speakerSelect').value = '337';
    $('speakerSelect').dispatchEvent(new w.Event('input', {bubbles: true})); await tick();
    const workersNow = world.ttsWorkers;
    draft.setSelectionRange(0, 0);
    key('F8');
    check('libritts: generates with a sid beyond the old 255 ceiling',
      gen().length === 1 && gen()[0].sid === 337 && world.ttsWorkers === workersNow, JSON.stringify(gen()));
    sendResult(); await tick(); await tick();
    key('Escape');

    $('settingsBox').value = 'RA1 {"speaker":{"libritts-r-medium":903}}';
    $('settingsApply').click(); await tick();
    check('libritts: settings accept high sids', $('speakerSelect').value === '903', $('speakerSelect').value);

    // auto-detection with no curated list: the engine's own count names them
    $('voiceSelect').value = 'libritts-raw';
    $('voiceSelect').dispatchEvent(new w.Event('input', {bubbles: true})); await tick();
    world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-ready', numSpeakers: 904}});
    check('libritts: uncurated package auto-lists every engine speaker',
      $('speakerRow').hidden === false && $('speakerSelect').options.length === 904 &&
      $('speakerSelect').options[903].textContent === 'Voice 904', String($('speakerSelect').options.length));
  }

  /* ============ resume marker toggle ============ */
  {
    const world = await makeWorld();
    const {w} = world;
    const $ = (id) => w.document.getElementById(id);
    const key = (k) => w.document.dispatchEvent(new w.KeyboardEvent('keydown', {key: k}));
    const sendResult = () => world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-result', samples: new Float32Array(8), sampleRate: 22050}});
    world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-ready', numSpeakers: 1}});
    const draft = $('draft');
    $('gap').value = '0';
    $('gap').dispatchEvent(new w.Event('input', {bubbles: true}));
    draft.value = 'Solo sentence.';
    draft.dispatchEvent(new w.Event('input', {bubbles: true})); await tick();

    check('resume toggle: on by default', $('resumeToggle').checked === true);
    draft.setSelectionRange(0, 0);
    key('F8'); sendResult(); await tick(); await tick();
    key('Escape'); await new Promise((r) => setTimeout(r, 60));
    check('resume toggle: marker exists while enabled', $('backdropContent').querySelector('u.resumemark') !== null);

    $('resumeToggle').checked = false;
    $('resumeToggle').dispatchEvent(new w.Event('input', {bubbles: true}));
    await new Promise((r) => setTimeout(r, 60));
    check('resume toggle: turning it off removes the existing marker',
      $('backdropContent').querySelector('u.resumemark') === null && !/Resume point/.test($('flagsInfo').textContent));
    draft.setSelectionRange(0, 0);
    key('F8'); await tick(); await tick();
    key('Escape'); await new Promise((r) => setTimeout(r, 60));
    check('resume toggle: no marker is left while disabled',
      $('backdropContent').querySelector('u.resumemark') === null, $('backdropContent').innerHTML.slice(0, 120));

    $('settingsBox').value = 'RA1 {"resume":true}';
    $('settingsApply').click();
    check('resume toggle: settings round trip restores it', $('resumeToggle').checked === true);
    $('settingsShow').click();
    check('resume toggle: state lands in the settings string', /"resume":true/.test($('settingsBox').value));
  }

  /* ============ playback queue hardening (BUGS.md P1) ============ */
  {
    const world = await makeWorld();
    const {w} = world;
    const $ = (id) => w.document.getElementById(id);
    const key = (k) => w.document.dispatchEvent(new w.KeyboardEvent('keydown', {key: k}));
    world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-ready', numSpeakers: 1}});
    const draft = $('draft');
    const gen = () => world.workerInstance.received;
    const resultFor = (id) => world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-result', id, samples: new Float32Array(8).fill(0.5), sampleRate: 22050}});

    // P1-1: replies are matched by id — a stale or bogus id changes nothing
    $('gap').value = '0';
    $('gap').dispatchEvent(new w.Event('input', {bubbles: true}));
    draft.value = 'Solo sentence.';
    draft.dispatchEvent(new w.Event('input', {bubbles: true})); await tick();
    draft.setSelectionRange(0, 0);
    key('F8');
    check('queue: generate carries a request id', gen().length === 1 && Number.isInteger(gen()[0].id), JSON.stringify(gen()));
    const realId = gen()[0].id;
    world.sourcesCreated = 0;
    resultFor(999999); await tick(); await tick();
    check('queue: a bogus id is ignored and starts nothing', world.sourcesCreated === 0 && /Generating|Reading|Speaking/.test($('statusTitle').textContent), $('statusTitle').textContent);
    resultFor(realId); await tick(); await tick();
    check('queue: the real id plays its own sentence', world.sourcesCreated === 1);
    key('Escape');

    // P1-2: a result landing inside the inter-sentence gap must not start
    // audio — the gap timer owns the start, so exactly one source per sentence
    w.__lastGapWorld = true;
    draft.value = 'First one. Second one.';
    draft.dispatchEvent(new w.Event('input', {bubbles: true})); await tick();
    $('gap').value = '0.15';
    $('gap').dispatchEvent(new w.Event('input', {bubbles: true}));
    world.sourcesCreated = 0;
    draft.setSelectionRange(0, 0);
    key('F8');
    resultFor(gen()[gen().length - 1].id); await tick(); await tick();
    check('queue: first sentence started once', world.sourcesCreated === 1);
    const s1 = world.liveSources[0];
    s1.onended && s1.onended(); await tick();           // gap begins, sentence 2 requested
    resultFor(gen()[gen().length - 1].id); await tick(); await tick();
    check('queue: result during the gap starts nothing', world.sourcesCreated === 1, `sources=${world.sourcesCreated}`);
    await new Promise((r) => setTimeout(r, 220)); await tick();
    check('queue: the gap timer starts it exactly once', world.sourcesCreated === 2, `sources=${world.sourcesCreated}`);
    key('Escape');

    // P1-2 step mode: a result while waiting must not speak on its own
    $('gap').value = '0';
    $('gap').dispatchEvent(new w.Event('input', {bubbles: true}));
    $('stepToggle').checked = true;
    $('stepToggle').dispatchEvent(new w.Event('input', {bubbles: true}));
    world.sourcesCreated = 0;
    draft.setSelectionRange(0, 0);
    key('F8'); await tick();
    if (gen().length && !world.liveSources.length) { resultFor(gen()[gen().length - 1].id); await tick(); await tick(); }
    check('queue: step mode first sentence started once', world.sourcesCreated === 1, `sources=${world.sourcesCreated}`);
    const s2 = world.liveSources[world.liveSources.length - 1];
    s2.onended && s2.onended(); await tick();            // now awaiting step
    if (gen().length) resultFor(gen()[gen().length - 1].id); await tick(); await tick();
    check('queue: result while awaiting step stays silent', world.sourcesCreated === 1, `sources=${world.sourcesCreated}`);
    key('F8'); await tick(); await tick();
    check('queue: F8 releases the paused sentence once', world.sourcesCreated === 2, `sources=${world.sourcesCreated}`);
    key('Escape');
    $('stepToggle').checked = false;

    // P2-1: every drive save carries the per-run token header
    draft.value = 'Token check.';
    draft.dispatchEvent(new w.Event('input', {bubbles: true})); await tick();
    $('saveTxtButton').click(); await settle();
    const saved = lastSave(world, 'text');
    check('queue: drive saves carry the X-RA-Token header',
      saved !== undefined && Object.prototype.hasOwnProperty.call(saved.headers, 'X-RA-Token'), JSON.stringify(saved && saved.headers));
  }

  /* ============ docx addon (phase 6) ============ */
  {
    // Without the addon: .docx is refused with a hint, .txt still works
    const world = await makeWorld();
    const {w} = world;
    const $ = (id) => w.document.getElementById(id);
    world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-ready', numSpeakers: 1}});
    await settle();
    const draft = $('draft');
    const drop = (file) => {
      const ev = new w.Event('drop', {bubbles: true, cancelable: true});
      ev.dataTransfer = {files: [file]};
      draft.dispatchEvent(ev);
    };
    drop(new w.File(['PK'], 'report.docx', {type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}));
    await settle();
    check('addons: docx refused with a hint when the addon is absent',
      draft.value === '' && /optional addon/.test($('statusTitle').textContent) && /addons\/docx/.test($('statusDetail').textContent),
      $('statusTitle').textContent + ' | ' + $('statusDetail').textContent);
  }
  {
    // With the addon: the extractor loads (pre-seeded, as script tags do not
    // execute in the harness) and the text flows through the import path
    const world = await makeWorld((wd) => {
      wd.addonsList = ['docx'];
      wd.w.mammoth = {extractRawText: async ({arrayBuffer}) => {
        wd.gotBuffer = arrayBuffer instanceof wd.w.ArrayBuffer && arrayBuffer.byteLength > 0;
        return {value: 'Extracted document text.\n\n\n\nSecond paragraph.'};
      }};
    });
    const {w} = world;
    const $ = (id) => w.document.getElementById(id);
    world.workerInstance.onmessage({data: {type: 'sherpa-onnx-tts-ready', numSpeakers: 1}});
    await settle();
    const draft = $('draft');
    const drop = (file) => {
      const ev = new w.Event('drop', {bubbles: true, cancelable: true});
      ev.dataTransfer = {files: [file]};
      draft.dispatchEvent(ev);
    };
    drop(new w.File(['PKfakezipbytes'], 'chapter.docx', {type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}));
    await settle();
    check('addons: docx imports through the extractor into memory',
      draft.value === 'Extracted document text.\n\nSecond paragraph.' && world.gotBuffer === true,
      JSON.stringify(draft.value));
    check('addons: import announces itself like any file open', /Opened chapter\.docx/.test($('statusTitle').textContent), $('statusTitle').textContent);

    // a dirty draft still gets the replace banner, exactly like txt drops
    draft.value = 'Precious unsaved rewrite.';
    draft.dispatchEvent(new w.Event('input', {bubbles: true})); await tick();
    drop(new w.File(['PK2'], 'other.docx', {type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}));
    await settle();
    check('addons: dirty draft raises the replace banner for docx too',
      $('importBanner').hidden === false && draft.value === 'Precious unsaved rewrite.');
    $('importNo').click();
  }

  const passed = results.filter(r => r[0]).length;
  for (const [ok, name] of results) console.log(ok ? 'PASS' : 'FAIL', name);
  console.log(`\n[${dir}] ${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
