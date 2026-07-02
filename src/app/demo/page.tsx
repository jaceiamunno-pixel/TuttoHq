"use client"

import { useEffect, useState } from "react"

// One-click demo entry. On mount we POST /api/demo, which provisions a throwaway
// demo user, joins them to the shared read-only demo company, and sets the auth
// cookie on the response. We then hard-navigate to /dashboard (the same
// post-login target normal login uses) so middleware re-reads the fresh cookie
// and the app boots authenticated — no form, no inputs.
export default function DemoPage() {
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch("/api/demo", { method: "POST" })
        if (!res.ok) throw new Error("bad status")
        if (cancelled) return
        window.location.href = "/dashboard"
      } catch {
        if (!cancelled) setError("We couldn't set up your demo. Please try again.")
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="min-h-screen bg-[#F4F5F7] flex items-center justify-center">
      <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-[360px] p-8 text-center">
        <div className="w-12 h-12 rounded-xl bg-[#7B9BB5]/15 border border-[#7B9BB5]/30 flex items-center justify-center mx-auto mb-4">
          <svg className="w-6 h-6 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        </div>
        <h1 className="text-[18px] font-bold text-[#0F172A] tracking-tight">TuttoHQ</h1>
        {error ? (
          <p className="text-[13px] text-red-500 mt-3">{error}</p>
        ) : (
          <p className="text-[13px] text-[#64748B] mt-2">Setting up your demo…</p>
        )}
      </div>
    </div>
  )
}
