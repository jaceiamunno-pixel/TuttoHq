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

// Precache poison guard (ADR-009 Phase 1, Step 1.1 hardening). The /dashboard
// shell is precached by fetching it at SW install — WITH credentials, so the
// request passes through middleware. In a narrow window (refresh token fully
// expired at install time) middleware 302s /dashboard → /login and the precache
// fetch follows it, resolving to the LOGIN document. Serwist would otherwise
// copy that redirected response and store it as the precached shell, so a later
// offline cold launch would serve a login page the user can't get past — the
// exact dead-zone lockout this feature exists to prevent.
//
// This plugin runs as the precache strategy's `cacheWillUpdate`. Returning null
// makes Serwist's precache install REJECT this entry atomically (cachePut →
// false → "bad-precaching-response"): the new SW never installs/activates, so
// the PREVIOUS service worker keeps serving its own good shell + matching
// chunks. A login document can therefore never become the precached shell. On
// the next install with a valid session the real shell is precached normally.
const rejectAuthRedirectInPrecache: SerwistPlugin = {
  cacheWillUpdate: async ({ response }) => {
    // KEEP THIS >=400 REJECT — do not "simplify" it away. Serwist only installs
    // its default precache cacheability plugin (defaultPrecacheCacheabilityPlugin,
    // which rejects >=400) when NO custom cacheWillUpdate exists
    // (_useDefaultCacheabilityPluginIfNeeded). Providing this plugin suppresses
    // that default, so without re-implementing the reject here, error responses
    // — and, via the always-on copyRedirectedCacheableResponsesPlugin, redirect
    // bodies — would silently become cacheable again, reopening the
    // login-as-shell hole guarded below.
    if (!response || response.status >= 400) return null
    let finalPath = ""
    try {
      finalPath = new URL(response.url).pathname
    } catch {
      // Unparseable response URL — treat as safe; don't block a legit asset.
    }
    // response.url is the FINAL url after any redirect (reliable at store time;
    // it does NOT survive into the cache, which is why we check here and not on
    // activate). EXACT-segment match — `=== "/login"` is the case middleware
    // actually produces; `startsWith("/login/")` covers future /login/* subpaths.
    // This is NOT a substring test, so app paths that merely contain "login"
    // (e.g. /login-help, /account/login, /logins) are unaffected.
    if (finalPath === "/login" || finalPath.startsWith("/login/")) return null
    return response
  },
}

const isSameOrigin = (url: URL) => url.origin === self.location.origin

// The start_url (and the offline shell entry) is /dashboard. A document request
// for it on an offline cold launch must resolve to the PRECACHED shell, not the
// /offline page — deterministically, with no dependence on a prior runtime cache
// hit. Other app routes (/projects, /library, …) are reached via the shell once
// it boots, so they don't need their own offline document.
const isDashboardDocument = (request: Request) => {
  if (request.destination !== "document") return false
  const path = new URL(request.url).pathname
  return path === "/dashboard" || path.startsWith("/dashboard/")
}

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
  // Reject an auth-redirect (login) response at precache store time, so a login
  // document can never become the precached /dashboard shell (see plugin above).
  precacheOptions: { plugins: [rejectAuthRedirectInPrecache] },
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
    // Order matters — the first matching entry wins.
    entries: [
      {
        // (1) Protected cold launch (start_url /dashboard) with the network gone
        // and nothing in the runtime page cache (i.e. NO priming): serve the
        // PRECACHED client shell. This is THE Step-1.1 fix — the offline shell
        // is now deterministic (precache), not dependent on NetworkFirst having
        // captured /dashboard during an earlier online session. The shell boots
        // client-side, trusts the last-known session, and renders the dashboard
        // + the offline daily-report entry.
        url: "/dashboard",
        matcher: ({ request }) => isDashboardDocument(request),
      },
      {
        // (2) Any other document navigation that misses network + cache (a
        // never-primed network-only route in a dead zone) → the branded offline
        // page instead of the browser's error screen.
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
