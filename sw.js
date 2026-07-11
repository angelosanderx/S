// Service worker do app de campo PNS 2026 — cache-first, pré-cacheia o app shell inteiro.
// Bump em CACHE_VERSION a cada deploy para invalidar o cache anterior.
'use strict';

const CACHE_VERSION = 'v3';
const CACHE_SHELL = `pns2026-shell-${CACHE_VERSION}`;

const ARQUIVOS_PRECACHE = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './dados.js',
  './manifest.json',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/images/marker-icon.png',
  './vendor/leaflet/images/marker-icon-2x.png',
  './vendor/leaflet/images/marker-shadow.png',
  './vendor/leaflet/images/layers.png',
  './vendor/leaflet/images/layers-2x.png',
  './vendor/leaflet-offline/idb.umd.js',
  './vendor/leaflet-offline/leaflet-offline.bundle.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_SHELL)
      .then((cache) => cache.addAll(ARQUIVOS_PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((chaves) => Promise.all(
        chaves
          .filter((c) => c.startsWith('pns2026-shell-') && c !== CACHE_SHELL)
          .map((c) => caches.delete(c))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((resp) => resp)
        .catch(() => cached); // sem rede e sem cache: deixa falhar (ex.: tile ausente)
    })
  );
});
