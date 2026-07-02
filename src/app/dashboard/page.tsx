"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import AppChrome from "@/components/app-chrome"
import { createClient } from "@/lib/supabase/client"
import { useNavRegion } from "@/components/keyboard-nav"
import { useProjectFavorites, sortByFavorite } from "./_shared/use-project-favorites"
import { SkeletonGrid } from "@/components/skeleton"
import type { Project } from "./_shared/types"

// ── Landing dashboard (ADR-006 Phase 2) ─────────────────────────────────────
// Project-first home: a project GRID + picker, nothing else. Pick a project →
// its work modules open inside the project shell (/projects/[id]/...). This is
// intentionally thin — no activity feed, no attention list (out of scope).
export default function DashboardLanding() {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading]   = useState(true)
  const [query, setQuery]       = useState("")
  const [userEmail, setUserEmail] = useState<string | null>(null)

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

  return (
    <AppChrome>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-[1100px] mx-auto px-4 sm:px-6 py-8 sm:py-10">
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
            <SkeletonGrid count={6} lines={2} />
          ) : projects.length === 0 ? (
            <div className="bg-white rounded-xl border border-[#E2E8F0] px-6 py-12 text-center">
              <p className="text-[14px] font-semibold text-[#0F172A]">No projects yet</p>
              <p className="text-[13px] text-[#64748B] mt-1 mb-4">Create your first project to start tracking submittals, RFIs, and more.</p>
              <Link href="/settings?tab=projects" className="inline-flex items-center h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors">
                Add a project in Settings
              </Link>
            </div>
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
