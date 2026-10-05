// Plants service worker: lets the installed mobile collector open offline.
//
//   navigation (HTML)   → network-first, fall back to the cached app shell
//   /assets/* (hashed)  → cache-first
//   other same-origin   → network-first, cache fallback (icons, manifest)
//   cross-origin        → untouched. Supabase responses are per-user and carry
//                         auth; the collector keeps its data in IndexedDB instead.
//   non-GET             → untouched (writes go through the IndexedDB queue)
//
// The shell's JS/CSS are precached at install: assets the page fetched before
// this worker took control would otherwise never be cached, and the app
// couldn't start offline after the first visit.

const CACHE_VERSION = 'plants-collector-v1'
const SHELL_URL = '/mobile'
const STATIC_URLS = ['/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/icon.svg', '/apple-touch-icon.png', '/favicon.svg']

// ── Install ──────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION)
      await precacheShell(cache)
      // Ignore individual failures so the worker still installs
      await Promise.allSettled(STATIC_URLS.map((u) => cache.add(u)))
      await self.skipWaiting()
    })(),
  )
})

// ── Activate ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

// ── Fetch ────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)

  // Only handle same-origin GET requests
  if (url.origin !== self.location.origin || request.method !== 'GET') return

  if (request.mode === 'navigate') {
    event.respondWith(navigationHandler(request))
    return
  }
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirstWithNetwork(request))
    return
  }
  event.respondWith(networkFirstWithCache(request))
})

// ── Strategy helpers ─────────────────────────────────────────────────────────

/** Caches index.html (every route serves it) plus the scripts and styles it references. */
async function precacheShell(cache, response) {
  try {
    const res = response ?? (await fetch(SHELL_URL, { cache: 'no-cache' }))
    if (!res.ok) return
    const html = await res.clone().text()
    await cache.put(SHELL_URL, res)
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1])
    const missing = []
    for (const asset of new Set(assets)) {
      if (!(await cache.match(asset))) missing.push(asset)
    }
    await Promise.allSettled(missing.map((a) => cache.add(a)))
  } catch {
    // Offline during install/update: keep whatever is cached
  }
}

async function navigationHandler(request) {
  const cache = await caches.open(CACHE_VERSION)
  try {
    const response = await fetch(request)
    // A new deploy brings new hashed assets: cache them while we're online.
    if (response.ok) precacheShell(cache, response.clone())
    return response
  } catch {
    // All routes are the same single-page app
    const cached = await cache.match(SHELL_URL, { ignoreVary: true })
    if (cached) return cached
    return new Response('<h1>Plants — offline</h1><p>Open Plants once with a connection to use it offline.</p>', {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  }
}

async function cacheFirstWithNetwork(request) {
  const cache = await caches.open(CACHE_VERSION)
  // Hashed assets never change; ignore Vary so the copies precached at install
  // (fetched without an Origin header) also serve the page's crossorigin requests.
  const cached = await cache.match(request, { ignoreVary: true })
  if (cached) return cached
  try {
    const response = await fetch(request)
    if (response.ok) cache.put(request, response.clone())
    return response
  } catch {
    return new Response('Asset not available offline', { status: 503 })
  }
}

async function networkFirstWithCache(request) {
  const cache = await caches.open(CACHE_VERSION)
  try {
    const response = await fetch(request)
    if (response.ok) cache.put(request, response.clone())
    return response
  } catch {
    return (await cache.match(request, { ignoreVary: true })) ?? new Response('Not available offline', { status: 503 })
  }
}
