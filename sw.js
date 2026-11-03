/* AdHoc TaskManager — Service Worker
 * Strategy:
 *   - Static assets (css/js/images/fonts/manifest): CACHE-FIRST (versioned cache)
 *   - Navigations & everything else same-origin:   NETWORK-FIRST (timeout) -> cache -> offline fallback
 * DEPLOYING AN UPDATE: bump VERSION. The new worker skips waiting, claims clients,
 * deletes every old cache, and tells open pages (which then offer a Reload).
 */
'use strict';

const VERSION = '1.0.1';
const CACHE_PREFIX = 'adhoc-taskmanager';
const STATIC_CACHE = `${CACHE_PREFIX}-static-v${VERSION}`;
const RUNTIME_CACHE = `${CACHE_PREFIX}-runtime-v${VERSION}`;
const RUNTIME_MAX_ENTRIES = 60;
const NETWORK_TIMEOUT_MS = 4000;

const SCOPE = self.registration.scope;
const abs = (p) => new URL(p, SCOPE).toString();

const PRECACHE = [
  './', 'index.html', 'offline.html', 'css/styles.css', 'js/app.js', 'manifest.webmanifest',
  'favicon.ico', 'favicon.svg', 'apple-touch-icon.png',
  'icons/icon-72.png', 'icons/icon-96.png', 'icons/icon-128.png', 'icons/icon-144.png', 'icons/icon-152.png',
  'icons/icon-192.png', 'icons/icon-384.png', 'icons/icon-512.png', 'icons/icon-maskable-192.png', 'icons/icon-maskable-512.png'
].map(abs);
const STATIC_DESTINATIONS = new Set(['style', 'script', 'image', 'font', 'manifest']);

/* ---------- Lifecycle ---------- */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    await Promise.all(PRECACHE.map(async (url) => {
      const res = await fetch(new Request(url, { cache: 'reload' }));
      if (!res.ok) throw new Error(`Precache failed (${res.status}): ${url}`);
      await cache.put(url, res);
    }));
    await self.skipWaiting(); // instant activation
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch (_) { /* optional */ }
    }
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith(CACHE_PREFIX) && k !== STATIC_CACHE && k !== RUNTIME_CACHE)
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    clients.forEach((c) => c.postMessage({ type: 'SW_ACTIVATED', version: VERSION }));
  })());
});

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'SKIP_WAITING') self.skipWaiting();
  if (msg.type === 'GET_VERSION' && event.source) event.source.postMessage({ type: 'SW_VERSION', version: VERSION });
  if (msg.type === 'CLEAR_CACHES') {
    event.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith(CACHE_PREFIX)).map((k) => caches.delete(k)))));
  }
});

/* ---------- Fetch routing ---------- */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;       // never touch cross-origin
  if (url.searchParams.has('__probe')) return;           // connectivity probes go straight to network

  if (req.mode === 'navigate') {
    event.respondWith(handleNavigation(event));
    return;
  }
  if (STATIC_DESTINATIONS.has(req.destination) || url.pathname.endsWith('.webmanifest')) {
    event.respondWith(cacheFirst(req));
    return;
  }
  event.respondWith(networkFirst(req));
});

/* ---------- Strategies ---------- */
async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res && res.ok && res.type === 'basic') {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(req, res.clone());
      trimCache(RUNTIME_CACHE, RUNTIME_MAX_ENTRIES);
    }
    return res;
  } catch (err) {
    return new Response('', { status: 503, statusText: 'Offline' });
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function networkFirst(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const res = await withTimeout(fetch(req), NETWORK_TIMEOUT_MS);
    if (res && res.ok && res.type === 'basic') {
      cache.put(req, res.clone());
      trimCache(RUNTIME_CACHE, RUNTIME_MAX_ENTRIES);
    }
    return res;
  } catch (err) {
    const cached = await caches.match(req);
    return cached || new Response('', { status: 503, statusText: 'Offline' });
  }
}

async function handleNavigation(event) {
  const req = event.request;
  try {
    const preload = event.preloadResponse ? await event.preloadResponse : null;
    const res = preload || (await withTimeout(fetch(req), NETWORK_TIMEOUT_MS));
    if (res && res.ok) {
      const cache = await caches.open(STATIC_CACHE);
      // Keep the app shell fresh for offline launches.
      cache.put(abs('index.html'), res.clone()).catch(() => {});
    }
    return res;
  } catch (err) {
    // Offline: the app is fully local, so serve the cached shell. Query strings (shortcuts) are ignored.
    const shell =
      (await caches.match(req, { ignoreSearch: true })) ||
      (await caches.match(abs('index.html'))) ||
      (await caches.match(abs('./')));
    if (shell) return shell;
    const offline = await caches.match(abs('offline.html'));
    return offline || new Response('<h1>Offline</h1>', { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
}

async function trimCache(name, max) {
  try {
    const cache = await caches.open(name);
    const keys = await cache.keys();
    for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
  } catch (_) { /* non-critical */ }
}
