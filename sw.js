// Keeps the app itself available offline. The AI models are cached separately by Transformers.js.
const CACHE = 'translitera-proto-v7';
const SHELL = [
  './', 'index.html', 'css/app.css', 'js/app.js', 'js/worker.js', 'js/phrases.js',
  'lib/transformers.min.js', 'lib/ort-wasm-simd-threaded.jsep.mjs', 'lib/ort-wasm-simd-threaded.jsep.wasm',
  'assets/logo.svg', 'assets/speaker.webp', 'assets/icon-180.png', 'assets/icon-192.png', 'assets/icon-512.png',
  'manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('translitera-proto-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return; // models come from Hugging Face; Transformers.js caches those
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }))
  );
});
