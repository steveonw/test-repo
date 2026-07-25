#!/usr/bin/env node
'use strict';
/*
 * Stress suite: hammers the playback engine, cache, and flag system with
 * hostile usage patterns — rapid cycles, cancels, floods, huge documents —
 * and asserts the app never wedges, leaks queue state, or slows past budget.
 * Runs on jsdom (fast, CI-friendly). Usage: node scripts/stress_tests.js [dir]
 */
const {JSDOM} = require('jsdom');
const fs = require('fs');
const dir = process.argv[2] || '.';
const html = fs.readFileSync(`${dir}/web/index.html`, 'utf8');
const appjs = fs.readFileSync(`${dir}/web/app.js`, 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 0));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (n, c, x = '') => { results.push([c, n]); console.log(c ? 'PASS' : 'FAIL', n, c ? '' : `-- ${x}`); };

function makeWorld() {
  const dom = new JSDOM(html, {url: 'http://127.0.0.1:17391/', runScripts: 'outside-only'});
  const w = dom.window;
  const world = {w, worker: null, live: [], blobs: []};
  w.Worker = class {
    constructor(script) { if (!String(script).includes('mp3')) world.worker = this; this.received = []; }
    postMessage(m) { if (m && m.type === 'init') return; this.received.push(m); }
    terminate() {}
  };
  w.AudioContext = class {
    async resume() {} async close() {}
    createBuffer(c, len) { return {getChannelData: () => new Float32Array(len)}; }
    createGain() { return {gain: {value: 1}, connect() {}}; }
    createBufferSource() {
      const s = {onended: null, playbackRate: {value: 1}, connect() {}, start() { world.live.push(s); }, stop() { world.live = world.live.filter((x) => x !== s); }};
      return s;
    }
    get destination() { return {}; }
  };
  w.ResizeObserver = class { observe() {} };
  w.URL.createObjectURL = (b) => { world.blobs.push(b); return 'blob:x'; };
  w.URL.revokeObjectURL = () => {};
  w.fetch = (url) => {
    if (String(url) === '/api/voices') {
      return Promise.resolve({ok: true, json: () => Promise.resolve({voices: [
        {id: 'amy-medium', name: 'Amy', quality: '', sampleRate: 22050,
         modelUrl: 'voices/amy-medium/model.onnx', tokensUrl: 'voices/amy-medium/tokens.txt'}], invalid: []})});
    }
    return Promise.resolve({ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('x')});
  };
  w.eval(appjs);
  world.$ = (id) => w.document.getElementById(id);
  world.key = (k) => w.document.dispatchEvent(new w.KeyboardEvent('keydown', {key: k}));
  world.input = () => world.$('draft').dispatchEvent(new w.Event('input', {bubbles: true}));
  world.result = (n = 40) => world.worker.onmessage({data: {type: 'sherpa-onnx-tts-result', samples: new Float32Array(n).fill(0.3), sampleRate: 22050}});
  world.endAudio = () => { const s = world.live.shift(); if (s && s.onended) s.onended(); };
  world.pending = (async () => {
    for (let i = 0; i < 50 && !world.worker; i++) await new Promise((r) => setTimeout(r, 5));
    world.worker.onmessage({data: {type: 'sherpa-onnx-tts-ready'}});
  })();
  world.$('gap').value = '0';
  world.$('gap').dispatchEvent(new w.Event('input', {bubbles: true}));
  return world;
}

(async () => {
  /* ---- 1. 60 rapid read/stop/resume cycles ---- */
  {
    const world = makeWorld(); await world.pending;
    const {$, key} = world;
    const draft = $('draft');
    draft.value = Array.from({length: 12}, (_, i) => `Cycle sentence number ${i} here.`).join(' ');
    world.input(); await tick();
    let sane = true;
    for (let i = 0; i < 60; i++) {
      draft.setSelectionRange(0, 0);
      key('F8');
      if (i % 3 === 0) { world.result(); await tick(); await tick(); } // sometimes audio starts
      if (i % 5 === 0) world.result();                                  // sometimes results land late
      key('Escape'); await tick();
      const st = $('statusTitle').textContent;
      if (!/Stopped|ready|Amy|Lessac/.test(st)) { sane = false; break; }
    }
    // flush any leftovers, then one clean run must still work end to end
    for (let i = 0; i < 30; i++) { try { world.result(); } catch (_) {} await tick(); }
    draft.setSelectionRange(0, 0);
    key('F8'); await tick();
    for (let i = 0; i < 40 && world.live.length === 0; i++) { world.result(); await tick(); await tick(); }
    check('60 read/stop cycles: status stays sane', sane, $('statusTitle').textContent);
    check('60 read/stop cycles: playback still works after', world.live.length === 1, $('statusTitle').textContent);
    key('Escape'); await tick();
  }

  /* ---- 2. 25 render/cancel/edit cycles ---- */
  {
    const world = makeWorld(); await world.pending;
    const {$, key} = world;
    const draft = $('draft');
    let ok = true;
    for (let i = 0; i < 25; i++) {
      draft.value = `Version ${i} first sentence. Version ${i} second sentence. Shared closing sentence.`;
      world.input(); await tick();
      $('renderButton').disabled || $('renderButton').click(); await tick();
      world.result(); await tick();       // one sentence completes
      key('Escape'); await tick();        // cancel mid-render
      if ($('statusTitle').textContent.includes('Rendering')) { ok = false; break; }
    }
    // final full render must succeed and reuse the shared sentence from cache
    draft.value = 'Version 24 first sentence. Version 24 second sentence. Shared closing sentence.';
    world.input(); await tick();
    if (!$('renderButton').disabled) {
      $('renderButton').click(); await tick();
      for (let i = 0; i < 60 && $('statusTitle').textContent !== 'Narration ready'; i++) { world.result(); await tick(); }
    }
    check('25 render/cancel/edit cycles: never wedges', ok, $('statusTitle').textContent);
    check('render completes after cancel storm', !$('exportButton').disabled, $('narrationInfo').textContent);
  }

  /* ---- 3. 500 flags: perf and correctness ---- */
  {
    const world = makeWorld(); await world.pending;
    const {$, key} = world;
    const draft = $('draft');
    draft.value = Array.from({length: 500}, (_, i) => `Flagged stress sentence number ${i}.`).join(' ');
    world.input(); await wait(300);
    const t0 = Date.now();
    for (let i = 0; i < 500; i++) {
      const pos = draft.value.indexOf(`number ${i}.`);
      draft.setSelectionRange(pos, pos);
      key('F9');
    }
    const flagMs = Date.now() - t0;
    check('500 flags toggled under 5s', flagMs < 5000, `${flagMs}ms`);
    check('500 flags counted', $('flagsInfo').textContent.includes('500 flagged'), $('flagsInfo').textContent);
    const t1 = Date.now();
    world.blobs.length = 0;
    $('flagReportButton').click();
    check('500-flag report generated quickly', Date.now() - t1 < 1000 && world.blobs.length === 1, `${Date.now() - t1}ms`);
    draft.setSelectionRange(0, 0);
    const t2 = Date.now();
    key('F10');
    check('F10 among 500 flags under 250ms', Date.now() - t2 < 250, `${Date.now() - t2}ms`);
  }

  /* ---- 4. 400KB document: typing stays responsive ---- */
  {
    const world = makeWorld(); await world.pending;
    const {$} = world;
    const draft = $('draft');
    draft.value = 'A realistic sentence for the very large manuscript test, long enough to be plausible. '.repeat(4600);
    const t0 = Date.now();
    world.input();
    const syncMs = Date.now() - t0;
    check('400KB doc: input handler under 30ms (deferred)', syncMs < 30, `${syncMs}ms`);
    await wait(350);
    check('400KB doc: deferred stats complete', $('statsInfo').textContent.includes('4600 sentences'), $('statsInfo').textContent.slice(0, 60));
    const t1 = Date.now();
    draft.setSelectionRange(0, 0);
    world.key('F8'); await tick();
    check('400KB doc: starting playback under 500ms', Date.now() - t1 < 500 && world.worker.received.length >= 1, `${Date.now() - t1}ms`);
    world.key('Escape');
  }

  /* ---- 5. stale-result flood: 20 interleaved stop/starts ---- */
  {
    const world = makeWorld(); await world.pending;
    const {$, key} = world;
    const draft = $('draft');
    draft.value = 'Flood alpha sentence. Flood beta sentence. Flood gamma sentence.';
    world.input(); await tick();
    for (let i = 0; i < 20; i++) {
      draft.setSelectionRange(0, 0);
      key('F8');
      key('Escape');
    }
    for (let i = 0; i < 25; i++) { try { world.result(); } catch (_) {} await tick(); }
    draft.setSelectionRange(0, 0);
    key('F8'); await tick(); await tick();
    // everything is cached by the flood's discarded-but-stored results
    check('stale flood: cached playback recovers instantly', world.live.length === 1, $('statusTitle').textContent);
    key('Escape');
  }

  const passed = results.filter((r) => r[0]).length;
  console.log(`\nSTRESS: ${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error('STRESS SUITE ERROR:', e); process.exit(1); });
