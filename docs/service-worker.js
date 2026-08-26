/**
 * service-worker.js
 * アプリシェルをキャッシュし、完全オフラインでも記録画面が開けるようにする。
 * キャッシュバージョンを上げると、次回オンライン時に新しいシェルへ更新される。
 */
const CACHE_NAME = 'collector-app-shell-v1';
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './db.js',
  './sync.js',
  './idlogic.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

// キャッシュ優先、なければネットワーク（アプリシェル用）。
// GAS への同期POSTなど他オリジンへのリクエストはそのままネットワークへ通す。
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // 他オリジンは素通し
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((res) => {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
          return res;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});
