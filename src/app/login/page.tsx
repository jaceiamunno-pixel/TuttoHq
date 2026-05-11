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
    // Detect invite / password-reset token in URL hash
    const params = new URLSearchParams(window.location.hash.slice(1))
    const type         = params.get("type")
    const accessToken  = params.get("access_token")
    const refreshToken = params.get("refresh_token")

    if ((type === "invite" || type === "recovery") && accessToken && refreshToken) {
      // Establish the session from the hash so updateUser works
      createClient().auth.setSession({ access_token: accessToken, refresh_token: refreshToken })
      setMode("set-password")
      // Remove the tokens from the URL bar
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
      router.push("/")
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
      router.push("/")
      router.refresh()
    }
  }

  return (
    <div className="min-h-screen bg-[#f7f6f3] flex items-center justify-center">
      <div className="bg-white rounded-lg border border-[#e9e9e7] shadow-sm w-[340px] p-8">

        <div className="text-center mb-6">
          <p className="text-4xl mb-2 select-none">🗂️</p>
          <h1 className="text-[17px] font-semibold text-[#37352f]">Submittal Library</h1>
          <p className="text-[13px] text-[#acaba8] mt-0.5">THP Construction</p>
        </div>

        {mode === "signin" ? (
          <form onSubmit={handleSignIn} className="space-y-3">
            <div>
              <label className="block text-[12px] text-[#787774] mb-1">Email</label>
              <input
                type="email" value={email} onChange={e => setEmail(e.target.value)}
                required autoFocus placeholder="you@company.com"
                className="w-full h-9 px-3 rounded border border-[#e9e9e7] text-[14px] text-[#37352f] placeholder-[#acaba8] focus:outline-none focus:ring-1 focus:ring-[#37352f]/25 focus:border-[#37352f]/35 transition-all"
              />
            </div>
            <div>
              <label className="block text-[12px] text-[#787774] mb-1">Password</label>
              <input
                type="password" value={password} onChange={e => setPassword(e.target.value)}
                required placeholder="••••••••"
                className="w-full h-9 px-3 rounded border border-[#e9e9e7] text-[14px] text-[#37352f] placeholder-[#acaba8] focus:outline-none focus:ring-1 focus:ring-[#37352f]/25 focus:border-[#37352f]/35 transition-all"
              />
            </div>
            {error && <p className="text-[12px] text-red-500">{error}</p>}
            <button type="submit" disabled={loading}
              className="w-full h-9 bg-[#37352f] text-white text-[14px] font-medium rounded hover:bg-[#2f2d28] transition-colors disabled:opacity-50">
              {loading ? "Signing in…" : "Sign in"}
            </button>
          </form>
        ) : (
          <form onSubmit={handleSetPassword} className="space-y-3">
            <p className="text-[13px] text-[#787774] -mt-2 mb-1">Create a password for your account.</p>
            <div>
              <label className="block text-[12px] text-[#787774] mb-1">New password</label>
              <input
                type="password" value={password} onChange={e => setPassword(e.target.value)}
                required autoFocus minLength={8} placeholder="Min. 8 characters"
                className="w-full h-9 px-3 rounded border border-[#e9e9e7] text-[14px] text-[#37352f] placeholder-[#acaba8] focus:outline-none focus:ring-1 focus:ring-[#37352f]/25 focus:border-[#37352f]/35 transition-all"
              />
            </div>
            <div>
              <label className="block text-[12px] text-[#787774] mb-1">Confirm password</label>
              <input
                type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
                required minLength={8} placeholder="••••••••"
                className="w-full h-9 px-3 rounded border border-[#e9e9e7] text-[14px] text-[#37352f] placeholder-[#acaba8] focus:outline-none focus:ring-1 focus:ring-[#37352f]/25 focus:border-[#37352f]/35 transition-all"
              />
            </div>
            {error && <p className="text-[12px] text-red-500">{error}</p>}
            <button type="submit" disabled={loading}
              className="w-full h-9 bg-[#37352f] text-white text-[14px] font-medium rounded hover:bg-[#2f2d28] transition-colors disabled:opacity-50">
              {loading ? "Setting password…" : "Set password"}
            </button>
          </form>
        )}

      </div>
    </div>
  )
}
