/* Splotify service worker — offline app shell. Audio stays in IndexedDB, never in the cache. */
const CACHE = 'splotify-v7.6';
const SHELL = [
  './', './index.html', './manifest.json',
  './css/app.css',
  './js/icons.js', './js/db.js', './js/player.js', './js/import.js', './js/artist-stats.js', './js/app.js', './js/plimport.js', './js/spotify-import.js', './js/vendor/mm.js', './js/vendor/jszip.min.js',
  './js/discography.json', './js/placeholder-artists.json', './js/artist-art/d4vd.jpg',
  './js/disco-art/Stargazing.jpg', './js/disco-art/Harlot.jpg', './js/disco-art/Hiraeth.jpg',
  './js/disco-art/Tired.jpg', './js/disco-art/Intervals.jpg', './js/disco-art/Drain.jpg',
  './js/disco-art/Retarded.jpg', './js/disco-art/Feel.jpg', './js/disco-art/Your_Eyes.jpg',
  './js/disco-art/roses-album.jpg',
  './fonts/montserrat-400.woff2', './fonts/montserrat-500.woff2', './fonts/montserrat-600.woff2',
  './fonts/montserrat-700.woff2', './fonts/montserrat-800.woff2',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png', './icons/favicon.png',
  './icons/shuffle-pink.png', './icons/repeat-all-pink.png', './icons/repeat-one-pink.png', './icons/create-tile.svg',
  './privacy.html', './terms.html',
];

self.addEventListener('install', e => {
  // cache:'reload' forces the network, so a redeploy can never precache stale HTTP-cached copies
  const reqs = SHELL.map(u => new Request(u, { cache: 'reload' }));
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(reqs)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // The in-app update check fetches sw.js directly; never serve it from cache.
  if (url.pathname.endsWith('/sw.js')) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(hit => {
      if (hit) return hit;
      return fetch(e.request).then(res => {
        // cache new same-origin gets opportunistically (never audio blobs — those live in IndexedDB)
        if (res.ok && !url.pathname.endsWith('.mp3') && !url.pathname.endsWith('.m4a') && !url.pathname.endsWith('.wav')) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
