// The service worker that makes the app installable and opens it offline. Everything of this site is
// fetched from the network first, so prices, picks and the app itself are always the newest when online;
// the last copy is kept only as a fallback for when there's no connection. Other sites (Supabase, the
// Anthropic API, script CDNs) are never touched.
const CACHE = 'paper-trader-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) {
        const copy = res.clone();
        event.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)));
      }
      return res;
    } catch (err) {
      const hit = (await caches.match(req)) ?? (req.mode === 'navigate' ? await caches.match('./') ?? await caches.match('index.html') : null);
      if (hit) return hit;
      throw err;
    }
  })());
});
