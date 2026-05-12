"use client"

import { useState, useEffect, useRef } from "react"
import Link from "next/link"

type Tab = "company" | "team" | "projects" | "gmail"

interface GmailConnection {
  connected: boolean
  gmail_address?: string
  watch_expiry?: string
  created_at?: string
}

interface TeamMember {
  id: string
  name: string
  title: string | null
  email: string | null
  created_at: string
}

interface Project {
  id: string
  name: string
  number: string | null
  location: string | null
  gc_name: string | null
  architect: string | null
  created_at: string
}

function XIcon({ className = "h-3 w-3" }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  )
}

function PencilIcon() {
  return (
    <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536M9 13l6.5-6.5a2.121 2.121 0 013 3L12 16H9v-3z" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
    </svg>
  )
}

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<Tab>("company")

  const [logoUrl, setLogoUrl]           = useState<string | null>(null)
  const [hasCoverPage, setHasCoverPage] = useState(false)
  const [loadingCompany, setLoadingCompany] = useState(true)
  const [uploadingLogo, setUploadingLogo]   = useState(false)
  const [uploadingCover, setUploadingCover] = useState(false)
  const [companyMessage, setCompanyMessage] = useState<{ text: string; ok: boolean } | null>(null)

  const [teamMembers, setTeamMembers]   = useState<TeamMember[]>([])
  const [teamLoading, setTeamLoading]   = useState(false)
  const [teamLoaded, setTeamLoaded]     = useState(false)
  const [showTeamForm, setShowTeamForm] = useState(false)
  const [editingMember, setEditingMember] = useState<TeamMember | null>(null)
  const [memberForm, setMemberForm]     = useState({ name: "", title: "", email: "" })
  const [savingMember, setSavingMember] = useState(false)
  const [teamMessage, setTeamMessage]   = useState<{ text: string; ok: boolean } | null>(null)

  const [projects, setProjects]         = useState<Project[]>([])
  const [projectsLoading, setProjectsLoading] = useState(false)
  const [projectsLoaded, setProjectsLoaded]   = useState(false)
  const [showProjectForm, setShowProjectForm] = useState(false)
  const [editingProject, setEditingProject]   = useState<Project | null>(null)
  const [projectForm, setProjectForm]   = useState({ name: "", number: "", location: "", gc_name: "", architect: "" })
  const [savingProject, setSavingProject] = useState(false)
  const [projectMessage, setProjectMessage] = useState<{ text: string; ok: boolean } | null>(null)

  const [gmailConn, setGmailConn]         = useState<GmailConnection | null>(null)
  const [gmailLoading, setGmailLoading]   = useState(false)
  const [gmailLoaded, setGmailLoaded]     = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [renewingWatch, setRenewingWatch] = useState(false)
  const [gmailMessage, setGmailMessage]   = useState<{ text: string; ok: boolean } | null>(null)

  const logoInputRef  = useRef<HTMLInputElement>(null)
  const coverInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetch("/api/settings")
      .then(r => r.json())
      .then(d => { setLogoUrl(d.logo_url); setHasCoverPage(d.has_cover_page) })
      .finally(() => setLoadingCompany(false))

    // Handle OAuth callback redirect params (?tab=gmail&connected=1 or &error=...)
    const params = new URLSearchParams(window.location.search)
    if (params.get("tab") === "gmail") {
      setActiveTab("gmail")
      const connected = params.get("connected")
      const err = params.get("error")
      if (connected === "1") {
        setGmailMessage({ text: "Gmail account connected successfully.", ok: true })
        setTimeout(() => setGmailMessage(null), 5000)
      } else if (err) {
        setGmailMessage({ text: `Connection failed: ${decodeURIComponent(err)}`, ok: false })
        setTimeout(() => setGmailMessage(null), 8000)
      }
      window.history.replaceState({}, "", "/settings?tab=gmail")
    }
  }, [])

  useEffect(() => {
    if (activeTab === "team" && !teamLoaded) {
      loadTeam()
    }
    if (activeTab === "projects" && !projectsLoaded) {
      loadProjects()
    }
    if (activeTab === "gmail" && !gmailLoaded) {
      loadGmailConnection()
    }
  }, [activeTab])

  function loadTeam() {
    setTeamLoading(true)
    fetch("/api/team")
      .then(r => r.json())
      .then(d => { setTeamMembers(d.members ?? []); setTeamLoaded(true) })
      .catch(() => {})
      .finally(() => setTeamLoading(false))
  }

  function loadProjects() {
    setProjectsLoading(true)
    fetch("/api/projects")
      .then(r => r.json())
      .then(d => { setProjects(d.projects ?? []); setProjectsLoaded(true) })
      .catch(() => {})
      .finally(() => setProjectsLoading(false))
  }

  function flashCompany(text: string, ok = true) {
    setCompanyMessage({ text, ok })
    setTimeout(() => setCompanyMessage(null), 3000)
  }

  function flashTeam(text: string, ok = true) {
    setTeamMessage({ text, ok })
    setTimeout(() => setTeamMessage(null), 3000)
  }

  function flashProject(text: string, ok = true) {
    setProjectMessage({ text, ok })
    setTimeout(() => setProjectMessage(null), 3000)
  }

  function flashGmail(text: string, ok = true) {
    setGmailMessage({ text, ok })
    setTimeout(() => setGmailMessage(null), 5000)
  }

  function loadGmailConnection() {
    setGmailLoading(true)
    fetch("/api/gmail/connection")
      .then(r => r.json())
      .then(d => { setGmailConn(d); setGmailLoaded(true) })
      .catch(() => {})
      .finally(() => setGmailLoading(false))
  }

  async function disconnectGmail() {
    if (!window.confirm("Disconnect your Gmail account? TuttoHQ will stop receiving email notifications.")) return
    setDisconnecting(true)
    try {
      const res = await fetch("/api/gmail/connection", { method: "DELETE" })
      if (!res.ok) throw new Error("Delete failed")
      setGmailConn({ connected: false })
      flashGmail("Gmail account disconnected.")
    } catch {
      flashGmail("Failed to disconnect. Please try again.", false)
    } finally {
      setDisconnecting(false)
    }
  }

  async function renewWatch() {
    setRenewingWatch(true)
    try {
      const res = await fetch("/api/gmail/watch", { method: "POST" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed")
      setGmailConn(prev => prev ? { ...prev, watch_expiry: data.watch_expiry } : prev)
      flashGmail("Gmail watch renewed successfully.")
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Renewal failed"
      flashGmail(msg, false)
    } finally {
      setRenewingWatch(false)
    }
  }

  async function uploadAsset(type: "logo" | "cover_page", file: File) {
    const fd = new FormData()
    fd.append("type", type)
    fd.append("file", file)
    const res  = await fetch("/api/settings", { method: "POST", body: fd })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error ?? "Upload failed")
    return data
  }

  async function handleLogoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploadingLogo(true)
    try {
      const data = await uploadAsset("logo", file)
      if (data.logo_url) setLogoUrl(data.logo_url)
      flashCompany("Logo updated successfully")
    } catch {
      flashCompany("Logo upload failed", false)
    } finally {
      setUploadingLogo(false)
      e.target.value = ""
    }
  }

  async function handleCoverChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.type !== "application/pdf") {
      flashCompany("Cover page must be a PDF file", false)
      e.target.value = ""
      return
    }
    setUploadingCover(true)
    try {
      await uploadAsset("cover_page", file)
      setHasCoverPage(true)
      flashCompany("Cover page updated successfully")
    } catch {
      flashCompany("Cover page upload failed", false)
    } finally {
      setUploadingCover(false)
      e.target.value = ""
    }
  }

  function openAddMember() {
    setEditingMember(null)
    setMemberForm({ name: "", title: "", email: "" })
    setShowTeamForm(true)
  }

  function openEditMember(m: TeamMember) {
    setEditingMember(m)
    setMemberForm({ name: m.name, title: m.title ?? "", email: m.email ?? "" })
    setShowTeamForm(true)
  }

  function cancelMemberForm() {
    setShowTeamForm(false)
    setEditingMember(null)
    setMemberForm({ name: "", title: "", email: "" })
  }

  async function saveMember(e: React.FormEvent) {
    e.preventDefault()
    if (!memberForm.name.trim()) return
    setSavingMember(true)
    try {
      const url    = editingMember ? `/api/team/${editingMember.id}` : "/api/team"
      const method = editingMember ? "PATCH" : "POST"
      const res    = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: memberForm.name.trim(), title: memberForm.title.trim() || null, email: memberForm.email.trim() || null }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Save failed")
      if (editingMember) {
        setTeamMembers(prev => prev.map(m => m.id === editingMember.id ? data.member : m))
        flashTeam("Member updated")
      } else {
        setTeamMembers(prev => [...prev, data.member])
        flashTeam("Member added")
      }
      cancelMemberForm()
    } catch {
      flashTeam("Save failed", false)
    } finally {
      setSavingMember(false)
    }
  }

  async function deleteMember(m: TeamMember) {
    if (!window.confirm(`Delete ${m.name}?`)) return
    const res = await fetch(`/api/team/${m.id}`, { method: "DELETE" })
    if (res.ok) {
      setTeamMembers(prev => prev.filter(x => x.id !== m.id))
      flashTeam("Member deleted")
    } else {
      flashTeam("Delete failed", false)
    }
  }

  function openAddProject() {
    setEditingProject(null)
    setProjectForm({ name: "", number: "", location: "", gc_name: "", architect: "" })
    setShowProjectForm(true)
  }

  function openEditProject(p: Project) {
    setEditingProject(p)
    setProjectForm({ name: p.name, number: p.number ?? "", location: p.location ?? "", gc_name: p.gc_name ?? "", architect: p.architect ?? "" })
    setShowProjectForm(true)
  }

  function cancelProjectForm() {
    setShowProjectForm(false)
    setEditingProject(null)
    setProjectForm({ name: "", number: "", location: "", gc_name: "", architect: "" })
  }

  async function saveProject(e: React.FormEvent) {
    e.preventDefault()
    if (!projectForm.name.trim()) return
    setSavingProject(true)
    try {
      const url    = editingProject ? `/api/projects/${editingProject.id}` : "/api/projects"
      const method = editingProject ? "PATCH" : "POST"
      const res    = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name:     projectForm.name.trim(),
          number:   projectForm.number.trim()   || null,
          location: projectForm.location.trim() || null,
          gc_name:  projectForm.gc_name.trim()  || null,
          architect: projectForm.architect.trim() || null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Save failed")
      if (editingProject) {
        setProjects(prev => prev.map(p => p.id === editingProject.id ? data.project : p))
        flashProject("Project updated")
      } else {
        setProjects(prev => [...prev, data.project])
        flashProject("Project added")
      }
      cancelProjectForm()
    } catch {
      flashProject("Save failed", false)
    } finally {
      setSavingProject(false)
    }
  }

  async function deleteProject(p: Project) {
    if (!window.confirm(`Delete project "${p.name}"?`)) return
    const res = await fetch(`/api/projects/${p.id}`, { method: "DELETE" })
    if (res.ok) {
      setProjects(prev => prev.filter(x => x.id !== p.id))
      flashProject("Project deleted")
    } else {
      flashProject("Delete failed", false)
    }
  }

  const inputCls = "w-full h-9 px-3 rounded-md border border-[#2a3347] text-[13px] text-[#e8edf5] bg-[#0d1117] focus:outline-none focus:ring-1 focus:ring-[#2563eb]/40 focus:border-[#2563eb]/50 placeholder:text-[#4f617a] transition-all"
  const labelCls = "block text-[12px] font-medium text-[#8b9ab5] mb-1"

  const tabs: { key: Tab; label: string }[] = [
    { key: "company",  label: "Company" },
    { key: "team",     label: "Team" },
    { key: "projects", label: "Projects" },
    { key: "gmail",    label: "Gmail" },
  ]

  return (
    <div className="min-h-screen bg-[#0f1117]">
      <div className="max-w-[720px] mx-auto py-12 px-6">

        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-[22px] font-bold text-[#e8edf5] tracking-tight">Settings</h1>
            <p className="text-[13px] text-[#8b9ab5] mt-0.5">THP Construction</p>
          </div>
          <Link href="/" className="text-[13px] text-[#8b9ab5] hover:text-[#e8edf5] transition-colors">
            ← Back to library
          </Link>
        </div>

        <div className="flex gap-1 mb-6 border-b border-[#2a3347]">
          {tabs.map(t => (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              className={`px-4 py-2.5 text-[13px] font-medium transition-colors border-b-2 -mb-px ${
                activeTab === t.key
                  ? "border-[#2563eb] text-[#e8edf5]"
                  : "border-transparent text-[#8b9ab5] hover:text-[#e8edf5]"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {activeTab === "company" && (
          <div className="space-y-4">
            {loadingCompany ? (
              <div className="text-[13px] text-[#8b9ab5]">Loading…</div>
            ) : (
              <>
                <div className="bg-[#161b27] rounded-xl border border-[#2a3347] p-5">
                  <h2 className="text-[14px] font-semibold text-[#e8edf5] mb-0.5">Company Logo</h2>
                  <p className="text-[12px] text-[#8b9ab5] mb-4">
                    Displayed in the app header. PNG, SVG, or JPG recommended.
                  </p>
                  <div className="flex items-center gap-4">
                    <div className="w-16 h-16 rounded-lg border border-[#2a3347] bg-[#0d1117] flex items-center justify-center overflow-hidden flex-shrink-0">
                      {logoUrl ? (
                        <img src={logoUrl} alt="Logo" className="w-full h-full object-contain p-1" />
                      ) : (
                        <svg className="w-7 h-7 text-[#4f617a]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                      )}
                    </div>
                    <div className="space-y-1">
                      <button
                        onClick={() => logoInputRef.current?.click()}
                        disabled={uploadingLogo}
                        className="h-8 px-4 rounded-md border border-[#2a3347] text-[13px] text-[#c8d3e6] hover:bg-white/[0.05] transition-colors disabled:opacity-50"
                      >
                        {uploadingLogo ? "Uploading…" : logoUrl ? "Replace logo" : "Upload logo"}
                      </button>
                      {logoUrl && <p className="text-[11px] text-[#8b9ab5]">Logo is active</p>}
                    </div>
                  </div>
                  <input ref={logoInputRef} type="file" accept="image/*" onChange={handleLogoChange} className="hidden" />
                </div>

                <div className="bg-[#161b27] rounded-xl border border-[#2a3347] p-5">
                  <h2 className="text-[14px] font-semibold text-[#e8edf5] mb-0.5">Cover Page Template</h2>
                  <p className="text-[12px] text-[#8b9ab5] mb-4">
                    This PDF will be prepended to every submittal when a user opens or downloads it. Must be a PDF file.
                  </p>
                  <div className="flex items-center gap-3">
                    <div className={`flex-1 h-9 px-3 rounded-md border flex items-center text-[13px] ${
                      hasCoverPage
                        ? "border-[#2a3347] bg-[#0d1117] text-[#c8d3e6]"
                        : "border-dashed border-[#2a3347] text-[#4f617a]"
                    }`}>
                      {hasCoverPage ? "📄 cover.pdf — active" : "No cover page uploaded"}
                    </div>
                    <button
                      onClick={() => coverInputRef.current?.click()}
                      disabled={uploadingCover}
                      className="h-9 px-4 rounded-md border border-[#2a3347] text-[13px] text-[#c8d3e6] hover:bg-white/[0.05] transition-colors disabled:opacity-50 flex-shrink-0"
                    >
                      {uploadingCover ? "Uploading…" : hasCoverPage ? "Replace" : "Upload PDF"}
                    </button>
                  </div>
                  <input ref={coverInputRef} type="file" accept=".pdf,application/pdf" onChange={handleCoverChange} className="hidden" />
                </div>
              </>
            )}

            {companyMessage && (
              <div className={`text-center text-[13px] ${companyMessage.ok ? "text-[#60a5fa]" : "text-red-400"}`}>
                {companyMessage.text}
              </div>
            )}
          </div>
        )}

        {activeTab === "team" && (
          <div className="space-y-4">
            <div className="bg-[#161b27] rounded-xl border border-[#2a3347] overflow-hidden">
              <div className="flex items-center justify-between px-5 py-4 border-b border-[#2a3347]">
                <div>
                  <h2 className="text-[14px] font-semibold text-[#e8edf5]">Team Members</h2>
                  <p className="text-[12px] text-[#8b9ab5] mt-0.5">Used to populate Reviewed By / Certified By fields on cover sheets.</p>
                </div>
                {!showTeamForm && (
                  <button
                    onClick={openAddMember}
                    className="h-8 px-3 rounded-md bg-[#2563eb] text-white text-[13px] font-medium hover:bg-[#1d4ed8] transition-colors flex items-center gap-1.5 flex-shrink-0"
                  >
                    <PlusIcon /> Add member
                  </button>
                )}
              </div>

              {showTeamForm && (
                <div className="px-5 py-4 border-b border-[#2a3347] bg-[#0d1117]/50">
                  <p className="text-[13px] font-semibold text-[#e8edf5] mb-3">
                    {editingMember ? "Edit member" : "New member"}
                  </p>
                  <form onSubmit={saveMember} className="space-y-3">
                    <div>
                      <label className={labelCls}>Name <span className="text-red-400">*</span></label>
                      <input
                        type="text"
                        value={memberForm.name}
                        onChange={e => setMemberForm(p => ({ ...p, name: e.target.value }))}
                        required
                        placeholder="Full name"
                        className={inputCls}
                        autoFocus
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className={labelCls}>Title</label>
                        <input
                          type="text"
                          value={memberForm.title}
                          onChange={e => setMemberForm(p => ({ ...p, title: e.target.value }))}
                          placeholder="e.g. Project Manager"
                          className={inputCls}
                        />
                      </div>
                      <div>
                        <label className={labelCls}>Email</label>
                        <input
                          type="email"
                          value={memberForm.email}
                          onChange={e => setMemberForm(p => ({ ...p, email: e.target.value }))}
                          placeholder="name@company.com"
                          className={inputCls}
                        />
                      </div>
                    </div>
                    <div className="flex justify-end gap-2 pt-1">
                      <button
                        type="button"
                        onClick={cancelMemberForm}
                        className="h-8 px-3 rounded-md border border-[#2a3347] text-[13px] text-[#8b9ab5] hover:text-[#e8edf5] hover:bg-white/[0.05] transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={savingMember || !memberForm.name.trim()}
                        className="h-8 px-4 rounded-md bg-[#2563eb] text-white text-[13px] font-semibold hover:bg-[#1d4ed8] transition-colors disabled:opacity-50"
                      >
                        {savingMember ? "Saving…" : editingMember ? "Save changes" : "Add member"}
                      </button>
                    </div>
                  </form>
                </div>
              )}

              {teamLoading && (
                <div className="px-5 py-4 text-[13px] text-[#8b9ab5]">Loading…</div>
              )}

              {!teamLoading && teamMembers.length === 0 && (
                <div className="px-5 py-8 text-center text-[13px] text-[#4f617a]">No team members yet.</div>
              )}

              {!teamLoading && teamMembers.length > 0 && (
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-[#2a3347]">
                      <th className="text-left px-5 py-2.5 text-[11px] font-semibold text-[#4f617a] uppercase tracking-wider">Name</th>
                      <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-[#4f617a] uppercase tracking-wider">Title</th>
                      <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-[#4f617a] uppercase tracking-wider">Email</th>
                      <th className="px-3 py-2.5 w-16" />
                    </tr>
                  </thead>
                  <tbody>
                    {teamMembers.map((m, i) => (
                      <tr key={m.id} className={`${i < teamMembers.length - 1 ? "border-b border-[#2a3347]" : ""} hover:bg-white/[0.03] transition-colors group`}>
                        <td className="px-5 py-3 text-[13px] font-medium text-[#e8edf5]">{m.name}</td>
                        <td className="px-3 py-3 text-[13px] text-[#8b9ab5]">{m.title ?? <span className="text-[#4f617a]">—</span>}</td>
                        <td className="px-3 py-3 text-[13px] text-[#8b9ab5]">{m.email ?? <span className="text-[#4f617a]">—</span>}</td>
                        <td className="px-3 py-3">
                          <div className="flex items-center gap-1.5 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              onClick={() => openEditMember(m)}
                              className="p-1 rounded text-[#4f617a] hover:text-[#c8d3e6] hover:bg-white/[0.08] transition-colors"
                              title="Edit"
                            >
                              <PencilIcon />
                            </button>
                            <button
                              onClick={() => deleteMember(m)}
                              className="p-1 rounded text-[#4f617a] hover:text-red-400 hover:bg-white/[0.08] transition-colors"
                              title="Delete"
                            >
                              <XIcon className="h-3 w-3" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {teamMessage && (
              <div className={`text-center text-[13px] ${teamMessage.ok ? "text-[#60a5fa]" : "text-red-400"}`}>
                {teamMessage.text}
              </div>
            )}
          </div>
        )}

        {activeTab === "projects" && (
          <div className="space-y-4">
            <div className="bg-[#161b27] rounded-xl border border-[#2a3347] overflow-hidden">
              <div className="flex items-center justify-between px-5 py-4 border-b border-[#2a3347]">
                <div>
                  <h2 className="text-[14px] font-semibold text-[#e8edf5]">Projects</h2>
                  <p className="text-[12px] text-[#8b9ab5] mt-0.5">Projects available when generating submittal cover sheets.</p>
                </div>
                {!showProjectForm && (
                  <button
                    onClick={openAddProject}
                    className="h-8 px-3 rounded-md bg-[#2563eb] text-white text-[13px] font-medium hover:bg-[#1d4ed8] transition-colors flex items-center gap-1.5 flex-shrink-0"
                  >
                    <PlusIcon /> Add project
                  </button>
                )}
              </div>

              {showProjectForm && (
                <div className="px-5 py-4 border-b border-[#2a3347] bg-[#0d1117]/50">
                  <p className="text-[13px] font-semibold text-[#e8edf5] mb-3">
                    {editingProject ? "Edit project" : "New project"}
                  </p>
                  <form onSubmit={saveProject} className="space-y-3">
                    <div className="grid grid-cols-3 gap-3">
                      <div className="col-span-2">
                        <label className={labelCls}>Project Name <span className="text-red-400">*</span></label>
                        <input
                          type="text"
                          value={projectForm.name}
                          onChange={e => setProjectForm(p => ({ ...p, name: e.target.value }))}
                          required
                          placeholder="e.g. Riverside Office Complex"
                          className={inputCls}
                          autoFocus
                        />
                      </div>
                      <div>
                        <label className={labelCls}>Project No.</label>
                        <input
                          type="text"
                          value={projectForm.number}
                          onChange={e => setProjectForm(p => ({ ...p, number: e.target.value }))}
                          placeholder="2024-001"
                          className={inputCls}
                        />
                      </div>
                    </div>
                    <div>
                      <label className={labelCls}>Location</label>
                      <input
                        type="text"
                        value={projectForm.location}
                        onChange={e => setProjectForm(p => ({ ...p, location: e.target.value }))}
                        placeholder="City, State"
                        className={inputCls}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className={labelCls}>General Contractor</label>
                        <input
                          type="text"
                          value={projectForm.gc_name}
                          onChange={e => setProjectForm(p => ({ ...p, gc_name: e.target.value }))}
                          placeholder="GC company name"
                          className={inputCls}
                        />
                      </div>
                      <div>
                        <label className={labelCls}>Architect</label>
                        <input
                          type="text"
                          value={projectForm.architect}
                          onChange={e => setProjectForm(p => ({ ...p, architect: e.target.value }))}
                          placeholder="Architecture firm"
                          className={inputCls}
                        />
                      </div>
                    </div>
                    <div className="flex justify-end gap-2 pt-1">
                      <button
                        type="button"
                        onClick={cancelProjectForm}
                        className="h-8 px-3 rounded-md border border-[#2a3347] text-[13px] text-[#8b9ab5] hover:text-[#e8edf5] hover:bg-white/[0.05] transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={savingProject || !projectForm.name.trim()}
                        className="h-8 px-4 rounded-md bg-[#2563eb] text-white text-[13px] font-semibold hover:bg-[#1d4ed8] transition-colors disabled:opacity-50"
                      >
                        {savingProject ? "Saving…" : editingProject ? "Save changes" : "Add project"}
                      </button>
                    </div>
                  </form>
                </div>
              )}

              {projectsLoading && (
                <div className="px-5 py-4 text-[13px] text-[#8b9ab5]">Loading…</div>
              )}

              {!projectsLoading && projects.length === 0 && (
                <div className="px-5 py-8 text-center text-[13px] text-[#4f617a]">No projects yet.</div>
              )}

              {!projectsLoading && projects.length > 0 && (
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-[#2a3347]">
                      <th className="text-left px-5 py-2.5 text-[11px] font-semibold text-[#4f617a] uppercase tracking-wider">Name</th>
                      <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-[#4f617a] uppercase tracking-wider">No.</th>
                      <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-[#4f617a] uppercase tracking-wider">Location</th>
                      <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-[#4f617a] uppercase tracking-wider">GC</th>
                      <th className="px-3 py-2.5 w-16" />
                    </tr>
                  </thead>
                  <tbody>
                    {projects.map((p, i) => (
                      <tr key={p.id} className={`${i < projects.length - 1 ? "border-b border-[#2a3347]" : ""} hover:bg-white/[0.03] transition-colors group`}>
                        <td className="px-5 py-3 text-[13px] font-medium text-[#e8edf5]">{p.name}</td>
                        <td className="px-3 py-3 text-[13px] text-[#8b9ab5]">{p.number ?? <span className="text-[#4f617a]">—</span>}</td>
                        <td className="px-3 py-3 text-[13px] text-[#8b9ab5]">{p.location ?? <span className="text-[#4f617a]">—</span>}</td>
                        <td className="px-3 py-3 text-[13px] text-[#8b9ab5]">{p.gc_name ?? <span className="text-[#4f617a]">—</span>}</td>
                        <td className="px-3 py-3">
                          <div className="flex items-center gap-1.5 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              onClick={() => openEditProject(p)}
                              className="p-1 rounded text-[#4f617a] hover:text-[#c8d3e6] hover:bg-white/[0.08] transition-colors"
                              title="Edit"
                            >
                              <PencilIcon />
                            </button>
                            <button
                              onClick={() => deleteProject(p)}
                              className="p-1 rounded text-[#4f617a] hover:text-red-400 hover:bg-white/[0.08] transition-colors"
                              title="Delete"
                            >
                              <XIcon className="h-3 w-3" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {projectMessage && (
              <div className={`text-center text-[13px] ${projectMessage.ok ? "text-[#60a5fa]" : "text-red-400"}`}>
                {projectMessage.text}
              </div>
            )}
          </div>
        )}

        {activeTab === "gmail" && (
          <div className="space-y-4">
            {gmailLoading ? (
              <div className="text-[13px] text-[#8b9ab5]">Loading…</div>
            ) : (
              <>
                <div className="bg-[#161b27] rounded-xl border border-[#2a3347] p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h2 className="text-[14px] font-semibold text-[#e8edf5] mb-0.5">Gmail Integration</h2>
                      <p className="text-[12px] text-[#8b9ab5]">
                        Connect a Gmail account so TuttoHQ can receive submittal files sent to that inbox.
                      </p>
                    </div>
                    <div className={`flex-shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border ${
                      gmailConn?.connected
                        ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
                        : "bg-[#0d1117] border-[#2a3347] text-[#4f617a]"
                    }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${gmailConn?.connected ? "bg-emerald-400" : "bg-[#4f617a]"}`} />
                      {gmailConn?.connected ? "Connected" : "Not connected"}
                    </div>
                  </div>

                  {gmailConn?.connected ? (
                    <div className="mt-5 space-y-4">
                      <div className="bg-[#0d1117] rounded-lg border border-[#2a3347] divide-y divide-[#2a3347]">
                        <div className="flex items-center justify-between px-4 py-3">
                          <span className="text-[12px] text-[#8b9ab5]">Connected account</span>
                          <span className="text-[13px] text-[#e8edf5] font-medium">{gmailConn.gmail_address}</span>
                        </div>
                        {gmailConn.created_at && (
                          <div className="flex items-center justify-between px-4 py-3">
                            <span className="text-[12px] text-[#8b9ab5]">Connected since</span>
                            <span className="text-[13px] text-[#8b9ab5]">
                              {new Date(gmailConn.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                            </span>
                          </div>
                        )}
                        {gmailConn.watch_expiry && (
                          <div className="flex items-center justify-between px-4 py-3">
                            <span className="text-[12px] text-[#8b9ab5]">Push notifications active until</span>
                            <div className="flex items-center gap-2">
                              <span className="text-[13px] text-[#8b9ab5]">
                                {new Date(gmailConn.watch_expiry).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                              </span>
                              <button
                                onClick={renewWatch}
                                disabled={renewingWatch}
                                className="text-[11px] text-[#60a5fa] hover:text-[#93c5fd] disabled:opacity-50 transition-colors"
                              >
                                {renewingWatch ? "Renewing…" : "Renew"}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>

                      <div className="flex gap-2">
                        <a
                          href="/api/auth/gmail"
                          className="h-8 px-4 rounded-md border border-[#2a3347] text-[13px] text-[#c8d3e6] hover:bg-white/[0.05] transition-colors inline-flex items-center"
                        >
                          Reconnect
                        </a>
                        <button
                          onClick={disconnectGmail}
                          disabled={disconnecting}
                          className="h-8 px-4 rounded-md border border-red-500/30 text-[13px] text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                        >
                          {disconnecting ? "Disconnecting…" : "Disconnect"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-5">
                      <a
                        href="/api/auth/gmail"
                        className="inline-flex items-center gap-2 h-9 px-5 rounded-md bg-[#2563eb] text-white text-[13px] font-medium hover:bg-[#1d4ed8] transition-colors"
                      >
                        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z" />
                        </svg>
                        Connect Gmail account
                      </a>
                    </div>
                  )}
                </div>

                <div className="bg-[#161b27] rounded-xl border border-[#2a3347] p-5">
                  <h2 className="text-[14px] font-semibold text-[#e8edf5] mb-3">Setup Instructions</h2>
                  <ol className="space-y-3 text-[13px] text-[#8b9ab5]">
                    <li className="flex gap-3">
                      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-[#2563eb]/20 text-[#60a5fa] text-[11px] font-semibold flex items-center justify-center">1</span>
                      <span>Click <strong className="text-[#c8d3e6]">Connect Gmail account</strong> above and sign in with the Gmail account you want TuttoHQ to monitor.</span>
                    </li>
                    <li className="flex gap-3">
                      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-[#2563eb]/20 text-[#60a5fa] text-[11px] font-semibold flex items-center justify-center">2</span>
                      <span>Grant the requested permissions — TuttoHQ needs read access to detect incoming submittals and the ability to label or archive processed emails.</span>
                    </li>
                    <li className="flex gap-3">
                      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-[#2563eb]/20 text-[#60a5fa] text-[11px] font-semibold flex items-center justify-center">3</span>
                      <span>Once connected, TuttoHQ will automatically detect emails with PDF attachments and add them to your submittal library.</span>
                    </li>
                    <li className="flex gap-3">
                      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-[#2563eb]/20 text-[#60a5fa] text-[11px] font-semibold flex items-center justify-center">4</span>
                      <span>Push notifications expire every 7 days. TuttoHQ auto-renews them — you can also manually renew from the connection details above.</span>
                    </li>
                  </ol>
                </div>
              </>
            )}

            {gmailMessage && (
              <div className={`text-center text-[13px] ${gmailMessage.ok ? "text-[#60a5fa]" : "text-red-400"}`}>
                {gmailMessage.text}
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  )
}
