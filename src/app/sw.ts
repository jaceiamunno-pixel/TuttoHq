// TuttoHQ service worker — ADR-009 Phase 1, Step 1.
//
// SCOPE (deliberately tiny): asset/shell precache + navigation fallback ONLY.
// It takes NO durable/queue role — the field-photo write path stays in
// IndexedDB + the UI-triggered runner (photo-sync.ts / idb-photos.ts), exactly
// as ADR-003 requires. Keeping the SW free of business logic is what lets the
// eventual Capacitor wrap drop it losslessly (the native shell ships assets
// on-device). Do NOT add /api caching, mutation replay, or background sync here.
//
// This file is type-checked via tsconfig.sw.json (lib: webworker), NOT the app
// tsconfig: the app deliberately keeps lib = ["dom"] and casts `self` in its
// workers (see src/lib/photo-compression.worker.ts), so we keep the worker lib
// out of app type-checking by excluding this file there.

import {
  ExpirationPlugin,
  NetworkFirst,
  NetworkOnly,
  Serwist,
  type PrecacheEntry,
  type RuntimeCaching,
  type SerwistGlobalConfig,
  type SerwistPlugin,
} from "serwist"

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    // Injected at build time by @serwist/next (injectManifest mode). This is the
    // BUILD-GENERATED precache manifest: every /_next/static/** chunk keyed to
    // its content hash, plus the public assets (icons/manifest) and the
    // /offline document. We never hand-maintain it — that is exactly what keeps
    // a stale shell from being served against freshly-hashed chunks on
    // redeploy. A new deploy ⇒ a new manifest ⇒ the old precache is purged on
    // activate.
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined
  }
}

declare const self: ServiceWorkerGlobalScope

const ONE_DAY_SECONDS = 24 * 60 * 60

// Never cache an auth redirect. A protected navigation made with an expired
// session follows a 302 → /login and resolves to a 200 at a DIFFERENT url; if
// we cached that body under the protected url we'd serve "login" for
// "/dashboard" the next time the device is offline. Only a real, non-redirected
// 200 is cacheable.
const cacheRealRendersOnly: SerwistPlugin = {
  cacheWillUpdate: async ({ response }) =>
    response.status === 200 && !response.redirected ? response : null,
}

const isSameOrigin = (url: URL) => url.origin === self.location.origin

const runtimeCaching: RuntimeCaching[] = [
  // (1) /api/* — NETWORK-ONLY, NEVER CACHED. Listed first so nothing below can
  // intercept it. Mutations must never replay from cache, and a GET must never
  // be served stale-as-live. (Read-caching other modules' data offline is
  // Phase 2 and will live behind explicit per-route SWR rules — never here.)
  {
    matcher: ({ url }) => isSameOrigin(url) && url.pathname.startsWith("/api/"),
    handler: new NetworkOnly(),
  },
  // (2) App Router RSC payloads (soft navigations + prefetches, identified by
  // the RSC header). NetworkFirst so a route opened online once still resolves
  // offline; online it always refreshes.
  {
    matcher: ({ url, request }) =>
      isSameOrigin(url) &&
      !url.pathname.startsWith("/api/") &&
      request.headers.get("RSC") === "1",
    handler: new NetworkFirst({
      cacheName: "tutto-pages-rsc",
      networkTimeoutSeconds: 5,
      plugins: [
        cacheRealRendersOnly,
        new ExpirationPlugin({ maxEntries: 64, maxAgeSeconds: ONE_DAY_SECONDS }),
      ],
    }),
  },
  // (3) HTML document navigations (hard load / PWA cold launch). NetworkFirst →
  // live shell when online (refreshing the cache), last cached shell when
  // offline. THIS is the mechanism that bypasses the middleware getUser() gate
  // offline: the SW answers the navigation from cache, so the request never
  // leaves the device and middleware never runs. A miss (a never-primed module
  // in a dead zone) falls through to the /offline document (see `fallbacks`).
  {
    matcher: ({ url, request }) =>
      isSameOrigin(url) &&
      !url.pathname.startsWith("/api/") &&
      request.mode === "navigate",
    handler: new NetworkFirst({
      cacheName: "tutto-pages",
      networkTimeoutSeconds: 5,
      plugins: [
        cacheRealRendersOnly,
        new ExpirationPlugin({ maxEntries: 64, maxAgeSeconds: ONE_DAY_SECONDS }),
      ],
    }),
  },
]

const serwist = new Serwist({
  // Build-generated precache: Next runtime + dashboard/daily client-shell chunks
  // + public icons/manifest + the /offline document. The ~1.3 MB heic2any WASM
  // chunk is excluded by maximumFileSizeToCacheInBytes in next.config — offline
  // HEIC is Step 2, gated on on-device WASM-in-worker verification.
  precacheEntries: self.__SW_MANIFEST,
  // Do NOT silently swap. A new SW installs and WAITS; the page detects it and
  // shows an explicit "new version — reload" prompt (pwa-provider.tsx), which
  // posts SKIP_WAITING below. This is the single highest-blast-radius guard: a
  // stale shell activated against new chunks white-screens the whole app.
  skipWaiting: false,
  // First install controls already-open pages immediately (no "works only on
  // the second visit" lag). On iOS the page may still need one navigation to be
  // fully controlled — see ADR-009 §iOS #3.
  clientsClaim: true,
  navigationPreload: false,
  runtimeCaching,
  fallbacks: {
    entries: [
      {
        // Document navigations that miss BOTH network and cache get the branded
        // offline page instead of the browser's error screen. Dashboard/daily,
        // primed online once, serve their own cached shell and never reach this.
        url: "/offline",
        matcher: ({ request }) => request.destination === "document",
      },
    ],
  },
})

// The page posts this when the user accepts the update prompt. We call
// skipWaiting() only then — never on our own — so a redeploy can't swap an old
// shell against new chunks under a live page.
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting()
})

serwist.addEventListeners()
