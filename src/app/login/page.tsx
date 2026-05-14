"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { createClient } from "@/lib/supabase/client"

type Mode = "signin" | "set-password"

export default function LoginPage() {
  const [mode, setMode]         = useState<Mode>("signin")
  const [email, setEmail]       = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm]   = useState("")
  const [error, setError]       = useState<string | null>(null)
  const [loading, setLoading]   = useState(false)
  const router = useRouter()

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1))
    const type         = params.get("type")
    const accessToken  = params.get("access_token")
    const refreshToken = params.get("refresh_token")

    if ((type === "invite" || type === "recovery") && accessToken && refreshToken) {
      createClient().auth.setSession({ access_token: accessToken, refresh_token: refreshToken })
      setMode("set-password")
      window.history.replaceState(null, "", window.location.pathname)
    }
  }, [])

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    const { error } = await createClient().auth.signInWithPassword({ email, password })
    if (error) {
      setError(error.message)
      setLoading(false)
    } else {
      router.push("/dashboard")
      router.refresh()
    }
  }

  async function handleSetPassword(e: React.FormEvent) {
    e.preventDefault()
    if (password !== confirm) { setError("Passwords don't match"); return }
    setLoading(true)
    setError(null)
    const { error } = await createClient().auth.updateUser({ password })
    if (error) {
      setError(error.message)
      setLoading(false)
    } else {
      router.push("/dashboard")
      router.refresh()
    }
  }

  const inputCls = "w-full h-10 px-3 rounded-md border border-[#E2E8F0] bg-white text-[14px] text-[#0F172A] placeholder-[#64748B] focus:outline-none focus:ring-2 focus:ring-[#7B9BB5]/40 focus:border-[#7B9BB5]/60 transition-all"

  return (
    <div className="min-h-screen bg-[#F4F5F7] flex items-center justify-center">
      <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-[360px] p-8">

        <div className="text-center mb-7">
          <div className="w-12 h-12 rounded-xl bg-[#7B9BB5]/15 border border-[#7B9BB5]/30 flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <h1 className="text-[18px] font-bold text-[#0F172A] tracking-tight">TuttoHQ</h1>
          <p className="text-[13px] text-[#64748B] mt-1">Construction Document Management</p>
        </div>

        {mode === "signin" ? (
          <form onSubmit={handleSignIn} className="space-y-4">
            <div>
              <label className="block text-[12px] font-medium text-[#64748B] mb-1.5">Email</label>
              <input
                type="email" value={email} onChange={e => setEmail(e.target.value)}
                required autoFocus placeholder="you@company.com"
                className={inputCls}
              />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-[#64748B] mb-1.5">Password</label>
              <input
                type="password" value={password} onChange={e => setPassword(e.target.value)}
                required placeholder="••••••••"
                className={inputCls}
              />
            </div>
            {error && <p className="text-[12px] text-red-400">{error}</p>}
            <button type="submit" disabled={loading}
              className="w-full h-10 bg-[#7B9BB5] text-white text-[14px] font-semibold rounded-md hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 mt-1">
              {loading ? "Signing in…" : "Sign in"}
            </button>
          </form>
        ) : (
          <form onSubmit={handleSetPassword} className="space-y-4">
            <p className="text-[13px] text-[#64748B] -mt-2 mb-1">Create a password for your account.</p>
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
              {loading ? "Setting password…" : "Set password"}
            </button>
          </form>
        )}

      </div>
    </div>
  )
}
