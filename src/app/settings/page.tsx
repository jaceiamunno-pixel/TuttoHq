"use client"

import { useState, useEffect, useRef } from "react"
import Link from "next/link"
import Papa from "papaparse"

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

interface TeamImportRow {
  name: string
  title: string
  email: string
}

interface ProjectImportRow {
  name: string
  number: string
  location: string
  gc_name: string
  architect: string
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

  const [teamImportRows, setTeamImportRows]       = useState<TeamImportRow[] | null>(null)
  const [teamImporting, setTeamImporting]         = useState(false)
  const [teamImportResult, setTeamImportResult]   = useState<{ imported: number; errors: string[] } | null>(null)

  const [projectImportRows, setProjectImportRows]     = useState<ProjectImportRow[] | null>(null)
  const [projectImporting, setProjectImporting]       = useState(false)
  const [projectImportResult, setProjectImportResult] = useState<{ imported: number; errors: string[] } | null>(null)

  const logoInputRef        = useRef<HTMLInputElement>(null)
  const coverInputRef       = useRef<HTMLInputElement>(null)
  const teamCsvInputRef     = useRef<HTMLInputElement>(null)
  const projectCsvInputRef  = useRef<HTMLInputElement>(null)

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

  function downloadTeamTemplate() {
    const csv = "Name,Title,Email\nJane Smith,Project Manager,jane@company.com\nBob Jones,Superintendent,bob@company.com\n"
    const a = document.createElement("a")
    a.href = "data:text/csv;charset=utf-8," + encodeURIComponent(csv)
    a.download = "team_members_template.csv"
    a.click()
  }

  function downloadProjectTemplate() {
    const csv = "Project Name,Project Number,Location,General Contractor,Architect\nRiverside Office Complex,2024-001,Austin TX,Turner Construction,Gensler\n"
    const a = document.createElement("a")
    a.href = "data:text/csv;charset=utf-8," + encodeURIComponent(csv)
    a.download = "projects_template.csv"
    a.click()
  }

  function handleTeamCsvChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ""
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const rows: TeamImportRow[] = results.data.map(r => ({
          name:  (r["Name"]  ?? r["name"]  ?? "").trim(),
          title: (r["Title"] ?? r["title"] ?? "").trim(),
          email: (r["Email"] ?? r["email"] ?? "").trim(),
        }))
        setTeamImportRows(rows)
        setTeamImportResult(null)
      },
    })
  }

  async function confirmTeamImport() {
    if (!teamImportRows) return
    const valid = teamImportRows.filter(r => r.name)
    if (!valid.length) return
    setTeamImporting(true)
    try {
      const res  = await fetch("/api/team/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ members: valid }),
      })
      const data = await res.json()
      setTeamImportResult({ imported: data.imported ?? 0, errors: data.errors ?? [] })
      if (data.members?.length) {
        setTeamMembers(prev => [...prev, ...data.members])
      }
      setTeamImportRows(null)
      flashTeam(`Imported ${data.imported} member${data.imported !== 1 ? "s" : ""} successfully`)
    } catch {
      flashTeam("Import failed", false)
    } finally {
      setTeamImporting(false)
    }
  }

  function cancelTeamImport() {
    setTeamImportRows(null)
    setTeamImportResult(null)
  }

  function handleProjectCsvChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ""
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const rows: ProjectImportRow[] = results.data.map(r => ({
          name:      (r["Project Name"]      ?? r["name"]      ?? "").trim(),
          number:    (r["Project Number"]    ?? r["number"]    ?? "").trim(),
          location:  (r["Location"]          ?? r["location"]  ?? "").trim(),
          gc_name:   (r["General Contractor"] ?? r["gc_name"]  ?? "").trim(),
          architect: (r["Architect"]         ?? r["architect"] ?? "").trim(),
        }))
        setProjectImportRows(rows)
        setProjectImportResult(null)
      },
    })
  }

  async function confirmProjectImport() {
    if (!projectImportRows) return
    const valid = projectImportRows.filter(r => r.name)
    if (!valid.length) return
    setProjectImporting(true)
    try {
      const res  = await fetch("/api/projects/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projects: valid }),
      })
      const data = await res.json()
      setProjectImportResult({ imported: data.imported ?? 0, errors: data.errors ?? [] })
      if (data.projects?.length) {
        setProjects(prev => [...prev, ...data.projects])
      }
      setProjectImportRows(null)
      flashProject(`Imported ${data.imported} project${data.imported !== 1 ? "s" : ""} successfully`)
    } catch {
      flashProject("Import failed", false)
    } finally {
      setProjectImporting(false)
    }
  }

  function cancelProjectImport() {
    setProjectImportRows(null)
    setProjectImportResult(null)
  }

  const inputCls = "w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-[#FDF0E8] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 focus:border-[#7B9BB5]/50 placeholder:text-[#64748B] transition-all"
  const labelCls = "block text-[12px] font-medium text-[#64748B] mb-1"

  const tabs: { key: Tab; label: string }[] = [
    { key: "company",  label: "Company" },
    { key: "team",     label: "Team" },
    { key: "projects", label: "Projects" },
    { key: "gmail",    label: "Gmail" },
  ]

  return (
    <div className="min-h-screen bg-[#FDF0E8]">
      <div className="max-w-[720px] mx-auto py-12 px-6">

        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-[22px] font-bold text-[#0F172A] tracking-tight">Settings</h1>
            <p className="text-[13px] text-[#64748B] mt-0.5">TuttoHQ</p>
          </div>
          <Link href="/" className="text-[13px] text-[#64748B] hover:text-[#0F172A] transition-colors">
            ← Back to library
          </Link>
        </div>

        <div className="flex gap-1 mb-6 border-b border-[#E2E8F0]">
          {tabs.map(t => (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              className={`px-4 py-2.5 text-[13px] font-medium transition-colors border-b-2 -mb-px ${
                activeTab === t.key
                  ? "border-[#7B9BB5] text-[#0F172A]"
                  : "border-transparent text-[#64748B] hover:text-[#0F172A]"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {activeTab === "company" && (
          <div className="space-y-4">
            {loadingCompany ? (
              <div className="text-[13px] text-[#64748B]">Loading…</div>
            ) : (
              <>
                <div className="bg-[#F9E8DA] rounded-xl border border-[#E2E8F0] p-5">
                  <h2 className="text-[14px] font-semibold text-[#0F172A] mb-0.5">Company Logo</h2>
                  <p className="text-[12px] text-[#64748B] mb-4">
                    Displayed in the app header. PNG, SVG, or JPG recommended.
                  </p>
                  <div className="flex items-center gap-4">
                    <div className="w-16 h-16 rounded-lg border border-[#E2E8F0] bg-[#FDF0E8] flex items-center justify-center overflow-hidden flex-shrink-0">
                      {logoUrl ? (
                        <img src={logoUrl} alt="Logo" className="w-full h-full object-contain p-1" />
                      ) : (
                        <svg className="w-7 h-7 text-[#64748B]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                      )}
                    </div>
                    <div className="space-y-1">
                      <button
                        onClick={() => logoInputRef.current?.click()}
                        disabled={uploadingLogo}
                        className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] hover:bg-[#FDF0E8]/[0.05] transition-colors disabled:opacity-50"
                      >
                        {uploadingLogo ? "Uploading…" : logoUrl ? "Replace logo" : "Upload logo"}
                      </button>
                      {logoUrl && <p className="text-[11px] text-[#64748B]">Logo is active</p>}
                    </div>
                  </div>
                  <input ref={logoInputRef} type="file" accept="image/*" onChange={handleLogoChange} className="hidden" />
                </div>

                <div className="bg-[#F9E8DA] rounded-xl border border-[#E2E8F0] p-5">
                  <h2 className="text-[14px] font-semibold text-[#0F172A] mb-0.5">Cover Page Template</h2>
                  <p className="text-[12px] text-[#64748B] mb-4">
                    This PDF will be prepended to every submittal when a user opens or downloads it. Must be a PDF file.
                  </p>
                  <div className="flex items-center gap-3">
                    <div className={`flex-1 h-9 px-3 rounded-md border flex items-center text-[13px] ${
                      hasCoverPage
                        ? "border-[#E2E8F0] bg-[#FDF0E8] text-[#0F172A]"
                        : "border-dashed border-[#E2E8F0] text-[#64748B]"
                    }`}>
                      {hasCoverPage ? "📄 cover.pdf — active" : "No cover page uploaded"}
                    </div>
                    <button
                      onClick={() => coverInputRef.current?.click()}
                      disabled={uploadingCover}
                      className="h-9 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] hover:bg-[#FDF0E8]/[0.05] transition-colors disabled:opacity-50 flex-shrink-0"
                    >
                      {uploadingCover ? "Uploading…" : hasCoverPage ? "Replace" : "Upload PDF"}
                    </button>
                  </div>
                  <input ref={coverInputRef} type="file" accept=".pdf,application/pdf" onChange={handleCoverChange} className="hidden" />
                </div>
              </>
            )}

            {companyMessage && (
              <div className={`text-center text-[13px] ${companyMessage.ok ? "text-[#7B9BB5]" : "text-red-400"}`}>
                {companyMessage.text}
              </div>
            )}
          </div>
        )}

        {activeTab === "team" && (
          <div className="space-y-4">
            <div className="bg-[#F9E8DA] rounded-xl border border-[#E2E8F0] overflow-hidden">
              <div className="flex items-center justify-between px-5 py-4 border-b border-[#E2E8F0]">
                <div>
                  <h2 className="text-[14px] font-semibold text-[#0F172A]">Team Members</h2>
                  <p className="text-[12px] text-[#64748B] mt-0.5">Used to populate Reviewed By / Certified By fields on cover sheets.</p>
                </div>
                {!showTeamForm && !teamImportRows && (
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      onClick={() => teamCsvInputRef.current?.click()}
                      className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] hover:bg-[#FDF0E8]/[0.05] transition-colors flex items-center gap-1.5"
                    >
                      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                      </svg>
                      Import CSV
                    </button>
                    <button
                      onClick={openAddMember}
                      className="h-8 px-3 rounded-md bg-[#7B9BB5] text-white text-[13px] font-medium hover:bg-[#6A8AA4] transition-colors flex items-center gap-1.5"
                    >
                      <PlusIcon /> Add member
                    </button>
                  </div>
                )}
              </div>
              <input ref={teamCsvInputRef} type="file" accept=".csv,text/csv" onChange={handleTeamCsvChange} className="hidden" />

              {showTeamForm && (
                <div className="px-5 py-4 border-b border-[#E2E8F0] bg-[#FDF0E8]/50">
                  <p className="text-[13px] font-semibold text-[#0F172A] mb-3">
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
                        className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:text-[#0F172A] hover:bg-[#FDF0E8]/[0.05] transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={savingMember || !memberForm.name.trim()}
                        className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50"
                      >
                        {savingMember ? "Saving…" : editingMember ? "Save changes" : "Add member"}
                      </button>
                    </div>
                  </form>
                </div>
              )}

              {teamImportRows && (
                <div className="border-b border-[#E2E8F0] bg-[#FDF0E8]/50">
                  <div className="px-5 py-3 flex items-center justify-between">
                    <div className="text-[13px] font-semibold text-[#0F172A]">
                      Preview — {teamImportRows.length} row{teamImportRows.length !== 1 ? "s" : ""}
                      {teamImportRows.filter(r => !r.name).length > 0 && (
                        <span className="ml-2 text-[12px] font-normal text-amber-400">
                          ({teamImportRows.filter(r => !r.name).length} missing name — will be skipped)
                        </span>
                      )}
                    </div>
                    <button
                      onClick={downloadTeamTemplate}
                      className="text-[11px] text-[#7B9BB5] hover:text-[#7B9BB5] transition-colors"
                    >
                      Download template
                    </button>
                  </div>
                  <div className="overflow-x-auto max-h-60 overflow-y-auto">
                    <table className="w-full">
                      <thead className="sticky top-0 bg-[#FDF0E8]">
                        <tr className="border-b border-[#E2E8F0]">
                          <th className="text-left px-5 py-2 text-[11px] font-semibold text-[#64748B] uppercase tracking-wider">Name</th>
                          <th className="text-left px-3 py-2 text-[11px] font-semibold text-[#64748B] uppercase tracking-wider">Title</th>
                          <th className="text-left px-3 py-2 text-[11px] font-semibold text-[#64748B] uppercase tracking-wider">Email</th>
                        </tr>
                      </thead>
                      <tbody>
                        {teamImportRows.map((r, i) => (
                          <tr key={i} className={`border-b border-[#E2E8F0]/50 ${!r.name ? "bg-red-500/5" : ""}`}>
                            <td className="px-5 py-2 text-[13px]">
                              {r.name
                                ? <span className="text-[#0F172A]">{r.name}</span>
                                : <span className="text-red-400 italic">missing</span>}
                            </td>
                            <td className="px-3 py-2 text-[13px] text-[#64748B]">{r.title || <span className="text-[#64748B]">—</span>}</td>
                            <td className="px-3 py-2 text-[13px] text-[#64748B]">{r.email || <span className="text-[#64748B]">—</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="px-5 py-3 flex items-center justify-between border-t border-[#E2E8F0]">
                    <span className="text-[12px] text-[#64748B]">
                      {teamImportRows.filter(r => r.name).length} of {teamImportRows.length} rows will be imported
                    </span>
                    <div className="flex gap-2">
                      <button
                        onClick={cancelTeamImport}
                        disabled={teamImporting}
                        className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:text-[#0F172A] hover:bg-[#FDF0E8]/[0.05] transition-colors disabled:opacity-50"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={confirmTeamImport}
                        disabled={teamImporting || !teamImportRows.filter(r => r.name).length}
                        className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50"
                      >
                        {teamImporting ? "Importing…" : `Import ${teamImportRows.filter(r => r.name).length} member${teamImportRows.filter(r => r.name).length !== 1 ? "s" : ""}`}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {teamImportResult && teamImportResult.errors.length > 0 && (
                <div className="px-5 py-3 border-b border-[#E2E8F0] bg-red-500/5">
                  <p className="text-[12px] font-semibold text-red-400 mb-1">Some rows failed:</p>
                  {teamImportResult.errors.map((e, i) => (
                    <p key={i} className="text-[12px] text-red-400/80">{e}</p>
                  ))}
                </div>
              )}

              {teamLoading && (
                <div className="px-5 py-4 text-[13px] text-[#64748B]">Loading…</div>
              )}

              {!teamLoading && teamMembers.length === 0 && !teamImportRows && (
                <div className="px-5 py-6 text-center space-y-2">
                  <p className="text-[13px] text-[#64748B]">No team members yet.</p>
                  <button onClick={downloadTeamTemplate} className="text-[12px] text-[#7B9BB5] hover:text-[#7B9BB5] transition-colors">
                    Download CSV template
                  </button>
                </div>
              )}

              {!teamLoading && teamMembers.length > 0 && (
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-[#E2E8F0]">
                      <th className="text-left px-5 py-2.5 text-[11px] font-semibold text-[#64748B] uppercase tracking-wider">Name</th>
                      <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-[#64748B] uppercase tracking-wider">Title</th>
                      <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-[#64748B] uppercase tracking-wider">Email</th>
                      <th className="px-3 py-2.5 w-16" />
                    </tr>
                  </thead>
                  <tbody>
                    {teamMembers.map((m, i) => (
                      <tr key={m.id} className={`${i < teamMembers.length - 1 ? "border-b border-[#E2E8F0]" : ""} hover:bg-[#FDF0E8]/[0.03] transition-colors group`}>
                        <td className="px-5 py-3 text-[13px] font-medium text-[#0F172A]">{m.name}</td>
                        <td className="px-3 py-3 text-[13px] text-[#64748B]">{m.title ?? <span className="text-[#64748B]">—</span>}</td>
                        <td className="px-3 py-3 text-[13px] text-[#64748B]">{m.email ?? <span className="text-[#64748B]">—</span>}</td>
                        <td className="px-3 py-3">
                          <div className="flex items-center gap-1.5 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              onClick={() => openEditMember(m)}
                              className="p-1 rounded text-[#64748B] hover:text-[#0F172A] hover:bg-[#FDF0E8]/[0.08] transition-colors"
                              title="Edit"
                            >
                              <PencilIcon />
                            </button>
                            <button
                              onClick={() => deleteMember(m)}
                              className="p-1 rounded text-[#64748B] hover:text-red-400 hover:bg-[#FDF0E8]/[0.08] transition-colors"
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
              <div className={`text-center text-[13px] ${teamMessage.ok ? "text-[#7B9BB5]" : "text-red-400"}`}>
                {teamMessage.text}
              </div>
            )}
          </div>
        )}

        {activeTab === "projects" && (
          <div className="space-y-4">
            <div className="bg-[#F9E8DA] rounded-xl border border-[#E2E8F0] overflow-hidden">
              <div className="flex items-center justify-between px-5 py-4 border-b border-[#E2E8F0]">
                <div>
                  <h2 className="text-[14px] font-semibold text-[#0F172A]">Projects</h2>
                  <p className="text-[12px] text-[#64748B] mt-0.5">Projects available when generating submittal cover sheets.</p>
                </div>
                {!showProjectForm && !projectImportRows && (
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      onClick={() => projectCsvInputRef.current?.click()}
                      className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] hover:bg-[#FDF0E8]/[0.05] transition-colors flex items-center gap-1.5"
                    >
                      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                      </svg>
                      Import CSV
                    </button>
                    <button
                      onClick={openAddProject}
                      className="h-8 px-3 rounded-md bg-[#7B9BB5] text-white text-[13px] font-medium hover:bg-[#6A8AA4] transition-colors flex items-center gap-1.5"
                    >
                      <PlusIcon /> Add project
                    </button>
                  </div>
                )}
              </div>
              <input ref={projectCsvInputRef} type="file" accept=".csv,text/csv" onChange={handleProjectCsvChange} className="hidden" />

              {showProjectForm && (
                <div className="px-5 py-4 border-b border-[#E2E8F0] bg-[#FDF0E8]/50">
                  <p className="text-[13px] font-semibold text-[#0F172A] mb-3">
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
                        className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:text-[#0F172A] hover:bg-[#FDF0E8]/[0.05] transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={savingProject || !projectForm.name.trim()}
                        className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50"
                      >
                        {savingProject ? "Saving…" : editingProject ? "Save changes" : "Add project"}
                      </button>
                    </div>
                  </form>
                </div>
              )}

              {projectImportRows && (
                <div className="border-b border-[#E2E8F0] bg-[#FDF0E8]/50">
                  <div className="px-5 py-3 flex items-center justify-between">
                    <div className="text-[13px] font-semibold text-[#0F172A]">
                      Preview — {projectImportRows.length} row{projectImportRows.length !== 1 ? "s" : ""}
                      {projectImportRows.filter(r => !r.name).length > 0 && (
                        <span className="ml-2 text-[12px] font-normal text-amber-400">
                          ({projectImportRows.filter(r => !r.name).length} missing name — will be skipped)
                        </span>
                      )}
                    </div>
                    <button
                      onClick={downloadProjectTemplate}
                      className="text-[11px] text-[#7B9BB5] hover:text-[#7B9BB5] transition-colors"
                    >
                      Download template
                    </button>
                  </div>
                  <div className="overflow-x-auto max-h-60 overflow-y-auto">
                    <table className="w-full">
                      <thead className="sticky top-0 bg-[#FDF0E8]">
                        <tr className="border-b border-[#E2E8F0]">
                          <th className="text-left px-5 py-2 text-[11px] font-semibold text-[#64748B] uppercase tracking-wider">Name</th>
                          <th className="text-left px-3 py-2 text-[11px] font-semibold text-[#64748B] uppercase tracking-wider">No.</th>
                          <th className="text-left px-3 py-2 text-[11px] font-semibold text-[#64748B] uppercase tracking-wider">Location</th>
                          <th className="text-left px-3 py-2 text-[11px] font-semibold text-[#64748B] uppercase tracking-wider">GC</th>
                          <th className="text-left px-3 py-2 text-[11px] font-semibold text-[#64748B] uppercase tracking-wider">Architect</th>
                        </tr>
                      </thead>
                      <tbody>
                        {projectImportRows.map((r, i) => (
                          <tr key={i} className={`border-b border-[#E2E8F0]/50 ${!r.name ? "bg-red-500/5" : ""}`}>
                            <td className="px-5 py-2 text-[13px]">
                              {r.name
                                ? <span className="text-[#0F172A]">{r.name}</span>
                                : <span className="text-red-400 italic">missing</span>}
                            </td>
                            <td className="px-3 py-2 text-[13px] text-[#64748B]">{r.number || <span className="text-[#64748B]">—</span>}</td>
                            <td className="px-3 py-2 text-[13px] text-[#64748B]">{r.location || <span className="text-[#64748B]">—</span>}</td>
                            <td className="px-3 py-2 text-[13px] text-[#64748B]">{r.gc_name || <span className="text-[#64748B]">—</span>}</td>
                            <td className="px-3 py-2 text-[13px] text-[#64748B]">{r.architect || <span className="text-[#64748B]">—</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="px-5 py-3 flex items-center justify-between border-t border-[#E2E8F0]">
                    <span className="text-[12px] text-[#64748B]">
                      {projectImportRows.filter(r => r.name).length} of {projectImportRows.length} rows will be imported
                    </span>
                    <div className="flex gap-2">
                      <button
                        onClick={cancelProjectImport}
                        disabled={projectImporting}
                        className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:text-[#0F172A] hover:bg-[#FDF0E8]/[0.05] transition-colors disabled:opacity-50"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={confirmProjectImport}
                        disabled={projectImporting || !projectImportRows.filter(r => r.name).length}
                        className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50"
                      >
                        {projectImporting ? "Importing…" : `Import ${projectImportRows.filter(r => r.name).length} project${projectImportRows.filter(r => r.name).length !== 1 ? "s" : ""}`}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {projectImportResult && projectImportResult.errors.length > 0 && (
                <div className="px-5 py-3 border-b border-[#E2E8F0] bg-red-500/5">
                  <p className="text-[12px] font-semibold text-red-400 mb-1">Some rows failed:</p>
                  {projectImportResult.errors.map((e, i) => (
                    <p key={i} className="text-[12px] text-red-400/80">{e}</p>
                  ))}
                </div>
              )}

              {projectsLoading && (
                <div className="px-5 py-4 text-[13px] text-[#64748B]">Loading…</div>
              )}

              {!projectsLoading && projects.length === 0 && !projectImportRows && (
                <div className="px-5 py-6 text-center space-y-2">
                  <p className="text-[13px] text-[#64748B]">No projects yet.</p>
                  <button onClick={downloadProjectTemplate} className="text-[12px] text-[#7B9BB5] hover:text-[#7B9BB5] transition-colors">
                    Download CSV template
                  </button>
                </div>
              )}

              {!projectsLoading && projects.length > 0 && (
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-[#E2E8F0]">
                      <th className="text-left px-5 py-2.5 text-[11px] font-semibold text-[#64748B] uppercase tracking-wider">Name</th>
                      <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-[#64748B] uppercase tracking-wider">No.</th>
                      <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-[#64748B] uppercase tracking-wider">Location</th>
                      <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-[#64748B] uppercase tracking-wider">GC</th>
                      <th className="px-3 py-2.5 w-16" />
                    </tr>
                  </thead>
                  <tbody>
                    {projects.map((p, i) => (
                      <tr key={p.id} className={`${i < projects.length - 1 ? "border-b border-[#E2E8F0]" : ""} hover:bg-[#FDF0E8]/[0.03] transition-colors group`}>
                        <td className="px-5 py-3 text-[13px] font-medium text-[#0F172A]">{p.name}</td>
                        <td className="px-3 py-3 text-[13px] text-[#64748B]">{p.number ?? <span className="text-[#64748B]">—</span>}</td>
                        <td className="px-3 py-3 text-[13px] text-[#64748B]">{p.location ?? <span className="text-[#64748B]">—</span>}</td>
                        <td className="px-3 py-3 text-[13px] text-[#64748B]">{p.gc_name ?? <span className="text-[#64748B]">—</span>}</td>
                        <td className="px-3 py-3">
                          <div className="flex items-center gap-1.5 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              onClick={() => openEditProject(p)}
                              className="p-1 rounded text-[#64748B] hover:text-[#0F172A] hover:bg-[#FDF0E8]/[0.08] transition-colors"
                              title="Edit"
                            >
                              <PencilIcon />
                            </button>
                            <button
                              onClick={() => deleteProject(p)}
                              className="p-1 rounded text-[#64748B] hover:text-red-400 hover:bg-[#FDF0E8]/[0.08] transition-colors"
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
              <div className={`text-center text-[13px] ${projectMessage.ok ? "text-[#7B9BB5]" : "text-red-400"}`}>
                {projectMessage.text}
              </div>
            )}
          </div>
        )}

        {activeTab === "gmail" && (
          <div className="space-y-4">
            {gmailLoading ? (
              <div className="text-[13px] text-[#64748B]">Loading…</div>
            ) : (
              <>
                <div className="bg-[#F9E8DA] rounded-xl border border-[#E2E8F0] p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h2 className="text-[14px] font-semibold text-[#0F172A] mb-0.5">Gmail Integration</h2>
                      <p className="text-[12px] text-[#64748B]">
                        Connect a Gmail account so TuttoHQ can receive submittal files sent to that inbox.
                      </p>
                    </div>
                    <div className={`flex-shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border ${
                      gmailConn?.connected
                        ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
                        : "bg-[#FDF0E8] border-[#E2E8F0] text-[#64748B]"
                    }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${gmailConn?.connected ? "bg-emerald-400" : "bg-[#64748B]"}`} />
                      {gmailConn?.connected ? "Connected" : "Not connected"}
                    </div>
                  </div>

                  {gmailConn?.connected ? (
                    <div className="mt-5 space-y-4">
                      <div className="bg-[#FDF0E8] rounded-lg border border-[#E2E8F0] divide-y divide-[#E2E8F0]">
                        <div className="flex items-center justify-between px-4 py-3">
                          <span className="text-[12px] text-[#64748B]">Connected account</span>
                          <span className="text-[13px] text-[#0F172A] font-medium">{gmailConn.gmail_address}</span>
                        </div>
                        {gmailConn.created_at && (
                          <div className="flex items-center justify-between px-4 py-3">
                            <span className="text-[12px] text-[#64748B]">Connected since</span>
                            <span className="text-[13px] text-[#64748B]">
                              {new Date(gmailConn.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                            </span>
                          </div>
                        )}
                        <div className="flex items-center justify-between px-4 py-3">
                          <span className="text-[12px] text-[#64748B]">Push notifications</span>
                          <div className="flex items-center gap-2">
                            {gmailConn.watch_expiry ? (
                              <span className="text-[13px] text-[#64748B]">
                                active until {new Date(gmailConn.watch_expiry).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                              </span>
                            ) : (
                              <span className="text-[13px] text-amber-400">Not active</span>
                            )}
                            <button
                              onClick={renewWatch}
                              disabled={renewingWatch}
                              className="text-[11px] text-[#7B9BB5] hover:text-[#7B9BB5] disabled:opacity-50 transition-colors"
                            >
                              {renewingWatch ? "Setting up…" : gmailConn.watch_expiry ? "Renew" : "Set up"}
                            </button>
                          </div>
                        </div>
                      </div>

                      <div className="flex gap-2">
                        <a
                          href="/api/auth/gmail"
                          className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] hover:bg-[#FDF0E8]/[0.05] transition-colors inline-flex items-center"
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
                        className="inline-flex items-center gap-2 h-9 px-5 rounded-md bg-[#7B9BB5] text-white text-[13px] font-medium hover:bg-[#6A8AA4] transition-colors"
                      >
                        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z" />
                        </svg>
                        Connect Gmail account
                      </a>
                    </div>
                  )}
                </div>

                <div className="bg-[#F9E8DA] rounded-xl border border-[#E2E8F0] p-5">
                  <h2 className="text-[14px] font-semibold text-[#0F172A] mb-3">Setup Instructions</h2>
                  <ol className="space-y-3 text-[13px] text-[#64748B]">
                    <li className="flex gap-3">
                      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-[#7B9BB5]/20 text-[#7B9BB5] text-[11px] font-semibold flex items-center justify-center">1</span>
                      <span>Click <strong className="text-[#0F172A]">Connect Gmail account</strong> above and sign in with the Gmail account you want TuttoHQ to monitor.</span>
                    </li>
                    <li className="flex gap-3">
                      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-[#7B9BB5]/20 text-[#7B9BB5] text-[11px] font-semibold flex items-center justify-center">2</span>
                      <span>Grant the requested permissions — TuttoHQ needs read access to detect incoming submittals and the ability to label or archive processed emails.</span>
                    </li>
                    <li className="flex gap-3">
                      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-[#7B9BB5]/20 text-[#7B9BB5] text-[11px] font-semibold flex items-center justify-center">3</span>
                      <span>
                        In Google Cloud Console, create a Pub/Sub topic and a push subscription. Set the push endpoint to:
                        <code className="block mt-1.5 px-2.5 py-1.5 rounded bg-[#FDF0E8] border border-[#E2E8F0] text-[11px] text-[#0F172A] font-mono break-all">
                          {process.env.NEXT_PUBLIC_APP_URL}/api/gmail-intake?token=<span className="text-[#64748B]">&lt;GMAIL_WEBHOOK_SECRET&gt;</span>
                        </code>
                        Set <code className="text-[#0F172A]">GMAIL_WEBHOOK_SECRET</code> and <code className="text-[#0F172A]">GOOGLE_PUBSUB_TOPIC</code> as environment variables in your deployment.
                      </span>
                    </li>
                    <li className="flex gap-3">
                      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-[#7B9BB5]/20 text-[#7B9BB5] text-[11px] font-semibold flex items-center justify-center">4</span>
                      <span>Once configured, any email with a PDF or Word attachment sent to the connected Gmail account will be automatically classified and added to the Submittal log.</span>
                    </li>
                    <li className="flex gap-3">
                      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-[#7B9BB5]/20 text-[#7B9BB5] text-[11px] font-semibold flex items-center justify-center">5</span>
                      <span>Push notification subscriptions expire every 7 days. TuttoHQ auto-renews them on each incoming notification — you can also manually renew from the connection details above.</span>
                    </li>
                  </ol>
                </div>
              </>
            )}

            {gmailMessage && (
              <div className={`text-center text-[13px] ${gmailMessage.ok ? "text-[#7B9BB5]" : "text-red-400"}`}>
                {gmailMessage.text}
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  )
}
