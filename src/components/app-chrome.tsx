"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { createClient } from "@/lib/supabase/client"
import { useNavRegion } from "@/components/keyboard-nav"

// Top-level (company-scoped) chrome for the root resources that live OUTSIDE a
// project: the landing project grid, Library, Directories, Settings. Mirrors
// the in-project chrome's navy header but carries no work-module nav.
const NAV = [
  { href: "/dashboard",   label: "Projects" },
  { href: "/library",     label: "Library" },
  { href: "/directories", label: "Directories" },
  { href: "/manpower",    label: "Manpower" },
  { href: "/settings",    label: "Settings" },
]

export default function AppChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const [userEmail, setUserEmail]     = useState<string | null>(null)
  const [logoUrl, setLogoUrl]         = useState<string | null>(null)
  const [displayName, setDisplayName] = useState<string | null>(null)
  const [mobileOpen, setMobileOpen]   = useState(false)

  // Keyboard-nav region: the top-level primary nav. Arrows move between the
  // destinations; Enter/→ navigates. order 10 — the first region for [ / ],
  // ahead of any content list (e.g. the dashboard project grid, order 20).
  const { regionProps: primaryNavProps } = useNavRegion({ id: "primary-nav", order: 10 })

  useEffect(() => {
    createClient().auth.getUser().then(({ data }) => setUserEmail(data.user?.email ?? null))
    fetch("/api/settings").then(r => r.json()).then(d => { if (d.logo_url) setLogoUrl(d.logo_url); if (d.display_name) setDisplayName(d.display_name) }).catch(() => {})
  }, [])

  async function signOut() {
    await createClient().auth.signOut()
    window.location.href = "/login"
  }

  const brand = displayName
    ? <span className="text-[15px] font-bold text-white tracking-tight truncate max-w-[180px]" title={displayName}>{displayName}</span>
    : logoUrl
      ? <img src={logoUrl} alt="Logo" className="h-7 max-w-[130px] object-contain" />
      : <span className="text-[15px] font-bold text-white tracking-tight">TuttoHQ</span>

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`)

  return (
    <div className="flex flex-col bg-[#F4F5F7] w-full overflow-hidden" style={{ height: "100dvh" }}>
      <header className="flex flex-shrink-0 items-center gap-2 h-14 bg-[#0A1628] border-b border-white/10 px-3 relative">
        <Link href="/dashboard" className="flex items-center gap-2.5 pr-3 sm:mr-1 sm:border-r border-white/10 h-8 flex-shrink-0">
          {brand}
        </Link>

        <nav className="hidden sm:flex items-center gap-0.5 flex-1" {...primaryNavProps}>
          {NAV.map(n => (
            <Link
              key={n.href}
              href={n.href}
              data-nav-item
              className={`h-9 px-3 flex items-center rounded-lg text-[13px] font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[#7B9BB5] ${isActive(n.href) ? "bg-white/[0.12] text-white" : "text-[#94A3B8] hover:text-white hover:bg-white/[0.06]"}`}
            >
              {n.label}
            </Link>
          ))}
        </nav>

        <div className="hidden sm:flex items-center gap-3 flex-shrink-0">
          <span className="text-[11px] text-[#64748B] truncate max-w-[180px]">{userEmail}</span>
          <button onClick={signOut} className="text-[11px] text-[#94A3B8] hover:text-white transition-colors">Sign out</button>
        </div>

        {/* mobile */}
        <div className="flex-1 sm:hidden" />
        <button
          onClick={() => setMobileOpen(o => !o)}
          className="sm:hidden text-[#94A3B8] hover:text-white transition-colors p-1 flex-shrink-0"
          aria-label="Open navigation menu"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={mobileOpen ? "M6 18L18 6M6 6l12 12" : "M4 6h16M4 12h16M4 18h16"} />
          </svg>
        </button>
        {mobileOpen && (
          <div className="absolute top-full left-0 right-0 bg-[#0A1628] border-b border-white/10 z-50 shadow-lg sm:hidden">
            {NAV.map(n => (
              <Link
                key={n.href}
                href={n.href}
                onClick={() => setMobileOpen(false)}
                className={`w-full text-left px-4 py-3 text-[13px] font-medium border-l-2 transition-colors flex items-center gap-2.5 ${isActive(n.href) ? "border-white text-white bg-white/[0.06]" : "border-transparent text-[#94A3B8] hover:text-white hover:bg-white/[0.04]"}`}
              >
                {n.label}
              </Link>
            ))}
            <div className="flex items-center justify-between px-4 py-3 border-t border-white/10">
              <span className="text-[11px] text-[#64748B] truncate min-w-0">{userEmail}</span>
              <button onClick={signOut} className="text-[11px] text-[#94A3B8] hover:text-white transition-colors flex-shrink-0 ml-2">Sign out</button>
            </div>
          </div>
        )}
      </header>

      <main className="flex-1 min-h-0 min-w-0 flex flex-col bg-[#F4F5F7]">
        {children}
      </main>
    </div>
  )
}
