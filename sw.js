// Offline copy of the app, so it opens without a connection and can be installed. App files come
// fresh from the site when online (so updates show up); the OCR files are large and fixed, so they
// come from the cache first.
const CACHE = 'keells-bill-reader-v1';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'bill-reader.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'vendor/tesseract/tesseract.min.js', 'vendor/tesseract/worker.min.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('keells-bill-reader-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || req.headers.has('range')) return;
  e.respondWith(url.pathname.includes('/vendor/') ? cacheFirst(req) : networkFirst(req));
});

async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
    return res;
  } catch (e) {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    throw e;
  }
}
