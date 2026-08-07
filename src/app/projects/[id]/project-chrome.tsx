"use client"

import { createContext, useContext, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter, useSelectedLayoutSegment } from "next/navigation"
import { createClient } from "@/lib/supabase/client"
import type { Project, TeamMember } from "@/app/dashboard/_shared/types"
import { isFeatureEnabled, type FeatureKey } from "@/lib/features"
import type { FieldModule } from "@/lib/field-access-shared"
import { useProjectFavorites, sortByFavorite } from "@/app/dashboard/_shared/use-project-favorites"

// The project verified by the server-side route guard (layout.tsx). Only the
// fields the chrome needs to display.
export interface ShellProject {
  id: string
  name: string
  number: string | null
  location: string | null
  gc_name: string | null
  architect: string | null
}

type SubmittalsView = "log" | "pending" | "packages"

// Shared context the project routes read. This carries the resolved
// active-project id + the company-scoped support data (projects, team, user)
// that the existing modules expect as props — unchanged from the old shell,
// just provided through context instead of being passed by setActiveModule.
interface ProjectShellValue {
  projectId: string
  project: ShellProject
  appProjects: Project[]
  teamMembers: TeamMember[]
  userEmail: string | null
  submittalsView: SubmittalsView
  setSubmittalsView: (v: SubmittalsView) => void
  closeoutPct: number | null
  setCloseoutPct: (n: number | null) => void
  // Modules call onNavigate with a module id; we map it to a project route.
  navigateModule: (m: string) => void
  // ADR-020: null for admin/member/demo. For field users, the granted modules
  // on THIS project (module → can_edit). Resolved server-side in layout.tsx.
  fieldModules: Partial<Record<FieldModule, boolean>> | null
}

const ProjectShellContext = createContext<ProjectShellValue | null>(null)

export function useProjectShell(): ProjectShellValue {
  const v = useContext(ProjectShellContext)
  if (!v) throw new Error("useProjectShell must be used inside a /projects/[id] route")
  return v
}

// In-project work-module nav. `slug` is the route segment under /projects/[id].
// Purchase Orders replaces Commitments (reads commitments WHERE
// type='purchase_order') — wired here as a project module per ADR-006.
const PROJECT_NAV: { slug: string; label: string; icon: React.ReactNode; feature?: FeatureKey }[] = [
  { slug: "submittals",      label: "Submittal Log", icon: <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg> },
  { slug: "rfis",            label: "RFIs",          icon: <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg> },
  { slug: "change-orders",   label: "Change Orders", icon: <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z" /></svg> },
  { slug: "sub-change-orders", label: "Subcontractor CO", icon: <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 14l6-6m-5.5.5h.01m4.99 5h.01M14 21H7a2 2 0 01-2-2V5a2 2 0 012-2h10a2 2 0 012 2v9m-4 4h6m-3-3v6" /></svg> },
  { slug: "purchase-orders", label: "Purchase Orders", icon: <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg> },
  { slug: "commitments",     label: "Commitments",   icon: <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg> },
  { slug: "punch",           label: "Punch List",    feature: "punchList", icon:<svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg> },
  { slug: "daily",           label: "Daily Reports", icon: <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg> },
  { slug: "manpower",        label: "Manpower",      icon: <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-1.13a4 4 0 10-4 0M19 8a3 3 0 11-6 0 3 3 0 016 0z" /></svg> },
  { slug: "schedule",        label: "Schedule",      icon: <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17V9m4 8v-5m4 5v-3M5 21h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg> },
  { slug: "drawings",        label: "Drawing Log",   icon: <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" /></svg> },
  // hidden 2026-08-07, re-enable when takeoff matures. Route + module stay
  // intact and reachable by direct URL (/projects/[id]/takeoff).
  // { slug: "takeoff",         label: "Takeoff",       icon: <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 9h16M4 14h16M9 4v16M14 4v16" /></svg> },
  { slug: "rfq",             label: "Bid Requests",  icon: <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg> },
  { slug: "estimate",        label: "Estimate",      icon: <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 7h6M9 11h.01M12 11h.01M15 11h.01M9 15h.01M12 15h.01M15 15h.01M5 21h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg> },
  { slug: "closeout",        label: "Closeout",      icon: <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z" /></svg> },
]

// Nav entries gated behind a disabled feature flag are hidden (reversible —
// flip the flag in @/lib/features to bring them back). The route, module, and
// data all stay intact regardless.
const VISIBLE_PROJECT_NAV = PROJECT_NAV.filter(m => !m.feature || isFeatureEnabled(m.feature))

// Cross-project Library, surfaced inside the Documents group (2026-08-07 nav
// regroup). It is an href destination, not a project module — never active in
// this shell, and hidden for field users like every company-level link.
const LIBRARY_NAV = {
  slug: "library",
  label: "Library",
  icon: <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /></svg>,
}

// Grouped rail (2026-08-07): the desktop left nav renders in three collapsible
// groups. Groups reference slugs only — feature flags and the field-user
// filter act on the flat list first, and a group shows whatever survives
// (empty groups disappear). Slugs not claimed by any group render flat below
// the groups so a future nav entry can never silently vanish.
const NAV_GROUPS: { id: string; label: string; slugs: string[] }[] = [
  { id: "field",     label: "Field",     slugs: ["daily", "manpower", "schedule", "punch"] },
  { id: "documents", label: "Documents", slugs: ["submittals", "library", "drawings", "rfis", "closeout"] },
  { id: "money",     label: "Money",     slugs: ["estimate", "rfq", "commitments", "change-orders", "sub-change-orders", "purchase-orders"] },
]

// Per-user collapse state (mirrors use-project-favorites' storage pattern).
function navCollapseKey(userEmail: string) {
  return `tuttohq:project-nav-collapsed:${userEmail}`
}

// Per-user icon-only ("mini") rail preference. Deliberately a separate key from
// navCollapseKey — mini is a rail-width mode, group collapse is a within-rail
// preference, and toggling one must never disturb the other.
function navMiniKey(userEmail: string) {
  return `tuttohq:project-nav-mini:${userEmail}`
}

// One rendered rail entry. Same shape PROJECT_NAV and LIBRARY_NAV already have —
// named here so the expanded and mini renderers can share it.
type NavEntry = { slug: string; label: string; icon: React.ReactNode }

// ADR-020: route slug → grantable module key for field-user nav filtering.
// Slugs absent here can never appear in a field user's nav.
const FIELD_SLUG_MODULE: Record<string, FieldModule> = {
  daily:    "daily_reports",
  drawings: "drawings",
  schedule: "schedule",
  rfis:     "rfis",
}

// Module ids passed by the existing modules' onNavigate callbacks → route slug.
const MODULE_SLUG: Record<string, string> = {
  submittals:      "submittals",
  rfis:            "rfis",
  changeorders:    "change-orders",
  purchaseorders:  "purchase-orders",
  commitments:     "commitments",
  punch:           "punch",
  daily:           "daily",
  drawings:        "drawings",
  closeout:        "closeout",
  rfq:             "rfq",
}

// Company-scoped destinations, pinned to the bottom of the rail (tertiary).
// "All projects" is reached via the brand link / the switcher's own item.
// Manpower is NOT here: inside a project it's a project-scoped work module (the
// crew schedule, in PROJECT_NAV above). The company-wide Workers roster keeps its
// home in the top-level chrome (AppChrome), reached via "All projects".
// Library moved into the Documents nav group (2026-08-07) — see LIBRARY_NAV.
// Icons are used by the mini rail only — the expanded rail keeps these as
// label-only text links, exactly as before.
const BOTTOM_LINKS = [
  { href: "/directories", label: "Directories", icon: <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" /></svg> },
  { href: "/settings",    label: "Settings",    icon: <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg> },
]

function ProjectSwitcher({ projects, currentId, onPick, favorites, onToggleFavorite }: {
  projects: Project[]
  currentId: string
  onPick: (id: string) => void
  favorites: Set<string>
  onToggleFavorite: (id: string) => void
}) {
  const [open, setOpen]     = useState(false)
  const [search, setSearch] = useState("")
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [])

  const selected = projects.find(p => p.id === currentId)
  const label = selected ? `${selected.name}${selected.number ? ` — ${selected.number}` : ""}` : "Select project"
  const q = search.trim().toLowerCase()
  const matched = q ? projects.filter(p => `${p.name} ${p.number ?? ""}`.toLowerCase().includes(q)) : projects
  // Favorited projects float to the top (per-user). Stable sort keeps server order within each group.
  const matches = sortByFavorite(matched, favorites)

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => { setOpen(o => !o); setSearch("") }}
        className="w-full h-9 px-2.5 rounded-lg bg-white/[0.06] border border-white/10 text-[12px] text-white flex items-center justify-between gap-1 hover:bg-white/[0.10] transition-colors"
      >
        <span className="truncate font-medium">{label}</span>
        <svg className={`w-3.5 h-3.5 flex-shrink-0 text-[#64748B] transition-transform ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 z-50 bg-[#1a2840] border border-white/10 rounded-lg shadow-xl overflow-hidden">
          {projects.length >= 10 && (
            <div className="p-2 border-b border-white/10">
              <input
                autoFocus
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search projects…"
                className="w-full h-7 px-2 rounded-md bg-white/[0.06] border border-white/10 text-[12px] text-white placeholder:text-[#64748B] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40"
              />
            </div>
          )}
          <div className="max-h-[60vh] overflow-y-auto">
            <Link
              href="/dashboard"
              onClick={() => setOpen(false)}
              className="block px-3 py-2 text-[12px] text-[#94A3B8] hover:bg-white/[0.06] hover:text-white transition-colors border-b border-white/5"
            >
              ← All projects
            </Link>
            {matches.map(p => {
              const fav = favorites.has(p.id)
              return (
              <div key={p.id} className="flex items-center group/proj">
                <button
                  onClick={() => { onPick(p.id); setOpen(false); setSearch("") }}
                  className={`flex-1 min-w-0 text-left px-3 py-2 text-[12px] truncate transition-colors ${p.id === currentId ? "bg-[#7B9BB5]/20 text-white" : "text-[#94A3B8] hover:bg-white/[0.06] hover:text-white"}`}
                >
                  {p.name}{p.number ? ` — ${p.number}` : ""}
                </button>
                <button
                  type="button"
                  onClick={e => { e.stopPropagation(); onToggleFavorite(p.id) }}
                  title={fav ? "Unfavorite" : "Favorite"}
                  aria-label={fav ? "Unfavorite project" : "Favorite project"}
                  className={`flex-shrink-0 px-2 py-2 transition-colors ${fav ? "text-amber-400" : "text-[#475569] hover:text-[#94A3B8] opacity-0 group-hover/proj:opacity-100"}`}
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill={fav ? "currentColor" : "none"} stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.5l2.3 4.66 5.14.75-3.72 3.62.88 5.12-4.6-2.42-4.6 2.42.88-5.12L4.04 8.9l5.14-.75 2.3-4.65z" />
                  </svg>
                </button>
              </div>
              )
            })}
            {matches.length === 0 && <p className="px-3 py-3 text-[12px] text-[#64748B]">No projects match.</p>}
          </div>
        </div>
      )}
    </div>
  )
}

export default function ProjectChrome({ project, fieldModules, children }: {
  project: ShellProject
  fieldModules: Partial<Record<FieldModule, boolean>> | null
  children: React.ReactNode
}) {
  const router  = useRouter()
  const segment = useSelectedLayoutSegment() // active module slug, e.g. "submittals"
  const isField = fieldModules !== null

  // Field users see only their granted modules; everyone else sees the full
  // (feature-filtered) rail. Server-side guards enforce the same set — this is
  // presentation, not the boundary.
  const navEntries = isField
    ? VISIBLE_PROJECT_NAV.filter(m => {
        const key = FIELD_SLUG_MODULE[m.slug]
        return key !== undefined && fieldModules[key] !== undefined
      })
    : VISIBLE_PROJECT_NAV

  const [appProjects, setAppProjects]   = useState<Project[]>([])
  const [teamMembers, setTeamMembers]   = useState<TeamMember[]>([])
  const [userEmail, setUserEmail]       = useState<string | null>(null)
  const [logoUrl, setLogoUrl]           = useState<string | null>(null)
  const [displayName, setDisplayName]   = useState<string | null>(null)
  const [submittalsView, setSubmittalsView] = useState<SubmittalsView>("log")
  const [closeoutPct, setCloseoutPct]   = useState<number | null>(null)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  // Per-user project favorites (localStorage, keyed by the signed-in user).
  const { favorites, toggleFavorite } = useProjectFavorites(userEmail)

  // Grouped-rail collapse state (per user, localStorage). Hydration runs when
  // the signed-in user is known and force-expands the group holding the
  // active module — the stored preference for the other groups is untouched.
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})
  useEffect(() => {
    if (typeof window === "undefined" || !userEmail) return
    let stored: Record<string, boolean> = {}
    try {
      const raw = window.localStorage.getItem(navCollapseKey(userEmail))
      if (raw) stored = JSON.parse(raw) as Record<string, boolean>
    } catch { /* ignore */ }
    const active = NAV_GROUPS.find(g => g.slugs.includes(segment ?? ""))
    if (active) stored = { ...stored, [active.id]: false }
    setCollapsedGroups(stored)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userEmail])

  // Navigating into a collapsed group's module auto-expands that group. Not
  // persisted — a view default, so a deliberately collapsed group stays
  // collapsed on the next load unless the user lands inside it again.
  useEffect(() => {
    const active = NAV_GROUPS.find(g => g.slugs.includes(segment ?? ""))
    if (active) setCollapsedGroups(prev => prev[active.id] ? { ...prev, [active.id]: false } : prev)
  }, [segment])

  // Icon-only rail (per user, localStorage). Same hydrate-when-email-arrives
  // pattern as the group-collapse state, but a separate key and a separate
  // setter — collapsing to mini and back leaves collapsedGroups untouched.
  const [navMini, setNavMini] = useState(false)
  useEffect(() => {
    if (typeof window === "undefined" || !userEmail) return
    try { setNavMini(window.localStorage.getItem(navMiniKey(userEmail)) === "1") } catch { /* ignore */ }
  }, [userEmail])

  function toggleNavMini() {
    setNavMini(prev => {
      const next = !prev
      if (userEmail) {
        try { window.localStorage.setItem(navMiniKey(userEmail), next ? "1" : "0") } catch { /* ignore quota */ }
      }
      return next
    })
  }

  function toggleGroup(id: string) {
    setCollapsedGroups(prev => {
      const next = { ...prev, [id]: !prev[id] }
      if (userEmail) {
        try { window.localStorage.setItem(navCollapseKey(userEmail), JSON.stringify(next)) } catch { /* ignore quota */ }
      }
      return next
    })
  }

  // Company-scoped support data the modules expect — same fetches the old shell
  // made (all RLS-scoped server-side). Unchanged call paths.
  useEffect(() => {
    createClient().auth.getUser().then(({ data }) => setUserEmail(data.user?.email ?? null))
    fetch("/api/settings").then(r => r.json()).then(d => { if (d.logo_url) setLogoUrl(d.logo_url); if (d.display_name) setDisplayName(d.display_name) }).catch(() => {})
    fetch("/api/projects").then(r => r.json()).then(d => setAppProjects(d.projects ?? [])).catch(() => {})
    fetch("/api/team").then(r => r.json()).then(d => setTeamMembers(d.members ?? [])).catch(() => {})
  }, [])

  function navigateModule(m: string) {
    if (m === "library") { router.push("/library"); return }
    const slug = MODULE_SLUG[m]
    if (slug) router.push(`/projects/${project.id}/${slug}`)
  }

  function switchProject(id: string) {
    // Keep the user on the same module when switching projects.
    router.push(`/projects/${id}/${segment ?? "submittals"}`)
  }

  async function signOut() {
    await createClient().auth.signOut()
    window.location.href = "/login"
  }

  const value: ProjectShellValue = {
    projectId: project.id,
    project,
    appProjects,
    teamMembers,
    userEmail,
    submittalsView,
    setSubmittalsView,
    closeoutPct,
    setCloseoutPct,
    navigateModule,
    fieldModules,
  }

  const brand = displayName
    ? <span className="text-[15px] font-bold text-white tracking-tight truncate max-w-[170px]" title={displayName}>{displayName}</span>
    : logoUrl
      ? <img src={logoUrl} alt="Logo" className="h-7 max-w-[130px] object-contain" />
      : <span className="text-[15px] font-bold text-white tracking-tight">TuttoHQ</span>

  // One rail entry — style identical to the pre-group flat rail. Library is
  // the lone href destination; module slugs link into this project.
  function railEntry(m: NavEntry) {
    return (
      <Link
        key={m.slug}
        href={m.slug === "library" ? "/library" : `/projects/${project.id}/${m.slug}`}
        className={`flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] font-medium transition-colors ${segment === m.slug ? "bg-white/[0.12] text-white" : "text-[#94A3B8] hover:text-white hover:bg-white/[0.06]"}`}
      >
        {m.icon}
        <span className="flex-1 truncate">{m.label}</span>
        {closeoutBadge(m.slug)}
      </Link>
    )
  }

  function closeoutBadge(slug: string) {
    if (slug !== "closeout" || closeoutPct === null) return null
    return (
      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0 ${closeoutPct === 100 ? "bg-emerald-500/20 text-emerald-400" : closeoutPct >= 50 ? "bg-amber-500/20 text-amber-400" : "bg-red-500/20 text-red-400"}`}>{closeoutPct}%</span>
    )
  }

  // Mini-rail entry — same href + active treatment as railEntry, icon only.
  // The label moves into the tooltip; the closeout badge shrinks to a dot.
  function miniRailEntry(m: NavEntry) {
    return (
      <Link
        key={m.slug}
        href={m.slug === "library" ? "/library" : `/projects/${project.id}/${m.slug}`}
        title={m.label}
        aria-label={m.label}
        className={`relative flex items-center justify-center w-10 h-10 rounded-lg transition-colors ${segment === m.slug ? "bg-white/[0.12] text-white" : "text-[#94A3B8] hover:text-white hover:bg-white/[0.06]"}`}
      >
        {m.icon}
        {closeoutDot(m.slug)}
      </Link>
    )
  }

  function closeoutDot(slug: string) {
    if (slug !== "closeout" || closeoutPct === null) return null
    return (
      <span
        title={`Closeout ${closeoutPct}%`}
        className={`absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full ${closeoutPct === 100 ? "bg-emerald-400" : closeoutPct >= 50 ? "bg-amber-400" : "bg-red-400"}`}
      />
    )
  }

  // Rail entries in render order. The groups are resolved once here so the
  // mini rail can flatten the exact same (feature- and field-filtered) set —
  // group headers are an expanded-state affordance only.
  const railGroups = NAV_GROUPS
    .map(g => ({
      ...g,
      entries: g.slugs
        .map(s => s === "library"
          ? (isField ? undefined : LIBRARY_NAV)
          : navEntries.find(m => m.slug === s))
        .filter((m): m is NavEntry => !!m),
    }))
    .filter(g => g.entries.length > 0)
  // Safety net: entries no group claims (future additions) render flat below
  // the groups instead of silently vanishing.
  const ungroupedEntries = navEntries.filter(m => !NAV_GROUPS.some(g => g.slugs.includes(m.slug)))
  const flatEntries = [...railGroups.flatMap(g => g.entries), ...ungroupedEntries]

  const navToggle = (
    <button
      type="button"
      onClick={toggleNavMini}
      aria-expanded={!navMini}
      aria-label={navMini ? "Expand navigation" : "Collapse navigation"}
      title={navMini ? "Expand navigation" : "Collapse navigation"}
      className="flex-shrink-0 flex items-center justify-center w-7 h-7 rounded-lg text-[#64748B] hover:text-white hover:bg-white/[0.06] transition-colors"
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={navMini ? "M13 5l7 7-7 7M5 5l7 7-7 7" : "M11 19l-7-7 7-7M19 19l-7-7 7-7"} />
      </svg>
    </button>
  )

  return (
    <ProjectShellContext.Provider value={value}>
      <div className="flex flex-col bg-[#F4F5F7] w-full overflow-hidden" style={{ height: "100dvh" }}>

        {/* ── Mobile top bar (sidebar collapses to a hamburger drawer) ─────── */}
        <header className="flex sm:hidden flex-shrink-0 items-center gap-2 h-14 bg-[#0A1628] border-b border-white/10 px-3 relative">
          <Link href="/dashboard" className="flex items-center gap-2 flex-shrink-0">{brand}</Link>
          <div className="flex-1 min-w-0">
            <ProjectSwitcher projects={appProjects} currentId={project.id} onPick={switchProject} favorites={favorites} onToggleFavorite={toggleFavorite} />
          </div>
          <button
            onClick={() => setMobileNavOpen(o => !o)}
            className="text-[#94A3B8] hover:text-white transition-colors p-1 flex-shrink-0"
            aria-label="Open navigation menu"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={mobileNavOpen ? "M6 18L18 6M6 6l12 12" : "M4 6h16M4 12h16M4 18h16"} />
            </svg>
          </button>

          {mobileNavOpen && (
            <div className="absolute top-full left-0 right-0 bg-[#0A1628] border-b border-white/10 z-50 shadow-lg max-h-[80vh] overflow-y-auto">
              {navEntries.map(m => (
                <Link
                  key={m.slug}
                  href={`/projects/${project.id}/${m.slug}`}
                  onClick={() => setMobileNavOpen(false)}
                  className={`w-full text-left px-4 py-3 text-[13px] font-medium border-l-2 transition-colors flex items-center gap-2.5 ${segment === m.slug ? "border-white text-white bg-white/[0.06]" : "border-transparent text-[#94A3B8] hover:text-white hover:bg-white/[0.04]"}`}
                >
                  {m.icon}
                  <span className="flex-1">{m.label}</span>
                  {closeoutBadge(m.slug)}
                </Link>
              ))}
              <div className="border-t border-white/10">
                <Link href="/dashboard" onClick={() => setMobileNavOpen(false)} className="w-full text-left px-4 py-3 text-[13px] font-medium text-[#94A3B8] hover:text-white hover:bg-white/[0.04] transition-colors flex items-center gap-2.5">All projects</Link>
                {/* The mobile drawer stays a flat list (groups are a rail
                    affordance), so Library keeps its old drawer spot here. */}
                {(isField ? [] : [{ href: "/library", label: "Library" }, ...BOTTOM_LINKS]).map(t => (
                  <Link
                    key={t.href}
                    href={t.href}
                    onClick={() => setMobileNavOpen(false)}
                    className="w-full text-left px-4 py-3 text-[13px] font-medium text-[#94A3B8] hover:text-white hover:bg-white/[0.04] transition-colors flex items-center gap-2.5"
                  >
                    {t.label}
                  </Link>
                ))}
              </div>
              <div className="flex items-center justify-between px-4 py-3 border-t border-white/10">
                <span className="text-[11px] text-[#64748B] truncate min-w-0">{userEmail}</span>
                <button onClick={signOut} className="text-[11px] text-[#94A3B8] hover:text-white transition-colors flex-shrink-0 ml-2">Sign out</button>
              </div>
            </div>
          )}
        </header>

        {/* ── Single left rail (desktop) + content ────────────────────────── */}
        <div className="flex flex-1 min-h-0">
          {/* Width is the only thing mini changes structurally — the content
              pane next to it is flex-1, so the recovered ~160px goes to the
              workspace rather than leaving a gap. */}
          <aside className={`hidden sm:flex flex-col flex-shrink-0 bg-[#0A1628] border-r border-white/10 transition-[width] duration-200 ease-out ${navMini ? "w-14" : "w-60"}`}>
            {navMini ? (
              <div className="flex-shrink-0 flex flex-col items-center gap-1 px-1 pt-4 pb-3 border-b border-white/10">
                <Link
                  href="/dashboard"
                  title="All projects"
                  aria-label="All projects"
                  className="flex items-center justify-center w-10 h-8 rounded-lg text-[#94A3B8] hover:text-white hover:bg-white/[0.06] transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" /></svg>
                </Link>
                {navToggle}
              </div>
            ) : (
              <div className="flex-shrink-0 px-3 pt-4 pb-3 border-b border-white/10 space-y-3">
                <div className="flex items-center justify-between gap-2 h-7">
                  <Link href="/dashboard" className="flex items-center gap-2 min-w-0" title="All projects">{brand}</Link>
                  {navToggle}
                </div>
                <div>
                  <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest px-0.5 mb-1.5">Project</p>
                  <ProjectSwitcher projects={appProjects} currentId={project.id} onPick={switchProject} favorites={favorites} onToggleFavorite={toggleFavorite} />
                </div>
              </div>
            )}

            {navMini ? (
              /* Flat icon strip — same entries, same order, group headers off. */
              <nav className="flex-1 overflow-y-auto overflow-x-hidden flex flex-col items-center px-1 py-3 space-y-0.5">
                {flatEntries.map(m => miniRailEntry(m))}
              </nav>
            ) : (
              <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-1">
                {railGroups.map(g => {
                  const open = !collapsedGroups[g.id]
                  return (
                    <div key={g.id}>
                      <button
                        type="button"
                        onClick={() => toggleGroup(g.id)}
                        aria-expanded={open}
                        className="w-full flex items-center justify-between gap-2 px-3 py-1.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest hover:text-[#94A3B8] transition-colors"
                      >
                        <span>{g.label}</span>
                        <svg className={`w-3 h-3 flex-shrink-0 transition-transform ${open ? "" : "-rotate-90"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                      </button>
                      {open && <div className="space-y-0.5 mb-1">{g.entries.map(m => railEntry(m))}</div>}
                    </div>
                  )
                })}
                {ungroupedEntries.map(m => railEntry(m))}
              </nav>
            )}

            <div className={`flex-shrink-0 border-t border-white/10 py-2 space-y-0.5 ${navMini ? "flex flex-col items-center px-1" : "px-2"}`}>
              {(isField ? [] : BOTTOM_LINKS).map(t => (
                navMini ? (
                  <Link
                    key={t.href}
                    href={t.href}
                    title={t.label}
                    aria-label={t.label}
                    className="flex items-center justify-center w-10 h-9 rounded-lg text-[#64748B] hover:text-white hover:bg-white/[0.06] transition-colors"
                  >
                    {t.icon}
                  </Link>
                ) : (
                  <Link
                    key={t.href}
                    href={t.href}
                    className="flex items-center px-3 py-1.5 rounded-lg text-[12px] text-[#64748B] hover:text-white hover:bg-white/[0.06] transition-colors"
                  >
                    {t.label}
                  </Link>
                )
              ))}
              {navMini ? (
                <button
                  onClick={signOut}
                  title={userEmail ? `Sign out (${userEmail})` : "Sign out"}
                  aria-label="Sign out"
                  className="flex items-center justify-center w-10 h-9 rounded-lg text-[#64748B] hover:text-white hover:bg-white/[0.06] transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
                </button>
              ) : (
                <div className="flex items-center justify-between px-3 pt-1.5">
                  <span className="text-[11px] text-[#64748B] truncate min-w-0">{userEmail}</span>
                  <button onClick={signOut} className="text-[11px] text-[#94A3B8] hover:text-white transition-colors flex-shrink-0 ml-2">Sign out</button>
                </div>
              )}
            </div>
          </aside>

          <div className="flex-1 flex flex-col min-h-0 min-w-0 bg-[#F4F5F7]">
            {children}
          </div>
        </div>
      </div>
    </ProjectShellContext.Provider>
  )
}
