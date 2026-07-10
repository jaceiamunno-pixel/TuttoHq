"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { createBrowserClient } from "@supabase/ssr"

/**
 * `/auth/callback` — the landing route for every Supabase auth email link.
 *
 * Two link shapes reach here, because we are mid-migration:
 *
 *   • PKCE / query `?code=…`      — the one-time code is exchanged for a session.
 *   • Implicit / fragment `#…`    — GoTrue's /verify 302s here with the session
 *                                    in the URL fragment (`#access_token=…`).
 *
 * Both are consumed CLIENT-SIDE, on purpose:
 *   - The fragment is never sent to the server, so only the client can read it.
 *   - Exchanging the PKCE code in the browser keeps the code out of our server
 *     access logs entirely (the "never log the token" rule), and the resulting
 *     cookies are written the same way the rest of the app writes them — via the
 *     ssr browser client (non-httpOnly, JS-owned). A server-side route-handler
 *     exchange would mint a *different* cookie posture (httpOnly) than every
 *     other session cookie in this app, so client-side exchange is both simpler
 *     and more consistent here. (See the trace notes handed to review.)
 *
 * A live access token must never sit in the address bar or in browser history,
 * so the URL is scrubbed via history.replaceState the instant the session is
 * set — before any navigation.
 *
 * On `type=recovery` → /auth/reset-password. On anything else → the app root.
 * On error / missing / expired → a plain "invalid or expired" card, never the
 * silent marketing homepage.
 */

// Dedicated client with detectSessionInUrl DISABLED so the SDK does not race us
// by auto-exchanging the `?code` (which would burn the one-time code and make
// our explicit exchange fail with "code already used"). flowType stays the
// package default ('pkce'); cookie storage is the same project-keyed jar the
// shared createClient() uses, so the session it writes is visible app-wide.
function callbackClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { detectSessionInUrl: false } },
  )
}

// Scrub any token/code out of the visible URL and history entry.
function scrubUrl() {
  window.history.replaceState(null, "", "/auth/callback")
}

type Phase = "working" | "error"

export default function AuthCallbackPage() {
  const [phase, setPhase] = useState<Phase>("working")
  const router = useRouter()

  useEffect(() => {
    let cancelled = false

    async function run() {
      const url = new URL(window.location.href)
      const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""))

      // Expired / denied links carry `error` — in the query on the PKCE path,
      // in the fragment on the implicit path. Either way: show the error card.
      if (url.searchParams.get("error") || hash.get("error")) {
        scrubUrl()
        if (!cancelled) setPhase("error")
        return
      }

      // Recovery marker: the query on the PKCE path (we set it via redirectTo),
      // the fragment on the implicit path (GoTrue puts it there).
      const type = url.searchParams.get("type") ?? hash.get("type")
      const code = url.searchParams.get("code")

      try {
        const supabase = callbackClient()

        if (code) {
          const { error } = await supabase.auth.exchangeCodeForSession(code)
          if (error) throw error
        } else {
          const accessToken = hash.get("access_token")
          const refreshToken = hash.get("refresh_token")
          if (!accessToken || !refreshToken) {
            // Bare visit / nothing actionable in the URL.
            scrubUrl()
            if (!cancelled) setPhase("error")
            return
          }
          const { error } = await supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
          })
          if (error) throw error
        }
      } catch {
        // Intentionally swallow the underlying error object — it can echo the
        // token/code. A generic failure is all the user (or Sentry) ever sees.
        scrubUrl()
        if (!cancelled) setPhase("error")
        return
      }

      scrubUrl()
      if (cancelled) return

      router.replace(type === "recovery" ? "/auth/reset-password" : "/dashboard")
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [router])

  return (
    <div className="min-h-screen bg-[#F4F5F7] flex items-center justify-center">
      <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-[360px] p-8 text-center">
        <div className="w-12 h-12 rounded-xl bg-[#7B9BB5]/15 border border-[#7B9BB5]/30 flex items-center justify-center mx-auto mb-4">
          <svg className="w-6 h-6 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        </div>

        {phase === "working" ? (
          <>
            <h1 className="text-[18px] font-bold text-[#0F172A] tracking-tight">Signing you in…</h1>
            <p className="text-[13px] text-[#64748B] mt-1">One moment while we verify your link.</p>
          </>
        ) : (
          <>
            <h1 className="text-[18px] font-bold text-[#0F172A] tracking-tight">This reset link is invalid or has expired</h1>
            <p className="text-[13px] text-[#64748B] mt-2">
              Reset links can only be used once and expire after a short time.
            </p>
            <Link
              href="/login"
              className="inline-block mt-5 w-full h-10 leading-10 bg-[#7B9BB5] text-white text-[14px] font-semibold rounded-md hover:bg-[#6A8AA4] transition-colors"
            >
              Return to sign in
            </Link>
          </>
        )}
      </div>
    </div>
  )
}
