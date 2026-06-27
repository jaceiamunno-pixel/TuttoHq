"use client"

import { apiFetch } from "@/lib/api-client"
import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { createClient } from "@/lib/supabase/client"

export default function SignupPage() {
  const [fullName, setFullName]       = useState("")
  const [companyName, setCompanyName] = useState("")
  const [email, setEmail]             = useState("")
  const [password, setPassword]       = useState("")
  const [confirm, setConfirm]         = useState("")
  const [error, setError]             = useState<string | null>(null)
  const [loading, setLoading]         = useState(false)
  const router = useRouter()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (password !== confirm) { setError("Passwords don't match"); return }
    if (password.length < 8)  { setError("Password must be at least 8 characters"); return }

    setLoading(true)
    setError(null)

    try {
      const res = await apiFetch("/api/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullName, companyName, email, password }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Signup failed")

      const { error: signInError } = await createClient().auth.signInWithPassword({ email, password })
      if (signInError) throw new Error(signInError.message)

      router.push("/dashboard")
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Signup failed")
      setLoading(false)
    }
  }

  const inputCls = "w-full h-10 px-3 rounded-md border border-[#E2E8F0] bg-white text-[14px] text-[#0F172A] placeholder-[#64748B] focus:outline-none focus:ring-2 focus:ring-[#7B9BB5]/40 focus:border-[#7B9BB5]/60 transition-all"
  const labelCls = "block text-[12px] font-medium text-[#64748B] mb-1.5"

  return (
    <div className="min-h-screen bg-[#F4F5F7] flex items-center justify-center py-10">
      <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-[400px] p-8">

        <div className="text-center mb-7">
          <div className="w-12 h-12 rounded-xl bg-[#7B9BB5]/15 border border-[#7B9BB5]/30 flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <h1 className="text-[18px] font-bold text-[#0F172A] tracking-tight">Create your account</h1>
          <p className="text-[13px] text-[#64748B] mt-1">TuttoHQ — Construction Document Management</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className={labelCls}>Full Name</label>
            <input
              type="text" value={fullName} onChange={e => setFullName(e.target.value)}
              required autoFocus placeholder="Jane Smith"
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls}>Company Name</label>
            <input
              type="text" value={companyName} onChange={e => setCompanyName(e.target.value)}
              required placeholder="Acme Construction"
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls}>Email</label>
            <input
              type="email" value={email} onChange={e => setEmail(e.target.value)}
              required placeholder="you@company.com"
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
            <label className={labelCls}>Confirm Password</label>
            <input
              type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
              required minLength={8} placeholder="••••••••"
              className={inputCls}
            />
          </div>

          {error && <p className="text-[12px] text-red-400">{error}</p>}

          <button
            type="submit" disabled={loading}
            className="w-full h-10 bg-[#7B9BB5] text-white text-[14px] font-semibold rounded-md hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 mt-1"
          >
            {loading ? "Creating account…" : "Create account"}
          </button>
        </form>

        <p className="text-center text-[12px] text-[#64748B] mt-5">
          Already have an account?{" "}
          <Link href="/login" className="text-[#7B9BB5] hover:text-[#6A8AA4] font-medium transition-colors">
            Back to login
          </Link>
        </p>

      </div>
    </div>
  )
}
