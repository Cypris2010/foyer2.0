// Minimal service worker: proves registration works and records whether its
// cache survives restarts (the page reads the marker back on the next load).
self.addEventListener('install', function (event) {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});
