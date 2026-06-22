"use client"

import { useEffect, useState } from "react"
import { createClient } from "@/lib/supabase/client"

// Offline-tolerant, correctly-keyed client auth gate (ADR-009 Phase 1, Step 1.1).
//
// Middleware stays the ONLINE gate (unchanged, server-enforced) — it just can't
// run on an offline cold launch, because the service worker answers the
// protected navigation from cache and the request never reaches the server.
// This gate is therefore the OFFLINE enforcement + the reconnect re-check:
//
//   • session present       → "authed"             (offline trusts the last-known session)
//   • no session + offline  → "offline-no-session"  (never hard-redirect to /login offline)
//   • no session + online   → redirect to /login    (online auth strength preserved)
//
// Keying detail: `getSession()` is a LOCAL read (cookie storage, no network), so
// it resolves offline and returns the last-known session. `getUser()` is NOT
// used for gating — it round-trips to the auth server and fails offline. The
// reconnect re-verify (getUser refresh) lives in PwaProvider; here we re-run the
// decision on the `online` event so a reconnecting signed-out user still lands
// on /login.
export type SessionGate = "checking" | "authed" | "offline-no-session"

export function useSessionGate(): SessionGate {
  const [gate, setGate] = useState<SessionGate>("checking")

  useEffect(() => {
    let active = true

    const evaluate = async () => {
      let hasSession = false
      try {
        hasSession = Boolean((await createClient().auth.getSession()).data.session)
      } catch {
        hasSession = false
      }
      if (!active) return
      if (hasSession) {
        setGate("authed")
      } else if (navigator.onLine) {
        // Online with no session: middleware already redirects unauthenticated
        // requests, so this is the client backstop + the reconnect handler. Not
        // reachable on an offline launch (the branch below runs instead).
        window.location.href = "/login"
      } else {
        setGate("offline-no-session")
      }
    }

    void evaluate()
    window.addEventListener("online", evaluate)
    return () => {
      active = false
      window.removeEventListener("online", evaluate)
    }
  }, [])

  return gate
}
