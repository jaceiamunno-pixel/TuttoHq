"use client"

import { useState, useEffect, useRef } from "react"
import type { CloseoutItem, SubmittalRecord, RFI, ChangeOrder, DrawingRecord, PunchItem, TeamMember, ProjectVendorRow, Project } from "../_shared/types"
import { PlusIcon, SpinnerIcon, XIcon, CheckIcon } from "../_shared/icons"
import { inputCls, labelCls } from "../_shared/ui"
import { presignAndUpload } from "@/lib/storage-upload"
import { isFeatureEnabled } from "@/lib/features"
import { RowActions } from "@/components/RowActions"
import CloseoutPackageCreateModal from "@/components/closeout-packages/CloseoutPackageCreateModal"
import CloseoutPackagesView from "@/components/closeout-packages/CloseoutPackagesView"

// Closeout module — extracted verbatim from dashboard/page.tsx (Step 8 of the split).
// Two differences from the inline original:
//  - the load effect keys on globalProjectId (the module mounts only when active)
//  - cross-module navigation ("Go to →" buttons) goes through onNavigate, and the
//    sidebar progress badge is fed via onProgress, since both live in the shell.

export default function CloseoutModule({ globalProjectId, appProjects, teamMembers, onProgress, onNavigate }: {
  globalProjectId: string
  appProjects: Project[]
  teamMembers: TeamMember[]
  onProgress: (pct: number | null) => void
  onNavigate: (module: "punch" | "submittals" | "rfis" | "changeorders" | "drawings") => void
}) {
  // Closeout
  const [closeoutItems, setCloseoutItems]         = useState<CloseoutItem[]>([])
  const [closeoutPunch, setCloseoutPunch]         = useState<PunchItem[]>([])
  const [closeoutSubmittals, setCloseoutSubmittals] = useState<SubmittalRecord[]>([])
  const [closeoutRFIs, setCloseoutRFIs]           = useState<RFI[]>([])
  const [closeoutCOs, setCloseoutCOs]             = useState<ChangeOrder[]>([])
  const [closeoutDrawings, setCloseoutDrawings]   = useState<DrawingRecord[]>([])
  // Full sets (all records, not just pending)
  const [closeoutAllSubmittals, setCloseoutAllSubmittals] = useState<SubmittalRecord[]>([])
  const [closeoutAllRFIs, setCloseoutAllRFIs]     = useState<RFI[]>([])
  const [closeoutAllCOs, setCloseoutAllCOs]       = useState<ChangeOrder[]>([])
  const [closeoutAllDrawings, setCloseoutAllDrawings] = useState<DrawingRecord[]>([])
  const [closeoutAllPunch, setCloseoutAllPunch]   = useState<PunchItem[]>([])
  const [closeoutTeam, setCloseoutTeam]           = useState<{id:string;name:string;title:string|null}[]>([])
  const [closeoutLoading, setCloseoutLoading]     = useState(false)
  const [closeoutIniting, setCloseoutIniting]         = useState(false)
  const [closeoutGenerating, setCloseoutGenerating]   = useState(false)
  const [closeoutResetting, setCloseoutResetting]     = useState(false)
  const [closeoutResetConfirm, setCloseoutResetConfirm] = useState(false)
  const [closeoutEditId, setCloseoutEditId]       = useState<string | null>(null)
  const [closeoutEditTitle, setCloseoutEditTitle] = useState("")
  const [closeoutEditAssigned, setCloseoutEditAssigned] = useState("")
  const [closeoutEditDue, setCloseoutEditDue]     = useState("")
  const [closeoutEditNotes, setCloseoutEditNotes] = useState("")
  const [showNewCloseout, setShowNewCloseout]     = useState(false)
  const [newCloseoutCategory, setNewCloseoutCategory] = useState("documents")
  const [newCloseoutTitle, setNewCloseoutTitle]   = useState("")
  const [newCloseoutAssigned, setNewCloseoutAssigned] = useState("")
  const [newCloseoutDue, setNewCloseoutDue]       = useState("")
  const [newCloseoutFolder, setNewCloseoutFolder] = useState("")
  const [showAddFolder, setShowAddFolder]         = useState(false)
  const [newFolderName, setNewFolderName]         = useState("")
  const [newFolderType, setNewFolderType]         = useState<"subcontractors"|"suppliers">("subcontractors")
  const closeoutFileRef = useRef<HTMLInputElement>(null)
  const [closeoutUploadingId, setCloseoutUploadingId] = useState<string | null>(null)

  // ─── Closeout packages (Session K1) ────────────────────────────────────────
  // Items | Packages tab; Select mode on Items adds checkboxes and a Create
  // Package button that opens CloseoutPackageCreateModal.
  const [view, setView]                       = useState<"items" | "packages">("items")
  const [selectMode, setSelectMode]           = useState(false)
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set())
  const [showPackageModal, setShowPackageModal] = useState(false)
  const [subs, setSubs]           = useState<ProjectVendorRow[]>([])
  const [suppliers, setSuppliers] = useState<ProjectVendorRow[]>([])
  const projectName = appProjects.find(p => p.id === globalProjectId)?.name ?? "Project"

  function toggleItemSelected(id: string) {
    setSelectedItemIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  function exitSelectMode() { setSelectMode(false); setSelectedItemIds(new Set()) }
  const selectedItems = closeoutItems.filter(i => selectedItemIds.has(i.id))

  function loadCloseout() {
    if (!globalProjectId) {
      setCloseoutItems([]); setCloseoutPunch([]); setCloseoutSubmittals([])
      setCloseoutRFIs([]); setCloseoutCOs([]); setCloseoutDrawings([])
      setCloseoutAllSubmittals([]); setCloseoutAllRFIs([]); setCloseoutAllCOs([])
      setCloseoutAllDrawings([]); setCloseoutAllPunch([]); setCloseoutTeam([])
      onProgress(null)
      return
    }
    setCloseoutLoading(true)
    fetch(`/api/closeout?project_id=${encodeURIComponent(globalProjectId)}`)
      .then(r => r.json())
      .then(d => {
        const items: CloseoutItem[] = d.items ?? []
        setCloseoutItems(items)
        setCloseoutAllPunch(d.all_punch ?? [])
        setCloseoutAllSubmittals(d.all_submittals ?? [])
        setCloseoutAllRFIs(d.all_rfis ?? [])
        setCloseoutAllCOs(d.all_cos ?? [])
        setCloseoutAllDrawings(d.all_drawings ?? [])
        setCloseoutSubmittals(d.pending_submittals ?? [])
        setCloseoutRFIs(d.pending_rfis ?? [])
        setCloseoutCOs(d.pending_cos ?? [])
        setCloseoutDrawings(d.pending_drawings ?? [])
        setCloseoutPunch(d.all_punch?.filter((p: PunchItem) => p.status !== "Completed") ?? [])
        setCloseoutTeam(d.team_members ?? [])
        onProgress(items.length > 0 ? Math.round(items.filter(i => i.status === "complete").length / items.length * 100) : null)
      })
      .catch(() => {})
      .finally(() => setCloseoutLoading(false))
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadCloseout() }, [globalProjectId])

  // Load vendor lists once per project — used by the package create modal's
  // vendor picker. Project name is derived from appProjects prop.
  useEffect(() => {
    if (!globalProjectId) {
      setSubs([]); setSuppliers([])
      exitSelectMode(); setView("items")
      return
    }
    fetch(`/api/projects/${globalProjectId}/subcontractors`)
      .then(r => r.ok ? r.json() : [])
      .then(d => setSubs(Array.isArray(d) ? d : []))
      .catch(() => {})
    fetch(`/api/projects/${globalProjectId}/suppliers`)
      .then(r => r.ok ? r.json() : [])
      .then(d => setSuppliers(Array.isArray(d) ? d : []))
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalProjectId])

  async function updateCloseoutItem(id: string, updates: Record<string, unknown>) {
    await fetch(`/api/closeout/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(updates) })
    loadCloseout()
  }

  async function deleteCloseoutItem(id: string) {
    await fetch(`/api/closeout/${id}`, { method: "DELETE" })
    loadCloseout()
  }

  async function addCloseoutFolder() {
    if (!newFolderName.trim() || !globalProjectId) return
    const folderItems = newFolderType === "subcontractors"
      ? [
          { title: "Workmanship Warranty",       item_type: "workmanship_warranty" },
          { title: "Conditional Lien Waiver",    item_type: "lien_waiver_conditional" },
          { title: "Unconditional Lien Waiver",  item_type: "lien_waiver_unconditional" },
          { title: "Final Pay Application",      item_type: "final_pay_app" },
          { title: "Insurance Certificate",      item_type: "insurance_cert" },
          { title: "Subcontractor Contact Sheet", item_type: "contact_sheet" },
        ]
      : [
          { title: "Material Warranty",    item_type: "material_warranty" },
          { title: "O&M Manual",           item_type: "om_manual" },
          { title: "Product Data Sheets",  item_type: "product_data_sheets" },
          { title: "Supplier Contact Sheet", item_type: "contact_sheet" },
        ]
    const maxOrder = closeoutItems.filter(i => i.category === newFolderType).reduce((m, i) => Math.max(m, i.sort_order), 0)
    let idx = maxOrder + 1
    for (const item of folderItems) {
      await fetch("/api/closeout", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: globalProjectId, category: newFolderType, item_type: item.item_type, title: item.title, folder_name: newFolderName.trim(), sort_order: idx++, status: "incomplete" }),
      })
    }
    setShowAddFolder(false); setNewFolderName(""); setNewFolderType("subcontractors")
    loadCloseout()
  }

  async function addCloseoutItem() {
    if (!newCloseoutTitle.trim() || !globalProjectId) return
    const maxOrder = closeoutItems.filter(i => i.category === newCloseoutCategory && (!newCloseoutFolder || i.folder_name === newCloseoutFolder)).reduce((m, i) => Math.max(m, i.sort_order), 0)
    await fetch("/api/closeout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: globalProjectId,
        category: newCloseoutCategory,
        folder_name: newCloseoutFolder || null,
        item_type: "custom",
        title: newCloseoutTitle.trim(),
        assigned_to: newCloseoutAssigned || null,
        due_date: newCloseoutDue || null,
        sort_order: maxOrder + 10,
      }),
    })
    setShowNewCloseout(false)
    setNewCloseoutTitle("")
    setNewCloseoutAssigned("")
    setNewCloseoutDue("")
    setNewCloseoutFolder("")
    loadCloseout()
  }

  async function uploadCloseoutFile(itemId: string, file: File) {
    setCloseoutUploadingId(itemId)
    try {
      const { path } = await presignAndUpload("submittals", `closeout/${itemId}`, file)
      await fetch(`/api/closeout/${itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_url: path, file_name: file.name }),
      })
      loadCloseout()
    } finally {
      setCloseoutUploadingId(null)
    }
  }

  return (
    <>
      {/* Closeout action bar */}
      <div className="flex-shrink-0 border-b border-[#E2E8F0] bg-white px-4 py-2.5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <p className="text-[13px] font-semibold text-[#0F172A]">Project Closeout</p>
          {/* Items | Packages tab (Session K1) */}
          {globalProjectId && (
            <div className="inline-flex items-center rounded-md border border-[#E2E8F0] overflow-hidden">
              {(["items", "packages"] as const).map(v => (
                <button key={v} onClick={() => { setView(v); if (v === "packages") exitSelectMode() }}
                  className={`h-7 px-3 text-[12px] font-medium transition-colors ${view === v ? "bg-[#7B9BB5] text-white" : "bg-white text-[#64748B] hover:bg-[#F8F9FA]"}`}>
                  {v === "items" ? "Items" : "Packages"}
                </button>
              ))}
            </div>
          )}
          {globalProjectId && closeoutItems.length > 0 && view === "items" && (() => {
            const total   = closeoutItems.length + closeoutPunch.length + closeoutSubmittals.length + closeoutRFIs.length + closeoutCOs.length + closeoutDrawings.length
            const complete = closeoutItems.filter(i => i.status === "complete").length
            const pct = total > 0 ? Math.round((complete / total) * 100) : 0
            return <span className="text-[11px] text-[#64748B]">{pct}% complete</span>
          })()}
        </div>
        {globalProjectId && view === "items" && closeoutItems.length > 0 && (
          closeoutResetConfirm ? (
            <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-1.5 flex-wrap">
              <span className="text-[12px] text-red-600 font-medium">Reset all closeout items?</span>
              <button
                disabled={closeoutResetting}
                onClick={async () => {
                  setCloseoutResetting(true)
                  await fetch("/api/closeout/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project_id: globalProjectId }) })
                  setCloseoutResetConfirm(false)
                  setCloseoutResetting(false)
                  loadCloseout()
                }}
                className="text-[12px] font-semibold text-white bg-red-500 hover:bg-red-600 px-2.5 py-1 rounded transition-colors disabled:opacity-50 flex items-center gap-1"
              >
                {closeoutResetting ? <SpinnerIcon className="h-3 w-3" /> : null}
                Yes, Reset
              </button>
              <button onClick={() => setCloseoutResetConfirm(false)} className="text-[12px] text-[#64748B] hover:text-[#0F172A] transition-colors">Cancel</button>
            </div>
          ) : (
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => { if (selectMode) exitSelectMode(); else setSelectMode(true) }}
                className={`h-8 px-3 rounded-md border text-[12px] font-semibold transition-colors flex items-center gap-1.5 ${
                  selectMode
                    ? "border-[#7B9BB5] bg-[#7B9BB5]/10 text-[#0F172A]"
                    : "border-[#E2E8F0] text-[#64748B] hover:text-[#0F172A]"
                }`}
              >
                <CheckIcon /> {selectMode ? "Done" : "Select"}
              </button>
              <button onClick={() => setShowNewCloseout(true)} className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[#64748B] text-[12px] font-semibold hover:text-[#0F172A] transition-colors flex items-center gap-1.5">
                <PlusIcon /> Add Item
              </button>
              <button onClick={() => setShowAddFolder(true)} className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[#64748B] text-[12px] font-semibold hover:text-[#0F172A] transition-colors flex items-center gap-1.5">
                <PlusIcon /> Add Folder
              </button>
              <button onClick={() => setCloseoutResetConfirm(true)} className="h-8 px-3 rounded-md border border-red-200 text-red-400 text-[12px] font-semibold hover:bg-red-50 hover:text-red-500 transition-colors">
                Reset
              </button>
              <button
                disabled={closeoutGenerating}
                onClick={async () => {
                  setCloseoutGenerating(true)
                  const res = await fetch("/api/closeout/pdf", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project_id: globalProjectId }) })
                  const d = await res.json()
                  if (d.url) window.open(d.url, "_blank")
                  setCloseoutGenerating(false)
                }}
                className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors flex items-center gap-1.5 disabled:opacity-50"
              >
                {closeoutGenerating ? <><SpinnerIcon className="h-3.5 w-3.5" /> Generating…</> : "Package"}
              </button>
            </div>
          )
        )}
      </div>

      {/* ── Closeout module ───────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {/* Packages tab — outbound dispatch + match-back (Session K1) */}
        {view === "packages" && globalProjectId && (
          <CloseoutPackagesView projectId={globalProjectId} />
        )}
        {/* Select-mode toolbar — only on Items tab */}
        {view === "items" && selectMode && globalProjectId && closeoutItems.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-[#E2E8F0] bg-[#F1F5F9]">
            <span className="text-[12px] font-semibold text-[#0F172A] whitespace-nowrap">
              {selectedItemIds.size} selected
            </span>
            <span className="text-[#CBD5E1]">·</span>
            <button onClick={() => setSelectedItemIds(new Set(closeoutItems.map(i => i.id)))}
              className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[12px] text-[#64748B] hover:bg-white transition-colors">
              Select all
            </button>
            <button onClick={() => setSelectedItemIds(new Set())} disabled={selectedItemIds.size === 0}
              className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[12px] text-[#64748B] hover:bg-white transition-colors disabled:opacity-50">
              Clear
            </button>
            <p className="text-[11px] text-[#64748B] hidden sm:block flex-1 min-w-[8px]">
              Tick items below to bundle into a closeout package, then click Create Package.
            </p>
            <button disabled={selectedItemIds.size === 0} onClick={() => setShowPackageModal(true)}
              className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[12px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 whitespace-nowrap">
              <PlusIcon /> Create Package
            </button>
          </div>
        )}
        {/* Select-mode flat picker — overlays a checkbox list of all closeout
            items above the existing rich UI so the PM can pick across
            categories without scrolling through the dashboard. */}
        {view === "items" && selectMode && globalProjectId && closeoutItems.length > 0 && (
          <div className="px-4 pt-4">
            <div className="rounded-xl border border-[#E2E8F0] overflow-clip bg-white">
              <div className="px-4 py-2 bg-[#F8F9FA] border-b border-[#E2E8F0]">
                <p className="text-[12px] font-bold text-[#0F172A]">Select items for a closeout package</p>
              </div>
              <div className="max-h-80 overflow-y-auto divide-y divide-[#E2E8F0]/60">
                {closeoutItems.map(i => {
                  const checked = selectedItemIds.has(i.id)
                  const catLabel = i.folder_name ? `${i.category} · ${i.folder_name}` : i.category
                  return (
                    <label key={i.id}
                      className={`flex items-center gap-3 px-4 py-2 cursor-pointer hover:bg-[#F8F9FA] ${checked ? "bg-[#7B9BB5]/5" : ""}`}>
                      <input type="checkbox" checked={checked} onChange={() => toggleItemSelected(i.id)}
                        className="accent-[#7B9BB5]" />
                      <span className="flex-1 text-[13px] text-[#0F172A] truncate" title={i.title}>{i.title}</span>
                      <span className="text-[11px] text-[#64748B] hidden sm:inline">{catLabel}</span>
                      <span className="text-[11px] text-[#64748B] w-20 text-right capitalize">{i.status.replace("_", " ")}</span>
                    </label>
                  )
                })}
              </div>
            </div>
          </div>
        )}
        {view === "items" && (() => {
            const cycleStatus  = (s: string) => s === "incomplete" ? "in_progress" : s === "in_progress" ? "complete" : "incomplete"
            const dotColor     = (s: string) => s === "complete" ? "#10b981" : s === "in_progress" ? "#f59e0b" : "#ef4444"
            const labelColor   = (s: string) => s === "complete" ? "text-emerald-400" : s === "in_progress" ? "text-amber-400" : "text-red-400"
            const statusLabel  = (s: string) => s === "complete" ? "Complete" : s === "in_progress" ? "In Progress" : "Incomplete"
            // Dynamic document counts
            const approvedSubs  = closeoutAllSubmittals.filter(s => s.review_status === "Approved").length
            const resolvedRFIs  = closeoutAllRFIs.filter(r => r.status === "Closed").length
            const approvedCOs   = closeoutAllCOs.filter(c => c.status === "Approved").length
            const asBuiltDwgs   = closeoutAllDrawings.filter(d => d.status === "As-Built").length
            const openPunchCount = closeoutAllPunch.filter(p => p.status !== "Completed").length
            const docStoredItems = closeoutItems.filter(i => i.category === "documents")
            const docStoredDone  = docStoredItems.filter(i => i.status === "complete").length
            const docTotal = docStoredItems.length + closeoutAllSubmittals.length + closeoutAllRFIs.length + closeoutAllCOs.length + closeoutAllDrawings.length
            const docDone  = docStoredDone + approvedSubs + resolvedRFIs + approvedCOs + asBuiltDwgs
            const subItems  = closeoutItems.filter(i => i.category === "subcontractors")
            const supplItems = closeoutItems.filter(i => i.category === "suppliers")
            const CATS = [
              { key: "documents",      label: "Documents",      total: docTotal, done: docDone },
              { key: "inspections",    label: "Inspections",    total: closeoutItems.filter(i=>i.category==="inspections").length,    done: closeoutItems.filter(i=>i.category==="inspections"&&i.status==="complete").length },
              { key: "warranties",     label: "Warranties",     total: closeoutItems.filter(i=>i.category==="warranties").length,     done: closeoutItems.filter(i=>i.category==="warranties"&&i.status==="complete").length },
              { key: "handover",       label: "Handover",       total: closeoutItems.filter(i=>i.category==="handover").length,       done: closeoutItems.filter(i=>i.category==="handover"&&i.status==="complete").length },
              { key: "subcontractors", label: "Subcontractors", total: subItems.length,  done: subItems.filter(i=>i.status==="complete").length },
              { key: "suppliers",      label: "Suppliers",      total: supplItems.length, done: supplItems.filter(i=>i.status==="complete").length },
              { key: "training",       label: "Training",       total: closeoutItems.filter(i=>i.category==="training").length,       done: closeoutItems.filter(i=>i.category==="training"&&i.status==="complete").length },
            ]
            return (
              <>
                <input ref={closeoutFileRef} type="file" className="hidden"
                  accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.xlsx,.xls"
                  onChange={async e => {
                    const file = e.target.files?.[0]
                    if (file && closeoutUploadingId) await uploadCloseoutFile(closeoutUploadingId, file)
                    if (closeoutFileRef.current) closeoutFileRef.current.value = ""
                  }}
                />

                {/* No project selected */}
                {!globalProjectId ? (
                  <div className="flex flex-col items-center justify-center h-full py-24 text-center">
                    <div className="w-14 h-14 rounded-2xl bg-[#7B9BB5]/10 border border-[#7B9BB5]/20 flex items-center justify-center mb-4">
                      <svg className="w-7 h-7 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>
                    </div>
                    <p className="text-[15px] font-bold text-[#0F172A]">Select a project to view closeout</p>
                    <p className="text-[13px] text-[#64748B] mt-1.5">Use the Project filter above to choose a project.</p>
                  </div>
                ) : closeoutLoading ? (
                  <div className="flex items-center justify-center h-40 gap-2 text-[13px] text-[#64748B]">
                    <SpinnerIcon className="h-4 w-4" /> Loading closeout data…
                  </div>
                ) : closeoutItems.length === 0 ? (
                  /* Not initialized */
                  <div className="flex flex-col items-center justify-center h-full py-24 text-center">
                    <div className="w-14 h-14 rounded-2xl bg-[#7B9BB5]/10 border border-[#7B9BB5]/20 flex items-center justify-center mb-4">
                      <svg className="w-7 h-7 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>
                    </div>
                    <p className="text-[15px] font-bold text-[#0F172A]">Closeout not started</p>
                    <p className="text-[13px] text-[#64748B] mt-1.5 max-w-xs">Initialize the closeout checklist to start tracking documents, inspections, and handover items for this project.</p>
                    <button
                      disabled={closeoutIniting}
                      onClick={async () => {
                        setCloseoutIniting(true)
                        await fetch("/api/closeout/init", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project_id: globalProjectId }) })
                        loadCloseout()
                        setCloseoutIniting(false)
                      }}
                      className="mt-6 h-9 px-5 rounded-lg bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors inline-flex items-center gap-2 disabled:opacity-50"
                    >
                      {closeoutIniting ? <><SpinnerIcon className="h-3.5 w-3.5" /> Initializing…</> : "Initialize Closeout Checklist"}
                    </button>
                  </div>
                ) : (
                  /* Main closeout dashboard */
                  <div className="p-4 space-y-4">

                    {/* Punch list banner — blocks 100% if open items.
                        Suppressed while the Punch List feature is hidden so it
                        doesn't surface a link to a hidden section. */}
                    {isFeatureEnabled("punchList") && openPunchCount > 0 && (
                      <div className="flex items-center gap-3 px-4 py-2.5 rounded-lg bg-red-500/10 border border-red-500/30">
                        <div className="w-2 h-2 rounded-full bg-red-400 flex-shrink-0" />
                        <span className="text-[12px] text-red-400 font-medium flex-1">{openPunchCount} open punch list item{openPunchCount !== 1 ? "s" : ""} — closeout cannot reach 100% until all punch items are closed.</span>
                        <button onClick={() => onNavigate("punch")} className="text-[11px] text-[#7B9BB5] hover:text-[#7B9BB5] transition-colors flex-shrink-0">Go to Punch →</button>
                      </div>
                    )}

                    {/* Progress cards */}
                    <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                      {CATS.map(cat => {
                        const pct   = cat.total > 0 ? Math.round((cat.done / cat.total) * 100) : 100
                        const color = pct >= 80 ? "#10b981" : pct >= 50 ? "#f59e0b" : "#ef4444"
                        return (
                          <div key={cat.key} className="bg-white rounded-xl border border-[#E2E8F0] p-3">
                            <div className="text-[10px] font-bold text-[#64748B] uppercase tracking-wide mb-2">{cat.label}</div>
                            <div className="text-[26px] font-extrabold leading-none mb-1" style={{ color }}>{pct}%</div>
                            <div className="text-[10px] text-[#64748B] mb-2">{cat.done}/{cat.total}</div>
                            <div className="h-1 rounded-full bg-[#E2E8F0] overflow-hidden">
                              <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, backgroundColor: color }} />
                            </div>
                          </div>
                        )
                      })}
                    </div>

                    {/* ── DOCUMENTS ─────────────────────────────────────────── */}
                    {(() => {
                      const storedDocs = closeoutItems.filter(i => i.category === "documents")
                      return (
                        <div className="bg-white rounded-xl border border-[#E2E8F0] overflow-hidden">
                          <div className="flex items-center justify-between px-4 py-3 border-b border-[#E2E8F0]">
                            <div className="flex items-center gap-2">
                              <span className="text-[13px] font-bold text-[#0F172A]">Documents</span>
                              <span className="text-[11px] text-[#64748B]">{docDone}/{docTotal} complete</span>
                            </div>
                            <button onClick={() => { setNewCloseoutCategory("documents"); setShowNewCloseout(true) }} className="text-[11px] text-white/70 hover:text-white transition-colors flex items-center gap-1"><PlusIcon /> Add</button>
                          </div>

                          {/* Submittals sub-section */}
                          {closeoutAllSubmittals.length > 0 && (
                            <div className="border-b border-[#E2E8F0]/40">
                              <div className="flex items-center justify-between px-4 py-2 bg-white/30">
                                <span className="text-[11px] font-bold text-[#64748B] uppercase tracking-wider">Submittals ({approvedSubs}/{closeoutAllSubmittals.length} Approved)</span>
                                <button onClick={() => onNavigate("submittals")} className="text-[10px] text-[#7B9BB5] hover:text-[#7B9BB5]">View all →</button>
                              </div>
                              {closeoutAllSubmittals.map(s => {
                                const done = s.review_status === "Approved"
                                return (
                                  <div key={s.id} className="flex items-center gap-3 px-4 py-2 border-b border-[#E2E8F0]/20 last:border-0 hover:bg-[#0F172A]/[0.02]">
                                    <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: done ? "#10b981" : "#ef4444" }} />
                                    <span className="text-[11px] text-[#64748B] font-mono flex-shrink-0 w-16 truncate">{s.csi_section ?? s.csi_division ?? "—"}</span>
                                    <span className={`flex-1 text-[12px] truncate ${done ? "text-[#64748B] line-through" : "text-[#0F172A]"}`}>{s.file_name}</span>
                                    <span className={`text-[11px] font-semibold flex-shrink-0 ${done ? "text-emerald-400" : "text-amber-400"}`}>{s.review_status ?? "Not Started"}</span>
                                  </div>
                                )
                              })}
                            </div>
                          )}

                          {/* RFIs sub-section */}
                          {closeoutAllRFIs.length > 0 && (
                            <div className="border-b border-[#E2E8F0]/40">
                              <div className="flex items-center justify-between px-4 py-2 bg-white/30">
                                <span className="text-[11px] font-bold text-[#64748B] uppercase tracking-wider">RFIs ({resolvedRFIs}/{closeoutAllRFIs.length} Resolved)</span>
                                <button onClick={() => onNavigate("rfis")} className="text-[10px] text-[#7B9BB5] hover:text-[#7B9BB5]">View all →</button>
                              </div>
                              {closeoutAllRFIs.map(r => {
                                const done = r.status === "Closed"
                                return (
                                  <div key={r.id} className="flex items-center gap-3 px-4 py-2 border-b border-[#E2E8F0]/20 last:border-0 hover:bg-[#0F172A]/[0.02]">
                                    <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: done ? "#10b981" : "#f59e0b" }} />
                                    <span className="text-[11px] text-[#64748B] font-mono flex-shrink-0">{r.rfi_number}</span>
                                    <span className={`flex-1 text-[12px] truncate ${done ? "text-[#64748B] line-through" : "text-[#0F172A]"}`}>{r.subject}</span>
                                    <span className={`text-[11px] font-semibold flex-shrink-0 ${done ? "text-emerald-400" : "text-amber-400"}`}>{r.status}</span>
                                  </div>
                                )
                              })}
                            </div>
                          )}

                          {/* Change Orders sub-section */}
                          {closeoutAllCOs.length > 0 && (
                            <div className="border-b border-[#E2E8F0]/40">
                              <div className="flex items-center justify-between px-4 py-2 bg-white/30">
                                <span className="text-[11px] font-bold text-[#64748B] uppercase tracking-wider">Change Orders ({approvedCOs}/{closeoutAllCOs.length} Signed)</span>
                                <button onClick={() => onNavigate("changeorders")} className="text-[10px] text-[#7B9BB5] hover:text-[#7B9BB5]">View all →</button>
                              </div>
                              {closeoutAllCOs.map(c => {
                                const done = c.status === "Approved"
                                return (
                                  <div key={c.id} className="flex items-center gap-3 px-4 py-2 border-b border-[#E2E8F0]/20 last:border-0 hover:bg-[#0F172A]/[0.02]">
                                    <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: done ? "#10b981" : "#ef4444" }} />
                                    <span className="text-[11px] text-[#64748B] font-mono flex-shrink-0">CO-{c.co_number}</span>
                                    <span className={`flex-1 text-[12px] truncate ${done ? "text-[#64748B] line-through" : "text-[#0F172A]"}`}>{c.proposal ?? "—"}</span>
                                    <span className={`text-[11px] font-semibold flex-shrink-0 ${done ? "text-emerald-400" : "text-red-400"}`}>{c.status}</span>
                                  </div>
                                )
                              })}
                            </div>
                          )}

                          {/* Drawings sub-section */}
                          {closeoutAllDrawings.length > 0 && (
                            <div className="border-b border-[#E2E8F0]/40">
                              <div className="flex items-center justify-between px-4 py-2 bg-white/30">
                                <span className="text-[11px] font-bold text-[#64748B] uppercase tracking-wider">Drawings — As-Built ({asBuiltDwgs}/{closeoutAllDrawings.length} Confirmed)</span>
                                <button onClick={() => onNavigate("drawings")} className="text-[10px] text-[#7B9BB5] hover:text-[#7B9BB5]">View all →</button>
                              </div>
                              {closeoutAllDrawings.map(d => {
                                const done = d.status === "As-Built"
                                return (
                                  <div key={d.id} className="flex items-center gap-3 px-4 py-2 border-b border-[#E2E8F0]/20 last:border-0 hover:bg-[#0F172A]/[0.02]">
                                    <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: done ? "#10b981" : "#f59e0b" }} />
                                    <span className="text-[11px] text-[#64748B] font-mono flex-shrink-0 w-16 truncate">{d.drawing_number}</span>
                                    <span className={`flex-1 text-[12px] truncate ${done ? "text-[#64748B] line-through" : "text-[#0F172A]"}`}>{d.sheet_title}</span>
                                    <span className={`text-[11px] font-semibold flex-shrink-0 ${done ? "text-emerald-400" : "text-amber-400"}`}>{d.status}</span>
                                  </div>
                                )
                              })}
                            </div>
                          )}

                          {/* Stored doc items (O&M, startup, commissioning) */}
                          {storedDocs.map(item => {
                            const isEditing = closeoutEditId === item.id
                            const typeLabel = item.item_type === "om_manual" ? "O&M" : item.item_type === "startup" ? "Start-Up" : item.item_type === "commissioning" ? "Commission" : ""
                            return (
                              <div key={item.id} className="border-b border-[#E2E8F0]/40 last:border-0">
                                <div className={`flex items-center gap-3 px-4 py-3 hover:bg-[#0F172A]/[0.02] transition-colors ${isEditing ? "bg-[#0F172A]/[0.02]" : ""}`}>
                                  <button title={`Click to mark ${cycleStatus(item.status)}`} onClick={() => updateCloseoutItem(item.id, { status: cycleStatus(item.status) })}
                                    className="flex-shrink-0 w-5 h-5 rounded-full border-2 transition-all hover:scale-110"
                                    style={{ borderColor: dotColor(item.status), backgroundColor: item.status === "complete" ? dotColor(item.status) : "transparent" }} />
                                  {typeLabel && <span className="text-[10px] font-bold text-[#64748B] bg-[#F4F5F7] px-1.5 py-0.5 rounded flex-shrink-0">{typeLabel}</span>}
                                  <span className={`flex-1 text-[13px] font-medium truncate ${item.status === "complete" ? "text-[#64748B] line-through" : "text-[#0F172A]"}`}>{item.title}</span>
                                  <span className={`text-[11px] font-semibold flex-shrink-0 ${labelColor(item.status)}`}>{statusLabel(item.status)}</span>
                                  {item.file_name ? (
                                    <span className="text-[11px] text-emerald-400 flex-shrink-0 hidden lg:block truncate max-w-[100px]">attached</span>
                                  ) : (
                                    <button onClick={() => { setCloseoutUploadingId(item.id); closeoutFileRef.current?.click() }} disabled={closeoutUploadingId === item.id}
                                      className="text-[11px] text-[#64748B] hover:text-[#7B9BB5] flex-shrink-0 hidden lg:block disabled:opacity-50">
                                      {closeoutUploadingId === item.id ? "Uploading…" : "+ Doc"}
                                    </button>
                                  )}
                                  <RowActions className="flex-shrink-0" actions={[
                                    { label: isEditing ? "Close" : "Edit", onClick: () => { if (isEditing) { setCloseoutEditId(null); return } setCloseoutEditId(item.id); setCloseoutEditTitle(item.title); setCloseoutEditAssigned(item.assigned_to ?? ""); setCloseoutEditDue(item.due_date ?? ""); setCloseoutEditNotes(item.notes ?? "") } },
                                    { label: "Del", onClick: () => deleteCloseoutItem(item.id), variant: "danger" },
                                  ]} />
                                </div>
                                {isEditing && (
                                  <div className="px-4 pb-4 pt-2 border-t border-[#E2E8F0]/40 bg-white/30 space-y-3">
                                    <div className="grid grid-cols-2 gap-3">
                                      <div><label className="block text-[11px] font-medium text-[#64748B] mb-1">Title</label>
                                        <input value={closeoutEditTitle} onChange={e => setCloseoutEditTitle(e.target.value)} className="w-full h-8 px-2 rounded border border-[#E2E8F0] bg-white text-[12px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" /></div>
                                      <div><label className="block text-[11px] font-medium text-[#64748B] mb-1">Status</label>
                                        <select value={item.status} onChange={e => updateCloseoutItem(item.id, { status: e.target.value })} className="w-full h-8 px-2 rounded border border-[#E2E8F0] bg-white text-[12px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                                          <option value="incomplete">Incomplete</option><option value="in_progress">In Progress</option><option value="complete">Complete</option>
                                        </select></div>
                                      <div><label className="block text-[11px] font-medium text-[#64748B] mb-1">Due Date</label>
                                        <input type="date" value={closeoutEditDue} onChange={e => setCloseoutEditDue(e.target.value)} className="w-full h-8 px-2 rounded border border-[#E2E8F0] bg-white text-[12px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" /></div>
                                      <div><label className="block text-[11px] font-medium text-[#64748B] mb-1">Notes</label>
                                        <input value={closeoutEditNotes} onChange={e => setCloseoutEditNotes(e.target.value)} className="w-full h-8 px-2 rounded border border-[#E2E8F0] bg-white text-[12px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" /></div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <button onClick={() => { setCloseoutUploadingId(item.id); closeoutFileRef.current?.click() }} className="text-[11px] text-[#64748B] hover:text-[#7B9BB5] px-2 py-1 border border-[#E2E8F0] rounded hover:border-[#E2E8F0] transition-colors">
                                        {item.file_name ? `attached: ${item.file_name.slice(0,25)}` : "+ Upload Document"}
                                      </button>
                                      <div className="flex-1" />
                                      <button onClick={() => setCloseoutEditId(null)} className="text-[12px] text-[#64748B] hover:text-[#64748B] px-3 py-1.5 rounded">Cancel</button>
                                      <button onClick={async () => { await updateCloseoutItem(item.id, { title: closeoutEditTitle, due_date: closeoutEditDue || null, notes: closeoutEditNotes || null }); setCloseoutEditId(null) }}
                                        className="text-[12px] font-semibold text-[#0F172A] bg-[#7B9BB5] hover:bg-[#6A8AA4] px-4 py-1.5 rounded">Save</button>
                                    </div>
                                  </div>
                                )}
                              </div>
                            )
                          })}
                          {storedDocs.length === 0 && closeoutAllSubmittals.length === 0 && closeoutAllRFIs.length === 0 && closeoutAllCOs.length === 0 && closeoutAllDrawings.length === 0 && (
                            <div className="px-4 py-3 text-[12px] text-[#64748B] italic">No documents yet. Initialize the checklist or add project data.</div>
                          )}
                        </div>
                      )
                    })()}

                    {/* ── STANDARD CHECKLIST CATEGORIES (Inspections, Warranties, Training, Handover) ── */}
                    {CATS.filter(c => c.key !== "documents" && c.key !== "subcontractors" && c.key !== "suppliers").map(cat => {
                      const items = closeoutItems.filter(i => i.category === cat.key)
                      return (
                        <div key={cat.key} className="bg-white rounded-xl border border-[#E2E8F0] overflow-hidden">
                          <div className="flex items-center justify-between px-4 py-3 border-b border-[#E2E8F0]">
                            <div className="flex items-center gap-2">
                              <span className="text-[13px] font-bold text-[#0F172A]">{cat.label}</span>
                              <span className="text-[11px] text-[#64748B]">{cat.done}/{cat.total} complete</span>
                            </div>
                            <button onClick={() => { setNewCloseoutCategory(cat.key); setShowNewCloseout(true) }} className="text-[11px] text-white/70 hover:text-white transition-colors flex items-center gap-1"><PlusIcon /> Add</button>
                          </div>

                          {items.length === 0 && (
                            <div className="px-4 py-3 text-[12px] text-[#64748B] italic">No items. Reinitialize or add manually.</div>
                          )}
                          {items.map(item => {
                            const isEditing = closeoutEditId === item.id
                            const isLienConditional = item.item_type === "lien_waiver_conditional"
                            const isLienUnconditional = item.item_type === "lien_waiver_unconditional"
                            const isWarranty = cat.key === "warranties"
                            const isTraining = cat.key === "training"
                            return (
                              <div key={item.id} className="border-b border-[#E2E8F0]/40 last:border-0">
                                <div className={`flex items-center gap-3 px-4 py-3 hover:bg-[#0F172A]/[0.02] transition-colors ${isEditing ? "bg-[#0F172A]/[0.02]" : ""}`}>
                                  <button title={`Click to mark ${cycleStatus(item.status)}`} onClick={() => updateCloseoutItem(item.id, { status: cycleStatus(item.status) })}
                                    className="flex-shrink-0 w-5 h-5 rounded-full border-2 transition-all hover:scale-110"
                                    style={{ borderColor: dotColor(item.status), backgroundColor: item.status === "complete" ? dotColor(item.status) : "transparent" }} />
                                  {/* Type badge for lien waivers */}
                                  {(isLienConditional || isLienUnconditional) && (
                                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded flex-shrink-0 ${isLienConditional ? "bg-amber-500/20 text-amber-400" : "bg-emerald-500/20 text-emerald-400"}`}>
                                      {isLienConditional ? "CONDITIONAL" : "UNCONDITIONAL"}
                                    </span>
                                  )}
                                  {isWarranty && item.notes && (
                                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded flex-shrink-0 bg-[#7B9BB5]/20 text-[#7B9BB5]">{item.notes}</span>
                                  )}
                                  <span className={`flex-1 text-[13px] font-medium truncate ${item.status === "complete" ? "text-[#64748B] line-through" : "text-[#0F172A]"}`}>{item.title}</span>
                                  {/* Trainer / date for training items */}
                                  {isTraining && item.assigned_to && (
                                    <span className="text-[11px] text-[#64748B] hidden md:block flex-shrink-0">{item.assigned_to}</span>
                                  )}
                                  {/* Expiry date for warranties */}
                                  {isWarranty && item.due_date && (
                                    <span className={`text-[11px] flex-shrink-0 hidden md:block ${new Date(item.due_date+"T00:00:00") < new Date() ? "text-red-400" : "text-[#64748B]"}`}>
                                      exp {new Date(item.due_date+"T00:00:00").toLocaleDateString("en-US",{month:"short",year:"numeric"})}
                                    </span>
                                  )}
                                  <span className={`text-[11px] font-semibold flex-shrink-0 hidden sm:block ${labelColor(item.status)}`}>{statusLabel(item.status)}</span>
                                  {item.file_name ? (
                                    <span className="text-[11px] text-emerald-400 flex-shrink-0 hidden lg:block">attached</span>
                                  ) : (
                                    <button onClick={() => { setCloseoutUploadingId(item.id); closeoutFileRef.current?.click() }} disabled={closeoutUploadingId === item.id}
                                      className="text-[11px] text-[#64748B] hover:text-[#7B9BB5] flex-shrink-0 hidden lg:block disabled:opacity-50">
                                      {closeoutUploadingId === item.id ? "Uploading…" : "+ Doc"}
                                    </button>
                                  )}
                                  <RowActions className="flex-shrink-0" actions={[
                                    { label: isEditing ? "Close" : "Edit", onClick: () => { if (isEditing) { setCloseoutEditId(null); return } setCloseoutEditId(item.id); setCloseoutEditTitle(item.title); setCloseoutEditAssigned(item.assigned_to ?? ""); setCloseoutEditDue(item.due_date ?? ""); setCloseoutEditNotes(item.notes ?? "") } },
                                    { label: "Del", onClick: () => deleteCloseoutItem(item.id), variant: "danger" },
                                  ]} />
                                </div>
                                {isEditing && (
                                  <div className="px-4 pb-4 pt-2 border-t border-[#E2E8F0]/40 bg-white/30 space-y-3">
                                    <div className="grid grid-cols-2 gap-3">
                                      <div><label className="block text-[11px] font-medium text-[#64748B] mb-1">Title</label>
                                        <input value={closeoutEditTitle} onChange={e => setCloseoutEditTitle(e.target.value)} className="w-full h-8 px-2 rounded border border-[#E2E8F0] bg-white text-[12px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" /></div>
                                      <div><label className="block text-[11px] font-medium text-[#64748B] mb-1">Status</label>
                                        <select value={item.status} onChange={e => updateCloseoutItem(item.id, { status: e.target.value })} className="w-full h-8 px-2 rounded border border-[#E2E8F0] bg-white text-[12px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                                          <option value="incomplete">Incomplete</option><option value="in_progress">In Progress</option><option value="complete">Complete</option>
                                        </select></div>
                                      <div><label className="block text-[11px] font-medium text-[#64748B] mb-1">{isTraining ? "Trainer Name" : isWarranty ? "Warrantor" : "Assigned To"}</label>
                                        <input value={closeoutEditAssigned} onChange={e => setCloseoutEditAssigned(e.target.value)} className="w-full h-8 px-2 rounded border border-[#E2E8F0] bg-white text-[12px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" /></div>
                                      <div><label className="block text-[11px] font-medium text-[#64748B] mb-1">{isTraining ? "Training Date" : isWarranty ? "Expiration Date" : "Due Date"}</label>
                                        <input type="date" value={closeoutEditDue} onChange={e => setCloseoutEditDue(e.target.value)} className="w-full h-8 px-2 rounded border border-[#E2E8F0] bg-white text-[12px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" /></div>
                                    </div>
                                    <div><label className="block text-[11px] font-medium text-[#64748B] mb-1">Notes</label>
                                      <input value={closeoutEditNotes} onChange={e => setCloseoutEditNotes(e.target.value)} placeholder="Add notes…" className="w-full h-8 px-2 rounded border border-[#E2E8F0] bg-white text-[12px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 placeholder:text-[#64748B]" /></div>
                                    <div className="flex items-center gap-2">
                                      <button onClick={() => { setCloseoutUploadingId(item.id); closeoutFileRef.current?.click() }} className="text-[11px] text-[#64748B] hover:text-[#7B9BB5] px-2 py-1 border border-[#E2E8F0] rounded hover:border-[#E2E8F0] transition-colors">
                                        {item.file_name ? `attached: ${item.file_name.slice(0,25)}` : "+ Upload Document"}
                                      </button>
                                      <div className="flex-1" />
                                      <button onClick={() => setCloseoutEditId(null)} className="text-[12px] text-[#64748B] hover:text-[#64748B] px-3 py-1.5 rounded">Cancel</button>
                                      <button onClick={async () => { await updateCloseoutItem(item.id, { title: closeoutEditTitle, assigned_to: closeoutEditAssigned || null, due_date: closeoutEditDue || null, notes: closeoutEditNotes || null }); setCloseoutEditId(null) }}
                                        className="text-[12px] font-semibold text-[#0F172A] bg-[#7B9BB5] hover:bg-[#6A8AA4] px-4 py-1.5 rounded">Save</button>
                                    </div>
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      )
                    })}

                    {/* ── SUBCONTRACTOR FOLDERS ─────────────────────────────── */}
                    {subItems.length > 0 && (() => {
                      const folders = [...new Set(subItems.map(i => i.folder_name).filter(Boolean))] as string[]
                      const unfolderedItems = subItems.filter(i => !i.folder_name)
                      return (
                        <div className="bg-white rounded-xl border border-[#E2E8F0] overflow-hidden">
                          <div className="flex items-center justify-between px-4 py-3 border-b border-[#E2E8F0]">
                            <div className="flex items-center gap-2">
                              <span className="text-[13px] font-bold text-[#0F172A]">Subcontractors</span>
                              <span className="text-[11px] text-[#64748B]">{subItems.filter(i=>i.status==="complete").length}/{subItems.length} complete</span>
                            </div>
                            <button onClick={() => { setNewFolderType("subcontractors"); setShowAddFolder(true) }} className="text-[11px] text-[#64748B] hover:text-[#0F172A] transition-colors flex items-center gap-1"><PlusIcon /> Add Folder</button>
                          </div>
                          {folders.map(folder => {
                            const folderItems = subItems.filter(i => i.folder_name === folder)
                            const folderDone = folderItems.filter(i => i.status === "complete").length
                            return (
                              <div key={folder} className="border-b border-[#E2E8F0]/40 last:border-0">
                                <div className="flex items-center justify-between px-4 py-2 bg-[#F8F9FA]">
                                  <div className="flex items-center gap-2">
                                    <svg className="w-3.5 h-3.5 text-[#64748B] flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" /></svg>
                                    <span className="text-[12px] font-bold text-[#0F172A]">{folder}</span>
                                  </div>
                                  <span className="text-[10px] text-[#64748B]">{folderDone}/{folderItems.length}</span>
                                </div>
                                {folderItems.map(item => {
                                  const isEditing = closeoutEditId === item.id
                                  return (
                                    <div key={item.id} className="border-b border-[#E2E8F0]/20 last:border-0">
                                      <div className={`flex items-center gap-3 px-4 pl-10 py-2.5 hover:bg-[#0F172A]/[0.02] transition-colors ${isEditing ? "bg-[#0F172A]/[0.02]" : ""}`}>
                                        <button title={`Click to mark ${cycleStatus(item.status)}`} onClick={() => updateCloseoutItem(item.id, { status: cycleStatus(item.status) })}
                                          className="flex-shrink-0 w-4 h-4 rounded-full border-2 transition-all hover:scale-110"
                                          style={{ borderColor: dotColor(item.status), backgroundColor: item.status === "complete" ? dotColor(item.status) : "transparent" }} />
                                        <span className={`flex-1 text-[12px] font-medium truncate ${item.status === "complete" ? "text-[#64748B] line-through" : "text-[#0F172A]"}`}>{item.title}</span>
                                        <span className={`text-[11px] font-semibold flex-shrink-0 hidden sm:block ${labelColor(item.status)}`}>{statusLabel(item.status)}</span>
                                        {item.file_name ? (
                                          <span className="text-[11px] text-emerald-400 flex-shrink-0 hidden lg:block">attached</span>
                                        ) : (
                                          <button onClick={() => { setCloseoutUploadingId(item.id); closeoutFileRef.current?.click() }} disabled={closeoutUploadingId === item.id}
                                            className="text-[11px] text-[#64748B] hover:text-[#7B9BB5] flex-shrink-0 hidden lg:block disabled:opacity-50">
                                            {closeoutUploadingId === item.id ? "Uploading…" : "+ Doc"}
                                          </button>
                                        )}
                                        <RowActions className="flex-shrink-0" actions={[
                                          { label: isEditing ? "Close" : "Edit", onClick: () => { if (isEditing) { setCloseoutEditId(null); return } setCloseoutEditId(item.id); setCloseoutEditTitle(item.title); setCloseoutEditAssigned(item.assigned_to ?? ""); setCloseoutEditDue(item.due_date ?? ""); setCloseoutEditNotes(item.notes ?? "") } },
                                          { label: "Del", onClick: () => deleteCloseoutItem(item.id), variant: "danger" },
                                        ]} />
                                      </div>
                                      {isEditing && (
                                        <div className="px-4 pl-10 pb-4 pt-2 border-t border-[#E2E8F0]/40 bg-white/30 space-y-3">
                                          <div className="grid grid-cols-2 gap-3">
                                            <div><label className="block text-[11px] font-medium text-[#64748B] mb-1">Title</label>
                                              <input value={closeoutEditTitle} onChange={e => setCloseoutEditTitle(e.target.value)} className="w-full h-8 px-2 rounded border border-[#E2E8F0] bg-white text-[12px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" /></div>
                                            <div><label className="block text-[11px] font-medium text-[#64748B] mb-1">Status</label>
                                              <select value={item.status} onChange={e => updateCloseoutItem(item.id, { status: e.target.value })} className="w-full h-8 px-2 rounded border border-[#E2E8F0] bg-white text-[12px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                                                <option value="incomplete">Incomplete</option><option value="in_progress">In Progress</option><option value="complete">Complete</option>
                                              </select></div>
                                            <div><label className="block text-[11px] font-medium text-[#64748B] mb-1">Notes</label>
                                              <input value={closeoutEditNotes} onChange={e => setCloseoutEditNotes(e.target.value)} className="w-full h-8 px-2 rounded border border-[#E2E8F0] bg-white text-[12px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" /></div>
                                            <div><label className="block text-[11px] font-medium text-[#64748B] mb-1">Due Date</label>
                                              <input type="date" value={closeoutEditDue} onChange={e => setCloseoutEditDue(e.target.value)} className="w-full h-8 px-2 rounded border border-[#E2E8F0] bg-white text-[12px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" /></div>
                                          </div>
                                          <div className="flex items-center gap-2">
                                            <button onClick={() => { setCloseoutUploadingId(item.id); closeoutFileRef.current?.click() }} className="text-[11px] text-[#64748B] hover:text-[#7B9BB5] px-2 py-1 border border-[#E2E8F0] rounded transition-colors">
                                              {item.file_name ? `attached: ${item.file_name.slice(0,25)}` : "+ Upload Document"}
                                            </button>
                                            <div className="flex-1" />
                                            <button onClick={() => setCloseoutEditId(null)} className="text-[12px] text-[#64748B] px-3 py-1.5 rounded">Cancel</button>
                                            <button onClick={async () => { await updateCloseoutItem(item.id, { title: closeoutEditTitle, due_date: closeoutEditDue || null, notes: closeoutEditNotes || null }); setCloseoutEditId(null) }}
                                              className="text-[12px] font-semibold text-white bg-[#7B9BB5] hover:bg-[#6A8AA4] px-4 py-1.5 rounded">Save</button>
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  )
                                })}
                                <div className="px-4 pl-10 py-1.5">
                                  <button onClick={() => { setNewCloseoutCategory("subcontractors"); setNewCloseoutFolder(folder); setShowNewCloseout(true) }}
                                    className="text-[11px] text-[#64748B] hover:text-[#7B9BB5] transition-colors flex items-center gap-1">
                                    <PlusIcon /> Add item to {folder}
                                  </button>
                                </div>
                              </div>
                            )
                          })}
                          {unfolderedItems.map(item => {
                            const isEditing = closeoutEditId === item.id
                            return (
                              <div key={item.id} className="border-b border-[#E2E8F0]/40 last:border-0">
                                <div className={`flex items-center gap-3 px-4 py-3 hover:bg-[#0F172A]/[0.02] transition-colors ${isEditing ? "bg-[#0F172A]/[0.02]" : ""}`}>
                                  <button onClick={() => updateCloseoutItem(item.id, { status: cycleStatus(item.status) })}
                                    className="flex-shrink-0 w-5 h-5 rounded-full border-2 transition-all hover:scale-110"
                                    style={{ borderColor: dotColor(item.status), backgroundColor: item.status === "complete" ? dotColor(item.status) : "transparent" }} />
                                  <span className={`flex-1 text-[13px] font-medium truncate ${item.status === "complete" ? "text-[#64748B] line-through" : "text-[#0F172A]"}`}>{item.title}</span>
                                  <span className={`text-[11px] font-semibold flex-shrink-0 hidden sm:block ${labelColor(item.status)}`}>{statusLabel(item.status)}</span>
                                  <RowActions className="flex-shrink-0" actions={[{ label: "Del", onClick: () => deleteCloseoutItem(item.id), variant: "danger" }]} />
                                </div>
                              </div>
                            )
                          })}
                          {folders.length === 0 && unfolderedItems.length === 0 && (
                            <div className="px-4 py-3 text-[12px] text-[#64748B] italic">No subcontractor folders. Use + Add Folder to create one.</div>
                          )}
                        </div>
                      )
                    })()}

                    {/* ── SUPPLIER FOLDERS ──────────────────────────────────── */}
                    {supplItems.length > 0 && (() => {
                      const folders = [...new Set(supplItems.map(i => i.folder_name).filter(Boolean))] as string[]
                      const unfolderedItems = supplItems.filter(i => !i.folder_name)
                      return (
                        <div className="bg-white rounded-xl border border-[#E2E8F0] overflow-hidden">
                          <div className="flex items-center justify-between px-4 py-3 border-b border-[#E2E8F0]">
                            <div className="flex items-center gap-2">
                              <span className="text-[13px] font-bold text-[#0F172A]">Suppliers</span>
                              <span className="text-[11px] text-[#64748B]">{supplItems.filter(i=>i.status==="complete").length}/{supplItems.length} complete</span>
                            </div>
                            <button onClick={() => { setNewFolderType("suppliers"); setShowAddFolder(true) }} className="text-[11px] text-[#64748B] hover:text-[#0F172A] transition-colors flex items-center gap-1"><PlusIcon /> Add Folder</button>
                          </div>
                          {folders.map(folder => {
                            const folderItems = supplItems.filter(i => i.folder_name === folder)
                            const folderDone = folderItems.filter(i => i.status === "complete").length
                            return (
                              <div key={folder} className="border-b border-[#E2E8F0]/40 last:border-0">
                                <div className="flex items-center justify-between px-4 py-2 bg-[#F8F9FA]">
                                  <div className="flex items-center gap-2">
                                    <svg className="w-3.5 h-3.5 text-[#64748B] flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" /></svg>
                                    <span className="text-[12px] font-bold text-[#0F172A]">{folder}</span>
                                  </div>
                                  <span className="text-[10px] text-[#64748B]">{folderDone}/{folderItems.length}</span>
                                </div>
                                {folderItems.map(item => {
                                  const isEditing = closeoutEditId === item.id
                                  return (
                                    <div key={item.id} className="border-b border-[#E2E8F0]/20 last:border-0">
                                      <div className={`flex items-center gap-3 px-4 pl-10 py-2.5 hover:bg-[#0F172A]/[0.02] transition-colors ${isEditing ? "bg-[#0F172A]/[0.02]" : ""}`}>
                                        <button title={`Click to mark ${cycleStatus(item.status)}`} onClick={() => updateCloseoutItem(item.id, { status: cycleStatus(item.status) })}
                                          className="flex-shrink-0 w-4 h-4 rounded-full border-2 transition-all hover:scale-110"
                                          style={{ borderColor: dotColor(item.status), backgroundColor: item.status === "complete" ? dotColor(item.status) : "transparent" }} />
                                        <span className={`flex-1 text-[12px] font-medium truncate ${item.status === "complete" ? "text-[#64748B] line-through" : "text-[#0F172A]"}`}>{item.title}</span>
                                        <span className={`text-[11px] font-semibold flex-shrink-0 hidden sm:block ${labelColor(item.status)}`}>{statusLabel(item.status)}</span>
                                        {item.file_name ? (
                                          <span className="text-[11px] text-emerald-400 flex-shrink-0 hidden lg:block">attached</span>
                                        ) : (
                                          <button onClick={() => { setCloseoutUploadingId(item.id); closeoutFileRef.current?.click() }} disabled={closeoutUploadingId === item.id}
                                            className="text-[11px] text-[#64748B] hover:text-[#7B9BB5] flex-shrink-0 hidden lg:block disabled:opacity-50">
                                            {closeoutUploadingId === item.id ? "Uploading…" : "+ Doc"}
                                          </button>
                                        )}
                                        <RowActions className="flex-shrink-0" actions={[
                                          { label: isEditing ? "Close" : "Edit", onClick: () => { if (isEditing) { setCloseoutEditId(null); return } setCloseoutEditId(item.id); setCloseoutEditTitle(item.title); setCloseoutEditAssigned(item.assigned_to ?? ""); setCloseoutEditDue(item.due_date ?? ""); setCloseoutEditNotes(item.notes ?? "") } },
                                          { label: "Del", onClick: () => deleteCloseoutItem(item.id), variant: "danger" },
                                        ]} />
                                      </div>
                                      {isEditing && (
                                        <div className="px-4 pl-10 pb-4 pt-2 border-t border-[#E2E8F0]/40 bg-white/30 space-y-3">
                                          <div className="grid grid-cols-2 gap-3">
                                            <div><label className="block text-[11px] font-medium text-[#64748B] mb-1">Title</label>
                                              <input value={closeoutEditTitle} onChange={e => setCloseoutEditTitle(e.target.value)} className="w-full h-8 px-2 rounded border border-[#E2E8F0] bg-white text-[12px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" /></div>
                                            <div><label className="block text-[11px] font-medium text-[#64748B] mb-1">Status</label>
                                              <select value={item.status} onChange={e => updateCloseoutItem(item.id, { status: e.target.value })} className="w-full h-8 px-2 rounded border border-[#E2E8F0] bg-white text-[12px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                                                <option value="incomplete">Incomplete</option><option value="in_progress">In Progress</option><option value="complete">Complete</option>
                                              </select></div>
                                            <div><label className="block text-[11px] font-medium text-[#64748B] mb-1">Notes</label>
                                              <input value={closeoutEditNotes} onChange={e => setCloseoutEditNotes(e.target.value)} className="w-full h-8 px-2 rounded border border-[#E2E8F0] bg-white text-[12px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" /></div>
                                            <div><label className="block text-[11px] font-medium text-[#64748B] mb-1">Due Date</label>
                                              <input type="date" value={closeoutEditDue} onChange={e => setCloseoutEditDue(e.target.value)} className="w-full h-8 px-2 rounded border border-[#E2E8F0] bg-white text-[12px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" /></div>
                                          </div>
                                          <div className="flex items-center gap-2">
                                            <button onClick={() => { setCloseoutUploadingId(item.id); closeoutFileRef.current?.click() }} className="text-[11px] text-[#64748B] hover:text-[#7B9BB5] px-2 py-1 border border-[#E2E8F0] rounded transition-colors">
                                              {item.file_name ? `attached: ${item.file_name.slice(0,25)}` : "+ Upload Document"}
                                            </button>
                                            <div className="flex-1" />
                                            <button onClick={() => setCloseoutEditId(null)} className="text-[12px] text-[#64748B] px-3 py-1.5 rounded">Cancel</button>
                                            <button onClick={async () => { await updateCloseoutItem(item.id, { title: closeoutEditTitle, due_date: closeoutEditDue || null, notes: closeoutEditNotes || null }); setCloseoutEditId(null) }}
                                              className="text-[12px] font-semibold text-white bg-[#7B9BB5] hover:bg-[#6A8AA4] px-4 py-1.5 rounded">Save</button>
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  )
                                })}
                                <div className="px-4 pl-10 py-1.5">
                                  <button onClick={() => { setNewCloseoutCategory("suppliers"); setNewCloseoutFolder(folder); setShowNewCloseout(true) }}
                                    className="text-[11px] text-[#64748B] hover:text-[#7B9BB5] transition-colors flex items-center gap-1">
                                    <PlusIcon /> Add item to {folder}
                                  </button>
                                </div>
                              </div>
                            )
                          })}
                          {unfolderedItems.map(item => {
                            const isEditing = closeoutEditId === item.id
                            return (
                              <div key={item.id} className="border-b border-[#E2E8F0]/40 last:border-0">
                                <div className={`flex items-center gap-3 px-4 py-3 hover:bg-[#0F172A]/[0.02] transition-colors ${isEditing ? "bg-[#0F172A]/[0.02]" : ""}`}>
                                  <button onClick={() => updateCloseoutItem(item.id, { status: cycleStatus(item.status) })}
                                    className="flex-shrink-0 w-5 h-5 rounded-full border-2 transition-all hover:scale-110"
                                    style={{ borderColor: dotColor(item.status), backgroundColor: item.status === "complete" ? dotColor(item.status) : "transparent" }} />
                                  <span className={`flex-1 text-[13px] font-medium truncate ${item.status === "complete" ? "text-[#64748B] line-through" : "text-[#0F172A]"}`}>{item.title}</span>
                                  <span className={`text-[11px] font-semibold flex-shrink-0 hidden sm:block ${labelColor(item.status)}`}>{statusLabel(item.status)}</span>
                                  <RowActions className="flex-shrink-0" actions={[{ label: "Del", onClick: () => deleteCloseoutItem(item.id), variant: "danger" }]} />
                                </div>
                              </div>
                            )
                          })}
                          {folders.length === 0 && unfolderedItems.length === 0 && (
                            <div className="px-4 py-3 text-[12px] text-[#64748B] italic">No supplier folders. Use + Add Folder to create one.</div>
                          )}
                        </div>
                      )
                    })()}

                    {/* All clear */}
                    {openPunchCount === 0 && closeoutSubmittals.length === 0 && closeoutRFIs.length === 0 && closeoutCOs.length === 0 && closeoutDrawings.length === 0 && closeoutItems.every(i => i.status === "complete") && (
                      <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-6 text-center">
                        <p className="text-[15px] font-bold text-emerald-400">Project is ready for closeout</p>
                        <p className="text-[13px] text-[#64748B] mt-1">All checklist items complete and no flagged items.</p>
                        <button disabled={closeoutGenerating}
                          onClick={async () => { setCloseoutGenerating(true); const res = await fetch("/api/closeout/pdf", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project_id: globalProjectId }) }); const d = await res.json(); if (d.url) window.open(d.url, "_blank"); setCloseoutGenerating(false) }}
                          className="mt-4 h-9 px-5 rounded-lg bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors inline-flex items-center gap-2 disabled:opacity-50">
                          {closeoutGenerating ? <><SpinnerIcon className="h-3.5 w-3.5" /> Generating…</> : "Generate Final Closeout Package"}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </>
            )
          })()}
      </div>

      {/* ── Add Closeout Item modal ───────────────────────────────────────── */}
      {showNewCloseout && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center" onClick={e => { if (e.target === e.currentTarget) setShowNewCloseout(false) }}>
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[480px] mx-4 sm:mx-0 p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-[15px] font-bold text-[#0F172A]">Add Closeout Item</h2>
              <button onClick={() => setShowNewCloseout(false)} className="text-[#64748B] hover:text-[#64748B] transition-colors"><XIcon className="h-4 w-4" /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className={labelCls}>Category</label>
                <select value={newCloseoutCategory} onChange={e => { setNewCloseoutCategory(e.target.value); setNewCloseoutFolder("") }} className={inputCls}>
                  <option value="documents">Documents</option>
                  <option value="inspections">Inspections</option>
                  <option value="training">Training</option>
                  <option value="handover">Handover</option>
                  <option value="warranties">Warranties</option>
                  <option value="subcontractors">Subcontractors</option>
                  <option value="suppliers">Suppliers</option>
                </select>
              </div>
              {(newCloseoutCategory === "subcontractors" || newCloseoutCategory === "suppliers") && (() => {
                const folderOptions = [...new Set(closeoutItems.filter(i => i.category === newCloseoutCategory && i.folder_name).map(i => i.folder_name))] as string[]
                return (
                  <div>
                    <label className={labelCls}>Folder (Company)</label>
                    <select value={newCloseoutFolder} onChange={e => setNewCloseoutFolder(e.target.value)} className={inputCls}>
                      <option value="">No folder</option>
                      {folderOptions.map(f => <option key={f} value={f}>{f}</option>)}
                    </select>
                  </div>
                )
              })()}
              <div>
                <label className={labelCls}>Title <span className="text-red-400">*</span></label>
                <input value={newCloseoutTitle} onChange={e => setNewCloseoutTitle(e.target.value)} placeholder="e.g. O&M Manual — Elevator" className={inputCls} autoFocus />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Assign To</label>
                  <select value={newCloseoutAssigned} onChange={e => setNewCloseoutAssigned(e.target.value)} className={inputCls}>
                    <option value="">Unassigned</option>
                    {teamMembers.map(m => <option key={m.id} value={m.name}>{m.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Due Date</label>
                  <input type="date" value={newCloseoutDue} onChange={e => setNewCloseoutDue(e.target.value)} className={inputCls} />
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button onClick={() => { setShowNewCloseout(false); setNewCloseoutFolder("") }} className="h-9 px-4 rounded-md text-[13px] text-[#64748B] hover:text-[#64748B] transition-colors">Cancel</button>
                <button onClick={addCloseoutItem} disabled={!newCloseoutTitle.trim()} className="h-9 px-5 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50">Add Item</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Add Closeout Folder modal ────────────────────────────────────── */}
      {showAddFolder && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center" onClick={e => { if (e.target === e.currentTarget) setShowAddFolder(false) }}>
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[420px] mx-4 sm:mx-0 p-6">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-[15px] font-bold text-[#0F172A]">Add Folder</h2>
              <button onClick={() => setShowAddFolder(false)} className="text-[#64748B] hover:text-[#64748B] transition-colors"><XIcon className="h-4 w-4" /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className={labelCls}>Type</label>
                <select value={newFolderType} onChange={e => setNewFolderType(e.target.value as "subcontractors"|"suppliers")} className={inputCls}>
                  <option value="subcontractors">Subcontractor</option>
                  <option value="suppliers">Supplier</option>
                </select>
              </div>
              <div>
                <label className={labelCls}>Company Name <span className="text-red-400">*</span></label>
                <input value={newFolderName} onChange={e => setNewFolderName(e.target.value)} placeholder="e.g. ABC Electrical" className={inputCls} autoFocus />
              </div>
              <p className="text-[11px] text-[#64748B]">Default line items will be created automatically for this folder.</p>
              <div className="flex justify-end gap-2 pt-2">
                <button onClick={() => { setShowAddFolder(false); setNewFolderName("") }} className="h-9 px-4 rounded-md text-[13px] text-[#64748B] hover:text-[#64748B] transition-colors">Cancel</button>
                <button onClick={addCloseoutFolder} disabled={!newFolderName.trim()} className="h-9 px-5 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50">Create Folder</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Closeout package create modal (Session K1) ──────────────────── */}
      {showPackageModal && globalProjectId && selectedItems.length > 0 && (
        <CloseoutPackageCreateModal
          projectId={globalProjectId}
          projectName={projectName}
          items={selectedItems}
          vendorPreset={null}
          subs={subs}
          suppliers={suppliers}
          onClose={() => setShowPackageModal(false)}
          onDone={() => { setShowPackageModal(false); exitSelectMode(); setView("packages") }}
        />
      )}
    </>
  )
}
