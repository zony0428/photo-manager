/**
 * Photo Manager Mobile - オフライン動作保証用 Service Worker
 * 一度スマホで開いてホーム画面に追加（PWAインストール）すれば、
 * PC電源OFF・圏外環境でもアプリアイコンから起動してUSB内の library.db を直接読み込める。
 */

const CACHE_NAME = 'pm-mobile-cache-v2.30';
const ASSETS_TO_CACHE = [
  '/m',
  '/mobile.html',
  '/css/mobile.css',
  '/js/mobile.js',
  '/vendor/sqljs/sql-wasm.js',
  '/vendor/sqljs/sql-wasm.wasm',
  '/manifest_mobile.json',
  '/favicon.ico',
  '/icons/icon-32.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE).catch((err) => {
        console.warn('[SW] 一部アセットの事前キャッシュをスキップ:', err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API通信 (/api/*) は常にネットワーク優先（失敗時はそのままオフライン判定へ渡す）
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // アプリシェル（HTML / CSS / JS / WASM）はネットワーク優先＋オフライン時キャッシュフォールバック
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200 && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => {
        return caches.match(event.request, { ignoreSearch: true }).then((cached) => {
          if (cached) return cached;
          if (event.request.mode === 'navigate') {
            return caches.match('/mobile.html', { ignoreSearch: true });
          }
          return new Response('Offline', { status: 503 });
        });
      })
  );
});
