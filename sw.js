/* FreshMart POS service worker.
 * Makes the app installable and lets it run with no connection: the shell is precached,
 * data lives in IndexedDB, and Google Sheets calls are made only when online.
 *
 * Bump CACHE_VERSION whenever an app-shell file changes.
 */
const CACHE_VERSION = "freshmart-pos-v11";
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

// NOTE: "./" is deliberately not listed — the server redirects it, and the navigation
// handler below serves "./index.html" instead, which covers offline starts.
const ASSETS = [
  "./index.html",
  "./manifest.webmanifest",
  "./css/styles.css",
  "./vendor/jsQR.js",
  "./vendor/qrcode.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-512.png",
  "./apps-script/Code.gs",
  "./js/app.js",
  "./js/analytics.js",
  "./js/dashboard.js",
  "./js/idb.js",
  "./js/inventory.js",
  "./js/labels.js",
  "./js/localdb.js",
  "./js/demoData.js",
  "./js/pos.js",
  "./js/pwa.js",
  "./js/qr.js",
  "./js/receipt.js",
  "./js/sales.js",
  "./js/scanner.js",
  "./js/settings.js",
  "./js/store.js",
  "./js/sync.js",
  "./js/ui.js",
  "./js/data/backend.js",
  "./js/data/logic.js",
  "./js/data/sample.js",
  "./js/data/sheets-adapter.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Precache one by one so a single missing file can't break the whole install.
      await Promise.allSettled(ASSETS.map((url) => cache.add(new Request(url, { cache: "reload" }))));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => !k.startsWith(CACHE_VERSION)).map((k) => caches.delete(k)));
      // Self-heal: anything that failed during install (e.g. a reload mid-install) is fetched again,
      // so the app is never left with a half-populated offline cache.
      try {
        const cache = await caches.open(SHELL_CACHE);
        const missing = [];
        for (const url of ASSETS) {
          if (!(await cache.match(url, { ignoreSearch: true }))) missing.push(url);
        }
        if (missing.length) await Promise.allSettled(missing.map((u) => cache.add(new Request(u, { cache: "reload" }))));
      } catch (e) {
        /* non-fatal */
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

/** Cache-first + refresh in the background: instant launch, still stays current. */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request, { ignoreSearch: request.mode === "navigate" });
  const network = fetch(request)
    .then((res) => {
      if (res && res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);
  if (cached) {
    network.catch(() => null); // keep the refresh going without blocking the response
    return cached;
  }
  const res = await network;
  return res || new Response("Offline", { status: 503, statusText: "Offline" });
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // Sheets writes/posts are always live

  const url = new URL(request.url);

  // Never cache the Apps Script web app or the Next.js health check.
  if (url.hostname === "script.google.com" || url.pathname === "/api/health") return;
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  try {
    // App pages: serve the shell so the POS opens with no connection.
    if (request.mode === "navigate") {
      event.respondWith(
        (async () => {
          try {
            return await staleWhileRevalidate(new Request("./index.html", { cache: "reload" }), SHELL_CACHE);
          } catch {
            const cache = await caches.open(SHELL_CACHE);
            return (await cache.match("./index.html")) || Response.error();
          }
        })(),
      );
      return;
    }

    // Our own assets: precached shell first.
    if (url.origin === self.location.origin) {
      event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
      return;
    }

    // Cross-origin (Google Fonts): cache what we can, fall back silently.
    if (/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
      event.respondWith(
        (async () => {
          const cache = await caches.open(RUNTIME_CACHE);
          const cached = await cache.match(request);
          if (cached) return cached;
          try {
            const res = await fetch(request);
            if (res.ok || res.type === "opaque") cache.put(request, res.clone());
            return res;
          } catch {
            return cached || Response.error();
          }
        })(),
      );
    }
  } catch (e) {
    /* let the browser handle it */
  }
});
