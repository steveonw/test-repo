#!/usr/bin/env node
'use strict';
/*
 * Runtime smoke test: boots the real launcher, drives the app in headless
 * Chromium, and verifies the paths that structural checks cannot see —
 * voice load, playback + highlight, render, WAV/MP3 export bytes, and the
 * theme/focus/hidden cascade in a real rendering engine. Screenshots of
 * light and dark themes are written for the CI artifact.
 *
 * Usage: node scripts/runtime_smoke.js <sharedDir> [port] [outDir]
 */
const {spawn} = require('child_process');
const fs = require('fs');
const path = require('path');

const sharedDir = process.argv[2];
const port = Number(process.argv[3] || 17391);
const outDir = process.argv[4] || 'dist/runtime-smoke';
if (!sharedDir || !fs.existsSync(sharedDir)) {
  console.error('usage: runtime_smoke.js <sharedDir> [port] [outDir]');
  process.exit(2);
}
fs.mkdirSync(outDir, {recursive: true});

const results = [];
const check = (name, cond, extra) => {
  results.push([Boolean(cond), name]);
  console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : `-- ${extra}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(base, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(base + '/health');
      if (res.ok) return true;
    } catch (_) { /* not up yet */ }
    await sleep(300);
  }
  return false;
}

(async () => {
  const base = `http://127.0.0.1:${port}`;
  console.log(`starting launcher for ${sharedDir} on ${base}`);
  const launcher = spawn('go', ['run', './cmd/launcher', '--shared', sharedDir, '--no-browser'], {
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: true, // own process group, so cleanup can kill `go run`'s compiled child too
  });
  let launcherExited = false;
  launcher.on('exit', () => { launcherExited = true; });

  try {
    check('launcher responds on /health', await waitForHealth(base, 60000), 'no response in 60s');

    const {chromium} = require('playwright');
    const browser = await chromium.launch({args: [
      '--autoplay-policy=no-user-gesture-required',
      // Containers ship a tiny /dev/shm; without this flag Chromium's
      // SharedArrayBuffer allocation for the 512MB wasm heap can hang.
      '--disable-dev-shm-usage',
    ]});
    const context = await browser.newContext({acceptDownloads: true});
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const url = (m.location() && m.location().url) || '';
      // settings.txt is optional by design; favicon is browser noise; the
      // sherpa engine prints normal diagnostics to stderr, which Emscripten
      // surfaces as console.error from the wasm glue.
      if (/settings\.txt$|favicon\.ico$|sherpa-onnx-wasm-main-tts\.js$/.test(url)) return;
      pageErrors.push(`${m.text()} [${url}]`);
    });

    await page.goto(base + '/', {waitUntil: 'domcontentloaded'});
    check('page loads', true);

    // 1. Voice engine loads (real WASM in CI; protocol stub locally)
    const readyDeadline = Date.now() + 600000; // ten minutes: slow disks and single-core boxes
    let readyOk = false;
    while (Date.now() < readyDeadline) {
      const status = await page.evaluate(() => document.getElementById('statusTitle').textContent);
      if (/is ready/.test(status)) { readyOk = true; break; }
      console.log(`  ...waiting for voice: "${status}"`);
      await sleep(15000);
    }
    check('voice engine reports ready', readyOk, 'not ready within 10 minutes');
    if (!readyOk) throw new Error('voice never became ready');

    // 2. Playback with follow-along highlight
    await page.fill('#draft', 'The quick brown fox jumps over the lazy dog. A second sentence checks the render.');
    await page.click('#draft');
    await page.evaluate(() => document.getElementById('draft').setSelectionRange(0, 0));
    await page.click('#readButton');
    await page.waitForFunction(
      () => /Reading|Speaking/.test(document.getElementById('statusTitle').textContent),
      null, {timeout: 90000},
    );
    check('playback starts', true);
    const markText = await page.evaluate(() => {
      const m = document.querySelector('#backdropContent mark');
      return m ? m.textContent : null;
    });
    check('follow-along highlight rendered', markText && markText.includes('quick brown fox'), markText);
    await page.keyboard.press('Escape');

    // 3. Render the narration
    await page.click('#renderButton');
    await page.waitForFunction(
      () => document.getElementById('statusTitle').textContent === 'Narration ready',
      null, {timeout: 180000},
    );
    check('render completes', true);

    // 4. WAV export produces a valid file (also proves blob downloads survive CSP)
    const [wavDl] = await Promise.all([
      page.waitForEvent('download', {timeout: 60000}),
      page.click('#exportButton'),
    ]);
    const wavPath = path.join(outDir, 'smoke.wav');
    await wavDl.saveAs(wavPath);
    const wav = fs.readFileSync(wavPath);
    check('WAV has RIFF/WAVE header and audio data',
      wav.length > 2000 && wav.toString('ascii', 0, 4) === 'RIFF' && wav.toString('ascii', 8, 12) === 'WAVE',
      `${wav.length} bytes`);

    // 5. MP3 export via the lamejs worker
    const [mp3Dl] = await Promise.all([
      page.waitForEvent('download', {timeout: 120000}),
      page.click('#exportMp3Button'),
    ]);
    const mp3Path = path.join(outDir, 'smoke.mp3');
    await mp3Dl.saveAs(mp3Path);
    const mp3 = fs.readFileSync(mp3Path);
    const mp3Ok = mp3.length > 500 &&
      ((mp3[0] === 0xff && (mp3[1] & 0xe0) === 0xe0) || mp3.toString('ascii', 0, 3) === 'ID3');
    check('MP3 has frame sync and data', mp3Ok, `${mp3.length} bytes, ${mp3[0]},${mp3[1]}`);

    // 6. Theme / focus / hidden cascade in a real engine (the shipped-bug class)
    await page.screenshot({path: path.join(outDir, 'light.png'), fullPage: true});
    await page.selectOption('#themeSelect', 'dark');
    const dark = await page.evaluate(() => {
      const stack = document.querySelector('.editor-stack');
      stack.classList.add('focus-live');
      const taColor = getComputedStyle(document.getElementById('draft')).color;
      stack.classList.remove('focus-live');
      return {
        attr: document.documentElement.dataset.theme,
        colorScheme: getComputedStyle(document.documentElement).colorScheme,
        focusTextarea: taColor,
        flagsRowDisplay: getComputedStyle(document.getElementById('flagsRow')).display,
        bodyBg: getComputedStyle(document.body).backgroundColor,
      };
    });
    check('dark theme attribute applied', dark.attr === 'dark', dark.attr);
    check('color-scheme follows theme', dark.colorScheme === 'dark', dark.colorScheme);
    check('focus mode keeps textarea transparent in dark', dark.focusTextarea === 'rgba(0, 0, 0, 0)', dark.focusTextarea);
    check('hidden flags row computes display none', dark.flagsRowDisplay === 'none', dark.flagsRowDisplay);
    await page.screenshot({path: path.join(outDir, 'dark.png'), fullPage: true});
    await page.selectOption('#themeSelect', 'light');

    check('no page errors during the run', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

    await browser.close();
    try { await fetch(base + '/quit', {method: 'POST'}); } catch (_) { /* fine */ }
    await sleep(1500);
  } finally {
    if (!launcherExited) {
      try { process.kill(-launcher.pid, 'SIGTERM'); } catch (_) { launcher.kill('SIGTERM'); }
      await sleep(500);
      if (!launcherExited) {
        try { process.kill(-launcher.pid, 'SIGKILL'); } catch (_) { launcher.kill('SIGKILL'); }
      }
    }
  }

  const passed = results.filter((r) => r[0]).length;
  console.log(`\nRUNTIME SMOKE: ${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((err) => {
  console.error('RUNTIME SMOKE FAILED:', err);
  process.exit(1);
});
