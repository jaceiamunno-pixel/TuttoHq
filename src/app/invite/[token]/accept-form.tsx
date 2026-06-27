"use client"

import { apiFetch } from "@/lib/api-client"
import { useState } from "react"
import { useRouter } from "next/navigation"
import { createClient } from "@/lib/supabase/client"

// Phase 4 — client form for the public accept page.
//
// Sequence:
//   1. supabase.auth.signUp({ email, password })
//      With "Confirm email" ON globally this creates an UNCONFIRMED auth
//      user and returns NO session. The password lives only in the
//      browser; the server never sees it.
//   2. POST /api/invites/accept { token }
//      The route RPCs accept_invite_link which validates the token, looks
//      up the just-signed-up auth user by invite.email, runs all gates,
//      and on success links user_profiles + sets email_confirmed_at +
//      marks the invite accepted — all in one DB transaction.
//   3. supabase.auth.signInWithPassword({ email, password })
//      Now succeeds because step 2 confirmed the email. Lands a session
//      and we route to /dashboard.
//
// If step 2 fails after step 1 succeeded, we leave the auth user in place.
// It's unconfirmed and has no user_profiles, so it's harmless until the
// admin cleans it up via the Supabase dashboard. Documented in the plan.

export default function AcceptForm({
  token, email, companyName, role,
}: {
  token:       string
  email:       string
  companyName: string
  role:        "admin" | "member"
}) {
  const [fullName, setFullName] = useState("")
  const [password, setPassword] = useState("")
  const [confirm,  setConfirm]  = useState("")
  const [error,    setError]    = useState<string | null>(null)
  const [loading,  setLoading]  = useState(false)
  // Set when the account was created + signed in but the name write did not
  // confirm. We surface a loud retry rather than navigate away pretending the
  // name saved.
  const [nameUnsaved, setNameUnsaved] = useState(false)
  const router = useRouter()

  // Persist full_name with bounded retries. Returns true ONLY on a confirmed
  // write — HTTP ok AND updated >= 1. A 0-rows response (profile row not visible
  // yet), any non-ok status, or a network error returns false, so the caller can
  // never mistake a silent no-op for success. The backoff covers any lag between
  // the accept transaction committing the user_profiles row and this write seeing
  // it.
  async function saveFullName(name: string): Promise<boolean> {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await apiFetch("/api/profile", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ full_name: name }),
        })
        if (res.ok) {
          const d = await res.json().catch(() => ({}))
          if ((d.updated ?? 0) >= 1) return true
        }
      } catch { /* network error — fall through to retry */ }
      if (attempt < 3) await new Promise(r => setTimeout(r, 400 * (attempt + 1)))
    }
    return false
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!fullName.trim())      { setError("Full name is required"); return }
    if (password !== confirm)  { setError("Passwords don't match"); return }
    if (password.length < 8)   { setError("Password must be at least 8 characters"); return }

    setLoading(true)
    setError(null)

    const sb = createClient()

    const { error: signUpError } = await sb.auth.signUp({ email, password })
    if (signUpError) {
      setError(signUpError.message)
      setLoading(false)
      return
    }

    const res = await apiFetch("/api/invites/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      setError(data.error ?? "Could not accept invitation")
      setLoading(false)
      return
    }

    const { error: signInError } = await sb.auth.signInWithPassword({ email, password })
    if (signInError) {
      // Very narrow: accept set email_confirmed_at, signIn should work.
      // Bounce them to /login so they can sign in with the password they
      // just set rather than getting stuck on a half-loaded form.
      router.push("/login")
      return
    }

    // Persist the full name onto the just-created user_profiles row. Done here —
    // with a real session in hand — rather than inside the token/accept logic, so
    // that flow stays untouched. The accept route already committed the profile
    // row before returning above, so the write should match; saveFullName retries
    // to cover any lag and, on confirmed failure, we stop and show a loud retry
    // (handleRetryName) rather than land on the dashboard with the name lost.
    const saved = await saveFullName(fullName.trim())
    if (!saved) {
      setNameUnsaved(true)
      setLoading(false)
      return
    }

    router.push("/dashboard")
    router.refresh()
  }

  // Retry only the name write — the account already exists and is signed in, so
  // we must NOT re-run signUp/accept.
  async function handleRetryName() {
    setLoading(true)
    setNameUnsaved(false)
    const saved = await saveFullName(fullName.trim())
    setLoading(false)
    if (saved) {
      router.push("/dashboard")
      router.refresh()
    } else {
      setNameUnsaved(true)
    }
  }

  const inputCls = "w-full h-10 px-3 rounded-md border border-[#E2E8F0] bg-white text-[14px] text-[#0F172A] placeholder-[#64748B] focus:outline-none focus:ring-2 focus:ring-[#7B9BB5]/40 focus:border-[#7B9BB5]/60 transition-all"
  const labelCls = "block text-[12px] font-medium text-[#64748B] mb-1.5"

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className={labelCls}>Email</label>
        <input
          type="email" value={email} readOnly disabled
          className={`${inputCls} bg-[#F4F5F7] cursor-not-allowed`}
        />
      </div>
      <div className="flex items-center justify-between -mt-2">
        <span className="text-[12px] text-[#64748B]">Joining {companyName}</span>
        <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${role === "admin" ? "bg-[#7B9BB5]/15 text-[#456A88]" : "bg-[#F4F5F7] text-[#64748B]"}`}>
          {role}
        </span>
      </div>
      <div>
        <label className={labelCls}>Full name</label>
        <input
          type="text" value={fullName} onChange={e => setFullName(e.target.value)}
          required autoFocus maxLength={120} placeholder="e.g. Jane Smith"
          className={inputCls}
        />
      </div>
      <div>
        <label className={labelCls}>Password</label>
        <input
          type="password" value={password} onChange={e => setPassword(e.target.value)}
          required minLength={8} placeholder="Min. 8 characters"
          className={inputCls}
        />
      </div>
      <div>
        <label className={labelCls}>Confirm password</label>
        <input
          type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
          required minLength={8} placeholder="••••••••"
          className={inputCls}
        />
      </div>

      {error && <p className="text-[12px] text-red-500">{error}</p>}

      {nameUnsaved ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 space-y-2">
          <p className="text-[12px] text-amber-800">
            Your account is ready, but we couldn&apos;t save your name yet. Retry, or set it later
            in Settings → Profile.
          </p>
          <div className="flex gap-2">
            <button
              type="button" onClick={handleRetryName} disabled={loading}
              className="flex-1 h-9 bg-[#7B9BB5] text-white text-[13px] font-semibold rounded-md hover:bg-[#6A8AA4] transition-colors disabled:opacity-50"
            >
              {loading ? "Saving…" : "Retry saving name"}
            </button>
            <button
              type="button" onClick={() => { router.push("/dashboard"); router.refresh() }} disabled={loading}
              className="h-9 px-3 text-[13px] font-medium text-[#64748B] rounded-md border border-[#E2E8F0] hover:bg-[#F4F5F7] transition-colors disabled:opacity-50"
            >
              Continue
            </button>
          </div>
        </div>
      ) : (
        <button
          type="submit" disabled={loading}
          className="w-full h-10 bg-[#7B9BB5] text-white text-[14px] font-semibold rounded-md hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 mt-1"
        >
          {loading ? "Accepting…" : "Accept invitation"}
        </button>
      )}
    </form>
  )
}
