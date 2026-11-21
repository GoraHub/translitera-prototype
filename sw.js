// Keeps the app itself available offline. The AI models are cached separately by Transformers.js.
const CACHE = 'translitera-proto-v11';
const SHELL = [
  './', 'index.html', 'css/app.css', 'js/app.js', 'js/worker.js', 'js/phrases.js',
  'lib/transformers.min.js', 'lib/ort-wasm-simd-threaded.asyncify.mjs', 'lib/ort-wasm-simd-threaded.asyncify.wasm',
  'assets/logo.svg', 'assets/speaker.webp', 'assets/app-icon-180.png', 'assets/app-icon-192.png', 'assets/app-icon-512.png',
  'manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  // Cache files one by one, so one missing file cannot block the update.
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((f) => c.add(f).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('translitera-proto-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return; // models come from Hugging Face; Transformers.js caches those
  // Network first, so a new version is used as soon as it is online; the cache is the offline fallback.
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
