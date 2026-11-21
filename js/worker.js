// Translitera prototype — AI worker.
// Runs speech recognition and translation entirely on the device (WebGPU when available, otherwise WebAssembly).
// Models are downloaded from Hugging Face on first use and then kept in the browser cache, so later runs work offline.

import { pipeline, env } from '../lib/transformers.min.js';

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = new URL('../lib/', import.meta.url).href;
env.backends.onnx.wasm.numThreads = 1; // GitHub Pages cannot enable cross-origin isolation, so no threads

const WHISPER = {
  base: 'onnx-community/whisper-base',
  small: 'onnx-community/whisper-small',
};
const WHISPER_LANG = { fi: 'finnish', uk: 'ukrainian', ru: 'russian' };

// Translation engines
const OPUS = { // via English (small models, one per direction)
  'fi>en': 'Xenova/opus-mt-fi-en', 'en>fi': 'Xenova/opus-mt-en-fi',
  'uk>en': 'Xenova/opus-mt-uk-en', 'en>uk': 'Xenova/opus-mt-en-uk',
  'ru>en': 'Xenova/opus-mt-ru-en', 'en>ru': 'Xenova/opus-mt-en-ru',
};
const NLLB = 'Xenova/nllb-200-distilled-600M'; // direct, one large multilingual model
const NLLB_CODE = { fi: 'fin_Latn', uk: 'ukr_Cyrl', ru: 'rus_Cyrl', en: 'eng_Latn' };

const cache = new Map(); // key -> pipeline promise
let gpuOk = null;
const stage = (text) => postMessage({ type: 'stage', text });

async function hasWebGPU() {
  if (gpuOk !== null) return gpuOk;
  try {
    gpuOk = !!(self.navigator && navigator.gpu && (await navigator.gpu.requestAdapter()));
  } catch (e) { gpuOk = false; }
  return gpuOk;
}

function progressFor(label) {
  return (p) => {
    if (p.status === 'progress' || p.status === 'download' || p.status === 'done' || p.status === 'initiate') {
      postMessage({ type: 'progress', label, file: p.file, status: p.status, loaded: p.loaded || 0, total: p.total || 0 });
    }
  };
}

async function getASR(size, cpuOnly) {
  const key = 'asr:' + size + (cpuOnly ? ':cpu' : '');
  if (!cache.has(key)) {
    cache.set(key, (async () => {
      const gpu = !cpuOnly && (await hasWebGPU());
      stage('Starting speech recognition on ' + (gpu ? 'GPU' : 'CPU') + '…');
      const opts = gpu
        ? { device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } }
        : { device: 'wasm', dtype: 'q8' };
      try {
        return { pipe: await pipeline('automatic-speech-recognition', WHISPER[size], { ...opts, progress_callback: progressFor('Speech ' + size) }), device: opts.device };
      } catch (e) {
        if (opts.device !== 'webgpu') throw e;
        // WebGPU failed on this device: fall back to WebAssembly
        stage('GPU did not work (' + String(e && e.message || e).slice(0, 80) + '). Switching to CPU…');
        return { pipe: await pipeline('automatic-speech-recognition', WHISPER[size], { device: 'wasm', dtype: 'q8', progress_callback: progressFor('Speech ' + size) }), device: 'wasm' };
      }
    })().catch((e) => { cache.delete(key); throw e; }));
  }
  return cache.get(key);
}

async function getMT(model, label) {
  const key = 'mt:' + model;
  if (!cache.has(key)) {
    stage('Starting ' + label + '…');
    cache.set(key, pipeline('translation', model, { device: 'wasm', dtype: 'q8', progress_callback: progressFor(label) })
      .catch((e) => { cache.delete(key); throw e; }));
  }
  return cache.get(key);
}

function opusSteps(from, to) {
  if (from === to) return [];
  if (from === 'en' || to === 'en') return [[from, to]];
  return [[from, 'en'], ['en', to]];
}

async function translate(text, from, to, engine) {
  const t0 = performance.now();
  if (engine === 'nllb') {
    const mt = await getMT(NLLB, 'Translation (direct)');
    const out = await mt(text, { src_lang: NLLB_CODE[from], tgt_lang: NLLB_CODE[to], max_new_tokens: 256 });
    return { text: out[0].translation_text, ms: performance.now() - t0, route: 'direct (NLLB)' };
  }
  let cur = text;
  const via = [];
  for (const [a, b] of opusSteps(from, to)) {
    const mt = await getMT(OPUS[a + '>' + b], 'Translation ' + a.toUpperCase() + '→' + b.toUpperCase());
    const out = await mt(cur, { max_new_tokens: 256 });
    cur = out[0].translation_text;
    if (b === 'en') via.push(cur);
  }
  return { text: cur, ms: performance.now() - t0, route: 'via English (OPUS-MT)', english: via[0] || null };
}

async function preload(cfg) {
  const { asrSize, engine, langs, cpuOnly } = cfg;
  const asr = await getASR(asrSize, cpuOnly);
  if (engine === 'nllb') {
    await getMT(NLLB, 'Translation (direct)');
  } else {
    for (const l of langs) {
      await getMT(OPUS[l + '>en'], 'Translation ' + l.toUpperCase() + '→EN');
      await getMT(OPUS['en>' + l], 'Translation EN→' + l.toUpperCase());
    }
  }
  stage('Ready');
  return { device: asr.device };
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'preload') {
      const r = await preload(m.cfg);
      postMessage({ type: 'ready', id: m.id, device: r.device, webgpu: await hasWebGPU() });
    } else if (m.type === 'transcribe') {
      stage('Recognising speech…');
      const asr = await getASR(m.asrSize, m.cpuOnly);
      const t0 = performance.now();
      let lang = m.lang, text, rerun = false;
      if (lang === 'auto') {
        // Let Whisper detect the language, then decide by script: Latin = Finnish, Cyrillic = the other language.
        const out = await asr.pipe(m.audio, { task: 'transcribe', chunk_length_s: 30 });
        text = (out.text || '').trim();
        const cyr = (text.match(/[\u0400-\u04FF]/g) || []).length;
        const lat = (text.match(/[A-Za-zÅÄÖåäö]/g) || []).length;
        lang = cyr > lat ? m.other : 'fi';
        // Whisper may confuse Ukrainian and Russian: if letters of the wrong one appear, transcribe again with the language fixed.
        const wrong = m.other === 'uk' ? /[ыэъё]/i : /[іїєґ]/i;
        if (lang === m.other && wrong.test(text)) rerun = true;
        if (lang === 'fi' && cyr === 0 && lat === 0) text = '';
      }
      if (lang !== 'auto' && (text === undefined || rerun)) {
        const out = await asr.pipe(m.audio, { language: WHISPER_LANG[lang], task: 'transcribe', chunk_length_s: 30 });
        text = (out.text || '').trim();
      }
      postMessage({ type: 'transcribed', id: m.id, text, lang, rerun, ms: performance.now() - t0, device: asr.device });
    } else if (m.type === 'translate') {
      const r = await translate(m.text, m.from, m.to, m.engine);
      postMessage({ type: 'translated', id: m.id, ...r });
    }
  } catch (err) {
    postMessage({ type: 'error', id: m.id, message: String((err && err.message) || err) });
  }
};
