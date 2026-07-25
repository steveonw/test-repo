#!/usr/bin/env node
'use strict';
/*
 * Browser-level reliability checks that need a real engine and launcher:
 *  - corrupted payload produces an understandable integrity warning
 *  - killing the server mid-session raises the drive-lost warning while
 *    the page keeps its in-memory state
 *  - the app leaves no trace in browser storage
 *  - assets carry the revalidation cache headers
 * Usage: node scripts/stress_browser.js <sharedDir> [port]
 */
const {spawn, spawnSync} = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const sharedDir = process.argv[2];
const port = Number(process.argv[3] || 17391);
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (n, c, x = '') => { results.push([c, n]); console.log(c ? 'PASS' : 'FAIL', n, c ? '' : `-- ${x}`); };

function startLauncher(dirArg) {
  return spawn('go', ['run', './cmd/launcher', '--shared', dirArg, '--no-browser'], {stdio: 'ignore', detached: true});
}
function killGroup(child) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { try { child.kill('SIGKILL'); } catch (_) {} }
}
async function waitHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(base + '/health'); if (r.ok) return await r.text(); } catch (_) {}
    await sleep(300);
  }
  return null;
}

(async () => {
  const {chromium} = require('playwright');

  /* ---- 1. corrupted payload: integrity flows launcher -> health -> page ---- */
  const corruptRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-corrupt-'));
  const corruptDir = path.join(corruptRoot, 'shared');
  fs.cpSync(sharedDir, corruptDir, {recursive: true});
  // a minimal voice so the app proceeds to the engine (its model is junk on purpose)
  const vdir = path.join(corruptRoot, 'voices', 'amy-medium');
  fs.mkdirSync(vdir, {recursive: true});
  fs.writeFileSync(path.join(vdir, 'model.onnx'), 'junk');
  fs.writeFileSync(path.join(vdir, 'tokens.txt'), '_ 0');
  fs.writeFileSync(path.join(vdir, 'voice.json'), JSON.stringify({schemaVersion: 1, id: 'amy-medium', name: 'Amy Medium', engine: 'sherpa-vits', architecture: 'vits', model: 'model.onnx', tokens: 'tokens.txt', quantization: 'none', sampleRate: 22050}));
  // real checksums, then corrupt one engine file
  const files = ['app.js', 'index.html', 'sherpa-onnx-tts.js'];
  const sums = files.map((f) => {
    const out = spawnSync('sha256sum', [path.join(corruptDir, f)], {encoding: 'utf8'}).stdout;
    return out.split(/\s+/)[0] + '  ' + f;
  });
  fs.writeFileSync(path.join(corruptDir, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
  fs.appendFileSync(path.join(corruptDir, 'sherpa-onnx-tts.js'), '\n// bit rot\n');

  let launcher = startLauncher(corruptDir);
  const health = await waitHealth(60000);
  check('corrupt payload: health reports the failure', health !== null && /integrity:failed:1\/3/.test(health), String(health));

  const browser = await chromium.launch({args: ['--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage']});
  let page = await browser.newPage();
  await page.goto(base + '/', {waitUntil: 'domcontentloaded'});
  await page.waitForFunction(() => /is ready|Could not load/.test(document.getElementById('statusTitle').textContent), null, {timeout: 600000});
  const detail = await page.evaluate(() => document.getElementById('statusDetail').textContent);
  check('corrupt payload: user sees an understandable warning', /1 of 3 files.*integrity|integrity check/.test(detail), detail.slice(0, 120));
  await page.close();
  killGroup(launcher);
  await sleep(1500);
  fs.rmSync(corruptRoot, {recursive: true, force: true});

  /* ---- 2. clean payload: storage cleanliness, cache headers, drive loss ---- */
  launcher = startLauncher(sharedDir);
  check('clean payload: launcher up', (await waitHealth(60000)) !== null);
  page = await browser.newPage();
  await page.addInitScript(() => { window.__RA_HEARTBEAT_MS = 1500; });
  await page.goto(base + '/', {waitUntil: 'domcontentloaded'});
  await page.waitForFunction(() => /is ready/.test(document.getElementById('statusTitle').textContent), null, {timeout: 600000});

  const headers = await page.evaluate(async () => {
    const r = await fetch('app.js', {method: 'GET', cache: 'no-store'});
    return r.headers.get('cache-control') || '';
  });
  check('assets carry revalidation cache headers', /no-cache|must-revalidate/.test(headers), headers);

  await page.fill('#draft', 'Storage cleanliness sentence.');
  const storage = await page.evaluate(async () => ({
    local: localStorage.length,
    session: sessionStorage.length,
    idb: (await indexedDB.databases()).length,
  }));
  check('no draft or audio in browser storage', storage.local === 0 && storage.session === 0 && storage.idb === 0, JSON.stringify(storage));

  // pull the drive: kill the server mid-session
  killGroup(launcher);
  await page.waitForFunction(
    () => document.getElementById('statusTitle').textContent === 'Lost contact with the drive',
    null, {timeout: 30000},
  ).catch(() => {});
  const lost = await page.evaluate(() => document.getElementById('statusTitle').textContent);
  check('drive removal raises the warning', lost === 'Lost contact with the drive', lost);
  const draftIntact = await page.evaluate(() => document.getElementById('draft').value);
  check('in-memory draft survives drive loss', draftIntact === 'Storage cleanliness sentence.', draftIntact);

  await browser.close();
  const passed = results.filter((r) => r[0]).length;
  console.log(`\nBROWSER STRESS: ${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error('BROWSER STRESS ERROR:', e); process.exit(1); });
