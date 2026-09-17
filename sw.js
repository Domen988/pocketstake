// App-shell cache. Data (tiles, parcels) lives in IndexedDB, not here.
const VERSION = 'pegged-shell-v4';

const SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'i18n.json',
  'manifest.webmanifest',
  'vendor/proj4.js',
  'src/proj.js',
  'src/gurs.js',
  'src/tiles.js',
  'src/store.js',
  'src/measure.js',
  'src/compass.js',
  'src/sim.js',
  'src/ui/welcome.js',
  'src/ui/map.js',
  'src/ui/measure.js',
  'src/ui/log.js',
  'src/ui/settings.js',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(VERSION)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // GURS requests go to the network
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(
      (hit) =>
        hit ??
        fetch(e.request).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(e.request, copy));
          }
          return res;
        })
    )
  );
});
