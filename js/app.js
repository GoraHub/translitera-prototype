// Translitera prototype — main thread: UI, microphone, speech output, test results.
import { PHRASES } from './phrases.js';

const $ = (id) => document.getElementById(id);
const LANG_NAME = { fi: 'Suomi', uk: 'Українська', ru: 'Русский', en: 'English' };
const LANG_CODE = { fi: 'FI', uk: 'UA', ru: 'RU' };
const LANG_EN = { fi: 'Finnish', uk: 'Ukrainian', ru: 'Russian' };
const TTS_LANG = { fi: 'fi-FI', uk: 'uk-UA', ru: 'ru-RU' };
const SIZE_GB = { base: 0.2, small: 0.5, turbo: 0.7, opus: 0.45, nllb: 0.9 };

const DEFAULTS = { lang: 'uk', engine: 'opus', asr: 'base', speak: true, showEn: false, cpuOnly: false, pauseMs: 800, releaseMic: true };
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
  lastMsg = Date.now();
  if (m.type === 'stage') return onStage(m.text);
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

let lastMsg = Date.now(), stageText = '', stageT0 = 0, tick = null;
function onStage(t) {
  stageText = t; stageT0 = Date.now();
  if (!ready) $('progressText').textContent = t;
}
function startTicker() {
  clearInterval(tick);
  tick = setInterval(() => {
    if (ready) return clearInterval(tick);
    const quiet = (Date.now() - lastMsg) / 1000;
    if (stageText && stageText !== 'Ready') {
      $('progressText').textContent = stageText + ' ' + Math.round((Date.now() - stageT0) / 1000) + ' s';
    }
    const hint = $('setupHint');
    if (quiet > 90) {
      hint.hidden = false;
      hint.textContent = settings.cpuOnly
        ? 'This is taking very long. The phone may be out of memory: close other apps and reload the page.'
        : 'This is taking very long. Try Settings › “Run AI on CPU only”, then reload the page.';
    } else hint.hidden = true;
  }, 1000);
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
  $('progressText').textContent = 'Downloading · ' + mb(loaded) + ' / ' + mb(total);
  stageText = '';
}
const mb = (b) => (b / 1048576).toFixed(0) + ' MB';

// ------------------------------------------------------------------ setup
function setupText() {
  $('setupLang').textContent = settings.lang === 'uk' ? 'Ukrainian' : 'Russian';
  const gb = SIZE_GB[settings.asr] + SIZE_GB[settings.engine];
  $('setupSize').textContent = 'about ' + gb.toFixed(1).replace('.0', '') + ' GB';
}
function showSetupError(t) {
  clearInterval(tick);
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
  lastMsg = Date.now(); startTicker();
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* ignore */ }
  save('tl-proto-loading', { asr: settings.asr, engine: settings.engine, cpuOnly: settings.cpuOnly });
  try {
    const r = await call({ type: 'preload', cfg: { asrSize: settings.asr, engine: settings.engine, langs: ['fi', settings.lang], cpuOnly: settings.cpuOnly } });
    device = r.device; webgpu = r.webgpu; ready = true;
    try { localStorage.removeItem('tl-proto-loading'); } catch (e) { /* ignore */ }
    $('setup').hidden = true;
    $('dock').hidden = false;
    renderAll();
    updateDevice();
  } catch (e) {
    try { localStorage.removeItem('tl-proto-loading'); } catch (e2) { /* ignore */ }
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
function speak(text, lang, onDone) {
  if (!settings.speak || !window.speechSynthesis || !text) { if (onDone) onDone(); return false; }
  const v = voiceFor(lang);
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  if (onDone) {
    let done = false;
    const fin = () => { if (!done) { done = true; clearTimeout(t); onDone(); } };
    u.onend = fin; u.onerror = fin;
    const t = setTimeout(fin, 2000 + text.length * 120); // fallback if Safari never fires onend
  }
  u.lang = TTS_LANG[lang];
  if (v) u.voice = v;
  u.rate = 0.95;
  speechSynthesis.speak(u);
  return !!v;
}

// ------------------------------------------------------------------ conversation
const otherOf = (lang) => (lang === 'fi' ? settings.lang : 'fi');

async function runTurn({ lang, audio, seconds, text, input, onSpoken, endedAt }) {
  const auto = lang === 'auto';
  const turn = { id: Date.now() + Math.random(), time: new Date().toISOString(), from: auto ? 'fi' : lang, to: auto ? settings.lang : otherOf(lang), auto, input, src: text || '', dst: '', en: null, asrMs: null, mtMs: null, seconds: seconds || null, route: '', device, engine: settings.engine, asr: settings.asr, rating: null, state: audio ? 'Listening done · recognising…' : 'Translating…' };
  turns.push(turn); renderAll(); scrollEnd();
  try {
    if (audio) {
      const r = await call({ type: 'transcribe', audio, lang, other: settings.lang, asrSize: settings.asr, cpuOnly: settings.cpuOnly }, [audio.buffer]);
      turn.src = r.text; turn.asrMs = Math.round(r.ms); turn.device = r.device;
      if (auto) { turn.from = r.lang; turn.to = otherOf(r.lang); turn.rerun = r.rerun; }
      if (!turn.src) {
        if (auto) { turns.splice(turns.indexOf(turn), 1); renderAll(); if (onSpoken) onSpoken(); return; }
        turn.state = ''; turn.dst = '(No speech recognised. Try again a little closer to the phone.)'; finish(turn); return;
      }
      turn.state = 'Translating…'; renderAll();
    }
    const t = await call({ type: 'translate', text: turn.src, from: turn.from, to: turn.to, engine: settings.engine });
    turn.dst = t.text; turn.mtMs = Math.round(t.ms); turn.route = t.route; turn.en = t.english || null; turn.state = '';
    if (endedAt) turn.waitMs = Math.round(performance.now() - endedAt);
    finish(turn);
    if (input === 'live' && live.on) liveSet('speaking');
    const spoken = speak(turn.dst, turn.to, onSpoken);
    if (settings.speak && !spoken) { turn.noVoice = true; finish(turn); }
    return;
  } catch (e) {
    turn.state = ''; turn.dst = 'Error: ' + e.message;
  }
  finish(turn);
  if (onSpoken) onSpoken();
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
      if (t.auto) parts.push('Always on' + (t.rerun ? ' (language re-checked)' : ''));
      if (t.seconds) parts.push('Spoke ' + t.seconds.toFixed(1) + ' s');
      if (t.waitMs != null) parts.push('Wait ' + (t.waitMs / 1000).toFixed(1) + ' s');
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


// ------------------------------------------------------------------ always-on mode
// Listens continuously. A simple voice detector cuts speech into sentences at pauses;
// each sentence is recognised (language detected automatically), translated and spoken.
// While the app is working or speaking it does not listen, so it never translates itself.
const live = { on: false, state: 'off', stream: null, src: null, proc: null, pre: [], buf: [], speaking: false, silentMs: 0, speechMs: 0, floor: 0.004, frames: 0, wake: null };

async function liveStart() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') await ctx.resume();
  primeSpeech();
  live.on = true;
  $('dock').classList.add('live'); document.body.classList.add('is-live');
  try { live.wake = navigator.wakeLock ? await navigator.wakeLock.request('screen') : null; } catch (e) { live.wake = null; }
  await liveListen();
}
function liveStop() {
  live.on = false;
  liveRelease();
  if (window.speechSynthesis) speechSynthesis.cancel();
  try { if (live.wake) live.wake.release(); } catch (e) { /* ignore */ }
  live.wake = null;
  $('dock').classList.remove('live'); document.body.classList.remove('is-live');
  liveSet('off');
}
function liveSet(state) {
  live.state = state;
  const txt = { off: 'Tap the speaker to start always-on translation', listening: 'Listening… speak in either language', hearing: 'Hearing speech…', working: 'Translating…', speaking: 'Speaking…', error: 'Microphone not available' }[state];
  $('liveStatus').textContent = txt;
  $('liveBtn').dataset.state = state;
  $('liveBtn').setAttribute('aria-label', live.on ? 'Pause translation' : 'Start always-on translation');
}
async function liveListen() {
  if (!live.on) return;
  try {
    if (!live.stream) {
      live.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      live.src = ctx.createMediaStreamSource(live.stream);
      live.proc = ctx.createScriptProcessor(2048, 1, 1);
      live.proc.onaudioprocess = onLiveAudio;
      live.src.connect(live.proc);
      live.proc.connect(ctx.destination);
    }
  } catch (e) { liveSet('error'); live.on = false; $('dock').classList.remove('live'); return; }
  live.pre = []; live.buf = []; live.speaking = false; live.silentMs = 0; live.speechMs = 0; live.frames = 0;
  liveSet('listening');
}
function liveRelease() {
  if (live.proc) { live.proc.onaudioprocess = null; live.proc.disconnect(); }
  if (live.src) live.src.disconnect();
  if (live.stream) live.stream.getTracks().forEach((t) => t.stop());
  live.proc = live.src = live.stream = null;
  $('liveBtn').style.setProperty('--lvl', 0);
}
function onLiveAudio(ev) {
  if (live.state !== 'listening' && live.state !== 'hearing') return;
  const d = ev.inputBuffer.getChannelData(0);
  const frame = new Float32Array(d);
  const ms = (frame.length / ctx.sampleRate) * 1000;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  const rms = Math.sqrt(sum / frame.length);
  live.frames++;
  // adaptive noise floor: follows quiet levels quickly, loud levels slowly
  live.floor = rms < live.floor ? live.floor * 0.9 + rms * 0.1 : live.floor * 0.995 + rms * 0.005;
  const thr = Math.max(0.012, live.floor * 3.2);
  const loud = rms > thr && live.frames > 8; // ignore the first ~0.3 s while the floor settles
  $('liveBtn').style.setProperty('--lvl', Math.min(1, rms / 0.12).toFixed(2));
  if (!live.speaking) {
    live.pre.push(frame);
    if (live.pre.length > 8) live.pre.shift(); // ~0.35 s pre-roll so the first syllable is kept
    if (loud) { live.speechMs += ms; if (live.speechMs > 120) { live.speaking = true; live.buf = live.pre.slice(); live.silentMs = 0; liveSet('hearing'); } }
    else live.speechMs = 0;
    return;
  }
  live.buf.push(frame);
  live.silentMs = loud ? 0 : live.silentMs + ms;
  const total = live.buf.reduce((n, f) => n + f.length, 0) / ctx.sampleRate;
  if (live.silentMs >= settings.pauseMs || total > 20) liveEndUtterance(total);
}
async function liveEndUtterance(seconds) {
  const frames = live.buf; live.buf = []; live.speaking = false;
  const endedAt = performance.now();
  if (seconds - settings.pauseMs / 1000 < 0.5) { live.pre = []; liveSet('listening'); return; } // too short: a cough or a click
  liveSet('working');
  if (settings.releaseMic) liveRelease();
  const len = frames.reduce((n, f) => n + f.length, 0);
  const all = new Float32Array(len);
  let o = 0;
  for (const f of frames) { all.set(f, o); o += f.length; }
  const audio = await to16k(all, ctx.sampleRate);
  await runTurn({ lang: 'auto', audio, seconds, input: 'live', endedAt, onSpoken: () => { if (live.on) setTimeout(liveListen, 250); } });
  if (live.on && live.state === 'working' && window.speechSynthesis && speechSynthesis.speaking) liveSet('speaking');
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
  $('optSpeak').checked = settings.speak; $('optShowEn').checked = settings.showEn; $('optCpu').checked = settings.cpuOnly;
  $('optPause').value = String(settings.pauseMs); $('optRelease').checked = settings.releaseMic;
  updateDevice();
  $('settings').showModal();
}
function applySettings() {
  const changed = settings.lang !== $('optLang').value || settings.engine !== $('optEngine').value || settings.asr !== $('optAsr').value;
  settings.lang = $('optLang').value; settings.engine = $('optEngine').value; settings.asr = $('optAsr').value;
  settings.speak = $('optSpeak').checked; settings.showEn = $('optShowEn').checked;
  const cpuChanged = settings.cpuOnly !== $('optCpu').checked;
  settings.cpuOnly = $('optCpu').checked;
  settings.pauseMs = +$('optPause').value; settings.releaseMic = $('optRelease').checked;
  save('tl-proto-settings', settings);
  $('settings').close();
  if (cpuChanged) { location.reload(); return; }
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
$('liveBtn').onclick = () => { if (!ready) return; if (live.on) liveStop(); else liveStart(); };
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

// If the last start never finished, the page most likely crashed (out of memory). Step down to a lighter setup.
function recoverFromCrash() {
  const last = load('tl-proto-loading', null);
  if (!last) return;
  try { localStorage.removeItem('tl-proto-loading'); } catch (e) { /* ignore */ }
  const name = { base: 'Whisper base', small: 'Whisper small', turbo: 'Whisper large-v3 turbo' };
  let msg;
  if (settings.engine === 'nllb') { settings.engine = 'opus'; msg = 'switched the translation engine to the smaller OPUS-MT'; }
  else if (settings.asr === 'turbo') { settings.asr = 'small'; msg = 'switched speech recognition from ' + name.turbo + ' to ' + name.small; }
  else if (settings.asr === 'small') { settings.asr = 'base'; msg = 'switched speech recognition from ' + name.small + ' to ' + name.base; }
  else if (!settings.cpuOnly) { settings.cpuOnly = true; msg = 'switched the AI to run on CPU only'; }
  else msg = 'kept the lightest settings. Close other apps and restart the phone, then try again';
  save('tl-proto-settings', settings);
  const el = $('setupError');
  el.hidden = false;
  el.textContent = 'The last start stopped unexpectedly – the phone probably ran out of memory. I ' + msg + '.';
}
recoverFromCrash();
labels(); setupText(); net(); renderAll();
