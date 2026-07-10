"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { createClient } from "@/lib/supabase/client"
import { clearRecoveryMarker } from "../recovery-marker"

/**
 * The password form for /auth/reset-password. The recovery session is already
 * live (the server component gated on it), so updateUser writes against it.
 *
 * On success we sign out GLOBALLY — invalidating the recovery session AND every
 * other refresh token for this user — then send them to /login to sign in fresh
 * with the new password. That closes the recovery session the moment it has
 * served its one purpose, so a copied link or a left-open tab can't be reused to
 * stay signed in.
 */
export default function ResetPasswordForm() {
  const [password, setPassword] = useState("")
  const [confirm, setConfirm]   = useState("")
  const [error, setError]       = useState<string | null>(null)
  const [loading, setLoading]   = useState(false)
  const router = useRouter()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (password !== confirm) {
      setError("Passwords don't match")
      return
    }
    setLoading(true)
    setError(null)

    const supabase = createClient()
    const { error: updateError } = await supabase.auth.updateUser({ password })

    // Clear the recovery marker unconditionally — success OR failure — the
    // moment the single password attempt is made. It authorizes nothing on its
    // own, but it must not linger to be replayed.
    clearRecoveryMarker()

    if (updateError) {
      setError(updateError.message)
      setLoading(false)
      return
    }

    // Password changed — burn the recovery session and all others, then force a
    // fresh sign-in with the new credentials.
    await supabase.auth.signOut({ scope: "global" })
    router.replace("/login")
    router.refresh()
  }

  const inputCls =
    "w-full h-10 px-3 rounded-md border border-[#E2E8F0] bg-white text-[14px] text-[#0F172A] placeholder-[#64748B] focus:outline-none focus:ring-2 focus:ring-[#7B9BB5]/40 focus:border-[#7B9BB5]/60 transition-all"

  return (
    <div className="min-h-screen bg-[#F4F5F7] flex items-center justify-center">
      <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-[360px] p-8">
        <div className="text-center mb-7">
          <div className="w-12 h-12 rounded-xl bg-[#7B9BB5]/15 border border-[#7B9BB5]/30 flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          </div>
          <h1 className="text-[18px] font-bold text-[#0F172A] tracking-tight">Choose a new password</h1>
          <p className="text-[13px] text-[#64748B] mt-1">Enter it twice to confirm.</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-[12px] font-medium text-[#64748B] mb-1.5">New password</label>
            <input
              type="password" value={password} onChange={e => setPassword(e.target.value)}
              required autoFocus minLength={8} placeholder="Min. 8 characters"
              className={inputCls}
            />
          </div>
          <div>
            <label className="block text-[12px] font-medium text-[#64748B] mb-1.5">Confirm password</label>
            <input
              type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
              required minLength={8} placeholder="••••••••"
              className={inputCls}
            />
          </div>
          {error && <p className="text-[12px] text-red-400">{error}</p>}
          <button type="submit" disabled={loading}
            className="w-full h-10 bg-[#7B9BB5] text-white text-[14px] font-semibold rounded-md hover:bg-[#6A8AA4] transition-colors disabled:opacity-50">
            {loading ? "Updating…" : "Update password"}
          </button>
        </form>
      </div>
    </div>
  )
}
