// Multi-voice TTS worker. Nothing is initialized on load: the page sends
// {type:'init'} naming the voice package, whose files are fetched and written
// into the engine's virtual filesystem before the engine is constructed.
// The wasm glue is ES6 so its pthread pool can spawn nested module workers.
//
// Two model families are supported by the same shared engine:
//   vits   — piper-style: model.onnx + tokens.txt
//   kitten — KittenTTS:   model.onnx + tokens.txt + voices.bin (style rows)
// espeak-ng-data is voice-independent and stays baked into the engine, so
// neither family ships it.
import createModule from './sherpa-onnx-wasm-main-tts.js';
import {createOfflineTts} from './sherpa-onnx-tts.js';

let tts = null;
let Module = null;
let initializing = false;
let speakerId = 0;

// Matches the adaptive count the build patches into the wrapper: use up to
// this many inference threads, but never more than the machine has cores, so
// a single-core PC behaves exactly like the classic single-threaded build.
const MAX_TTS_THREADS = 4;
function threadCount() {
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 1;
  return Math.min(MAX_TTS_THREADS, cores);
}

// The wrapper's built-in defaults only cover vits (its modelType is private
// and always 0), so a kitten voice needs the whole config passed explicitly.
// Paths match what the engine expects at the filesystem root.
function baseModelConfig() {
  return {
    offlineTtsVitsModelConfig: {
      model: '', lexicon: '', tokens: '', dataDir: '',
      noiseScale: 0.667, noiseScaleW: 0.8, lengthScale: 1.0,
    },
    offlineTtsMatchaModelConfig: {
      acousticModel: '', vocoder: '', lexicon: '', tokens: '', dataDir: '',
      noiseScale: 0.667, lengthScale: 1.0,
    },
    offlineTtsKokoroModelConfig: {
      model: '', voices: '', tokens: '', dataDir: '',
      lengthScale: 1.0, lexicon: '', lang: '',
    },
    offlineTtsKittenModelConfig: {
      model: '', voices: '', tokens: '', dataDir: '', lengthScale: 1.0,
    },
    offlineTtsZipVoiceModelConfig: {
      tokens: '', encoder: '', decoder: '', vocoder: '', dataDir: '', lexicon: '',
      featScale: 0.1, tShift: 0.5, targetRMS: 0.1, guidanceScale: 1.0,
    },
    offlineTtsPocketModelConfig: {
      lmFlow: '', lmMain: '', encoder: '', decoder: '', textConditioner: '',
      vocabJson: '', tokenScoresJson: '', voiceEmbeddingCacheCapacity: 50,
    },
    numThreads: threadCount(),
    debug: 1,
    provider: 'cpu',
  };
}

function kittenConfig() {
  const model = baseModelConfig();
  model.offlineTtsKittenModelConfig = {
    model: './model.onnx',
    voices: './voices.bin',
    tokens: './tokens.txt',
    dataDir: './espeak-ng-data',
    lengthScale: 1.0,
  };
  return {offlineTtsModelConfig: model, ruleFsts: '', ruleFars: '', maxNumSentences: 1};
}

// Explicit vits config so the delivery noise values are settable; identical
// layout to the wrapper defaults otherwise, threading included.
function vitsConfig(noiseScale, noiseScaleW) {
  const model = baseModelConfig();
  model.offlineTtsVitsModelConfig = {
    model: './model.onnx',
    lexicon: '',
    tokens: './tokens.txt',
    dataDir: './espeak-ng-data',
    noiseScale,
    noiseScaleW,
    lengthScale: 1.0,
  };
  return {offlineTtsModelConfig: model, ruleFsts: '', ruleFars: '', maxNumSentences: 1};
}

async function fetchAsset(url, what) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`could not read the voice ${what} (${r.status})`);
  return r.arrayBuffer();
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  if (msg.type === 'init') {
    if (initializing || tts) return; // one voice per worker life
    initializing = true;
    try {
      const arch = msg.arch === 'kitten' ? 'kitten' : 'vits';
      speakerId = Number(msg.speakerId) || 0;

      Module = await createModule({
        locateFile: (path, dir = '') => dir + path,
        setStatus: (status) => self.postMessage({type: 'sherpa-onnx-tts-progress', status}),
      });
      self.postMessage({type: 'sherpa-onnx-tts-progress', status: 'Reading the voice model from this drive...'});

      // Files arrive either as URLs (normal operation) or as raw buffers
      // (the voice-maker test bench auditioning uninstalled files).
      let model;
      let tokens;
      let voices = null;
      if (msg.modelData && msg.tokensData) {
        model = msg.modelData;
        tokens = msg.tokensData;
        voices = msg.voicesData || null;
      } else {
        [model, tokens] = await Promise.all([
          fetchAsset(msg.modelUrl, 'model'),
          fetchAsset(msg.tokensUrl, 'tokens'),
        ]);
        if (arch === 'kitten') {
          if (!msg.voicesUrl) throw new Error('this kitten voice package has no voices file');
          voices = await fetchAsset(msg.voicesUrl, 'style data');
        }
      }
      if (arch === 'kitten' && !voices) {
        throw new Error('this kitten voice package has no voices file');
      }

      Module.FS.writeFile('/model.onnx', new Uint8Array(model));
      Module.FS.writeFile('/tokens.txt', new Uint8Array(tokens));
      if (voices) Module.FS.writeFile('/voices.bin', new Uint8Array(voices));

      // Both families now use explicit configs: kitten because the wrapper's
      // defaults can't describe it, vits so the delivery noise values are
      // settable. Threading comes from numThreads in both.
      const ns = Number.isFinite(Number(msg.noiseScale)) ? Number(msg.noiseScale) : 0.667;
      const nsw = Number.isFinite(Number(msg.noiseScaleW)) ? Number(msg.noiseScaleW) : 0.8;
      tts = arch === 'kitten' ? createOfflineTts(Module, kittenConfig()) : createOfflineTts(Module, vitsConfig(ns, nsw));
      self.postMessage({type: 'sherpa-onnx-tts-ready', numSpeakers: tts.numSpeakers});
    } catch (err) {
      self.postMessage({type: 'error', message: String((err && err.message) || err)});
    }
    initializing = false;
  } else if (msg.type === 'generate') {
    if (!tts) return;
    try {
      const sid = msg.sid !== undefined ? msg.sid : speakerId;
      const audio = tts.generate({text: msg.text, sid, speed: msg.speed || 1.0});
      self.postMessage({type: 'sherpa-onnx-tts-result', samples: audio.samples, sampleRate: tts.sampleRate});
    } catch (err) {
      self.postMessage({type: 'error', message: String((err && err.message) || err)});
    }
  }
};
