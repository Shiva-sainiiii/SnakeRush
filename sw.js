// Snake Rush service worker
//
// Strategy: cache-first for the app shell (HTML/CSS/JS — the game itself),
// network-first for anything else (so a future redeploy doesn't get stuck
// serving a stale game forever). Bump CACHE_VERSION on every deploy that
// changes any of the precached files — that's what forces old clients to
// pick up the new version instead of serving a cached copy indefinitely.
const CACHE_VERSION = 'snake-rush-v2';
const APP_SHELL = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/game_part1.js',
  '/js/game_part2.js',
  '/js/game_part3.js',
  '/js/game_part4.js',
  '/js/game_part5.js',
  '/site.webmanifest',
  '/assets/favicon-192.png',
  '/assets/favicon-512.png',
  '/assets/favicon-192-maskable.png',
  '/assets/favicon-512-maskable.png',
  '/assets/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL))
  );
  // Activate this new worker as soon as it finishes installing, rather
  // than waiting for every open tab to close first — a game update should
  // apply the next time the player opens the app, not require them to
  // fully quit and relaunch.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET — POST/etc (if any future API calls happen) should
  // always go straight to the network untouched.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Cross-origin requests (fonts, cdnjs, analytics, etc.) — network only,
  // never cached here. Trying to cache third-party responses opens up
  // staleness/CORS complications this game doesn't need.
  if (url.origin !== self.location.origin) return;

  const isAppShellFile = APP_SHELL.includes(url.pathname) || url.pathname === '/';

  if (isAppShellFile) {
    // Cache-first: the whole point of an app shell is instant load even
    // fully offline. Falls back to network (and caches the fresh copy)
    // if it's somehow missing from cache.
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          const clone = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, clone));
          return response;
        });
      })
    );
  } else {
    // Network-first for everything else (e.g. any future dynamic assets),
    // falling back to cache only if the network is unreachable.
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() => caches.match(request))
    );
  }
});
