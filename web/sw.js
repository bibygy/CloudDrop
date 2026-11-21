// CloudDrop Service Worker
// 1. Offline-first app shell caching
// 2. Android / PWA Web Share Target POST receiver

const CACHE_NAME = 'clouddrop-shell-v1';
const SHARE_CACHE = 'clouddrop-share-inbox';
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './styles/tokens.css',
  './styles/app.css',
  './assets/icon.svg',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/favicon-32.png',
  './src/main.js',
  './src/state/db.js',
  './src/state/store.js',
  './src/crypto/e2ee.js',
  './src/providers/base.js',
  './src/providers/local.js',
  './src/providers/gdrive.js',
  './src/providers/onedrive.js',
  './src/sync/engine.js',
  './src/ui/icons.js',
  './src/ui/markdown.js',
  './src/ui/toast.js',
  './src/ui/render.js',
  './src/ui/modals.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME && k !== SHARE_CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Intercept Android Web Share Target POST
  if (event.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith((async () => {
      try {
        const formData = await event.request.formData();
        const title = formData.get('title') || '';
        const text = formData.get('text') || '';
        const sharedUrl = formData.get('url') || '';
        const files = formData.getAll('files').filter((f) => f && typeof f === 'object' && f.size >= 0);

        const shareCache = await caches.open(SHARE_CACHE);
        const manifest = {
          title: String(title),
          text: String(text),
          url: String(sharedUrl),
          files: [],
          receivedAt: Date.now()
        };

        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          const key = `./__shared_file_${i}`;
          manifest.files.push({
            key,
            name: f.name || `shared_${Date.now()}_${i}`,
            type: f.type || 'application/octet-stream',
            size: f.size
          });
          await shareCache.put(key, new Response(f, {
            headers: { 'Content-Type': f.type || 'application/octet-stream' }
          }));
        }

        await shareCache.put('./__shared_meta', new Response(JSON.stringify(manifest), {
          headers: { 'Content-Type': 'application/json' }
        }));
      } catch (err) {
        console.error('[SW] Share target error:', err);
      }
      return Response.redirect('./?share=pending', 303);
    })());
    return;
  }

  // Never cache cloud APIs, OAuth endpoints, or local-sync API
  if (
    event.request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/')
  ) {
    return;
  }

  // Network-first for HTML/JS/CSS (always fresh in dev & desktop), fallback to cache offline
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
