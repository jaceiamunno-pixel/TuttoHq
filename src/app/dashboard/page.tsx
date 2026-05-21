"use client"

import { useState, useEffect, useRef } from "react"
import Link from "next/link"
import { createClient } from "@/lib/supabase/client"
import type { Project, TeamMember } from "./_shared/types"
import { SelectProjectEmptyState } from "./_shared/ui"
import DrawingsModule from "./_modules/DrawingsModule"
import CommitmentsModule from "./_modules/CommitmentsModule"
import PunchModule from "./_modules/PunchModule"
import DailyModule from "./_modules/DailyModule"
import RfisModule from "./_modules/RfisModule"
import ChangeOrdersModule from "./_modules/ChangeOrdersModule"
import CloseoutModule from "./_modules/CloseoutModule"
import LibrarySubmittalsModule from "./_modules/LibrarySubmittalsModule"

type ModuleId = "library" | "submittals" | "rfis" | "changeorders" | "punch" | "daily" | "drawings" | "commitments" | "closeout"

// Module nav — rendered horizontally in the top nav (desktop) and as a
// hamburger dropdown (mobile). Spec Books is intentionally absent: it is
// per-project setup and now lives in Settings → Projects.
const MODULES: { id: ModuleId; label: string; icon: React.ReactNode }[] = [
  { id: "library",      label: "Library",       icon: <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 14v3m4-3v3m4-3v3M3 21h18M3 10h18M3 7l9-4 9 4M4 10h16v11H4V10z" /></svg> },
  { id: "submittals",   label: "Submittal Log", icon: <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg> },
  { id: "rfis",         label: "RFIs",          icon: <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg> },
  { id: "changeorders", label: "Change Orders", icon: <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z" /></svg> },
  { id: "punch",        label: "Punch List",    icon: <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg> },
  { id: "daily",        label: "Daily Reports", icon: <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg> },
  { id: "drawings",     label: "Drawing Log",   icon: <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" /></svg> },
  { id: "commitments",  label: "Commitments",   icon: <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg> },
  { id: "closeout",     label: "Closeout",      icon: <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z" /></svg> },
]

// Empty-state phrasing for project-scoped modules opened with no project set.
const MODULE_EMPTY_LABEL: Record<Exclude<ModuleId, "library">, string> = {
  submittals:   "the submittal log",
  rfis:         "RFIs",
  changeorders: "change orders",
  punch:        "the punch list",
  daily:        "daily reports",
  drawings:     "the drawing log",
  commitments:  "commitments",
  closeout:     "closeout",
}

// Project selector — the primary navigation control. Always visible (slim
// sidebar on desktop, top bar on mobile), one-click dropdown, typeahead search
// once there are 10+ projects, and shows the job number for disambiguation.
function ProjectSelector({ projects, value, onChange }: {
  projects: Project[]
  value: string
  onChange: (id: string) => void
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

  const selected = projects.find(p => p.id === value)
  const buttonLabel = selected
    ? `${selected.name}${selected.number ? ` — ${selected.number}` : ""}`
    : "All Projects"

  const showSearch = projects.length >= 10
  const q = search.trim().toLowerCase()
  const matches = q
    ? projects.filter(p => `${p.name} ${p.number ?? ""}`.toLowerCase().includes(q))
    : projects
  const items: { id: string; name: string; number: string | null }[] = [
    { id: "", name: "All Projects", number: null },
    ...matches.map(p => ({ id: p.id, name: p.name, number: p.number ?? null })),
  ]

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => { setOpen(o => !o); setSearch("") }}
        className="w-full h-9 px-2.5 rounded-lg bg-white/[0.06] border border-white/10 text-[12px] text-white flex items-center justify-between gap-1 hover:bg-white/[0.10] transition-colors"
      >
        <span className="truncate">{buttonLabel}</span>
        <svg className={`w-3.5 h-3.5 flex-shrink-0 text-[#64748B] transition-transform ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 z-50 bg-[#1a2840] border border-white/10 rounded-lg shadow-xl overflow-hidden">
          {showSearch && (
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
            {items.map(p => (
              <button
                key={p.id || "__all__"}
                onClick={() => { onChange(p.id); setOpen(false); setSearch("") }}
                className={`w-full text-left px-3 py-2 text-[12px] truncate transition-colors ${value === p.id ? "bg-[#7B9BB5]/20 text-white" : "text-[#94A3B8] hover:bg-white/[0.06] hover:text-white"}`}
              >
                {p.name}{p.number ? ` — ${p.number}` : ""}
              </button>
            ))}
            {items.length === 1 && q && (
              <p className="px-3 py-3 text-[12px] text-[#64748B]">No projects match.</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default function Home() {
  // Auth + company settings
  const [userEmail, setUserEmail] = useState<string | null>(null)
  const [logoUrl, setLogoUrl]     = useState<string | null>(null)

  // Projects + team
  const [appProjects, setAppProjects] = useState<Project[]>([])
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([])

  // Module navigation
  const [activeModule, setActiveModule]     = useState<ModuleId>("submittals")
  const [globalProjectId, setGlobalProjectId] = useState<string>("")
  const [mobileNavOpen, setMobileNavOpen]   = useState(false)

  // Submittals sub-view — kept in the shell so it survives LibrarySubmittalsModule
  // unmounting (e.g. when switching to Library and back).
  const [submittalsView, setSubmittalsView] = useState<"log" | "pending">("log")

  // Closeout — top-nav progress badge (the module owns the rest of closeout state)
  const [closeoutPct, setCloseoutPct] = useState<number | null>(null)

  // Load user email + company logo + projects + team
  useEffect(() => {
    createClient().auth.getUser().then(({ data }) => {
      setUserEmail(data.user?.email ?? null)
    })
    fetch("/api/settings")
      .then(r => r.json())
      .then(d => { if (d.logo_url) setLogoUrl(d.logo_url) })
      .catch(() => {})
    fetch("/api/projects").then(r => r.json()).then(d => setAppProjects(d.projects ?? [])).catch(() => {})
    fetch("/api/team").then(r => r.json()).then(d => setTeamMembers(d.members ?? [])).catch(() => {})
  }, [])

  async function signOut() {
    await createClient().auth.signOut()
    window.location.href = "/login"
  }

  // Library is the only cross-project module; everything else requires a
  // project to be selected before it shows content.
  const needsProject  = activeModule !== "library"
  const showEmptyState = needsProject && !globalProjectId

  const logo = logoUrl ? (
    <img src={logoUrl} alt="Logo" className="h-7 max-w-[130px] object-contain" />
  ) : (
    <>
      <div className="w-7 h-7 rounded-lg bg-[#7B9BB5]/10 border border-[#7B9BB5]/30 flex items-center justify-center flex-shrink-0">
        <svg className="w-4 h-4 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
      </div>
      <span className="text-[15px] font-bold text-white tracking-tight">TuttoHQ</span>
    </>
  )

  function closeoutBadge(id: ModuleId) {
    if (id !== "closeout" || !globalProjectId || closeoutPct === null) return null
    return (
      <span className={`ml-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0 ${closeoutPct === 100 ? "bg-emerald-500/20 text-emerald-400" : closeoutPct >= 50 ? "bg-amber-500/20 text-amber-400" : "bg-red-500/20 text-red-400"}`}>{closeoutPct}%</span>
    )
  }

  return (
    <div className="flex flex-col bg-[#F4F5F7] w-full overflow-hidden" style={{ height: "100dvh" }}>

      {/* ── Top nav — desktop ─────────────────────────────────────────────── */}
      <header className="hidden sm:flex flex-shrink-0 items-center h-14 bg-[#0A1628] border-b border-white/10 px-3">
        <div className="flex items-center gap-2.5 pr-3 mr-1 border-r border-white/10 h-8">
          {logo}
        </div>
        <nav className="flex items-center gap-0.5 overflow-x-auto">
          {MODULES.map(m => (
            <button
              key={m.id}
              onClick={() => setActiveModule(m.id)}
              className={`flex items-center gap-2 h-9 px-3 rounded-lg text-[13px] font-medium whitespace-nowrap flex-shrink-0 transition-colors ${activeModule === m.id ? "bg-white/[0.12] text-white" : "text-[#94A3B8] hover:text-white hover:bg-white/[0.06]"}`}
            >
              {m.icon}
              {m.label}
              {closeoutBadge(m.id)}
            </button>
          ))}
        </nav>
      </header>

      {/* ── Top bar — mobile ──────────────────────────────────────────────── */}
      <header className="flex sm:hidden flex-shrink-0 items-center gap-2 h-14 bg-[#0A1628] border-b border-white/10 px-3 relative">
        <div className="flex items-center gap-2 flex-shrink-0">{logo}</div>
        {appProjects.length > 0 && (
          <div className="flex-1 min-w-0">
            <ProjectSelector projects={appProjects} value={globalProjectId} onChange={setGlobalProjectId} />
          </div>
        )}
        <button
          onClick={() => setMobileNavOpen(o => !o)}
          className="text-[#94A3B8] hover:text-white transition-colors p-1 flex-shrink-0"
          aria-label="Open navigation menu"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={mobileNavOpen ? "M6 18L18 6M6 6l12 12" : "M4 6h16M4 12h16M4 18h16"} />
          </svg>
        </button>

        {/* Mobile hamburger dropdown — modules + settings + sign out */}
        {mobileNavOpen && (
          <div className="absolute top-full left-0 right-0 bg-[#0A1628] border-b border-white/10 z-50 shadow-lg">
            {MODULES.map(m => (
              <button
                key={m.id}
                onClick={() => { setActiveModule(m.id); setMobileNavOpen(false) }}
                className={`w-full text-left px-4 py-3 text-[13px] font-medium border-l-2 transition-colors flex items-center gap-2.5 ${activeModule === m.id ? "border-white text-white bg-white/[0.06]" : "border-transparent text-[#94A3B8] hover:text-white hover:bg-white/[0.04]"}`}
              >
                {m.icon}
                {m.label}
                {closeoutBadge(m.id)}
              </button>
            ))}
            <Link
              href="/settings"
              className="w-full text-left px-4 py-3 text-[13px] font-medium border-l-2 border-transparent text-[#94A3B8] hover:text-white hover:bg-white/[0.04] transition-colors flex items-center gap-2.5"
            >
              <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              Settings
            </Link>
            <div className="flex items-center justify-between px-4 py-3 border-t border-white/10">
              <span className="text-[11px] text-[#64748B] truncate min-w-0">{userEmail}</span>
              <button onClick={signOut} className="text-[11px] text-[#94A3B8] hover:text-white transition-colors flex-shrink-0 ml-2">Sign out</button>
            </div>
          </div>
        )}
      </header>

      {/* ── Sidebar + content row ─────────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0">

        {/* Slim left sidebar — desktop only */}
        <aside className="hidden sm:flex flex-col flex-shrink-0 w-52 bg-[#0A1628] border-r border-white/10">
          {appProjects.length > 0 && (
            <div className="flex-shrink-0 px-3 pt-4 pb-3">
              <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest px-0.5 mb-1.5">Project</p>
              <ProjectSelector projects={appProjects} value={globalProjectId} onChange={setGlobalProjectId} />
            </div>
          )}

          <div className="flex-1" />

          <div className="flex-shrink-0 border-t border-white/10 px-2 py-2 space-y-0.5">
            <Link
              href="/settings"
              className="flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] text-[#94A3B8] hover:text-white hover:bg-white/[0.06] transition-colors"
            >
              <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              Settings
            </Link>
            <div className="flex items-center justify-between px-3 py-1.5">
              <span className="text-[11px] text-[#64748B] truncate min-w-0">{userEmail}</span>
              <button onClick={signOut} className="text-[11px] text-[#94A3B8] hover:text-white transition-colors flex-shrink-0 ml-2">Sign out</button>
            </div>
          </div>
        </aside>

        {/* ── Main content area ───────────────────────────────────────────── */}
        <div className="flex-1 flex flex-col min-h-0 min-w-0 bg-[#F4F5F7]">
          {showEmptyState ? (
            <SelectProjectEmptyState label={MODULE_EMPTY_LABEL[activeModule as Exclude<ModuleId, "library">]} />
          ) : (
            <>
              {(activeModule === "library" || activeModule === "submittals") && (
                <LibrarySubmittalsModule
                  activeModule={activeModule}
                  globalProjectId={globalProjectId}
                  appProjects={appProjects}
                  teamMembers={teamMembers}
                  userEmail={userEmail}
                  submittalsView={submittalsView}
                  setSubmittalsView={setSubmittalsView}
                  onNavigate={setActiveModule}
                />
              )}

              {activeModule === "drawings" && (
                <DrawingsModule globalProjectId={globalProjectId} appProjects={appProjects} />
              )}

              {activeModule === "commitments" && (
                <CommitmentsModule globalProjectId={globalProjectId} />
              )}

              {activeModule === "punch" && (
                <PunchModule globalProjectId={globalProjectId} appProjects={appProjects} />
              )}

              {activeModule === "daily" && (
                <DailyModule globalProjectId={globalProjectId} appProjects={appProjects} teamMembers={teamMembers} />
              )}

              {activeModule === "rfis" && (
                <RfisModule globalProjectId={globalProjectId} appProjects={appProjects} teamMembers={teamMembers} />
              )}

              {activeModule === "changeorders" && (
                <ChangeOrdersModule globalProjectId={globalProjectId} appProjects={appProjects} />
              )}

              {activeModule === "closeout" && (
                <CloseoutModule globalProjectId={globalProjectId} teamMembers={teamMembers} onProgress={setCloseoutPct} onNavigate={setActiveModule} />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
