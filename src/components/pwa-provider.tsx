"use client"

import { useCallback, useEffect, useState } from "react"
import { createClient } from "@/lib/supabase/client"

// PWA runtime glue (ADR-009 Phase 1). Mounted once at the app shell. Owns four
// orthogonal concerns, all client-only:
//   1. Service-worker registration + the explicit "new version — reload" prompt
//      (never a silent shell swap — that is the #1 source of PWA white-screens).
//   2. Offline awareness banner (the daily flow keeps working from IndexedDB;
//      network-only modules need a reconnect — make that explicit).
//   3. Best-effort persistent storage so iOS is less likely to evict caches.
//   4. Re-verify the Supabase session on reconnect (we never hard-redirect to
//      /login while offline; this is the catch-up).
//
// It does NOT touch the durable photo path (photo-sync.ts / idb-photos.ts).

function registerServiceWorker(onWaiting: () => void): void {
  navigator.serviceWorker
    .register("/sw.js", { scope: "/" })
    .then((reg) => {
      // A worker from a previous load is already waiting → offer the update now.
      if (reg.waiting && navigator.serviceWorker.controller) onWaiting()

      reg.addEventListener("updatefound", () => {
        const installing = reg.installing
        if (!installing) return
        installing.addEventListener("statechange", () => {
          // installed + an existing controller ⇒ this is an UPDATE (not the
          // first install) and the new worker is now WAITING. Prompt the user;
          // do not swap silently. (On first install there is no controller, so
          // we stay quiet and let clientsClaim take over.)
          if (installing.state === "installed" && navigator.serviceWorker.controller) {
            onWaiting()
          }
        })
      })
    })
    .catch(() => {
      // Registration failures (private mode, unsupported, blocked) are non-fatal
      // — the app runs fine online without the SW.
    })
}

export default function PwaProvider() {
  const [updateReady, setUpdateReady] = useState(false)
  const [isOffline, setIsOffline] = useState(false)

  useEffect(() => {
    // ── Offline awareness + session re-verify on reconnect ──────────────────
    const syncOnline = () => setIsOffline(!navigator.onLine)
    syncOnline()
    const handleOnline = () => {
      setIsOffline(false)
      // Refresh the Supabase token so the next /api call or hard navigation
      // (which re-runs middleware getUser()) is authorized after a dead-zone
      // stretch. Best-effort; failures are swallowed.
      createClient().auth.getUser().catch(() => {})
    }
    const handleOffline = () => setIsOffline(true)
    window.addEventListener("online", handleOnline)
    window.addEventListener("offline", handleOffline)

    // ── Best-effort durable storage ─────────────────────────────────────────
    // Asks the browser to make Cache Storage + IndexedDB persistent so iOS is
    // less likely to evict the precache (re-fetchable) — and, more importantly,
    // the durable photo queue (NOT re-fetchable). iOS grants this
    // inconsistently; installed PWAs fare better than tab-Safari.
    void navigator.storage?.persist?.().catch?.(() => {})

    // ── Service worker (production only) ────────────────────────────────────
    // Dev has no generated SW (disabled in next.config), so skip registration
    // to avoid a 404 + console noise while developing.
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      registerServiceWorker(() => setUpdateReady(true))
    }

    return () => {
      window.removeEventListener("online", handleOnline)
      window.removeEventListener("offline", handleOffline)
    }
  }, [])

  // Apply a waiting update: tell the waiting SW to take over, then reload once
  // it does (controllerchange fires after skipWaiting → the page loads the new
  // shell + new chunks together, so there is never a stale mismatch). The
  // controllerchange listener is wired ONLY here, on the user's action, so the
  // first-install clientsClaim does not trigger a reload.
  const applyUpdate = useCallback(async () => {
    const reg = await navigator.serviceWorker?.getRegistration()
    const waiting = reg?.waiting
    if (!waiting) {
      window.location.reload()
      return
    }
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      () => window.location.reload(),
      { once: true },
    )
    waiting.postMessage({ type: "SKIP_WAITING" })
  }, [])

  return (
    <>
      {updateReady && (
        <div
          role="status"
          className="fixed bottom-3 right-3 z-[120] flex items-center gap-3 rounded-lg bg-[#0A1628] border border-white/10 px-3.5 py-2.5 shadow-xl"
        >
          <span className="text-[12.5px] font-medium text-white">A new version is ready.</span>
          <button
            onClick={applyUpdate}
            className="h-7 px-3 rounded-md bg-[#7B9BB5] text-[12px] font-semibold text-white transition-colors hover:bg-[#6A8AA4]"
          >
            Reload
          </button>
        </div>
      )}

      {isOffline && (
        <div
          role="status"
          className="fixed bottom-3 left-3 z-[110] flex items-center gap-2 rounded-full bg-[#0A1628] border border-amber-400/30 pl-2.5 pr-3 py-1.5 shadow-lg"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
          <span className="text-[12px] font-medium text-amber-200">
            Offline — daily reports keep working; reconnect to load other tools.
          </span>
        </div>
      )}
    </>
  )
}
