'use strict';
// Encodes 16-bit mono PCM to MP3 using the vendored lamejs build.
// Runs off the main thread so long narrations never freeze the page.
importScripts('vendor/lame.min.js');

onmessage = (event) => {
  const {pcm, sampleRate, kbps} = event.data;
  try {
    const encoder = new lamejs.Mp3Encoder(1, sampleRate, kbps || 64);
    const chunks = [];
    const BLOCK = 1152 * 32;
    for (let i = 0; i < pcm.length; i += BLOCK) {
      const encoded = encoder.encodeBuffer(pcm.subarray(i, Math.min(i + BLOCK, pcm.length)));
      if (encoded.length) chunks.push(encoded);
      if ((i / BLOCK) % 8 === 0) {
        postMessage({type: 'progress', done: i, total: pcm.length});
      }
    }
    const tail = encoder.flush();
    if (tail.length) chunks.push(tail);
    postMessage({type: 'done', chunks}, chunks.map((c) => c.buffer));
  } catch (err) {
    postMessage({type: 'error', message: String(err && err.message || err)});
  }
};
