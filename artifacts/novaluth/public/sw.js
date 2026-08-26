const CACHE = "novaluth-v2";
const APP_SHELL = [
  "/",
  "/annuaire",
  "/manifest.json",
  "/novaluth-wordmark.png",
  "/novaluth-logo.png",
  "/novaluth-globe.png",
  "/polices/space-grotesk-latin.woff2",
];
const EXCLUDED = ["/admin", "/brief", "/api/"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || EXCLUDED.some((prefix) => url.pathname.startsWith(prefix))) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && response.type === "basic") {
          caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match("/"))),
  );
});