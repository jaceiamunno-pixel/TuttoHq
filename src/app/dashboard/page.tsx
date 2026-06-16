"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import AppChrome from "@/components/app-chrome"
import type { Project } from "./_shared/types"

// ── Landing dashboard (ADR-006 Phase 2) ─────────────────────────────────────
// Project-first home: a project GRID + picker, nothing else. Pick a project →
// its work modules open inside the project shell (/projects/[id]/...). This is
// intentionally thin — no activity feed, no attention list (out of scope).
export default function DashboardLanding() {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading]   = useState(true)
  const [query, setQuery]       = useState("")

  useEffect(() => {
    // RLS-scoped server-side — only this company's projects come back.
    fetch("/api/projects")
      .then(r => r.json())
      .then(d => setProjects(d.projects ?? []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return projects
    return projects.filter(p => `${p.name} ${p.number ?? ""} ${p.location ?? ""} ${p.gc_name ?? ""}`.toLowerCase().includes(q))
  }, [projects, query])

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
            <p className="text-[13px] text-[#64748B]">Loading…</p>
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
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {filtered.map(p => (
                <Link
                  key={p.id}
                  href={`/projects/${p.id}/submittals`}
                  className="group bg-white rounded-xl border border-[#E2E8F0] p-4 hover:border-[#7B9BB5]/60 hover:shadow-sm transition-all"
                >
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="text-[14px] font-semibold text-[#0F172A] leading-snug group-hover:text-[#456A88] transition-colors">{p.name}</h2>
                    {p.number && <span className="text-[11px] font-medium text-[#64748B] bg-[#F4F5F7] border border-[#E2E8F0] rounded px-1.5 py-0.5 flex-shrink-0 whitespace-nowrap">{p.number}</span>}
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
              ))}
            </div>
          )}
        </div>
      </div>
    </AppChrome>
  )
}
