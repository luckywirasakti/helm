self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  // Pass through all requests
  e.respondWith(fetch(e.request));
});