#!/usr/bin/env node
// Deterministic bundle smoke test: verifies the assembled USB tree is complete
// and internally consistent before it is packaged or released.
'use strict';
const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');

const root = process.argv[2];
if (!root) { console.error('usage: smoke_test.js <ReadAloudUSB dir>'); process.exit(2); }
const shared = path.join(root, 'shared');
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`);
  if (!ok) failures++;
};
const exists = (p) => fs.existsSync(p);
const size = (p) => (exists(p) ? fs.statSync(p).size : 0);

for (const f of ['index.html', 'app.js', 'style.css', 'mp3-worker.js',
                 'sherpa-onnx-tts.js', 'sherpa-onnx-tts.worker.js',
                 path.join('vendor', 'lame.min.js')]) {
  check(`shared/${f} present`, exists(path.join(shared, f)));
}
const wasm = fs.readdirSync(shared).filter((f) => f.endsWith('.wasm'));
const data = fs.readdirSync(shared).filter((f) => f.endsWith('.data'));
check('wasm payload present and non-trivial', wasm.length > 0 && size(path.join(shared, wasm[0])) > 1e6);
check('model data payload present and non-trivial', data.length > 0 && size(path.join(shared, data[0])) > 1e7);

for (const f of ['START - WINDOWS.exe', 'START - LINUX.sh', 'README.txt', 'SHA256SUMS.txt',
                 path.join('platform', 'linux', 'readaloud-server'),
                 path.join('platform', 'linux', 'readaloud-server-arm64'),
                 path.join('START - MACOS.app', 'Contents', 'MacOS', 'readaloud')]) {
  check(`${f} present`, exists(path.join(root, f)));
}

// app.js and mp3-worker.js must be valid JavaScript
for (const f of ['app.js', 'mp3-worker.js']) {
  let ok = true, msg = '';
  try { execFileSync(process.execPath, ['--check', path.join(shared, f)]); }
  catch (e) { ok = false; msg = String(e.stderr || e); }
  check(`${f} parses`, ok, msg.slice(0, 120));
}

// every local script/stylesheet referenced by index.html must exist
const html = fs.readFileSync(path.join(shared, 'index.html'), 'utf8');
for (const m of html.matchAll(/(?:src|href)="([^"?]+)(?:\?[^"]*)?"/g)) {
  const ref = m[1];
  if (/^https?:/.test(ref)) continue;
  check(`index.html reference exists: ${ref}`, exists(path.join(shared, ref)));
}

// spot-check SHA256SUMS integrity on the two app files
const crypto = require('crypto');
const sums = fs.readFileSync(path.join(root, 'SHA256SUMS.txt'), 'utf8');
for (const name of ['./shared/app.js', './shared/index.html']) {
  const line = sums.split('\n').find((l) => l.endsWith(name));
  let ok = false;
  if (line) {
    const want = line.split(/\s+/)[0];
    const got = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex');
    ok = want === got;
  }
  check(`SHA256SUMS covers ${name}`, ok);
}

console.log(failures === 0 ? '\nSMOKE TEST PASSED' : `\nSMOKE TEST FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
