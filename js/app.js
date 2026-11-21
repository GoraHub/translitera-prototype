// Translitera prototype — main thread: UI, microphone, speech output, test results.
import { PHRASES } from './phrases.js';

const $ = (id) => document.getElementById(id);
const LANG_NAME = { fi: 'Suomi', uk: 'Українська', ru: 'Русский', en: 'English' };
const LANG_CODE = { fi: 'FI', uk: 'UA', ru: 'RU' };
const LANG_EN = { fi: 'Finnish', uk: 'Ukrainian', ru: 'Russian' };
const TTS_LANG = { fi: 'fi-FI', uk: 'uk-UA', ru: 'ru-RU' };
const SIZE_GB = { base: 0.2, small: 0.5, opus: 0.45, nllb: 0.9 };

const DEFAULTS = { lang: 'uk', engine: 'opus', asr: 'base', speak: true, showEn: false };
const settings = Object.assign({}, DEFAULTS, load('tl-proto-settings', {}));
let turns = load('tl-proto-turns', []);
let ready = false;
let device = '–';
let webgpu = false;

function load(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } }

// ------------------------------------------------------------------ worker RPC
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let nextId = 1;
const pending = new Map();
const files = new Map(); // progress per file
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'progress') return onProgress(m);
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.type === 'error') p.reject(new Error(m.message)); else p.resolve(m);
};
worker.onerror = (e) => showSetupError('The AI worker could not start: ' + (e.message || 'unknown error'));
function call(msg, transfer) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id }, transfer || []);
  });
}

function onProgress(m) {
  if (!m.file) return;
  const key = m.label + '|' + m.file;
  const f = files.get(key) || { loaded: 0, total: 0 };
  if (m.total) f.total = m.total;
  if (m.loaded) f.loaded = m.loaded;
  if (m.status === 'done' && f.total) f.loaded = f.total;
  files.set(key, f);
  let loaded = 0, total = 0;
  for (const v of files.values()) { loaded += v.loaded; total += v.total; }
  const pct = total ? Math.min(100, (loaded / total) * 100) : 0;
  $('progressFill').style.width = pct.toFixed(1) + '%';
  $('progressText').textContent = m.label + ' · ' + mb(loaded) + ' / ' + mb(total);
}
const mb = (b) => (b / 1048576).toFixed(0) + ' MB';

// ------------------------------------------------------------------ setup
function setupText() {
  $('setupLang').textContent = settings.lang === 'uk' ? 'Ukrainian' : 'Russian';
  const gb = SIZE_GB[settings.asr] + SIZE_GB[settings.engine];
  $('setupSize').textContent = 'about ' + gb.toFixed(1).replace('.0', '') + ' GB';
}
function showSetupError(t) {
  const el = $('setupError');
  el.hidden = false;
  el.textContent = t;
  $('downloadBtn').disabled = false;
  $('downloadBtn').textContent = 'Try again';
}

async function start() {
  $('downloadBtn').disabled = true;
  $('setupError').hidden = true;
  $('progressWrap').hidden = false;
  $('progressText').textContent = 'Preparing…';
  files.clear();
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* ignore */ }
  try {
    const r = await call({ type: 'preload', cfg: { asrSize: settings.asr, engine: settings.engine, langs: ['fi', settings.lang] } });
    device = r.device; webgpu = r.webgpu; ready = true;
    $('setup').hidden = true;
    $('dock').hidden = false;
    renderAll();
    updateDevice();
  } catch (e) {
    showSetupError('Could not load the models: ' + e.message + '. Check the connection and free storage, or try the smaller options in Settings.');
  }
}

// ------------------------------------------------------------------ microphone
let ctx = null, stream = null, proc = null, chunks = [], recLang = null, recTimer = null;

async function startRec(lang) {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') await ctx.resume();
  primeSpeech();
  stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const src = ctx.createMediaStreamSource(stream);
  proc = ctx.createScriptProcessor(4096, 1, 1);
  chunks = [];
  proc.onaudioprocess = (ev) => chunks.push(new Float32Array(ev.inputBuffer.getChannelData(0)));
  src.connect(proc);
  proc.connect(ctx.destination);
  recLang = lang;
  recTimer = setTimeout(() => stopRec(), 30000);
}

async function stopRec() {
  clearTimeout(recTimer);
  if (!proc) return null;
  proc.disconnect();
  proc.onaudioprocess = null;
  stream.getTracks().forEach((t) => t.stop());
  proc = null;
  const len = chunks.reduce((a, c) => a + c.length, 0);
  const all = new Float32Array(len);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  chunks = [];
  return { audio: await to16k(all, ctx.sampleRate), seconds: len / ctx.sampleRate };
}

async function to16k(data, rate) {
  if (rate === 16000) return data;
  const frames = Math.max(1, Math.round(data.length * 16000 / rate));
  const off = new OfflineAudioContext(1, frames, 16000);
  const buf = off.createBuffer(1, data.length, rate);
  buf.copyToChannel(data, 0);
  const s = off.createBufferSource();
  s.buffer = buf; s.connect(off.destination); s.start();
  const out = await off.startRendering();
  return out.getChannelData(0).slice();
}

// ------------------------------------------------------------------ speech output
let voices = [];
function loadVoices() { voices = window.speechSynthesis ? speechSynthesis.getVoices() : []; }
if (window.speechSynthesis) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }
function primeSpeech() { // iOS needs a user gesture before speech works
  if (!window.speechSynthesis || primeSpeech.done) return;
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0; speechSynthesis.speak(u); primeSpeech.done = true;
}
function voiceFor(lang) {
  const code = TTS_LANG[lang];
  return voices.find((v) => v.lang === code && v.localService) || voices.find((v) => v.lang === code) || voices.find((v) => v.lang && v.lang.startsWith(lang));
}
function speak(text, lang) {
  if (!settings.speak || !window.speechSynthesis || !text) return false;
  const v = voiceFor(lang);
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = TTS_LANG[lang];
  if (v) u.voice = v;
  u.rate = 0.95;
  speechSynthesis.speak(u);
  return !!v;
}

// ------------------------------------------------------------------ conversation
const otherOf = (lang) => (lang === 'fi' ? settings.lang : 'fi');

async function runTurn({ lang, audio, seconds, text, input }) {
  const turn = { id: Date.now() + Math.random(), time: new Date().toISOString(), from: lang, to: otherOf(lang), input, src: text || '', dst: '', en: null, asrMs: null, mtMs: null, seconds: seconds || null, route: '', device, engine: settings.engine, asr: settings.asr, rating: null, state: audio ? 'Listening done · recognising…' : 'Translating…' };
  turns.push(turn); renderAll(); scrollEnd();
  try {
    if (audio) {
      const r = await call({ type: 'transcribe', audio, lang, asrSize: settings.asr }, [audio.buffer]);
      turn.src = r.text; turn.asrMs = Math.round(r.ms); turn.device = r.device;
      if (!turn.src) { turn.state = ''; turn.dst = '(No speech recognised. Try again a little closer to the phone.)'; finish(turn); return; }
      turn.state = 'Translating…'; renderAll();
    }
    const t = await call({ type: 'translate', text: turn.src, from: turn.from, to: turn.to, engine: settings.engine });
    turn.dst = t.text; turn.mtMs = Math.round(t.ms); turn.route = t.route; turn.en = t.english || null; turn.state = '';
    const spoken = speak(turn.dst, turn.to);
    if (settings.speak && !spoken) turn.noVoice = true;
  } catch (e) {
    turn.state = ''; turn.dst = 'Error: ' + e.message;
  }
  finish(turn);
}
function finish(turn) { turn.state = ''; save('tl-proto-turns', turns.map(({ state, ...t }) => t)); renderAll(); scrollEnd(); }
function scrollEnd() { requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })); }

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

function renderAll() {
  const c = $('convo');
  c.textContent = '';
  for (const t of turns) {
    const card = el('article', 'turn' + (t.from === 'fi' ? '' : ' right') + (t.state ? ' pending' : ''));
    card.appendChild(el('div', 'dir', LANG_NAME[t.from] + ' → ' + LANG_NAME[t.to]));
    if (t.src) card.appendChild(el('div', 'src', t.src));
    if (settings.showEn && t.en) card.appendChild(el('div', 'via', 'EN: ' + t.en));
    card.appendChild(el('div', 'dst', t.state || t.dst));
    if (!t.state) {
      const parts = [];
      if (t.seconds) parts.push('Spoke ' + t.seconds.toFixed(1) + ' s');
      if (t.asrMs != null) parts.push('Recognition ' + (t.asrMs / 1000).toFixed(1) + ' s');
      if (t.mtMs != null) parts.push('Translation ' + (t.mtMs / 1000).toFixed(1) + ' s');
      if (t.route) parts.push(t.route);
      if (t.device) parts.push(t.device === 'webgpu' ? 'GPU' : 'CPU');
      card.appendChild(el('div', 'meta', parts.join(' · ')));
      if (t.noVoice) card.appendChild(el('div', 'meta', 'No ' + LANG_EN[t.to] + ' voice on this phone. iPhone: Settings › Accessibility › Spoken Content › Voices.'));
      const a = el('div', 'actions');
      const play = el('button', 'chip', '🔊 Play');
      play.type = 'button';
      play.onclick = () => { const s = settings.speak; settings.speak = true; speak(t.dst, t.to); settings.speak = s; };
      a.appendChild(play);
      for (const [val, label] of [['good', '👍 Good'], ['ok', 'Understandable'], ['bad', '👎 Wrong']]) {
        const b = el('button', 'chip' + (t.rating === val ? ' on' : ''), label);
        b.type = 'button';
        b.setAttribute('aria-pressed', t.rating === val ? 'true' : 'false');
        b.onclick = () => { t.rating = t.rating === val ? null : val; finish(t); };
        a.appendChild(b);
      }
      card.appendChild(a);
    }
    c.appendChild(card);
  }
}

// ------------------------------------------------------------------ mic buttons
function labels() {
  $('micALabel').textContent = LANG_NAME.fi;
  $('micBLabel').textContent = LANG_NAME[settings.lang];
  $('micB').dataset.lang = settings.lang;
  $('typeLang').options[1].value = settings.lang;
  $('typeLang').options[1].textContent = LANG_CODE[settings.lang];
}
let busy = false;
async function onMic(btn) {
  if (!ready || busy) return;
  const lang = btn.dataset.lang;
  if (recLang) { // stop
    const was = recLang;
    recLang = null;
    document.querySelectorAll('.mic').forEach((b) => b.classList.remove('rec'));
    $('hint').textContent = 'Working…';
    busy = true; setMicsDisabled(true);
    try {
      const r = await stopRec();
      if (r && r.seconds > 0.4) await runTurn({ lang: was, audio: r.audio, seconds: r.seconds, input: 'voice' });
    } finally { busy = false; setMicsDisabled(false); $('hint').textContent = 'Tap a language, speak, tap again to translate.'; }
    return;
  }
  try {
    await startRec(lang);
    btn.classList.add('rec');
    $('hint').textContent = 'Listening in ' + LANG_NAME[lang] + '… tap again when done.';
  } catch (e) {
    $('hint').textContent = 'Microphone not available: ' + e.message;
  }
}
function setMicsDisabled(d) { document.querySelectorAll('.mic').forEach((b) => { b.disabled = d; b.classList.toggle('busy', d); }); }

// ------------------------------------------------------------------ settings, phrases, export
function updateDevice() {
  const est = navigator.storage && navigator.storage.estimate ? navigator.storage.estimate() : Promise.resolve(null);
  est.then((s) => {
    const used = s && s.usage ? (s.usage / 1073741824).toFixed(2) + ' GB stored' : '';
    $('deviceInfo').textContent = 'AI runs on: ' + (device === 'webgpu' ? 'GPU (WebGPU)' : device === 'wasm' ? 'CPU (WebAssembly)' : 'not loaded yet') +
      ' · WebGPU available: ' + (webgpu ? 'yes' : 'no') + (used ? ' · ' + used : '') +
      ' · Voices: ' + ['fi', 'uk', 'ru'].map((l) => LANG_CODE[l] + (voiceFor(l) ? ' ✓' : ' ✗')).join(' ');
  });
}
function openSettings() {
  $('optLang').value = settings.lang; $('optEngine').value = settings.engine; $('optAsr').value = settings.asr;
  $('optSpeak').checked = settings.speak; $('optShowEn').checked = settings.showEn;
  updateDevice();
  $('settings').showModal();
}
function applySettings() {
  const changed = settings.lang !== $('optLang').value || settings.engine !== $('optEngine').value || settings.asr !== $('optAsr').value;
  settings.lang = $('optLang').value; settings.engine = $('optEngine').value; settings.asr = $('optAsr').value;
  settings.speak = $('optSpeak').checked; settings.showEn = $('optShowEn').checked;
  save('tl-proto-settings', settings);
  $('settings').close();
  labels(); setupText(); renderAll();
  if (changed && ready) { ready = false; $('dock').hidden = true; $('setup').hidden = false; $('downloadBtn').textContent = 'Download and start'; start(); }
}
function openPhrases() {
  const list = $('phraseList');
  list.textContent = '';
  for (const lang of ['fi', settings.lang]) {
    for (const p of PHRASES[lang]) {
      const b = el('button', 'phrase');
      b.type = 'button';
      b.appendChild(el('span', 'tag', LANG_CODE[lang]));
      b.appendChild(document.createTextNode(p));
      b.onclick = () => { primeSpeech(); $('phrases').close(); runTurn({ lang, text: p, input: 'phrase' }); };
      list.appendChild(b);
    }
  }
  $('phrases').showModal();
}
async function exportResults() {
  const data = { app: 'Translitera offline prototype', exported: new Date().toISOString(), userAgent: navigator.userAgent, device, webgpu, settings, turns: turns.map(({ state, ...t }) => t) };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const name = 'translitera-test-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.json';
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Translitera test results' }); return; } catch (e) { /* cancelled */ }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ------------------------------------------------------------------ online indicator, offline cache
function net() { $('netPill').textContent = navigator.onLine ? 'Prototype · online' : 'Offline ✓'; }
window.addEventListener('online', net); window.addEventListener('offline', net);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

// ------------------------------------------------------------------ wire up
$('downloadBtn').onclick = start;
$('micA').onclick = () => onMic($('micA'));
$('micB').onclick = () => onMic($('micB'));
$('settingsBtn').onclick = openSettings;
$('applyBtn').onclick = applySettings;
$('clearBtn').onclick = () => { if (confirmClear()) { turns = []; save('tl-proto-turns', turns); renderAll(); $('settings').close(); } };
$('exportBtn').onclick = exportResults;
$('phrasesBtn').onclick = openPhrases;
$('typeBtn').onclick = () => { $('typeRow').hidden = !$('typeRow').hidden; if (!$('typeRow').hidden) $('typeText').focus(); };
$('typeRow').onsubmit = (e) => { e.preventDefault(); const v = $('typeText').value.trim(); if (!v || !ready) return; primeSpeech(); $('typeText').value = ''; runTurn({ lang: $('typeLang').value, text: v, input: 'text' }); };
function confirmClear() { return turns.length === 0 || window.confirm('Clear the conversation and its ratings from this phone?'); }

labels(); setupText(); net(); renderAll();
