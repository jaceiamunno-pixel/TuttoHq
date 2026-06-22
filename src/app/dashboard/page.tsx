"use client"

import { useEffect, useMemo, useState } from "react"
import dynamic from "next/dynamic"
import Link from "next/link"
import AppChrome from "@/components/app-chrome"
import { createClient } from "@/lib/supabase/client"
import { useNavRegion } from "@/components/keyboard-nav"
import { useProjectFavorites, sortByFavorite } from "./_shared/use-project-favorites"
import { useSessionGate } from "@/lib/use-session-gate"
import { readLastProject, type LastProject } from "@/lib/last-project"
import type { Project } from "./_shared/types"

function CenteredNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 min-h-0 flex items-center justify-center px-6">
      <p className="text-[13px] text-[#64748B] text-center">{children}</p>
    </div>
  )
}

// The daily-report capture flow, loaded on demand. ssr:false keeps it out of the
// dashboard's initial bundle; its chunk is precached, so the dynamic import
// resolves from cache offline (ADR-009 Phase 1, Step 1.1 — offline daily entry).
const DailyModule = dynamic(() => import("./_modules/DailyModule"), {
  ssr: false,
  loading: () => <CenteredNote>Loading…</CenteredNote>,
})

// ── Landing dashboard (ADR-006 Phase 2) ─────────────────────────────────────
// Project-first home: a project GRID + picker, nothing else. Pick a project →
// its work modules open inside the project shell (/projects/[id]/...). This is
// intentionally thin — no activity feed, no attention list (out of scope).
//
// ADR-009 Step 1.1: this is ALSO the precached offline SHELL (start_url). On an
// offline cold launch the SW serves this document; it gates on the last-known
// session (client-side, offline-tolerant) and, when offline, surfaces a direct
// entry into the last-opened project's daily report — the grid itself is
// /api-driven and empty in a dead zone.
export default function DashboardLanding() {
  const gate = useSessionGate()
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading]   = useState(true)
  const [query, setQuery]       = useState("")
  const [userEmail, setUserEmail] = useState<string | null>(null)

  const [offline, setOffline]         = useState(false)
  const [lastProject, setLastProject] = useState<LastProject | null>(null)
  const [dailyOpen, setDailyOpen]     = useState(false)

  // Per-user project favorites — keyed by the signed-in user (see hook).
  const { favorites, toggleFavorite } = useProjectFavorites(userEmail)

  useEffect(() => {
    createClient().auth.getUser().then(({ data }) => setUserEmail(data.user?.email ?? null))
    // RLS-scoped server-side — only this company's projects come back.
    fetch("/api/projects")
      .then(r => r.json())
      .then(d => setProjects(d.projects ?? []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  // Offline awareness + the last-opened project (both client-only reads). The
  // last project is persisted by ProjectChrome whenever a project is opened
  // online; it's what makes the daily flow reachable with no network.
  useEffect(() => {
    setOffline(!navigator.onLine)
    setLastProject(readLastProject())
    const goOnline = () => setOffline(false)
    const goOffline = () => setOffline(true)
    window.addEventListener("online", goOnline)
    window.addEventListener("offline", goOffline)
    return () => {
      window.removeEventListener("online", goOnline)
      window.removeEventListener("offline", goOffline)
    }
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matched = q
      ? projects.filter(p => `${p.name} ${p.number ?? ""} ${p.location ?? ""} ${p.gc_name ?? ""}`.toLowerCase().includes(q))
      : projects
    // Favorited projects float to the top of the grid (per-user).
    return sortByFavorite(matched, favorites)
  }, [projects, query, favorites])

  // Keyboard-nav region: the project grid. Arrows move between cards; Enter/→
  // activates a card (the <Link>'s native navigation opens the project).
  // order 20 sits after the primary nav (order 10) for [ / ] left-to-right.
  const { regionProps: projectsGridProps } = useNavRegion<HTMLDivElement>({ id: "projects-grid", order: 20 })

  // ── Auth gate (offline-tolerant; see useSessionGate) ──────────────────────
  // Online auth is still enforced by middleware; this is the offline decision.
  if (gate === "checking") {
    return <AppChrome><CenteredNote>Loading…</CenteredNote></AppChrome>
  }
  if (gate === "offline-no-session") {
    return (
      <AppChrome>
        <div className="flex-1 min-h-0 flex items-center justify-center px-6">
          <div className="max-w-sm text-center">
            <p className="text-[14px] font-semibold text-[#0F172A]">You&rsquo;re offline and signed out</p>
            <p className="text-[13px] text-[#64748B] mt-1">Reconnect to sign in. Any daily reports you saved are still on this device and will sync once you&rsquo;re back online.</p>
          </div>
        </div>
      </AppChrome>
    )
  }

  // ── Offline daily-report capture (entered from the offline card below) ────
  // Renders DailyModule standalone (it is prop-only — no project-route context),
  // bypassing the server project layout, which can't run offline.
  if (offline && dailyOpen && lastProject) {
    return (
      <AppChrome>
        <div className="flex-shrink-0 flex items-center gap-2 px-4 py-2 border-b border-[#E2E8F0] bg-white">
          <button
            onClick={() => setDailyOpen(false)}
            className="text-[12px] font-medium text-[#7B9BB5] hover:text-[#456A88] transition-colors"
          >
            ← All projects
          </button>
          <span className="text-[12px] text-[#64748B] truncate">Offline · {lastProject.name}</span>
        </div>
        <DailyModule globalProjectId={lastProject.id} appProjects={[]} teamMembers={[]} />
      </AppChrome>
    )
  }

  return (
    <AppChrome>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-[1100px] mx-auto px-4 sm:px-6 py-8 sm:py-10">

          {/* Offline entry into the daily flow — the grid below can't load over
              the network in a dead zone, so this is the way in. */}
          {offline && (
            lastProject ? (
              <div className="mb-6 bg-[#0A1628] rounded-xl px-4 py-4 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold text-white">You&rsquo;re offline</p>
                  <p className="text-[12px] text-[#94A3B8] mt-0.5 truncate">Daily reports still work. Continue on {lastProject.name}.</p>
                </div>
                <button
                  onClick={() => setDailyOpen(true)}
                  className="flex-shrink-0 inline-flex items-center h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors"
                >
                  Open Daily Report
                </button>
              </div>
            ) : (
              <div className="mb-6 bg-[#0A1628] rounded-xl px-4 py-4">
                <p className="text-[13px] font-semibold text-white">You&rsquo;re offline</p>
                <p className="text-[12px] text-[#94A3B8] mt-0.5">Open a project once while online to enable its daily report offline.</p>
              </div>
            )
          )}

          <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-6">
            <div>
              <h1 className="text-[20px] sm:text-[22px] font-bold text-[#0F172A] tracking-tight">Projects</h1>
              <p className="text-[13px] text-[#64748B] mt-0.5">Pick a project to open its work modules.</p>
            </div>
            {projects.length > 0 && (
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search projects…"
                className="w-full sm:w-64 h-9 px-3 rounded-lg border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 placeholder:text-[#94A3B8]"
              />
            )}
          </div>

          {loading ? (
            <p className="text-[13px] text-[#64748B]">Loading…</p>
          ) : projects.length === 0 ? (
            offline ? (
              // Don't claim "No projects yet" in a dead zone — the grid simply
              // can't load. Point at the offline daily shortcut above.
              <p className="text-[13px] text-[#64748B]">Projects can&rsquo;t load while offline. {lastProject ? "Use the daily-report shortcut above." : "Reconnect to see your projects."}</p>
            ) : (
              <div className="bg-white rounded-xl border border-[#E2E8F0] px-6 py-12 text-center">
                <p className="text-[14px] font-semibold text-[#0F172A]">No projects yet</p>
                <p className="text-[13px] text-[#64748B] mt-1 mb-4">Create your first project to start tracking submittals, RFIs, and more.</p>
                <Link href="/settings?tab=projects" className="inline-flex items-center h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors">
                  Add a project in Settings
                </Link>
              </div>
            )
          ) : filtered.length === 0 ? (
            <p className="text-[13px] text-[#64748B]">No projects match “{query}”.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3" {...projectsGridProps}>
              {filtered.map(p => {
                const fav = favorites.has(p.id)
                return (
                <Link
                  key={p.id}
                  href={`/projects/${p.id}/submittals`}
                  data-nav-item
                  className="group bg-white rounded-xl border border-[#E2E8F0] p-4 hover:border-[#7B9BB5]/60 hover:shadow-sm transition-all outline-none focus-visible:ring-2 focus-visible:ring-[#7B9BB5]"
                >
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="text-[14px] font-semibold text-[#0F172A] leading-snug group-hover:text-[#456A88] transition-colors">{p.name}</h2>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {p.number && <span className="text-[11px] font-medium text-[#64748B] bg-[#F4F5F7] border border-[#E2E8F0] rounded px-1.5 py-0.5 whitespace-nowrap">{p.number}</span>}
                      <button
                        type="button"
                        onClick={e => { e.preventDefault(); e.stopPropagation(); toggleFavorite(p.id) }}
                        title={fav ? "Unfavorite" : "Favorite"}
                        aria-label={fav ? "Unfavorite project" : "Favorite project"}
                        className={`transition-colors ${fav ? "text-amber-400" : "text-[#CBD5E1] hover:text-[#94A3B8]"}`}
                      >
                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill={fav ? "currentColor" : "none"} stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.5l2.3 4.66 5.14.75-3.72 3.62.88 5.12-4.6-2.42-4.6 2.42.88-5.12L4.04 8.9l5.14-.75 2.3-4.65z" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  <div className="mt-2 space-y-1">
                    {p.location && <p className="text-[12px] text-[#64748B] truncate">📍 {p.location}</p>}
                    {p.gc_name && <p className="text-[12px] text-[#64748B] truncate">GC: {p.gc_name}</p>}
                  </div>
                  <div className="mt-3 text-[12px] font-semibold text-[#7B9BB5] flex items-center gap-1">
                    Open project
                    <svg className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                  </div>
                </Link>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </AppChrome>
  )
}
