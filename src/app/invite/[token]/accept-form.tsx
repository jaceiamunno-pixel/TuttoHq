"use client"

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
  const [password, setPassword] = useState("")
  const [confirm,  setConfirm]  = useState("")
  const [error,    setError]    = useState<string | null>(null)
  const [loading,  setLoading]  = useState(false)
  const router = useRouter()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
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

    const res = await fetch("/api/invites/accept", {
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

    router.push("/dashboard")
    router.refresh()
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
        <label className={labelCls}>Password</label>
        <input
          type="password" value={password} onChange={e => setPassword(e.target.value)}
          required autoFocus minLength={8} placeholder="Min. 8 characters"
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

      <button
        type="submit" disabled={loading}
        className="w-full h-10 bg-[#7B9BB5] text-white text-[14px] font-semibold rounded-md hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 mt-1"
      >
        {loading ? "Accepting…" : "Accept invitation"}
      </button>
    </form>
  )
}
