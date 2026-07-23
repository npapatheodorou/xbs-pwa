/**
 * Service worker: app-shell caching only.
 *
 * Deliberately narrow in scope:
 *   - it caches the shell (HTML/CSS/JS/icons) so the app opens offline
 *   - it NEVER caches API responses; bookmark freshness is handled in app code,
 *     which can label stale data honestly. A cached API response here would be
 *     invisible to that logic and could show stale bookmarks as fresh.
 *   - it never touches cross-origin requests at all
 */

// Bump on every deploy that changes a shell file, so clients pick it up.
const CACHE = 'xbs-shell-v1';

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/app.js',
  './js/api.js',
  './js/crypto.js',
  './js/lzutf8.js',
  './js/store.js',
  './js/bookmarks.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon-180.png',
  './icons/apple-touch-icon-167.png',
  './icons/apple-touch-icon-152.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // Individually, so one missing optional asset cannot fail the whole install.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Anything not on this origin is the xBrowserSync API. Leave it entirely
  // alone so the app's own freshness handling stays authoritative.
  if (url.origin !== self.location.origin) return;

  // Navigations: network first, falling back to the cached shell when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match('./index.html', { ignoreSearch: true }).then((cached) => cached || Response.error())
      )
    );
    return;
  }

  // Static assets: cache first, revalidating in the background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
