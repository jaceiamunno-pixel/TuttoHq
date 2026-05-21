"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { createClient } from "@/lib/supabase/client"
import type { Project, TeamMember } from "./_shared/types"
import DrawingsModule from "./_modules/DrawingsModule"
import CommitmentsModule from "./_modules/CommitmentsModule"
import PunchModule from "./_modules/PunchModule"
import DailyModule from "./_modules/DailyModule"
import RfisModule from "./_modules/RfisModule"
import ChangeOrdersModule from "./_modules/ChangeOrdersModule"
import SpecBooksModule from "./_modules/SpecBooksModule"
import CloseoutModule from "./_modules/CloseoutModule"
import LibrarySubmittalsModule from "./_modules/LibrarySubmittalsModule"

export default function Home() {
  // Auth + company settings
  const [userEmail, setUserEmail] = useState<string | null>(null)
  const [logoUrl, setLogoUrl]     = useState<string | null>(null)

  // Projects + team
  const [appProjects, setAppProjects]     = useState<Project[]>([])
  const [teamMembers, setTeamMembers]     = useState<TeamMember[]>([])

  // Sidebar
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [projectDropdownOpen, setProjectDropdownOpen] = useState(false)
  useEffect(() => {
    if (sessionStorage.getItem("sidebarOpen") === "true") setSidebarOpen(true)
  }, [])
  useEffect(() => {
    if (!projectDropdownOpen) return
    const close = () => setProjectDropdownOpen(false)
    document.addEventListener("click", close)
    return () => document.removeEventListener("click", close)
  }, [projectDropdownOpen])

  // Module navigation
  const [activeModule, setActiveModule] = useState<"library" | "submittals" | "rfis" | "changeorders" | "punch" | "daily" | "drawings" | "commitments" | "closeout" | "specbooks">("submittals")
  const [globalProjectId, setGlobalProjectId] = useState<string>("")
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  // Submittals sub-view — kept in the shell so it survives LibrarySubmittalsModule
  // unmounting and so the Spec Books parse handoff can switch to the pending view.
  const [submittalsView, setSubmittalsView] = useState<"log" | "pending">("log")

  // Closeout — sidebar progress badge (the module owns the rest of closeout state)
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

  return (
    <div className="flex bg-[#F4F5F7] w-full overflow-hidden" style={{ height: '100dvh' }}>
      {/* ── Sidebar ───────────────────────────────────────────────────────── */}
      <aside className="fixed left-0 top-0 z-40 bg-[#0A1628] border-r border-white/10 hidden sm:flex flex-col w-56 overflow-hidden" style={{ height: '100dvh' }}>

        {/* Header */}
        <div className="flex-shrink-0 flex items-center gap-2.5 h-14 px-4 border-b border-white/10">
          {logoUrl ? (
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
          )}
        </div>

        {/* Project selector */}
        {appProjects.length > 0 && (
          <div className="flex-shrink-0 px-3 pt-3 pb-2 relative">
            <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest px-1 mb-1.5">Project</p>
            <button
              onClick={() => setProjectDropdownOpen(o => !o)}
              className="w-full h-8 px-2.5 rounded-lg bg-white/[0.06] border border-white/10 text-[12px] text-white flex items-center justify-between gap-1 hover:bg-white/[0.10] transition-colors"
            >
              <span className="truncate">
                {globalProjectId ? (appProjects.find(p => p.id === globalProjectId)?.name ?? "All Projects") : "All Projects"}
              </span>
              <svg className={`w-3.5 h-3.5 flex-shrink-0 text-[#64748B] transition-transform ${projectDropdownOpen ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {projectDropdownOpen && (
              <div className="absolute left-3 right-3 top-full mt-1 z-50 bg-[#1a2840] border border-white/10 rounded-lg shadow-xl overflow-y-auto max-h-[70vh]">
                {[{ id: "", name: "All Projects", number: null }, ...appProjects].map(p => (
                  <button
                    key={p.id}
                    onClick={() => { setGlobalProjectId(p.id); setProjectDropdownOpen(false) }}
                    className={`w-full text-left px-3 py-2 text-[12px] truncate transition-colors ${globalProjectId === p.id ? "bg-[#7B9BB5]/20 text-white" : "text-[#94A3B8] hover:bg-white/[0.06] hover:text-white"}`}
                  >
                    {p.name}{p.number ? ` — ${p.number}` : ""}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Module nav */}
        <nav className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5">
          {([
            { id: "library",       label: "Library",        icon: <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 14v3m4-3v3m4-3v3M3 21h18M3 10h18M3 7l9-4 9 4M4 10h16v11H4V10z" /></svg> },
            { id: "submittals",    label: "Submittal Log",  icon: <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg> },
            { id: "rfis",          label: "RFIs",           icon: <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg> },
            { id: "changeorders",  label: "Change Orders",  icon: <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z" /></svg> },
            { id: "punch",         label: "Punch List",     icon: <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg> },
            { id: "daily",         label: "Daily Reports",  icon: <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg> },
            { id: "drawings",      label: "Drawing Log",    icon: <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" /></svg> },
            { id: "specbooks",     label: "Spec Books",     icon: <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /></svg> },
            { id: "commitments",   label: "Commitments",    icon: <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg> },
            { id: "closeout",      label: "Closeout",       icon: <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z" /></svg> },
          ] as { id: typeof activeModule; label: string; icon: React.ReactNode }[]).map(item => (
            <button
              key={item.id}
              onClick={() => setActiveModule(item.id)}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] font-medium transition-colors ${activeModule === item.id ? "bg-white/[0.12] text-white" : "text-[#94A3B8] hover:text-white hover:bg-white/[0.06]"}`}
            >
              {item.icon}
              <span className="truncate">{item.label}</span>
              {item.id === "closeout" && globalProjectId && closeoutPct !== null && (
                <span className={`ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0 ${closeoutPct === 100 ? "bg-emerald-500/20 text-emerald-400" : closeoutPct >= 50 ? "bg-amber-500/20 text-amber-400" : "bg-red-500/20 text-red-400"}`}>{closeoutPct}%</span>
              )}
            </button>
          ))}
        </nav>

        {/* Bottom */}
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

      {/* ── Main content area ─────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0 ml-0 sm:ml-56">


        {/* Module navigation */}
        <div className="flex-shrink-0 border-b border-white/[0.12] bg-[#0A1628] relative">
          {/* Mobile nav bar */}
          <div className="flex sm:hidden items-center justify-between px-4 py-2.5">
            <span className="text-[14px] font-semibold text-white">
              {{ library: "Library", submittals: "Submittal Log", rfis: "RFIs", changeorders: "Change Orders", punch: "Punch List", daily: "Daily Reports", drawings: "Drawing Log", specbooks: "Spec Books", commitments: "Commitments", closeout: "Closeout" }[activeModule]}
            </span>
            <button
              onClick={() => setMobileNavOpen(prev => !prev)}
              className="text-[#94A3B8] hover:text-white transition-colors p-1"
              aria-label="Open navigation menu"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={mobileNavOpen ? "M6 18L18 6M6 6l12 12" : "M4 6h16M4 12h16M4 18h16"} />
              </svg>
            </button>
          </div>

          {/* Mobile dropdown menu */}
          {mobileNavOpen && (
            <div className="sm:hidden absolute top-full left-0 right-0 bg-[#0A1628] border-b border-white/[0.12] z-50 shadow-lg">
              {(["library","submittals","rfis","changeorders","punch","daily","drawings","specbooks","commitments","closeout"] as const).map(mod => {
                const labels: Record<string, string> = { library: "Library", submittals: "Submittal Log", rfis: "RFIs", changeorders: "Change Orders", punch: "Punch List", daily: "Daily Reports", drawings: "Drawing Log", specbooks: "Spec Books", commitments: "Commitments", closeout: "Closeout" }
                const isActive = activeModule === mod
                return (
                  <button key={mod}
                    onClick={() => { setActiveModule(mod); setMobileNavOpen(false) }}
                    className={`w-full text-left px-4 py-3 text-[13px] font-medium border-l-2 transition-colors ${isActive ? "border-white text-white bg-white/[0.06]" : "border-transparent text-[#94A3B8] hover:text-white hover:bg-white/[0.04]"}`}>
                    {labels[mod]}
                  </button>
                )
              })}
              {/* Settings link — mobile */}
              <a href="/settings"
                className="w-full text-left px-4 py-3 text-[13px] font-medium border-l-2 border-transparent text-[#94A3B8] hover:text-white hover:bg-white/[0.04] transition-colors flex items-center gap-2">
                Settings
              </a>
              {/* Global project filter — mobile */}
              {appProjects.length > 0 && (
                <div className="px-4 py-3 border-t border-white/[0.12]">
                  <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-2">Project</p>
                  <div className="space-y-0.5">
                    {[{ id: "", name: "All Projects" }, ...appProjects].map(p => (
                      <button
                        key={p.id}
                        onClick={() => { setGlobalProjectId(p.id); setMobileNavOpen(false) }}
                        className={`w-full text-left px-3 py-2 rounded-md text-[13px] font-medium transition-colors ${globalProjectId === p.id ? "bg-white/[0.12] text-white" : "text-[#94A3B8] hover:text-white hover:bg-white/[0.06]"}`}
                      >
                        {p.name}{"number" in p && p.number ? ` — ${p.number}` : ""}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

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

        {activeModule === "specbooks" && (
          <SpecBooksModule globalProjectId={globalProjectId} appProjects={appProjects} onParsed={() => { setActiveModule("submittals"); setSubmittalsView("pending") }} />
        )}

        {activeModule === "closeout" && (
          <CloseoutModule globalProjectId={globalProjectId} teamMembers={teamMembers} onProgress={setCloseoutPct} onNavigate={setActiveModule} />
        )}
      </div>
    </div>
  )
}
