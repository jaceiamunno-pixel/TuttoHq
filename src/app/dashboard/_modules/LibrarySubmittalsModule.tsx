"use client"

import { useState, useEffect, useRef } from "react"
import SubmittalCoversheet from "@/components/submittals/SubmittalCoversheet"
import type {
  Division, SubmittalFile, SubmittalRecord, AiResult, NameOptions, UploadStep,
  BatchItem, BatchPhase, Project, TeamMember, OpenFileCtx, FileModalStep,
  CoverFormData, CoverContact, StagedSubmittal, SpecSectionRow, PendingDoc,
  SubcontractorRow, SupplierRow,
} from "../_shared/types"
import { SUBMITTAL_TYPE_OPTIONS } from "../_shared/types"
import { CSI_DIVISIONS, CSI_SECTIONS, SECTION_PALETTE, sectionColorMap } from "../_shared/csi"
import { getDot, fmtDate } from "../_shared/format"
import { SearchIcon, XIcon, PlusIcon, CheckIcon, SpinnerIcon, LayersIcon } from "../_shared/icons"
import { StatusBadge } from "../_shared/badges"
import { Combobox, inputCls, labelCls } from "../_shared/ui"
import { presignAndUpload } from "@/lib/storage-upload"
import { exportSubmittalLogToExcel } from "../_shared/excel-export"
import PackageCreateModal, { type VendorPreset } from "@/components/packages/PackageCreateModal"
import PackagesView from "@/components/packages/PackagesView"

// Status options for the inline Status dropdown in the submittal log.
// "Sent to Sub" is the outbound-dispatch milestone (Session I).
const LOG_STATUS_OPTIONS = [
  "Sent to Sub", "Received", "Under Review", "Approved", "Approved with Comments",
  "Rejected", "Revise and Resubmit", "Needs Review", "Transmitted",
] as const

// ─── Submittal-log calculated columns ────────────────────────────────────────
function daysBetween(a: string, b: string): number | null {
  const t1 = Date.parse(a), t2 = Date.parse(b)
  if (Number.isNaN(t1) || Number.isNaN(t2)) return null
  return Math.round((t2 - t1) / 86_400_000)
}

/** Approval turnaround: returned-from-A/E minus sent-to-A/E, in days. */
function approvalDays(s: SubmittalRecord): number | null {
  if (!s.sent_to_ae_date || !s.returned_from_ae_date) return null
  return daysBetween(s.sent_to_ae_date, s.returned_from_ae_date)
}

/**
 * Late / On-Time state. A submittal is Late when it has been out for A/E
 * review longer than 14 days — whether it has come back (turnaround > 14) or
 * is still outstanding (today − sent > 14). Null until it is sent to the A/E.
 */
function lateState(s: SubmittalRecord): "late" | "ontime" | null {
  if (!s.sent_to_ae_date) return null
  const end = s.returned_from_ae_date ?? new Date().toISOString().slice(0, 10)
  const d = daysBetween(s.sent_to_ae_date, end)
  if (d === null) return null
  return d > 14 ? "late" : "ontime"
}

// Small inline document icon for the Source column.
function SourceIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 3v6h6" />
    </svg>
  )
}

// Library + Submittals module — extracted from dashboard/page.tsx (Step 9, final).
// Library and Submittals share the upload/batch/cover/transmittal machinery and
// Pending Review, so they live in one module that switches on the activeModule
// prop. submittalsView is owned by the shell so it survives this module
// unmounting (Library ↔ Submittals switch); navigation uses onNavigate.

export default function LibrarySubmittalsModule({ activeModule, globalProjectId, appProjects, teamMembers, userEmail, submittalsView, setSubmittalsView, onNavigate }: {
  activeModule: string
  globalProjectId: string
  appProjects: Project[]
  teamMembers: TeamMember[]
  userEmail: string | null
  submittalsView: "log" | "pending" | "packages"
  setSubmittalsView: (v: "log" | "pending" | "packages") => void
  onNavigate: (module: "library" | "submittals") => void
}) {
  // Tree state
  const [divisions, setDivisions]     = useState<Division[]>([])
  const [treeLoading, setTreeLoading] = useState(true)
  const [treeError, setTreeError]     = useState<string | null>(null)

  // Accordion state — keyed by division.num and section.code
  const [openDivisions, setOpenDivisions] = useState<Set<string>>(new Set())
  const [openSections, setOpenSections]   = useState<Set<string>>(new Set())

  // Files per section, loaded on demand, keyed by section.code
  const [sectionFiles, setSectionFiles]       = useState<Record<string, SubmittalFile[]>>({})
  const [loadingSections, setLoadingSections] = useState<Set<string>>(new Set())

  // Search
  const [query, setQuery]                 = useState("")
  const [searchResults, setSearchResults] = useState<SubmittalRecord[] | null>(null)
  const [searching, setSearching]         = useState(false)
  const [searchError, setSearchError]     = useState<string | null>(null)
  const [searchAiSummary, setSearchAiSummary] = useState<string | null>(null)

  // Upload modal
  const [showUpload, setShowUpload]         = useState(false)
  const [uploadFile, setUploadFile]         = useState<File | null>(null)
  // Storage path of the file once it has been PUT straight to storage (presigned
  // URL flow). Both /api/classify and /api/upload reference this — the file is
  // never streamed through a Vercel function.
  const [uploadFilePath, setUploadFilePath] = useState<string | null>(null)
  const [uploadDiv, setUploadDiv]           = useState("")
  const [uploadDivName, setUploadDivName]   = useState("")
  const [uploadSec, setUploadSec]           = useState("")
  const [uploadSecName, setUploadSecName]   = useState("")
  const [uploading, setUploading]           = useState(false)
  const [uploadError, setUploadError]       = useState<string | null>(null)
  const [uploadStep, setUploadStep]         = useState<UploadStep>("file")
  const [aiResult, setAiResult]             = useState<AiResult | null>(null)
  const [nameMatl, setNameMatl]             = useState("")
  const [nameMfr, setNameMfr]               = useState("")
  const [nameDims, setNameDims]             = useState("")
  const [nameOpts, setNameOpts]             = useState<NameOptions>({ materials: [], manufacturers: [], dimensions: [] })

  // Submittal log
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [logSubmittals, setLogSubmittals]       = useState<SubmittalRecord[]>([])
  const [logLoading, setLogLoading]             = useState(true)
  const [editSubmittal, setEditSubmittal]       = useState<SubmittalRecord | null>(null)
  const [editStatus, setEditStatus]             = useState("")
  const [editDiv, setEditDiv]                   = useState("")
  const [editDivName, setEditDivName]           = useState("")
  const [editSec, setEditSec]                   = useState("")
  const [editSecName, setEditSecName]           = useState("")
  const [editSaving, setEditSaving]             = useState(false)

  // Submittal-log tracker — vendors, grouping, inline-save debounce
  const [vendorSubs, setVendorSubs]             = useState<SubcontractorRow[]>([])
  const [vendorSuppliers, setVendorSuppliers]   = useState<SupplierRow[]>([])
  const [groupBySection, setGroupBySection]     = useState(true)
  // Sub-package selection (Session I) — "Select" mode adds a checkbox column.
  const [selectMode, setSelectMode]             = useState(false)
  const [selectedIds, setSelectedIds]           = useState<Set<string>>(new Set())
  const [showPackageModal, setShowPackageModal] = useState(false)
  const saveTimers     = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const pendingPatches = useRef<Map<string, Record<string, unknown>>>(new Map())
  // Monotonic id so an out-of-order Submittal Log response can't clobber a newer one.
  const logReqSeq      = useRef(0)
  // Reset Submittal Log
  const [resetMenuOpen, setResetMenuOpen]       = useState(false)
  const [resetScope, setResetScope]             = useState<"all" | "spec_ingestion" | null>(null)
  const [resetCount, setResetCount]             = useState<number | null>(null)
  const [resetting, setResetting]               = useState(false)
  // Source PDF preview
  const [sourceModal, setSourceModal]           = useState<
    { url: string; page: number; spec_number: string; spec_title: string; file_name: string } | null>(null)
  const [sourceLoadingId, setSourceLoadingId]   = useState<string | null>(null)

  // Batch upload
  const [showBatch, setShowBatch]     = useState(false)
  const [batchItems, setBatchItems]   = useState<BatchItem[]>([])
  const [batchPhase, setBatchPhase]   = useState<BatchPhase>("select")
  const [batchDragOver, setBatchDragOver] = useState(false)
  // Division visibility
  const [hiddenDivisions, setHiddenDivisions] = useState<Set<string>>(new Set())
  const [showManage, setShowManage] = useState(false)
  // File open modal
  const [openFileCtx, setOpenFileCtx]     = useState<OpenFileCtx | null>(null)
  const [fileModalStep, setFileModalStep] = useState<FileModalStep>("project")
  const [modalProjectId, setModalProjectId] = useState("")
  const [coverForm, setCoverForm]         = useState<CoverFormData | null>(null)
  const [coverEditId, setCoverEditId]     = useState<string | null>(null)
  const [generatingCover, setGeneratingCover] = useState(false)
  const [coverProjectSubs, setCoverProjectSubs]           = useState<CoverContact[]>([])
  const [coverProjectSuppliers, setCoverProjectSuppliers] = useState<CoverContact[]>([])
  const [coverProjectCms, setCoverProjectCms]             = useState<CoverContact[]>([])
  const [coverSelectedId, setCoverSelectedId]             = useState<string>("")
  const [showCoverPreview, setShowCoverPreview]           = useState(false)
  // Sync submittal project filter with global project selection
  useEffect(() => { setActiveProjectId(globalProjectId || null) }, [globalProjectId])

  const [transmittalSub, setTransmittalSub]           = useState<SubmittalRecord | null>(null)
  const [transmittalLoading, setTransmittalLoading]   = useState(false)
  const [transmittalPdfUrl, setTransmittalPdfUrl]     = useState<string | null>(null)
  const [showTransmittalConfirm, setShowTransmittalConfirm] = useState(false)
  const [pendingStaged, setPendingStaged]             = useState<StagedSubmittal[]>([])
  const [pendingSections, setPendingSections]         = useState<SpecSectionRow[]>([])
  const [pendingDocuments, setPendingDocuments]       = useState<PendingDoc[]>([])
  const [pendingLoading, setPendingLoading]           = useState(false)
  const [specMode, setSpecMode]                       = useState<"consolidated" | "detailed">("consolidated")
  const [pendingCommitting, setPendingCommitting]     = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  // Load division tree
  function loadTree() {
    setTreeLoading(true)
    fetch("/api/folders")
      .then(r => r.json())
      .then(d => {
        if (d.error) throw new Error(d.error)
        setDivisions(d.divisions)
      })
      .catch(e => setTreeError(e instanceof Error ? e.message : "Failed to load folders"))
      .finally(() => setTreeLoading(false))
  }

  useEffect(() => { loadTree() }, [])

  useEffect(() => {
    try {
      const saved = localStorage.getItem("submittal-hidden-divisions")
      if (saved) setHiddenDivisions(new Set(JSON.parse(saved)))
    } catch {}
  }, [])

  useEffect(() => {
    if (showUpload || showBatch) {
      fetch("/api/submittal-names")
        .then(r => r.json())
        .then(d => setNameOpts(d))
        .catch(() => {})
    }
  }, [showUpload, showBatch])

  function toggleDivisionVisibility(num: string) {
    setHiddenDivisions(prev => {
      const next = new Set(prev)
      next.has(num) ? next.delete(num) : next.add(num)
      localStorage.setItem("submittal-hidden-divisions", JSON.stringify([...next]))
      return next
    })
  }
  function closeModal() {
    setShowUpload(false)
    setUploadFile(null)
    setUploadFilePath(null)
    setUploadDiv("")
    setUploadDivName("")
    setUploadSec("")
    setUploadSecName("")
    setUploadStep("file")
    setAiResult(null)
    setUploadError(null)
    setNameMatl("")
    setNameMfr("")
    setNameDims("")
  }

  function acceptSuggestion() {
    if (!aiResult) return
    setUploadDiv(aiResult.division_num)
    setUploadDivName(aiResult.division_name)
    setUploadSec(aiResult.section_code)
    setUploadSecName(aiResult.section_name)
    if (aiResult.material_name) setNameMatl(aiResult.material_name)
    if (aiResult.manufacturer)  setNameMfr(aiResult.manufacturer)
    if (aiResult.dimensions)    setNameDims(aiResult.dimensions)
    setUploadStep("manual")
  }

  function handleFileOpen(file: SubmittalFile, divNum: string, divName: string, secCode: string, secName: string, existingProjectId?: string | null) {
    setOpenFileCtx({ file, divNum, divName, secCode, secName })
    if (existingProjectId) {
      setModalProjectId(existingProjectId)
      setFileModalStep("coversheet")
    } else {
      setFileModalStep("project")
      setModalProjectId("")
    }
    setCoverForm(null)
  }

  function closeFileModal() { setOpenFileCtx(null); setModalProjectId(""); setCoverForm(null); setCoverEditId(null) }

  function openEditCoverSheet(s: SubmittalRecord) {
    const proj = appProjects.find(p => p.id === s.project_id)
    const today = new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" })
    const myName = teamMembers.find(m => m.email === userEmail)?.name ?? userEmail ?? ""
    setOpenFileCtx({
      file: { id: s.id, file_name: s.file_name, file_url: "", mime_type: s.mime_type, file_size: s.file_size, created_at: s.created_at },
      divNum: s.csi_division ?? "", divName: s.division_name ?? "",
      secCode: s.csi_section ?? "", secName: s.section_name ?? "",
    })
    setModalProjectId(s.project_id ?? "")
    setCoverEditId(s.id)
    setCoverForm({
      projectName: proj?.name ?? "", projectNumber: proj?.number ?? "",
      projectLocation: proj?.location ?? "", gcName: proj?.gc_name ?? "",
      architect: proj?.architect ?? "", specSectionNo: s.csi_section ?? "",
      specSectionTitle: s.section_name ?? "",
      description: s.file_name.replace(/\.[^.]+$/, ""),
      dateSubmitted: today, submittalNo: s.submittal_number ?? "1",
      revisionNo: s.revision_number ?? "00", dueDate: s.due_date ?? "",
      isCritical: s.is_critical ?? false, partyRequired: s.party_required ?? false,
      copyTo: s.copy_to ?? "",
      reviewedBy: "", certifiedBy: "", notes: "",
      sendToType: (s.send_to_type as "cm"|"subcontractor"|"supplier"|"") ?? "",
      sendToCompany: s.send_to_company ?? "",
      sendToContact: s.send_to_contact ?? "",
      sendToEmail: s.send_to_email ?? "",
      sendToPhone: s.send_to_phone ?? "",
      sendToAddress: s.send_to_address ?? "",
      transmittedBy: s.transmitted_by ?? myName,
      transmittedByCompany: s.transmitted_by_company ?? proj?.gc_name ?? "",
    })
    setCoverSelectedId(s.send_to_type ? "__manual__" : "")
    setFileModalStep("form")
    if (s.project_id) loadCoverContacts(s.project_id)
  }

  function openFileDirectly() {
    if (!openFileCtx) return
    window.open(openFileCtx.file.mime_type === "application/pdf" ? `/api/download/${openFileCtx.file.id}` : openFileCtx.file.file_url, "_blank")
    closeFileModal()
  }

  async function loadCoverContacts(projectId: string) {
    if (!projectId) { setCoverProjectSubs([]); setCoverProjectSuppliers([]); setCoverProjectCms([]); return }
    const [subsRes, supplRes, cmsRes] = await Promise.all([
      fetch(`/api/projects/${projectId}/subcontractors`),
      fetch(`/api/projects/${projectId}/suppliers`),
      fetch(`/api/projects/${projectId}/cms`),
    ])
    setCoverProjectSubs(subsRes.ok ? await subsRes.json() : [])
    setCoverProjectSuppliers(supplRes.ok ? await supplRes.json() : [])
    setCoverProjectCms(cmsRes.ok ? await cmsRes.json() : [])
  }

  function initCoverForm() {
    if (!openFileCtx) return
    const proj = appProjects.find(p => p.id === modalProjectId)
    const today = new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" })
    const myName = teamMembers.find(m => m.email === userEmail)?.name ?? userEmail ?? ""
    setCoverSelectedId("")
    setCoverForm({ projectName: proj?.name ?? "", projectNumber: proj?.number ?? "", projectLocation: proj?.location ?? "", gcName: proj?.gc_name ?? "", architect: proj?.architect ?? "", specSectionNo: openFileCtx.secCode, specSectionTitle: openFileCtx.secName, description: openFileCtx.file.file_name.replace(/\.[^.]+$/, ""), dateSubmitted: today, submittalNo: "1", revisionNo: "00", dueDate: "", isCritical: false, partyRequired: false, copyTo: "", reviewedBy: "", certifiedBy: "", notes: "", sendToType: "", sendToCompany: "", sendToContact: "", sendToEmail: "", sendToPhone: "", sendToAddress: "", transmittedBy: myName, transmittedByCompany: proj?.gc_name ?? "" })
    setFileModalStep("form")
    if (modalProjectId) loadCoverContacts(modalProjectId)
  }

  function openTransmittal(s: SubmittalRecord) {
    setOpenFileCtx({
      file: { id: s.id, file_name: s.file_name, file_url: "", mime_type: s.mime_type, file_size: s.file_size, created_at: s.created_at },
      divNum: s.csi_division ?? "", divName: s.division_name ?? "",
      secCode: s.csi_section ?? "", secName: s.section_name ?? "",
    })
    const pid = s.project_id ?? ""
    setModalProjectId(pid)
    setCoverEditId(s.id)
    const proj = appProjects.find(p => p.id === pid)
    const today = new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" })
    const myName = teamMembers.find(m => m.email === userEmail)?.name ?? userEmail ?? ""
    setCoverForm({
      projectName: proj?.name ?? "", projectNumber: proj?.number ?? "",
      projectLocation: proj?.location ?? "", gcName: proj?.gc_name ?? "",
      architect: proj?.architect ?? "", specSectionNo: s.csi_section ?? "",
      specSectionTitle: s.section_name ?? "",
      description: s.file_name.replace(/\.[^.]+$/, ""),
      dateSubmitted: today, submittalNo: s.submittal_number ?? "1",
      revisionNo: s.revision_number ?? "00", dueDate: s.due_date ?? "",
      isCritical: s.is_critical ?? false, partyRequired: s.party_required ?? false,
      copyTo: s.copy_to ?? "",
      reviewedBy: "", certifiedBy: "", notes: "",
      sendToType: (s.send_to_type as "cm"|"subcontractor"|"supplier"|"") ?? "",
      sendToCompany: s.send_to_company ?? "",
      sendToContact: s.send_to_contact ?? "",
      sendToEmail: s.send_to_email ?? "",
      sendToPhone: s.send_to_phone ?? "",
      sendToAddress: s.send_to_address ?? "",
      transmittedBy: s.transmitted_by ?? myName,
      transmittedByCompany: s.transmitted_by_company ?? proj?.gc_name ?? "",
    })
    setCoverSelectedId(s.send_to_type ? "__manual__" : "")
    setFileModalStep("form")
    if (pid) loadCoverContacts(pid)
  }

  async function handleGenerateCover(e: React.FormEvent) {
    e.preventDefault()
    if (!coverForm || !openFileCtx) return
    setGeneratingCover(true)
    try {
      const res = await fetch("/api/generate-cover", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ submittalId: openFileCtx.file.id, projectId: modalProjectId || null, existingId: coverEditId || null, ...coverForm }) })
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}))
        throw new Error(errJson.error ?? `Server error ${res.status}`)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = openFileCtx.file.file_name.replace(/\.[^.]+$/, "") + "_transmittal.pdf"
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      const pid = modalProjectId
      closeFileModal()
      if (pid) loadSubmittals(pid)
    } catch (err) {
      alert("Failed to generate transmittal: " + (err instanceof Error ? err.message : "Unknown error"))
    } finally { setGeneratingCover(false) }
  }

  function toggleDivision(num: string) {
    setOpenDivisions(prev => {
      const next = new Set(prev)
      next.has(num) ? next.delete(num) : next.add(num)
      return next
    })
  }

  async function toggleSection(code: string) {
    setOpenSections(prev => {
      const next = new Set(prev)
      next.has(code) ? next.delete(code) : next.add(code)
      return next
    })
    if (sectionFiles[code] !== undefined || loadingSections.has(code)) return
    setLoadingSections(prev => new Set([...prev, code]))
    try {
      const res  = await fetch(`/api/files?code=${encodeURIComponent(code)}`)
      const data = await res.json()
      setSectionFiles(prev => ({ ...prev, [code]: data.files ?? [] }))
    } catch {
      setSectionFiles(prev => ({ ...prev, [code]: [] }))
    } finally {
      setLoadingSections(prev => { const n = new Set(prev); n.delete(code); return n })
    }
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    const q = query.trim()
    if (!q) { clearSearch(); return }
    setSearching(true)
    setSearchError(null)
    setSearchAiSummary(null)
    try {
      const res  = await fetch(`/api/search?q=${encodeURIComponent(q)}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Search failed")
      setSearchResults(data.files)
      setSearchAiSummary(data.aiSummary ?? null)
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : "Search failed")
      setSearchResults(null)
    } finally {
      setSearching(false)
    }
  }

  function clearSearch() {
    setQuery("")
    setSearchResults(null)
    setSearchError(null)
    setSearchAiSummary(null)
    inputRef.current?.focus()
  }

  function refetchSection(code: string) {
    setLoadingSections(prev => new Set([...prev, code]))
    fetch(`/api/files?code=${encodeURIComponent(code)}`)
      .then(r => r.json())
      .then(d => setSectionFiles(prev => ({ ...prev, [code]: d.files ?? [] })))
      .catch(() => setSectionFiles(prev => ({ ...prev, [code]: [] })))
      .finally(() => setLoadingSections(prev => { const n = new Set(prev); n.delete(code); return n }))
  }

  function loadSubmittals(pid = activeProjectId) {
    // The Submittal Log is strictly scoped to the current project — it must
    // never run the cross-project query (that is the Library's job). With no
    // project selected, show nothing rather than every company submittal.
    if (!pid) {
      logReqSeq.current++
      setLogSubmittals([])
      setLogLoading(false)
      return
    }
    setLogLoading(true)
    const seq = ++logReqSeq.current
    fetch(`/api/submittals?project_id=${encodeURIComponent(pid)}`)
      .then(r => r.json())
      .then(d => { if (seq === logReqSeq.current) setLogSubmittals(d.submittals ?? []) })
      .catch(() => { if (seq === logReqSeq.current) setLogSubmittals([]) })
      .finally(() => { if (seq === logReqSeq.current) setLogLoading(false) })
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadSubmittals(activeProjectId) }, [activeProjectId])

  // ── Submittal-log inline editing ─────────────────────────────────────────────
  // Vendors for the inline picker — company-wide subcontractors + suppliers.
  function loadVendors() {
    fetch("/api/subcontractors").then(r => r.json())
      .then(d => setVendorSubs(Array.isArray(d) ? d : [])).catch(() => {})
    fetch("/api/suppliers").then(r => r.json())
      .then(d => setVendorSuppliers(Array.isArray(d) ? d : [])).catch(() => {})
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (activeModule === "submittals") loadVendors() }, [activeModule])

  function vendorLabel(s: SubmittalRecord): string {
    if (s.vendor_subcontractor_id)
      return vendorSubs.find(v => v.id === s.vendor_subcontractor_id)?.company_name ?? "—"
    if (s.vendor_supplier_id)
      return vendorSuppliers.find(v => v.id === s.vendor_supplier_id)?.company_name ?? "—"
    return ""
  }

  // ── Sub-package selection (Session I) ────────────────────────────────────────
  function toggleRowSelected(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }
  // Add or remove a batch of rows from the selection (used by select-all and
  // the by-section picker, which is additive).
  function setRowsSelected(ids: string[], on: boolean) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      for (const id of ids) on ? next.add(id) : next.delete(id)
      return next
    })
  }
  function exitSelectMode() { setSelectMode(false); setSelectedIds(new Set()) }

  // Derive a vendor preset for the package modal: when every selected submittal
  // shares one vendor, prefill it; otherwise the PM names the recipient.
  function computeVendorPreset(picked: SubmittalRecord[]): VendorPreset | null {
    if (picked.length === 0) return null
    const subIds = new Set(picked.map(s => s.vendor_subcontractor_id))
    const supIds = new Set(picked.map(s => s.vendor_supplier_id))
    if (subIds.size === 1 && !subIds.has(null) && supIds.size === 1 && supIds.has(null)) {
      const v = vendorSubs.find(x => x.id === [...subIds][0])
      if (v) return { id: v.id, type: "subcontractor", name: v.company_name, email: v.email ?? null }
    }
    if (supIds.size === 1 && !supIds.has(null) && subIds.size === 1 && subIds.has(null)) {
      const v = vendorSuppliers.find(x => x.id === [...supIds][0])
      if (v) return { id: v.id, type: "supplier", name: v.company_name, email: v.email ?? null }
    }
    return null
  }
  const selectedSubmittals = logSubmittals.filter(s => selectedIds.has(s.id))

  // Optimistic local update + 500ms-debounced PATCH, coalescing several field
  // edits on the same row into one request.
  function patchSubmittal(id: string, updates: Record<string, unknown>) {
    setLogSubmittals(prev => prev.map(s => s.id === id ? { ...s, ...updates } as SubmittalRecord : s))
    setSearchResults(prev => prev ? prev.map(s => s.id === id ? { ...s, ...updates } as SubmittalRecord : s) : prev)
    pendingPatches.current.set(id, { ...(pendingPatches.current.get(id) ?? {}), ...updates })
    const existing = saveTimers.current.get(id)
    if (existing) clearTimeout(existing)
    saveTimers.current.set(id, setTimeout(() => {
      const body = pendingPatches.current.get(id) ?? {}
      pendingPatches.current.delete(id)
      saveTimers.current.delete(id)
      fetch(`/api/submittals/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }).catch(() => { /* optimistic — reconciles on next load */ })
    }, 500))
  }

  // ── Excel export ─────────────────────────────────────────────────────────────
  // Replicates the table's in-render sort so the spreadsheet row order matches
  // what the user sees on screen. `displaySubmittals` already accounts for the
  // search filter; `groupBySection` flips between section/type/seq vs seq only.
  const [exporting, setExporting] = useState(false)
  async function handleExportLog() {
    if (!activeProjectId) return
    const project = appProjects.find(p => p.id === activeProjectId)
    if (!project) return
    const exportRows = [...displaySubmittals]
    if (groupBySection) {
      exportRows.sort((a, b) =>
        (a.csi_section ?? "").localeCompare(b.csi_section ?? "") ||
        (a.submittal_type ?? "").localeCompare(b.submittal_type ?? "") ||
        (a.submittal_seq ?? 0) - (b.submittal_seq ?? 0))
    } else {
      exportRows.sort((a, b) => (a.submittal_seq ?? 0) - (b.submittal_seq ?? 0))
    }
    setExporting(true)
    try {
      await exportSubmittalLogToExcel({
        rows: exportRows,
        projectName: project.name,
        gcName: project.gc_name,
        vendorSubs,
        vendorSuppliers,
        appOrigin: window.location.origin,
        groupedBySection: groupBySection,
        isSearchMode,
        searchQuery: query.trim() || null,
      })
    } catch (err) {
      alert(err instanceof Error ? err.message : "Export failed")
    } finally {
      setExporting(false)
    }
  }

  // ── Reset Submittal Log ──────────────────────────────────────────────────────
  async function openResetConfirm(scope: "all" | "spec_ingestion") {
    setResetMenuOpen(false)
    if (!activeProjectId) return
    setResetScope(scope)
    setResetCount(null)
    try {
      const r = await fetch(`/api/submittals/reset?project_id=${encodeURIComponent(activeProjectId)}&scope=${scope}`)
      const d = await r.json()
      setResetCount(r.ok ? (d.count ?? 0) : 0)
    } catch { setResetCount(0) }
  }

  async function doReset() {
    if (!activeProjectId || !resetScope) return
    setResetting(true)
    try {
      const r = await fetch("/api/submittals/reset", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: activeProjectId, scope: resetScope }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error ?? "Reset failed")
      setResetScope(null)
      loadSubmittals(activeProjectId)
      loadTree()
    } catch (err) {
      alert(err instanceof Error ? err.message : "Reset failed")
    } finally { setResetting(false) }
  }

  // ── Source spec PDF ──────────────────────────────────────────────────────────
  async function openSource(s: SubmittalRecord) {
    setSourceLoadingId(s.id)
    try {
      const r = await fetch(`/api/submittals/${s.id}/source`)
      const d = await r.json()
      if (!r.ok) throw new Error(d.error ?? "No source available")
      setSourceModal(d)
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not open source")
    } finally { setSourceLoadingId(null) }
  }

  // ── Pending Review (staged submittals) ───────────────────────────────────────
  function loadPending(pid = globalProjectId) {
    if (!pid) { setPendingStaged([]); setPendingSections([]); setPendingDocuments([]); return }
    setPendingLoading(true)
    fetch(`/api/staged-submittals?project_id=${encodeURIComponent(pid)}`)
      .then(r => r.json())
      .then(d => {
        setPendingStaged(d.staged ?? [])
        setPendingSections(d.sections ?? [])
        setPendingDocuments(d.documents ?? [])
      })
      .catch(() => { setPendingStaged([]); setPendingSections([]); setPendingDocuments([]) })
      .finally(() => setPendingLoading(false))
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (activeModule === "submittals") loadPending() }, [activeModule, globalProjectId])

  function updateStagedLocal(ids: string[], updates: Partial<StagedSubmittal>) {
    const set = new Set(ids)
    setPendingStaged(prev => prev.map(s => set.has(s.id) ? { ...s, ...updates } : s))
  }

  function patchStaged(ids: string[], updates: Partial<StagedSubmittal>) {
    updateStagedLocal(ids, updates)
    for (const id of ids) {
      fetch(`/api/staged-submittals/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      }).catch(() => { /* optimistic — server reconciles on next load */ })
    }
  }

  async function commitStaged() {
    if (!globalProjectId) return
    setPendingCommitting(true)
    try {
      const res = await fetch("/api/staged-submittals/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: globalProjectId, mode: specMode }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? "Commit failed")
      let msg = `Added ${d.committed} submittal${d.committed === 1 ? "" : "s"} to the log.`
      if (d.skippedMissingSection > 0) {
        msg += ` ${d.skippedMissingSection} row${d.skippedMissingSection === 1 ? "" : "s"} skipped — their spec section was re-parsed during review.`
      }
      alert(msg)
      setSubmittalsView("log")
      loadPending()
      loadSubmittals(globalProjectId)
    } catch (err) {
      alert(err instanceof Error ? err.message : "Commit failed")
    } finally {
      setPendingCommitting(false)
    }
  }

  function openEditModal(s: SubmittalRecord) {
    setEditSubmittal(s)
    setEditStatus(s.review_status ?? "Received")
    setEditDiv(s.csi_division ?? "")
    setEditDivName(s.division_name ?? "")
    setEditSec(s.csi_section ?? "")
    setEditSecName(s.section_name ?? "")
  }

  async function deleteSubmittal(s: SubmittalRecord) {
    if (!window.confirm(`Delete "${s.file_name}"? This cannot be undone.`)) return
    const res = await fetch(`/api/submittals/${s.id}`, { method: "DELETE" })
    if (res.ok) {
      // Optimistically remove from all local caches
      setLogSubmittals(prev => prev.filter(x => x.id !== s.id))
      setSectionFiles(prev => {
        const next = { ...prev }
        // Clear the section cache entirely so next toggle re-fetches fresh from DB
        if (s.csi_section) delete next[s.csi_section]
        return next
      })
      loadTree()
      loadSubmittals()
    }
  }

  async function saveEdit() {
    if (!editSubmittal) return
    setEditSaving(true)
    const div = CSI_DIVISIONS.find(d => d.num === editDiv)
    const sec = (CSI_SECTIONS[editDiv] ?? []).find(s => s.code === editSec)
    const updates: Record<string, string | null> = {
      review_status: editStatus || null,
      csi_division:  editDiv || null,
      division_name: (div?.name ?? editDivName) || null,
      csi_section:   editSec || null,
      section_name:  (sec?.name ?? editSecName) || null,
    }
    try {
      const res = await fetch(`/api/submittals/${editSubmittal.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(updates),
      })
      if (res.ok) { setEditSubmittal(null); loadSubmittals(); loadTree() }
    } finally { setEditSaving(false) }
  }

  async function handleTransmittal(sub: SubmittalRecord, subNum: number) {
    setTransmittalSub(sub)
    setTransmittalLoading(true)
    setTransmittalPdfUrl(null)
    try {
      const res = await fetch(`/api/transmittal/${sub.id}`, { method: "POST" })
      if (!res.ok) { alert("Failed to generate transmittal PDF. Please try again."); return }
      const { url } = await res.json()
      setTransmittalPdfUrl(url)

      const proj = appProjects.find(p => p.id === sub.project_id)
      const title = sub.file_name.replace(/\.[^.]+$/, "")
      const safeName = title.replace(/[^a-zA-Z0-9_-]/g, "_")
      const div = [sub.csi_division, sub.division_name].filter(Boolean).join(" — ")
      const emailSubject = `Submittal Transmittal — ${proj?.name ?? ""} — ${subNum} — ${title} — ${div}`
      const today = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
      const senderName = sub.transmitted_by ?? ""
      const senderCompany = sub.transmitted_by_company ?? proj?.gc_name ?? ""
      const emailBody = [
        "Please find attached the following submittal for your review:",
        "",
        `Project: ${proj?.name ?? ""}`,
        `Submittal No.: ${subNum}`,
        `Title: ${title}`,
        `CSI Division: ${div}`,
        `Section: ${sub.section_name ?? sub.csi_section ?? ""}`,
        `Date: ${today}`,
        "",
        "Please review and return with your response at your earliest convenience.",
        "",
        `This submittal has been transmitted by ${senderName} on behalf of ${senderCompany}.`,
        "",
        "Regards,",
        senderName,
        senderCompany,
      ].join("\n")

      // Fetch PDF as a blob so we can share/download it directly
      const pdfRes = await fetch(url)
      const pdfBlob = await pdfRes.blob()
      const pdfFile = new File([pdfBlob], `${safeName}_transmittal.pdf`, { type: "application/pdf" })

      // Web Share API: on mobile this opens the native share sheet with the PDF attached
      // The user picks their email app and the file is already there
      if (typeof navigator.share === "function" && navigator.canShare?.({ files: [pdfFile] })) {
        try {
          await navigator.share({
            files: [pdfFile],
            title: emailSubject,
            text: emailBody,
          })
          setShowTransmittalConfirm(true)
          return
        } catch {
          // User cancelled share sheet — fall through to mailto fallback
        }
      }

      // Desktop fallback: download PDF then open email client
      // Must use object URL (same-origin) so the download attribute is respected
      const objectUrl = URL.createObjectURL(pdfBlob)
      const dlLink = document.createElement("a")
      dlLink.href = objectUrl
      dlLink.download = `${safeName}_transmittal.pdf`
      document.body.appendChild(dlLink)
      dlLink.click()
      document.body.removeChild(dlLink)

      // Open mailto after a short delay so the browser doesn't block both
      const mailto = `mailto:${encodeURIComponent(sub.send_to_email ?? "")}?subject=${encodeURIComponent(emailSubject)}&body=${encodeURIComponent(emailBody)}`
      setTimeout(() => {
        const mailLink = document.createElement("a")
        mailLink.href = mailto
        document.body.appendChild(mailLink)
        mailLink.click()
        document.body.removeChild(mailLink)
        URL.revokeObjectURL(objectUrl)
      }, 300)

      setShowTransmittalConfirm(true)
    } finally {
      setTransmittalLoading(false)
    }
  }

  async function markTransmitted() {
    if (!transmittalSub) return
    await fetch(`/api/submittals/${transmittalSub.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        review_status: "Transmitted",
        transmittal_sent_at: new Date().toISOString(),
        transmittal_recipient: transmittalSub.send_to_email ?? transmittalSub.send_to_contact ?? "",
      }),
    })
    setShowTransmittalConfirm(false)
    setTransmittalSub(null)
    setTransmittalPdfUrl(null)
    loadSubmittals()
  }

  function closeBatch() {
    setShowBatch(false)
    setBatchItems([])
    setBatchPhase("select")
    setBatchDragOver(false)
  }

  function updateBatchItem(id: string, update: Partial<BatchItem>) {
    setBatchItems(prev => prev.map(it => it.id === id ? { ...it, ...update } : it))
  }

  function initBatchFiles(files: File[]) {
    const valid = files.filter(f => /\.(pdf|doc|docx|xls|xlsx|dwg|rvt)$/i.test(f.name))
    if (!valid.length) return
    setBatchItems(valid.map((file, i) => ({
      id: `${Date.now()}-${i}`, file, status: "pending",
      divNum: "", divName: "", secCode: "", secName: "",
      nameMatl: "", nameMfr: "", nameDims: "", customName: file.name.replace(/\.[^.]+$/, ""), expanded: false,
    })))
  }

  async function classifyBatch() {
    setBatchPhase("classifying")
    const items = [...batchItems]
    const CONCURRENCY = 4

    async function classifyOne(item: BatchItem) {
      updateBatchItem(item.id, { status: "classifying" })
      try {
        // PUT the file straight to storage once — its path then feeds both
        // /api/classify here and /api/upload in uploadBatch.
        const { path } = await presignAndUpload("submittals", "uploads", item.file)
        updateBatchItem(item.id, { storagePath: path })
        const res  = await fetch("/api/classify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ storage_path: path, file_name: item.file.name }),
        })
        const data = await res.json()
        if (res.ok && data.division_num && data.section_code) {
          const nameMatl = data.material_name ?? ""
          const nameMfr  = data.manufacturer  ?? ""
          const nameDims = data.dimensions     ?? ""
          const composed = [nameMatl, nameMfr, nameDims].filter(Boolean).join(" — ")
          updateBatchItem(item.id, {
            status: "ready",
            divNum: data.division_num, divName: data.division_name,
            secCode: data.section_code, secName: data.section_name,
            nameMatl, nameMfr, nameDims,
            customName: composed || item.file.name.replace(/\.[^.]+$/, ""),
          })
        } else {
          updateBatchItem(item.id, { status: "error", errorMsg: "Could not classify — assign manually" })
        }
      } catch {
        updateBatchItem(item.id, { status: "error", errorMsg: "Network error" })
      }
    }

    // Run in chunks of CONCURRENCY to stay within API rate limits
    for (let i = 0; i < items.length; i += CONCURRENCY) {
      await Promise.all(items.slice(i, i + CONCURRENCY).map(classifyOne))
    }
    setBatchPhase("review")
  }

  async function uploadBatch() {
    setBatchPhase("uploading")
    const toUpload = batchItems.filter(it => (it.status === "ready" || it.status === "error") && it.divNum && it.secCode)

    async function uploadOne(item: BatchItem) {
      updateBatchItem(item.id, { status: "uploading" })
      if (!item.storagePath) {
        // classifyBatch PUTs the file before classifying; a missing path means
        // that upload failed, so there is nothing in storage to record.
        updateBatchItem(item.id, { status: "upload-error", errorMsg: "File was not uploaded — re-add it" })
        return
      }
      try {
        const res = await fetch("/api/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            file_path:     item.storagePath,
            file_name:     item.file.name,
            file_size:     item.file.size,
            mime_type:     item.file.type || null,
            division_num:  item.divNum,
            division_name: item.divName,
            section_code:  item.secCode,
            section_name:  item.secName,
            material_name: item.nameMatl || null,
            manufacturer:  item.nameMfr  || null,
            dimensions:    item.nameDims || null,
            display_name:  item.customName || null,
            project_id:    globalProjectId || null,
          }),
        })
        updateBatchItem(item.id, { status: res.ok ? "done" : "upload-error", errorMsg: res.ok ? undefined : "Upload failed" })
      } catch {
        updateBatchItem(item.id, { status: "upload-error", errorMsg: "Network error" })
      }
    }

    // Uploads can all run in parallel — no AI rate limit concern
    await Promise.all(toUpload.map(uploadOne))
    setBatchPhase("done")
    loadTree()
    loadSubmittals()
    setSectionFiles({})
  }

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault()
    if (!uploadFile || !uploadFilePath || !uploadDiv || !uploadSec) return
    setUploading(true)
    setUploadError(null)

    // The file was already PUT to storage when it was picked (see the file
    // input's onChange) — only metadata travels through the API route here.
    const payload: Record<string, unknown> = {
      file_path:     uploadFilePath,
      file_name:     uploadFile.name,
      file_size:     uploadFile.size,
      mime_type:     uploadFile.type || null,
      division_num:  uploadDiv,
      division_name: uploadDivName,
      section_code:  uploadSec,
      section_name:  uploadSecName,
      material_name: nameMatl,
      manufacturer:  nameMfr,
      dimensions:    nameDims,
    }
    if (globalProjectId)              payload.project_id    = globalProjectId
    if (aiResult?.confidence != null) payload.ai_confidence = aiResult.confidence
    if (aiResult?.reasoning)          payload.ai_reasoning  = aiResult.reasoning

    try {
      const res  = await fetch("/api/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Upload failed")

      // Append new name values to local opts so they appear in next upload
      setNameOpts(prev => ({
        materials:     nameMatl.trim() && !prev.materials.includes(nameMatl.trim())     ? [...prev.materials,     nameMatl.trim()].sort()     : prev.materials,
        manufacturers: nameMfr.trim()  && !prev.manufacturers.includes(nameMfr.trim()) ? [...prev.manufacturers, nameMfr.trim()].sort()  : prev.manufacturers,
        dimensions:    nameDims.trim() && !prev.dimensions.includes(nameDims.trim())   ? [...prev.dimensions,    nameDims.trim()].sort()    : prev.dimensions,
      }))

      // Open the division + section and immediately fetch the files
      setOpenDivisions(prev => new Set([...prev, uploadDiv]))
      setOpenSections(prev => new Set([...prev, uploadSec]))
      setSectionFiles(prev => { const n = { ...prev }; delete n[uploadSec]; return n })
      refetchSection(uploadSec)
      loadTree()
      closeModal()

      // If uploaded directly to a project, immediately prompt for cover sheet
      if (globalProjectId && data.record) {
        const rec = data.record
        const proj = appProjects.find(p => p.id === globalProjectId)
        const today = new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" })
        setOpenFileCtx({ file: { id: rec.id, file_name: rec.file_name, file_url: "", mime_type: rec.mime_type, file_size: rec.file_size, created_at: rec.created_at }, divNum: rec.csi_division ?? uploadDiv, divName: rec.division_name ?? uploadDivName, secCode: rec.csi_section ?? uploadSec, secName: rec.section_name ?? uploadSecName })
        setModalProjectId(globalProjectId)
        setCoverEditId(rec.id)
        const myName = teamMembers.find(m => m.email === userEmail)?.name ?? userEmail ?? ""
        setCoverForm({ projectName: proj?.name ?? "", projectNumber: proj?.number ?? "", projectLocation: proj?.location ?? "", gcName: proj?.gc_name ?? "", architect: proj?.architect ?? "", specSectionNo: rec.csi_section ?? uploadSec, specSectionTitle: rec.section_name ?? uploadSecName, description: rec.file_name.replace(/\.[^.]+$/, ""), dateSubmitted: today, submittalNo: "1", revisionNo: "00", dueDate: "", isCritical: false, partyRequired: false, copyTo: "", reviewedBy: "", certifiedBy: "", notes: "", sendToType: "", sendToCompany: "", sendToContact: "", sendToEmail: "", sendToPhone: "", sendToAddress: "", transmittedBy: myName, transmittedByCompany: proj?.gc_name ?? "" })
        loadCoverContacts(globalProjectId)
        setFileModalStep("form")
      } else {
        loadSubmittals()
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed")
    } finally {
      setUploading(false)
    }
  }

  const isSearchMode = searchResults !== null || searching
  const displaySubmittals = isSearchMode ? (searchResults ?? []) : logSubmittals
  return (
    <>
        {/* Library action bar */}
        {activeModule === "library" && (
        <div className="flex-shrink-0 border-b border-[#E2E8F0] bg-white flex items-center justify-between px-4 py-2.5 gap-2 min-w-0">
          <p className="text-[13px] font-semibold text-[#0F172A] truncate min-w-0">Submittal Library</p>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={() => { setShowBatch(true); setBatchPhase("select"); setBatchItems([]) }}
              className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[12px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors flex items-center gap-1.5 whitespace-nowrap"
            >
              <LayersIcon /> <span className="hidden sm:inline">Batch </span>Upload
            </button>
            <button
              onClick={() => setShowUpload(true)}
              className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors flex items-center gap-1.5 whitespace-nowrap"
            >
              <PlusIcon /> <span className="hidden sm:inline">Upload Submittal to </span>Library
            </button>
          </div>
        </div>
        )}

        {/* Submittal Log action bar */}
        {activeModule === "submittals" && (
        <div className="flex-shrink-0 border-b border-[#E2E8F0] bg-white">
          <div className="flex items-center justify-between px-4 py-2.5 gap-2 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <div className="flex rounded-md border border-[#E2E8F0] overflow-hidden flex-shrink-0">
                {(["log", "pending", "packages"] as const).map(v => (
                  <button key={v} onClick={() => setSubmittalsView(v)}
                    className={`h-7 px-3 text-[12px] font-medium transition-colors ${submittalsView === v ? "bg-[#7B9BB5] text-white" : "bg-white text-[#64748B] hover:bg-[#F8F9FA]"}`}>
                    {v === "log"
                      ? "Submittal Log"
                      : v === "pending"
                        ? `Pending Review${pendingStaged.length > 0 ? ` (${pendingStaged.length})` : ""}`
                        : "Packages"}
                  </button>
                ))}
              </div>
              <p className="text-[12px] text-[#64748B] truncate hidden sm:block">
                {submittalsView === "log"
                  ? (isSearchMode
                      ? `Search results${searchResults !== null ? ` (${searchResults.length})` : ""}`
                      : `${logSubmittals.length} submittal${logSubmittals.length === 1 ? "" : "s"}`)
                  : "Staged from spec book — review and commit"}
              </p>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {submittalsView === "log" && !isSearchMode && (
                <label className="flex items-center gap-1.5 text-[12px] text-[#64748B] cursor-pointer select-none whitespace-nowrap">
                  <input type="checkbox" checked={groupBySection}
                    onChange={e => setGroupBySection(e.target.checked)}
                    className="accent-[#7B9BB5]" />
                  <span className="hidden sm:inline">Group by section</span>
                </label>
              )}
              {submittalsView === "log" && !isSearchMode && activeProjectId && (
                <button
                  onClick={() => { if (selectMode) exitSelectMode(); else setSelectMode(true) }}
                  className={`h-8 px-3 rounded-md border text-[12px] font-semibold transition-colors flex items-center gap-1.5 whitespace-nowrap ${
                    selectMode
                      ? "border-[#7B9BB5] bg-[#7B9BB5]/10 text-[#0F172A]"
                      : "border-[#E2E8F0] text-[#64748B] hover:bg-[#0F172A]/[0.04]"
                  }`}
                >
                  <CheckIcon /> {selectMode ? "Done" : "Select"}
                </button>
              )}
              {submittalsView === "log" && activeProjectId && displaySubmittals.length > 0 && (
                <button
                  onClick={handleExportLog}
                  disabled={exporting}
                  title="Download the current view as an Excel spreadsheet"
                  className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[12px] font-semibold text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors flex items-center gap-1.5 whitespace-nowrap disabled:opacity-60"
                >
                  {exporting ? <SpinnerIcon className="h-3.5 w-3.5" /> : (
                    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" />
                    </svg>
                  )}
                  <span className="hidden sm:inline">{exporting ? "Exporting…" : "Export"}</span>
                </button>
              )}
              {submittalsView === "log" && activeProjectId && (
                <div className="relative">
                  <button
                    onClick={() => setResetMenuOpen(o => !o)}
                    className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[12px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors flex items-center gap-1.5 whitespace-nowrap"
                  >
                    Reset
                    <svg className={`w-3 h-3 transition-transform ${resetMenuOpen ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  {resetMenuOpen && (
                    <>
                      <div className="fixed inset-0 z-40" onClick={() => setResetMenuOpen(false)} />
                      <div className="absolute right-0 top-full mt-1 z-50 w-64 bg-white border border-[#E2E8F0] rounded-lg shadow-xl overflow-hidden">
                        <button onClick={() => openResetConfirm("spec_ingestion")}
                          className="w-full text-left px-3 py-2.5 hover:bg-[#F8F9FA] transition-colors">
                          <span className="block text-[12px] font-semibold text-[#0F172A]">Reset spec-ingested only</span>
                          <span className="block text-[11px] text-[#64748B]">Removes AI-extracted rows; keeps manual &amp; email entries.</span>
                        </button>
                        <button onClick={() => openResetConfirm("all")}
                          className="w-full text-left px-3 py-2.5 hover:bg-red-50 transition-colors border-t border-[#E2E8F0]">
                          <span className="block text-[12px] font-semibold text-red-600">Reset all submittals</span>
                          <span className="block text-[11px] text-red-400">Deletes every submittal in this project.</span>
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
              <button
                onClick={() => onNavigate("library")}
                className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[12px] text-[#7B9BB5] hover:bg-[#0F172A]/[0.04] transition-colors flex items-center gap-1.5 whitespace-nowrap"
              >
                <PlusIcon /> <span className="hidden sm:inline">Upload to Library</span>
              </button>
            </div>
          </div>
          {submittalsView === "log" && (<>
          <form onSubmit={handleSearch} className="flex items-center gap-2 px-4 pb-2.5">
            <div className="relative flex-1">
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#94A3B8] pointer-events-none"><SearchIcon /></span>
              <input
                ref={inputRef}
                type="search"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search submittals by name, spec section, or description…"
                className="w-full h-8 pl-8 pr-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 focus:border-[#7B9BB5]/50 placeholder:text-[#94A3B8]"
              />
              {query && (
                <button type="button" onClick={clearSearch} className="absolute right-2 top-1/2 -translate-y-1/2 text-[#94A3B8] hover:text-[#0F172A]">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
                </button>
              )}
            </div>
            <button type="submit" disabled={searching} className="h-8 px-3 rounded-md bg-[#7B9BB5] text-white text-[12px] font-semibold hover:bg-[#6A8AA4] transition-colors flex items-center gap-1.5 flex-shrink-0 disabled:opacity-60">
              {searching ? <SpinnerIcon className="h-3.5 w-3.5" /> : "Search"}
            </button>
          </form>
          {searchAiSummary && (
            <p className="px-4 pb-2 text-[12px] text-[#64748B] italic">{searchAiSummary}</p>
          )}
          {searchError && (
            <p className="px-4 pb-2 text-[12px] text-red-500">{searchError}</p>
          )}
          </>)}
        </div>
        )}
        <div className="flex-1 overflow-y-auto min-h-0">

          {/* Library */}
          {activeModule === "library" && (
            <div className="px-4 py-4 max-w-4xl">
              {treeLoading ? (
                <div className="flex items-center gap-2 py-8 text-[13px] text-[#64748B]">
                  <SpinnerIcon className="h-4 w-4" /> Loading library…
                </div>
              ) : divisions.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-24 text-center">
                  <div className="w-14 h-14 rounded-2xl bg-[#7B9BB5]/10 border border-[#7B9BB5]/20 flex items-center justify-center mb-4">
                    <svg className="w-7 h-7 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                  </div>
                  <p className="text-[15px] font-bold text-[#0F172A]">Your library is empty</p>
                  <p className="text-[13px] text-[#64748B] mt-1.5 mb-5">Upload submittals to start building your CSI library.</p>
                  <button onClick={() => setShowUpload(true)} className="h-9 px-5 rounded-lg bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors inline-flex items-center gap-2">
                    <PlusIcon /> Upload Submittal to Library
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  {divisions.map(div => (
                    <div key={div.num} className="bg-white rounded-xl border border-[#E2E8F0] overflow-hidden">
                      <div className="flex items-center justify-between px-4 py-3 bg-[#F8F9FA] border-b border-[#E2E8F0]">
                        <div className="flex items-center gap-2.5">
                          <span className="text-[11px] font-mono font-bold text-[#7B9BB5] bg-[#7B9BB5]/10 px-2 py-0.5 rounded">{div.num}</span>
                          <span className="text-[13px] font-semibold text-[#0F172A]">{div.name}</span>
                        </div>
                        <span className="text-[11px] text-[#64748B]">{div.file_count} {div.file_count === 1 ? "file" : "files"}</span>
                      </div>
                      <div className="divide-y divide-[#E2E8F0]">
                        {div.sections.filter(s => (s.file_count ?? 0) > 0).map(sec => (
                          <div key={sec.code}>
                            <button
                              onClick={() => toggleSection(sec.code)}
                              className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-[#F4F5F7] transition-colors text-left"
                            >
                              <div className="flex items-center gap-2.5 min-w-0">
                                <span className="text-[11px] font-mono text-[#64748B] flex-shrink-0">{sec.code}</span>
                                <span className="text-[13px] text-[#0F172A] truncate">{sec.name}</span>
                              </div>
                              <div className="flex items-center gap-1.5 flex-shrink-0 ml-4">
                                <span className="text-[11px] text-[#64748B]">{sec.file_count} {sec.file_count === 1 ? "file" : "files"}</span>
                                <svg className={`w-3.5 h-3.5 text-[#64748B] transition-transform ${openSections.has(sec.code) ? "rotate-90" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7"/></svg>
                              </div>
                            </button>
                            {openSections.has(sec.code) && (
                              <div className="border-t border-[#E2E8F0] bg-[#F8F9FA] px-4 py-2 space-y-0.5">
                                {loadingSections.has(sec.code) ? (
                                  <div className="flex items-center gap-2 py-2 text-[12px] text-[#64748B]"><SpinnerIcon className="h-3.5 w-3.5" /> Loading…</div>
                                ) : (sectionFiles[sec.code] ?? []).length === 0 ? (
                                  <p className="text-[12px] text-[#64748B] py-2">No files found.</p>
                                ) : (sectionFiles[sec.code] ?? []).map(file => (
                                  <div key={file.id} className="flex items-center gap-2 py-1.5 group">
                                    <span className={`flex-shrink-0 w-1.5 h-1.5 rounded-full ${getDot(file.mime_type)}`} />
                                    <span className="flex-1 min-w-0 text-[12px] text-[#0F172A] truncate">{file.file_name}</span>
                                    <a
                                      href={file.file_url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="flex-shrink-0 text-[11px] text-[#7B9BB5] hover:text-[#5A7A94] font-medium px-2 py-0.5 rounded hover:bg-[#7B9BB5]/10 transition-colors"
                                    >Open</a>
                                    <button
                                      onClick={() => handleFileOpen(file, div.num, div.name, sec.code, sec.name)}
                                      className="flex-shrink-0 text-[11px] text-[#64748B] hover:text-[#0F172A] font-medium px-2 py-0.5 rounded hover:bg-[#0F172A]/[0.04] transition-colors"
                                    >Cover</button>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Submittal log */}
          {activeModule === "submittals" && (<>
          {submittalsView === "packages" ? (
            !globalProjectId ? (
              <div className="flex flex-col items-center justify-center h-full py-24 text-center">
                <p className="text-[15px] font-bold text-[#0F172A]">Select a project to view packages</p>
                <p className="text-[13px] text-[#64748B] mt-1.5">Use the Project filter above to choose a project.</p>
              </div>
            ) : (
              <PackagesView projectId={globalProjectId} />
            )
          ) : submittalsView === "pending" ? (
            !globalProjectId ? (
              <div className="flex flex-col items-center justify-center h-full py-24 text-center">
                <p className="text-[15px] font-bold text-[#0F172A]">Select a project to review staged submittals</p>
                <p className="text-[13px] text-[#64748B] mt-1.5">Use the Project filter above to choose a project.</p>
              </div>
            ) : pendingLoading ? (
              <div className="flex items-center justify-center h-40 gap-2 text-[13px] text-[#64748B]">
                <SpinnerIcon className="h-4 w-4" /> Loading staged submittals…
              </div>
            ) : pendingStaged.length === 0 ? (() => {
              // Surface the most recent parse's telemetry so an empty Pending
              // Review explains itself instead of looking broken.
              const summary = pendingDocuments.find(d => d.parse_status === "parsed" && d.parse_summary)?.parse_summary ?? null
              return (
                <div className="flex flex-col items-center justify-center h-full py-24 text-center">
                  <div className="w-14 h-14 rounded-2xl bg-[#7B9BB5]/10 border border-[#7B9BB5]/20 flex items-center justify-center mb-4">
                    <svg className="w-7 h-7 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                  </div>
                  <p className="text-[15px] font-bold text-[#0F172A]">Nothing pending review</p>
                  {summary ? (
                    <div className="mt-2 max-w-md space-y-2">
                      <p className="text-[13px] text-[#64748B]">
                        Parsing completed: {summary.sectionsScoped} section{summary.sectionsScoped === 1 ? "" : "s"} scoped, {summary.sectionsWithSubmittals} contained SUBMITTALS articles.
                      </p>
                      {summary.sectionsFound < summary.sectionsScoped && (
                        <p className="text-[13px] text-[#64748B]">
                          This likely means the section bodies are in another volume of the spec book. Upload additional volumes from Settings → Projects.
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="text-[13px] text-[#64748B] mt-1.5">Upload a spec book from Settings → Projects to auto-extract submittals for review.</p>
                  )}
                  <a href="/settings?tab=projects" className="mt-5 h-9 px-5 rounded-lg bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors inline-flex items-center gap-2">
                    Manage spec books
                  </a>
                </div>
              )
            })() : (() => {
              const typeLabels: Record<string, string> = {
                "Product Data": "Product Data", "Shop Drawing": "Shop Drawings", "Sample": "Samples",
                "Certification": "Certifications & Qualifications", "Warranty": "Warranty",
                "O&M Manual": "O&M / Maintenance Data", "Lab Test": "Test Reports",
                "Attic Stock": "Attic Stock", "Other": "Other Submittals",
              }
              const sectionMap = new Map(pendingSections.map(s => [s.id, s]))
              const staged = pendingStaged
              const sectionIds = [...new Set(staged.map(s => s.spec_section_id))]
                .sort((a, b) => (sectionMap.get(a)?.spec_number ?? "").localeCompare(sectionMap.get(b)?.spec_number ?? ""))
              let commitCount = 0
              if (specMode === "detailed") {
                commitCount = staged.filter(s => s.is_selected).length
              } else {
                const g = new Set<string>()
                for (const s of staged) if (s.is_selected) g.add(`${s.spec_section_id}|${s.submittal_type}`)
                commitCount = g.size
              }
              return (
                <div className="flex flex-col min-h-full">
                  {/* Pending Review header */}
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-4 py-3 border-b border-[#E2E8F0] flex-shrink-0">
                    <p className="text-[13px] font-semibold text-[#0F172A]">Pending Review <span className="text-[#64748B] font-normal ml-1">({staged.length} staged)</span></p>
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="flex rounded-md border border-[#E2E8F0] overflow-hidden">
                        {(["consolidated", "detailed"] as const).map(m => (
                          <button key={m} onClick={() => setSpecMode(m)}
                            className={`h-8 px-3 text-[12px] font-medium capitalize transition-colors ${specMode === m ? "bg-[#7B9BB5] text-white" : "bg-white text-[#64748B] hover:bg-[#F8F9FA]"}`}>
                            {m}
                          </button>
                        ))}
                      </div>
                      <button onClick={commitStaged} disabled={pendingCommitting || commitCount === 0}
                        className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed">
                        {pendingCommitting && <SpinnerIcon className="h-3 w-3" />}
                        {pendingCommitting ? "Adding…" : `Add ${commitCount} to Submittal Log`}
                      </button>
                    </div>
                  </div>
                  <div className="px-4 py-4 space-y-4">
                    {sectionIds.map(secId => {
                      const sec  = sectionMap.get(secId)
                      const rows = staged.filter(s => s.spec_section_id === secId)
                      return (
                        <div key={secId} className="rounded-xl border border-[#E2E8F0] overflow-clip bg-white">
                          <div className="bg-[#F8F9FA] border-b border-[#E2E8F0] px-4 py-2">
                            <p className="text-[12px] font-bold text-[#0F172A]">{sec?.spec_number} <span className="font-medium text-[#64748B]">— {sec?.spec_title}</span></p>
                          </div>
                          <table className="w-full text-[13px] border-collapse">
                            <tbody>
                              {specMode === "detailed" ? rows.map(r => (
                                <tr key={r.id} className="border-b border-[#E2E8F0]/60 last:border-0 hover:bg-[#F8F9FA] transition-colors">
                                  <td className="px-3 py-2 w-8 align-top">
                                    <input type="checkbox" checked={r.is_selected}
                                      onChange={() => patchStaged([r.id], { is_selected: !r.is_selected })}
                                      className="accent-[#7B9BB5] mt-0.5" />
                                  </td>
                                  <td className="px-2 py-2 w-8 align-top text-[12px] font-semibold text-[#64748B]">{r.letter ?? ""}</td>
                                  <td className="px-2 py-2 w-56 align-top">
                                    <input type="text" value={r.project_item_name}
                                      onChange={e => updateStagedLocal([r.id], { project_item_name: e.target.value })}
                                      onBlur={e => patchStaged([r.id], { project_item_name: e.target.value })}
                                      className="w-full h-7 px-2 rounded border border-[#E2E8F0] text-[12px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" />
                                  </td>
                                  <td className="px-2 py-2 w-40 align-top">
                                    <select value={r.submittal_type}
                                      onChange={e => patchStaged([r.id], { submittal_type: e.target.value })}
                                      className="w-full h-7 px-1 rounded border border-[#E2E8F0] text-[12px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                                      {SUBMITTAL_TYPE_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
                                    </select>
                                  </td>
                                  <td className="px-2 py-2 align-top text-[12px] text-[#64748B]">{r.description}</td>
                                </tr>
                              )) : SUBMITTAL_TYPE_OPTIONS.flatMap(type => {
                                const group = rows.filter(r => r.submittal_type === type)
                                if (group.length === 0) return []
                                const ids = group.map(g => g.id)
                                const allSelected = group.every(g => g.is_selected)
                                return [(
                                  <tr key={`${secId}-${type}`} className="border-b border-[#E2E8F0]/60 last:border-0 hover:bg-[#F8F9FA] transition-colors">
                                    <td className="px-3 py-2 w-8 align-top">
                                      <input type="checkbox" checked={allSelected}
                                        onChange={() => patchStaged(ids, { is_selected: !allSelected })}
                                        className="accent-[#7B9BB5] mt-0.5" />
                                    </td>
                                    <td className="px-2 py-2 w-64 align-top">
                                      <input type="text" value={group[0].project_item_name}
                                        onChange={e => updateStagedLocal(ids, { project_item_name: e.target.value })}
                                        onBlur={e => patchStaged(ids, { project_item_name: e.target.value })}
                                        className="w-full h-7 px-2 rounded border border-[#E2E8F0] text-[12px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" />
                                    </td>
                                    <td className="px-2 py-2 align-top text-[12px] text-[#0F172A] font-medium">{typeLabels[type] ?? type}</td>
                                    <td className="px-2 py-2 w-20 align-top text-[11px] text-[#64748B]">{group.length} item{group.length === 1 ? "" : "s"}</td>
                                  </tr>
                                )]
                              })}
                            </tbody>
                          </table>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })()
          ) : appProjects.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full py-24 text-center">
              <div className="w-14 h-14 rounded-2xl bg-[#7B9BB5]/10 border border-[#7B9BB5]/20 flex items-center justify-center mb-4">
                <svg className="w-7 h-7 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>
              </div>
              <p className="text-[15px] font-bold text-[#0F172A]">Welcome to TuttoHQ</p>
              <p className="text-[13px] text-[#64748B] mt-1.5 max-w-sm">Create your first project to get started. Upload its spec book during setup and TuttoHQ builds the submittal log for you.</p>
              <a href="/settings?tab=projects" className="mt-5 h-9 px-5 rounded-lg bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors inline-flex items-center gap-2">
                Create your first project
              </a>
            </div>
          ) : searching ? (
            <div className="flex items-center justify-center h-40 gap-2 text-[13px] text-[#64748B]">
              <SpinnerIcon className="h-4 w-4" /> Searching…
            </div>
          ) : logLoading ? (
            <div className="flex items-center justify-center h-40 gap-2 text-[13px] text-[#64748B]">
              <SpinnerIcon className="h-4 w-4" /> Loading…
            </div>
          ) : displaySubmittals.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full py-24 text-center">
              <div className="w-14 h-14 rounded-2xl bg-[#7B9BB5]/10 border border-[#7B9BB5]/20 flex items-center justify-center mb-4">
                <svg className="w-7 h-7 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </div>
              <p className="text-[15px] font-bold text-[#0F172A]">No submittals in this project yet</p>
              <p className="text-[13px] text-[#64748B] mt-1.5">Upload submittals to the Library first, then attach them to a project.</p>
              <button onClick={() => onNavigate("library")} className="mt-5 h-9 px-5 rounded-lg bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors inline-flex items-center gap-2">
                Go to Library
              </button>
            </div>
          ) : (() => {
            // Sort + colour-band the rows. Grouped: spec section, then type,
            // then number. Ungrouped: per-project submittal number.
            const rows = [...displaySubmittals]
            if (groupBySection) {
              rows.sort((a, b) =>
                (a.csi_section ?? "").localeCompare(b.csi_section ?? "") ||
                (a.submittal_type ?? "").localeCompare(b.submittal_type ?? "") ||
                (a.submittal_seq ?? 0) - (b.submittal_seq ?? 0))
            } else {
              rows.sort((a, b) => (a.submittal_seq ?? 0) - (b.submittal_seq ?? 0))
            }
            const colorIdx = sectionColorMap(rows.map(r => r.csi_section))
            const colorFor = (sec: string | null) => SECTION_PALETTE[colorIdx.get(sec ?? "—") ?? 0]
            const HEADERS = ["Subm. #", "Spec #", "Description", "Type of Subm.", "Vendor",
              "Received", "To A/E", "Returned A/E", "Returned to Sub", "Approval (Days)",
              "Status", "Late / On Time", "Source", "Actions"]
            // Select mode (Session I) — adds a leading checkbox column + the
            // package-selection toolbar. Off during search to avoid ambiguity.
            const showSelect = selectMode && !isSearchMode
            const visibleIds = rows.map(r => r.id)
            const allVisibleSelected = visibleIds.length > 0 && visibleIds.every(id => selectedIds.has(id))
            const vendorOptionsForToolbar = (() => {
              const map = new Map<string, { key: string; label: string; count: number }>()
              for (const s of logSubmittals) {
                let key: string | null = null, label = "Unknown"
                if (s.vendor_subcontractor_id) {
                  key = `sub:${s.vendor_subcontractor_id}`
                  label = vendorSubs.find(v => v.id === s.vendor_subcontractor_id)?.company_name ?? "Unknown"
                } else if (s.vendor_supplier_id) {
                  key = `sup:${s.vendor_supplier_id}`
                  label = vendorSuppliers.find(v => v.id === s.vendor_supplier_id)?.company_name ?? "Unknown"
                }
                if (!key) continue
                const e = map.get(key) ?? { key, label, count: 0 }
                e.count++; map.set(key, e)
              }
              return [...map.values()].sort((a, b) => a.label.localeCompare(b.label))
            })()
            const sectionOptionsForToolbar = (() => {
              const map = new Map<string, number>()
              for (const s of logSubmittals) {
                const sec = s.csi_section ?? "—"
                map.set(sec, (map.get(sec) ?? 0) + 1)
              }
              return [...map.entries()].map(([sec, count]) => ({ sec, count }))
                .sort((a, b) => a.sec.localeCompare(b.sec))
            })()
            return (
            <>
            {/* Package-selection toolbar */}
            {showSelect && (
              <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-[#E2E8F0] bg-[#F1F5F9]">
                <span className="text-[12px] font-semibold text-[#0F172A] whitespace-nowrap">
                  {selectedIds.size} selected
                </span>
                <span className="text-[#CBD5E1]">·</span>
                <select value="" onChange={e => {
                  const v = e.target.value
                  if (!v) return
                  const [kind, id] = v.split(":")
                  setSelectedIds(new Set(logSubmittals.filter(s =>
                    kind === "sub" ? s.vendor_subcontractor_id === id : s.vendor_supplier_id === id,
                  ).map(s => s.id)))
                }}
                  className="h-8 px-2 rounded-md border border-[#E2E8F0] text-[12px] text-[#64748B] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                  <option value="">By vendor…</option>
                  {vendorOptionsForToolbar.map(o => (
                    <option key={o.key} value={o.key}>{o.label} ({o.count})</option>
                  ))}
                </select>
                <select value="" onChange={e => {
                  const sec = e.target.value
                  if (!sec) return
                  setRowsSelected(logSubmittals.filter(s => (s.csi_section ?? "—") === sec).map(s => s.id), true)
                }}
                  className="h-8 px-2 rounded-md border border-[#E2E8F0] text-[12px] text-[#64748B] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                  <option value="">Add by section…</option>
                  {sectionOptionsForToolbar.map(o => (
                    <option key={o.sec} value={o.sec}>{o.sec} ({o.count})</option>
                  ))}
                </select>
                <button onClick={() => setSelectedIds(new Set())} disabled={selectedIds.size === 0}
                  className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[12px] text-[#64748B] hover:bg-white transition-colors disabled:opacity-50">
                  Clear
                </button>
                <div className="flex-1 min-w-[8px]" />
                <button disabled={selectedIds.size === 0} onClick={() => setShowPackageModal(true)}
                  className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[12px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 whitespace-nowrap">
                  <PlusIcon /> Create Package
                </button>
              </div>
            )}
            {/* Desktop tracker table — horizontal scroll on the outer pane,
                frozen header sticks against it. */}
            <div className="hidden sm:block">
            <table className="w-full min-w-max text-[12px] border-collapse border-b border-[#E2E8F0]">
              <thead className="sticky top-0 bg-[#F8F9FA] z-10">
                <tr className="border-b border-[#E2E8F0]">
                  {showSelect && (
                    <th className="px-3 py-2.5 w-9">
                      <input type="checkbox" checked={allVisibleSelected}
                        onChange={() => setRowsSelected(visibleIds, !allVisibleSelected)}
                        className="accent-[#7B9BB5] align-middle" />
                    </th>
                  )}
                  {HEADERS.map(h => (
                    <th key={h} className="text-left px-3 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-wider whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(s => {
                  const c = colorFor(s.csi_section)
                  const appr = approvalDays(s)
                  const late = lateState(s)
                  const hasSource = s.source === "spec_ingestion" && !!s.spec_section_id
                  return (
                  <tr key={s.id} className={`border-b border-[#E2E8F0]/60 ${c.bg} ${showSelect && selectedIds.has(s.id) ? "ring-1 ring-inset ring-[#7B9BB5]/40" : ""}`}>
                    {showSelect && (
                      <td className="px-3 py-1.5">
                        <input type="checkbox" checked={selectedIds.has(s.id)}
                          onChange={() => toggleRowSelected(s.id)}
                          className="accent-[#7B9BB5] align-middle" />
                      </td>
                    )}
                    <td className={`px-3 py-1.5 tabular-nums text-[#0F172A] font-semibold border-l-4 ${c.border} whitespace-nowrap`}>{s.submittal_seq ?? "—"}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      <span className={`inline-block px-1.5 py-0.5 rounded font-mono text-[11px] font-semibold ${c.chip}`}>{s.csi_section ?? "—"}</span>
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="flex items-center gap-1.5 max-w-[280px]">
                        <span className="text-[#0F172A] truncate" title={s.file_name}>{s.file_name}</span>
                        {s.sender_email && (
                          <span title={`Received from ${s.sender_email}`} className="flex-shrink-0 text-[#94A3B8]">
                            <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-1.5 text-[#64748B] whitespace-nowrap">{s.submittal_type ?? "—"}</td>
                    <td className="px-2 py-1.5">
                      <VendorCell subId={s.vendor_subcontractor_id} supplierId={s.vendor_supplier_id}
                        subs={vendorSubs} suppliers={vendorSuppliers}
                        onChange={(subId, supId) => patchSubmittal(s.id, { vendor_subcontractor_id: subId, vendor_supplier_id: supId })} />
                    </td>
                    <td className="px-2 py-1.5"><DateCell value={s.received_date} onChange={v => patchSubmittal(s.id, { received_date: v })} /></td>
                    <td className="px-2 py-1.5"><DateCell value={s.sent_to_ae_date} onChange={v => patchSubmittal(s.id, { sent_to_ae_date: v })} /></td>
                    <td className="px-2 py-1.5"><DateCell value={s.returned_from_ae_date} onChange={v => patchSubmittal(s.id, { returned_from_ae_date: v })} /></td>
                    <td className="px-2 py-1.5"><DateCell value={s.returned_to_sub_date} onChange={v => patchSubmittal(s.id, { returned_to_sub_date: v })} /></td>
                    <td className="px-3 py-1.5 text-center tabular-nums text-[#64748B]">{appr ?? "—"}</td>
                    <td className="px-2 py-1.5">
                      <select value={s.review_status ?? "Received"}
                        onChange={e => patchSubmittal(s.id, { review_status: e.target.value })}
                        className="h-7 px-1.5 rounded border border-[#E2E8F0] text-[12px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                        {LOG_STATUS_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                      </select>
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      {late === "late"
                        ? <span className="inline-flex px-2 py-0.5 rounded-full text-[11px] font-semibold bg-red-100 text-red-700">Late</span>
                        : late === "ontime"
                        ? <span className="inline-flex px-2 py-0.5 rounded-full text-[11px] font-semibold bg-green-100 text-green-700">On Time</span>
                        : <span className="text-[#94A3B8]">—</span>}
                    </td>
                    <td className="px-3 py-1.5 text-center">
                      {hasSource ? (
                        <button onClick={() => openSource(s)} disabled={sourceLoadingId === s.id}
                          title="View source spec section" className="text-[#7B9BB5] hover:text-[#5A7A94] disabled:opacity-50 align-middle">
                          {sourceLoadingId === s.id ? <SpinnerIcon className="h-4 w-4" /> : <SourceIcon />}
                        </button>
                      ) : (
                        <span className="text-[#CBD5E1] inline-block align-middle" title="No source — manual or email entry"><SourceIcon /></span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      <div className="flex items-center gap-0.5">
                        {s.storage_path && (
                          <button onClick={() => window.open(`/api/download/${s.id}`, "_blank")} className="text-[11px] text-[#64748B] hover:text-[#0F172A] px-1.5 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">Open</button>
                        )}
                        <button onClick={() => openEditModal(s)} className="text-[11px] text-[#64748B] hover:text-[#0F172A] px-1.5 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">Edit</button>
                        <button onClick={() => s.project_id ? openEditCoverSheet(s) : openTransmittal(s)} className="text-[11px] text-[#7B9BB5] px-1.5 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">Cover</button>
                        <button onClick={() => handleTransmittal(s, s.submittal_seq ?? 0)} disabled={transmittalLoading && transmittalSub?.id === s.id}
                          className="text-[11px] text-emerald-700 hover:text-emerald-800 px-1.5 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50 flex items-center gap-1">
                          {transmittalLoading && transmittalSub?.id === s.id ? <SpinnerIcon className="h-3 w-3" /> : null}Transmit
                        </button>
                        <button onClick={() => deleteSubmittal(s)} className="text-[11px] text-[#64748B] hover:text-red-400 px-1.5 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors" title="Delete submittal">Delete</button>
                      </div>
                    </td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
            </div>
            {/* Mobile card list */}
            <div className="sm:hidden px-3 py-3 space-y-2">
              {rows.map(s => {
                const c = colorFor(s.csi_section)
                const late = lateState(s)
                const vendor = vendorLabel(s)
                return (
                <div key={s.id} className={`rounded-xl border border-[#E2E8F0] border-l-4 ${c.border} p-3 shadow-sm ${c.bg}`}>
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <div className="flex items-center gap-1.5 min-w-0">
                      {showSelect && (
                        <input type="checkbox" checked={selectedIds.has(s.id)}
                          onChange={() => toggleRowSelected(s.id)}
                          className="accent-[#7B9BB5] flex-shrink-0" />
                      )}
                      <span className="text-[11px] font-bold tabular-nums text-[#64748B] flex-shrink-0">#{s.submittal_seq ?? "—"}</span>
                      <p className="text-[13px] font-medium text-[#0F172A] leading-tight truncate" title={s.file_name}>{s.file_name}</p>
                    </div>
                    <StatusBadge status={s.review_status ?? "Received"} />
                  </div>
                  <p className="text-[11px] text-[#64748B] mb-1">
                    <span className={`inline-block px-1.5 rounded font-mono font-semibold ${c.chip}`}>{s.csi_section ?? "—"}</span>
                    {s.submittal_type ? ` · ${s.submittal_type}` : ""}
                    {vendor ? ` · ${vendor}` : ""}
                  </p>
                  {late && (
                    <p className={`text-[11px] mb-1.5 font-semibold ${late === "late" ? "text-red-600" : "text-green-700"}`}>
                      {late === "late" ? "Late" : "On Time"}
                    </p>
                  )}
                  <div className="flex items-center gap-1 flex-wrap">
                    {(s.source === "spec_ingestion" && s.spec_section_id) && (
                      <button onClick={() => openSource(s)} className="text-[11px] text-[#7B9BB5] px-2 py-1 rounded border border-[#E2E8F0] bg-white transition-colors">Source</button>
                    )}
                    {s.storage_path && (
                      <button onClick={() => window.open(`/api/download/${s.id}`, "_blank")} className="text-[11px] text-[#64748B] px-2 py-1 rounded border border-[#E2E8F0] bg-white transition-colors">Open</button>
                    )}
                    <button onClick={() => openEditModal(s)} className="text-[11px] text-[#64748B] px-2 py-1 rounded border border-[#E2E8F0] bg-white transition-colors">Edit</button>
                    <button onClick={() => s.project_id ? openEditCoverSheet(s) : openTransmittal(s)} className="text-[11px] text-[#7B9BB5] px-2 py-1 rounded border border-[#E2E8F0] bg-white transition-colors">Cover</button>
                    <button
                      onClick={() => handleTransmittal(s, s.submittal_seq ?? 0)}
                      disabled={transmittalLoading && transmittalSub?.id === s.id}
                      className="text-[11px] text-emerald-700 px-2 py-1 rounded border border-[#E2E8F0] bg-white transition-colors disabled:opacity-50 flex items-center gap-1">
                      {transmittalLoading && transmittalSub?.id === s.id ? <SpinnerIcon className="h-3 w-3" /> : null}
                      Transmit
                    </button>
                    <button onClick={() => deleteSubmittal(s)} className="text-[11px] text-red-400 px-2 py-1 rounded border border-[#E2E8F0] bg-white transition-colors">Delete</button>
                  </div>
                </div>
                )
              })}
            </div>
            </>
            )
          })()}
          </>)}

        </div>

      {/* ── Source spec PDF preview ─────────────────────────────────────── */}
      {sourceModal && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
          onClick={e => { if (e.target === e.currentTarget) setSourceModal(null) }}>
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[860px] mx-4 sm:mx-0 flex flex-col" style={{ height: "88vh" }}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-[#E2E8F0] flex-shrink-0">
              <div className="min-w-0">
                <h2 className="text-[14px] font-bold text-[#0F172A] truncate">
                  {sourceModal.spec_number} <span className="font-medium text-[#64748B]">— {sourceModal.spec_title}</span>
                </h2>
                <p className="text-[11px] text-[#64748B] truncate">{sourceModal.file_name} · opened at page {sourceModal.page}</p>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <a href={sourceModal.url} target="_blank" rel="noopener noreferrer"
                  className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[12px] font-semibold text-[#7B9BB5] hover:bg-[#0F172A]/[0.04] transition-colors whitespace-nowrap">
                  Open full PDF in new tab
                </a>
                <button onClick={() => setSourceModal(null)} className="text-[#64748B] hover:text-[#0F172A] transition-colors">
                  <XIcon className="h-4 w-4" />
                </button>
              </div>
            </div>
            <iframe
              src={`${sourceModal.url}#page=${sourceModal.page}`}
              title="Source spec section"
              className="flex-1 min-h-0 w-full rounded-b-xl"
            />
          </div>
        </div>
      )}

      {/* ── Submittal package create / dispatch (Session I) ────────────── */}
      {showPackageModal && globalProjectId && (
        <PackageCreateModal
          projectId={globalProjectId}
          projectName={appProjects.find(p => p.id === globalProjectId)?.name ?? "Project"}
          submittals={selectedSubmittals}
          vendorPreset={computeVendorPreset(selectedSubmittals)}
          subs={vendorSubs}
          suppliers={vendorSuppliers}
          onClose={() => setShowPackageModal(false)}
          onDone={() => {
            setShowPackageModal(false)
            exitSelectMode()
            loadSubmittals()
          }}
        />
      )}

      {/* ── Reset Submittal Log confirmation ────────────────────────────── */}
      {resetScope && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[440px] mx-4 sm:mx-0 p-6">
            <h2 className="text-[16px] font-bold text-[#0F172A] mb-2">
              {resetScope === "all" ? "Reset all submittals?" : "Reset spec-ingested submittals?"}
            </h2>
            <p className="text-[13px] text-[#64748B] mb-3">
              {resetScope === "all"
                ? "Every submittal in this project will be permanently deleted, including manual and email-intake entries."
                : "Every AI-extracted submittal (from spec book ingestion) will be permanently deleted. Manual and email-intake entries are kept."}
            </p>
            <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 mb-5">
              <p className="text-[13px] text-red-700 font-semibold">
                {resetCount === null
                  ? "Counting affected rows…"
                  : `${resetCount} submittal${resetCount === 1 ? "" : "s"} will be deleted. This cannot be undone.`}
              </p>
            </div>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setResetScope(null)} disabled={resetting}
                className="h-9 px-5 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50">
                Cancel
              </button>
              <button onClick={doReset} disabled={resetting || resetCount === null || resetCount === 0}
                className="h-9 px-5 rounded-md bg-red-600 text-white text-[13px] font-semibold hover:bg-red-700 transition-colors disabled:opacity-50 flex items-center gap-1.5">
                {resetting && <SpinnerIcon className="h-3.5 w-3.5" />}
                {resetting ? "Deleting…" : "Delete permanently"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Transmittal confirmation dialog ─────────────────────────────── */}
      {showTransmittalConfirm && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center">
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[420px] mx-4 sm:mx-0 p-6">
            <h2 className="text-[16px] font-bold text-[#0F172A] mb-2">Has this transmittal been sent?</h2>
            <p className="text-[13px] text-[#64748B] mb-1">
              The PDF was downloaded to your device and your email client was opened with the subject and body pre-filled.
              <strong className="text-[#0F172A]"> Attach the downloaded PDF to the email before sending.</strong>
            </p>
            {transmittalSub?.send_to_email && (
              <p className="text-[13px] text-[#64748B] mb-4">
                Recipient: <span className="font-medium text-[#0F172A]">{transmittalSub.send_to_email}</span>
              </p>
            )}
            {!transmittalSub?.send_to_email && <div className="mb-4" />}
            <p className="text-[13px] text-[#64748B] mb-5">
              Clicking <strong>Yes</strong> will mark this submittal as <span className="text-purple-700 font-semibold">Transmitted</span> and log the date and recipient.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => { setShowTransmittalConfirm(false); setTransmittalSub(null); setTransmittalPdfUrl(null) }}
                className="h-9 px-5 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors">
                No, not yet
              </button>
              <button
                onClick={markTransmitted}
                className="h-9 px-5 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors">
                Yes, mark as Transmitted
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── File open modal ───────────────────────────────────────────────── */}
      {openFileCtx && fileModalStep === "project" && (
        <div
          className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
          onClick={e => { if (e.target === e.currentTarget) closeFileModal() }}
        >
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[460px] mx-4 sm:mx-0 p-6">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-[15px] font-bold text-[#0F172A]">Open Submittal</h2>
              <button onClick={closeFileModal} className="text-[#64748B] hover:text-[#64748B] transition-colors">
                <XIcon className="h-4 w-4" />
              </button>
            </div>
            <p className="text-[12px] text-[#64748B] mb-4 truncate">{openFileCtx.file.file_name}</p>

            <div className="mb-4">
              <label className="block text-[12px] font-medium text-[#64748B] mb-1">Which project is this for?</label>
              <select
                value={modalProjectId}
                onChange={e => setModalProjectId(e.target.value)}
                className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40"
              >
                <option value="">No project / skip</option>
                {appProjects.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name}{p.number ? ` — ${p.number}` : ""}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex justify-between items-center gap-2">
              <button
                onClick={closeFileModal}
                className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors"
              >
                Cancel
              </button>
              <div className="flex gap-2">
                <button
                  onClick={openFileDirectly}
                  className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors"
                >
                  Skip &amp; Open
                </button>
                <button
                  onClick={() => setFileModalStep("coversheet")}
                  className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors"
                >
                  Continue →
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {openFileCtx && fileModalStep === "coversheet" && (
        <div
          className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
          onClick={e => { if (e.target === e.currentTarget) closeFileModal() }}
        >
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[460px] mx-4 sm:mx-0 p-6">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-[15px] font-bold text-[#0F172A]">Add Cover Sheet?</h2>
              <button onClick={closeFileModal} className="text-[#64748B] hover:text-[#64748B] transition-colors">
                <XIcon className="h-4 w-4" />
              </button>
            </div>
            <p className="text-[12px] font-semibold text-[#0F172A] mb-1">
              {modalProjectId ? (appProjects.find(p => p.id === modalProjectId)?.name ?? "Project") : "No project selected"}
            </p>
            <p className="text-[13px] text-[#64748B] mb-5">
              Generate a submittal transmittal cover sheet and merge it with this document.
            </p>
            <div className="flex flex-col gap-2">
              <button
                onClick={initCoverForm}
                className="h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors"
              >
                Yes, add cover sheet
              </button>
              <button
                onClick={openFileDirectly}
                className="h-9 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors"
              >
                No, just open
              </button>
              <button
                onClick={closeFileModal}
                className="h-9 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {openFileCtx && fileModalStep === "form" && coverForm && (
        <div
          className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
          onClick={e => { if (e.target === e.currentTarget) closeFileModal() }}
        >
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[680px] mx-4 sm:mx-0">
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E2E8F0]">
              <h2 className="text-[15px] font-bold text-[#0F172A]">Submittal Transmittal</h2>
              <button onClick={closeFileModal} className="text-[#64748B] hover:text-[#64748B] transition-colors">
                <XIcon className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleGenerateCover}>
              <div className="px-6 py-4 space-y-3 overflow-y-auto max-h-[75vh]">

                <div className="flex flex-col sm:flex-row gap-3">
                  <div className="flex-[2]">
                    <label className={labelCls}>Project Name</label>
                    <input type="text" value={coverForm.projectName} onChange={e => setCoverForm(prev => ({ ...prev!, projectName: e.target.value }))} placeholder="Project name" className={inputCls} />
                  </div>
                  <div className="flex-1">
                    <label className={labelCls}>Project No.</label>
                    <input type="text" value={coverForm.projectNumber} onChange={e => setCoverForm(prev => ({ ...prev!, projectNumber: e.target.value }))} placeholder="2024-001" className={inputCls} />
                  </div>
                </div>

                <div>
                  <label className={labelCls}>Location</label>
                  <input type="text" value={coverForm.projectLocation} onChange={e => setCoverForm(prev => ({ ...prev!, projectLocation: e.target.value }))} placeholder="City, State" className={inputCls} />
                </div>

                <div className="flex flex-col sm:flex-row gap-3">
                  <div className="flex-1">
                    <label className={labelCls}>General Contractor</label>
                    <input type="text" value={coverForm.gcName} onChange={e => setCoverForm(prev => ({ ...prev!, gcName: e.target.value }))} placeholder="GC name" className={inputCls} />
                  </div>
                  <div className="flex-1">
                    <label className={labelCls}>Architect</label>
                    <input type="text" value={coverForm.architect} onChange={e => setCoverForm(prev => ({ ...prev!, architect: e.target.value }))} placeholder="Architecture firm" className={inputCls} />
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row gap-3">
                  <div className="flex-1">
                    <label className={labelCls}>Spec Section No.</label>
                    <input type="text" value={coverForm.specSectionNo} onChange={e => setCoverForm(prev => ({ ...prev!, specSectionNo: e.target.value }))} placeholder="03 30 00" className={inputCls} />
                  </div>
                  <div className="flex-[2]">
                    <label className={labelCls}>Spec Section Title</label>
                    <input type="text" value={coverForm.specSectionTitle} onChange={e => setCoverForm(prev => ({ ...prev!, specSectionTitle: e.target.value }))} placeholder="Cast-in-Place Concrete" className={inputCls} />
                  </div>
                </div>

                <div>
                  <label className={labelCls}>Submittal Description</label>
                  <input type="text" value={coverForm.description} onChange={e => setCoverForm(prev => ({ ...prev!, description: e.target.value }))} placeholder="Description of submittal" className={inputCls} />
                </div>

                <div className="flex flex-col sm:flex-row gap-3">
                  <div className="flex-1">
                    <label className={labelCls}>Date Submitted</label>
                    <input type="text" value={coverForm.dateSubmitted} onChange={e => setCoverForm(prev => ({ ...prev!, dateSubmitted: e.target.value }))} placeholder="MM/DD/YYYY" className={inputCls} />
                  </div>
                  <div className="flex-1">
                    <label className={labelCls}>Submittal No.</label>
                    <input type="text" value={coverForm.submittalNo} onChange={e => setCoverForm(prev => ({ ...prev!, submittalNo: e.target.value }))} placeholder="1" className={inputCls} />
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row gap-3">
                  <div className="flex-1">
                    <label className={labelCls}>Revision No.</label>
                    <input type="text" value={coverForm.revisionNo} onChange={e => setCoverForm(prev => ({ ...prev!, revisionNo: e.target.value }))} placeholder="00" className={inputCls} />
                  </div>
                  <div className="flex-1">
                    <label className={labelCls}>Due Date</label>
                    <input type="date" value={coverForm.dueDate} onChange={e => setCoverForm(prev => ({ ...prev!, dueDate: e.target.value }))} className={inputCls} />
                  </div>
                </div>

                <div className="flex items-center gap-6 py-0.5">
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input type="checkbox" checked={coverForm.isCritical} onChange={e => setCoverForm(prev => ({ ...prev!, isCritical: e.target.checked }))} className="w-4 h-4 rounded border-[#E2E8F0] accent-[#7B9BB5]" />
                    <span className="text-[13px] text-[#0F172A]">Critical Submittal</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input type="checkbox" checked={coverForm.partyRequired} onChange={e => setCoverForm(prev => ({ ...prev!, partyRequired: e.target.checked }))} className="w-4 h-4 rounded border-[#E2E8F0] accent-[#7B9BB5]" />
                    <span className="text-[13px] text-[#0F172A]">Submittal Party Required</span>
                  </label>
                </div>

                <div>
                  <label className={labelCls}>Copy To</label>
                  <input type="text" value={coverForm.copyTo} onChange={e => setCoverForm(prev => ({ ...prev!, copyTo: e.target.value }))} placeholder="Names or emails, comma-separated" className={inputCls} />
                </div>

                <div className="flex flex-col sm:flex-row gap-3">
                  <div className="flex-1">
                    <label className={labelCls}>Reviewed By</label>
                    <select value={coverForm.reviewedBy} onChange={e => setCoverForm(prev => ({ ...prev!, reviewedBy: e.target.value }))} className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                      <option value="">Select…</option>
                      {teamMembers.map(m => <option key={m.id} value={m.name}>{m.name}{m.title ? ` — ${m.title}` : ""}</option>)}
                    </select>
                  </div>
                  <div className="flex-1">
                    <label className={labelCls}>Certified by CQM</label>
                    <select value={coverForm.certifiedBy} onChange={e => setCoverForm(prev => ({ ...prev!, certifiedBy: e.target.value }))} className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                      <option value="">Select…</option>
                      {teamMembers.map(m => <option key={m.id} value={m.name}>{m.name}{m.title ? ` — ${m.title}` : ""}</option>)}
                    </select>
                  </div>
                </div>

                {/* ── SEND TO ── */}
                <div className="border border-[#E2E8F0] rounded-lg overflow-hidden">
                  <div className="px-3 py-2 bg-[#F8F9FA] border-b border-[#E2E8F0] flex items-center justify-between">
                    <span className="text-[11px] font-bold text-[#0F172A] uppercase tracking-wide">Send To</span>
                    {coverForm.sendToType && <button type="button" onClick={() => { setCoverSelectedId(""); setCoverForm(prev => ({ ...prev!, sendToType: "", sendToCompany: "", sendToContact: "", sendToEmail: "", sendToPhone: "", sendToAddress: "" })) }} className="text-[10px] text-[#64748B] hover:text-red-400">Clear</button>}
                  </div>
                  <div className="p-3 space-y-3">
                    <div className="flex flex-wrap gap-2">
                      {([["cm", "Construction Manager"], ["subcontractor", "Subcontractor"], ["supplier", "Supplier"]] as const).map(([key, label]) => (
                        <button key={key} type="button"
                          onClick={() => { setCoverSelectedId(""); setCoverForm(prev => ({ ...prev!, sendToType: key, sendToCompany: "", sendToContact: "", sendToEmail: "", sendToPhone: "", sendToAddress: "" })) }}
                          className={`h-7 px-3 rounded text-[11px] font-semibold transition-colors ${coverForm.sendToType === key ? "bg-[#7B9BB5] text-white" : "border border-[#E2E8F0] text-[#64748B] hover:border-[#7B9BB5] hover:text-[#7B9BB5]"}`}
                        >{label}</button>
                      ))}
                    </div>
                    {coverForm.sendToType !== "" && (() => {
                      const list = coverForm.sendToType === "cm" ? coverProjectCms : coverForm.sendToType === "subcontractor" ? coverProjectSubs : coverProjectSuppliers
                      const typeLabel = coverForm.sendToType === "cm" ? "Construction Manager" : coverForm.sendToType === "subcontractor" ? "Subcontractor" : "Supplier"
                      return (
                        <div className="space-y-3">
                          <div>
                            <label className={labelCls}>Select {typeLabel}</label>
                            <select
                              value={coverSelectedId}
                              onChange={e => {
                                const val = e.target.value
                                setCoverSelectedId(val)
                                if (val === "" || val === "__manual__") {
                                  setCoverForm(prev => ({ ...prev!, sendToCompany: "", sendToContact: "", sendToEmail: "", sendToPhone: "", sendToAddress: "" }))
                                } else {
                                  const sel = list.find(x => x.id === val)
                                  if (sel) setCoverForm(prev => ({ ...prev!, sendToCompany: sel.company_name, sendToContact: sel.contact_name ?? "", sendToEmail: sel.email ?? "", sendToPhone: sel.phone ?? "", sendToAddress: sel.address ?? "" }))
                                }
                              }}
                              className={inputCls}
                            >
                              <option value="">— Select a {typeLabel} —</option>
                              {list.map(x => <option key={x.id} value={x.id}>{x.company_name}{x.contact_name ? ` — ${x.contact_name}` : ""}</option>)}
                              <option value="__manual__">Enter manually</option>
                            </select>
                          </div>
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <label className={labelCls}>Company Name</label>
                              <input value={coverForm.sendToCompany} onChange={e => setCoverForm(prev => ({ ...prev!, sendToCompany: e.target.value }))} placeholder="Company name" className={inputCls} />
                            </div>
                            <div>
                              <label className={labelCls}>Contact Name</label>
                              <input value={coverForm.sendToContact} onChange={e => setCoverForm(prev => ({ ...prev!, sendToContact: e.target.value }))} placeholder="Contact name" className={inputCls} />
                            </div>
                            <div>
                              <label className={labelCls}>Email</label>
                              <input type="email" value={coverForm.sendToEmail} onChange={e => setCoverForm(prev => ({ ...prev!, sendToEmail: e.target.value }))} placeholder="email@company.com" className={inputCls} />
                            </div>
                            <div>
                              <label className={labelCls}>Phone</label>
                              <input value={coverForm.sendToPhone} onChange={e => setCoverForm(prev => ({ ...prev!, sendToPhone: e.target.value }))} placeholder="(555) 555-5555" className={inputCls} />
                            </div>
                          </div>
                          {(coverForm.sendToType === "cm" || coverForm.sendToAddress) && (
                            <div>
                              <label className={labelCls}>Address</label>
                              <input value={coverForm.sendToAddress} onChange={e => setCoverForm(prev => ({ ...prev!, sendToAddress: e.target.value }))} placeholder="123 Main St, City, State 00000" className={inputCls} />
                            </div>
                          )}
                        </div>
                      )
                    })()}
                  </div>
                </div>

                {/* ── TRANSMITTED BY ── */}
                <div className="flex flex-col sm:flex-row gap-3">
                  <div className="flex-1">
                    <label className={labelCls}>Transmitted By</label>
                    <input value={coverForm.transmittedBy} onChange={e => setCoverForm(prev => ({ ...prev!, transmittedBy: e.target.value }))} placeholder="Your name" className={inputCls} />
                  </div>
                  <div className="flex-1">
                    <label className={labelCls}>Company</label>
                    <input value={coverForm.transmittedByCompany} onChange={e => setCoverForm(prev => ({ ...prev!, transmittedByCompany: e.target.value }))} placeholder="Your company" className={inputCls} />
                  </div>
                </div>

                <div>
                  <label className={labelCls}>Notes</label>
                  <textarea
                    value={coverForm.notes}
                    onChange={e => setCoverForm(prev => ({ ...prev!, notes: e.target.value }))}
                    rows={3}
                    placeholder="Additional notes or instructions…"
                    className="w-full px-3 py-2 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 resize-none placeholder:text-[#64748B]"
                  />
                </div>

              </div>

              {/* Live coversheet preview */}
              <div className="border-t border-[#E2E8F0]">
                <button
                  type="button"
                  onClick={() => setShowCoverPreview(p => !p)}
                  className="w-full flex items-center justify-between px-6 py-3 text-[12px] font-semibold text-[#7B9BB5] hover:text-[#5A7A94] hover:bg-[#F4F5F7] transition-colors"
                >
                  <span>Preview Coversheet</span>
                  <svg className={`w-3.5 h-3.5 transition-transform ${showCoverPreview ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7"/></svg>
                </button>
                {showCoverPreview && (
                  <div className="overflow-hidden bg-[#f1f5f9]" style={{ height: 420 }}>
                    <div style={{ transform: "scale(0.5)", transformOrigin: "top left", width: 816, pointerEvents: "none" }}>
                      <SubmittalCoversheet
                        gcName={coverForm!.gcName}
                        projectName={coverForm!.projectName}
                        projectNumber={coverForm!.projectNumber}
                        projectLocation={coverForm!.projectLocation}
                        submittalDescription={coverForm!.description}
                        specSectionTitle={coverForm!.specSectionTitle}
                        specSectionNumber={coverForm!.specSectionNo}
                        submittalNumber={String(Math.max(1, parseInt(coverForm!.submittalNo || "1", 10) || 1)).padStart(2, "0")}
                        revisionNumber="00"
                        dateSubmitted={coverForm!.dateSubmitted}
                        submittalDueDate=""
                        copyTo=""
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#E2E8F0]">
                <button
                  type="button"
                  onClick={closeFileModal}
                  className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={generatingCover}
                  className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 flex items-center gap-2"
                >
                  {generatingCover && <SpinnerIcon className="h-3 w-3" />}
                  {generatingCover ? "Generating…" : "Generate & Download"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Upload modal ──────────────────────────────────────────────────── */}
      {showUpload && (
        <div
          className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
          onClick={e => { if (e.target === e.currentTarget) closeModal() }}
        >
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[440px] mx-4 sm:mx-0 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-[15px] font-bold text-[#0F172A]">Upload Submittal</h2>
              <button onClick={closeModal} className="text-[#64748B] hover:text-[#64748B] transition-colors">
                <XIcon className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleUpload} className="space-y-3">
              {/* File */}
              <div>
                <label className="block text-[12px] font-medium text-[#64748B] mb-1">File</label>
                <input
                  type="file"
                  accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.dwg,.rvt"
                  disabled={uploadStep === "classifying"}
                  onChange={async e => {
                    const f = e.target.files?.[0] ?? null
                    setUploadFile(f)
                    setUploadFilePath(null)
                    setAiResult(null)
                    setUploadError(null)
                    if (!f) { setUploadStep("file"); return }
                    setUploadStep("classifying")
                    // PUT the file straight to storage first; its path then
                    // feeds both /api/classify and /api/upload.
                    let path: string
                    try {
                      ;({ path } = await presignAndUpload("submittals", "uploads", f))
                      setUploadFilePath(path)
                    } catch {
                      setUploadError("Upload failed. Please try again.")
                      setUploadFile(null)
                      setUploadStep("file")
                      return
                    }
                    try {
                      const res = await fetch("/api/classify", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ storage_path: path, file_name: f.name }),
                      })
                      if (res.ok) {
                        const data = await res.json()
                        if (data.division_num && data.section_code) {
                          setAiResult(data)
                          setUploadStep("suggested")
                          return
                        }
                      }
                    } catch {}
                    setUploadStep("manual")
                  }}
                  required
                  className="w-full text-[13px] text-[#0F172A] file:mr-3 file:text-[12px] file:bg-[#E2E8F0] file:border-0 file:rounded-md file:px-3 file:py-1.5 file:text-[#0F172A] file:cursor-pointer cursor-pointer disabled:opacity-50"
                />
              </div>

              {/* Classifying spinner */}
              {uploadStep === "classifying" && (
                <div className="flex items-center gap-2 py-1 text-[13px] text-[#64748B]">
                  <SpinnerIcon className="h-4 w-4" /> Analyzing document…
                </div>
              )}

              {/* AI suggestion card */}
              {uploadStep === "suggested" && aiResult && (
                <div className="rounded-lg border border-[#7B9BB5]/30 bg-[#7B9BB5]/10 p-3 space-y-2">
                  <p className="text-[11px] font-bold text-[#7B9BB5] uppercase tracking-widest">✦ AI Suggestion</p>
                  <div>
                    <p className="text-[13px] font-semibold text-[#0F172A]">{aiResult.division_num} — {aiResult.division_name}</p>
                    <p className="text-[12px] text-[#64748B] mt-0.5">{aiResult.section_code} — {aiResult.section_name}</p>
                  </div>
                  {(aiResult.material_name || aiResult.manufacturer || aiResult.dimensions) && (
                    <div className="border-t border-[#7B9BB5]/20 pt-2 space-y-0.5">
                      {aiResult.material_name && <p className="text-[12px] text-[#0F172A]"><span className="text-[#64748B]">Material:</span> {aiResult.material_name}</p>}
                      {aiResult.manufacturer  && <p className="text-[12px] text-[#0F172A]"><span className="text-[#64748B]">Mfr:</span> {aiResult.manufacturer}</p>}
                      {aiResult.dimensions    && <p className="text-[12px] text-[#0F172A]"><span className="text-[#64748B]">Dims:</span> {aiResult.dimensions}</p>}
                    </div>
                  )}
                  {aiResult.confidence != null && (
                    <div className="border-t border-[#7B9BB5]/20 pt-2 flex items-center gap-2">
                      <div className="flex-1 h-1 rounded-full bg-[#E2E8F0] overflow-hidden">
                        <div className={`h-full rounded-full transition-all ${aiResult.confidence >= 70 ? "bg-emerald-400" : "bg-amber-400"}`} style={{ width: `${aiResult.confidence}%` }} />
                      </div>
                      <span className={`text-[11px] font-medium ${aiResult.confidence >= 70 ? "text-emerald-400" : "text-amber-400"}`}>{aiResult.confidence}% confident</span>
                    </div>
                  )}
                  {aiResult.confidence != null && aiResult.confidence < 70 && (
                    <p className="text-[11px] text-amber-300 bg-amber-400/10 rounded px-2 py-1">Low confidence — verify the classification before uploading</p>
                  )}
                  {aiResult.reasoning && <p className="text-[11px] text-[#64748B] italic">{aiResult.reasoning}</p>}
                  <div className="flex gap-2 pt-0.5">
                    <button type="button" onClick={acceptSuggestion}
                      className="h-7 px-3 rounded-md bg-[#7B9BB5] text-white text-[12px] font-semibold hover:bg-[#6A8AA4] transition-colors">
                      Use this →
                    </button>
                    <button type="button" onClick={() => { setUploadDiv(""); setUploadDivName(""); setUploadSec(""); setUploadSecName(""); setUploadStep("manual") }}
                      className="h-7 px-3 rounded-md border border-[#E2E8F0] text-[12px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors">
                      Classify manually
                    </button>
                  </div>
                </div>
              )}

              {/* Manual classification */}
              {uploadStep === "manual" && (
                <>
                  <div>
                    <label className="block text-[12px] font-medium text-[#64748B] mb-1">Division</label>
                    <select
                      value={uploadDiv}
                      onChange={e => {
                        const picked = CSI_DIVISIONS.find(d => d.num === e.target.value)
                        setUploadDiv(e.target.value)
                        setUploadDivName(picked?.name ?? "")
                        setUploadSec("")
                        setUploadSecName("")
                      }}
                      required
                      className="w-full h-9 px-2 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40"
                    >
                      <option value="">Select a division…</option>
                      {CSI_DIVISIONS.map(d => (
                        <option key={d.num} value={d.num}>{d.num} — {d.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[12px] font-medium text-[#64748B] mb-1">Section</label>
                    <select
                      value={uploadSec}
                      onChange={e => {
                        const picked = (CSI_SECTIONS[uploadDiv] ?? []).find(s => s.code === e.target.value)
                        setUploadSec(e.target.value)
                        setUploadSecName(picked?.name ?? "")
                      }}
                      disabled={!uploadDiv}
                      className="w-full h-9 px-2 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <option value="">{uploadDiv ? "Select a section…" : "Select a division first"}</option>
                      {(CSI_SECTIONS[uploadDiv] ?? []).map(s => (
                        <option key={s.code} value={s.code}>{s.code} — {s.name}</option>
                      ))}
                    </select>
                  </div>
                </>
              )}

              {/* Naming step */}
              {uploadStep === "naming" && (
                <div className="space-y-3 pt-1">
                  <div className="h-px bg-[#E2E8F0]" />
                  <p className="text-[11px] font-bold text-[#64748B] uppercase tracking-widest">Submittal Name</p>

                  <div>
                    <label className="block text-[12px] font-medium text-[#64748B] mb-1">Material</label>
                    <Combobox value={nameMatl} onChange={setNameMatl} options={nameOpts.materials} placeholder="e.g. Gypsum Board" autoFocus />
                  </div>

                  <div>
                    <label className="block text-[12px] font-medium text-[#64748B] mb-1">Manufacturer</label>
                    <Combobox value={nameMfr} onChange={setNameMfr} options={nameOpts.manufacturers} placeholder="e.g. Georgia-Pacific" />
                  </div>

                  <div>
                    <label className="block text-[12px] font-medium text-[#64748B] mb-1">Dimensions</label>
                    <Combobox value={nameDims} onChange={setNameDims} options={nameOpts.dimensions} placeholder='e.g. 5/8" x 4&apos; x 8&apos;' />
                  </div>

                  {(nameMatl || nameMfr || nameDims) && (
                    <div className="rounded-md bg-[#7B9BB5]/10 border border-[#7B9BB5]/20 px-3 py-2">
                      <p className="text-[10px] font-bold text-[#7B9BB5] uppercase tracking-widest mb-0.5">Name preview</p>
                      <p className="text-[13px] font-medium text-[#0F172A] truncate">
                        {[nameMatl, nameMfr, nameDims].filter(Boolean).join(" — ")}
                      </p>
                    </div>
                  )}
                </div>
              )}

              {uploadError && <p className="text-[12px] text-red-400">{uploadError}</p>}

              <div className="flex justify-between gap-2 pt-1">
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={closeModal}
                    className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors"
                  >
                    Cancel
                  </button>
                  {uploadStep === "naming" && (
                    <button
                      type="button"
                      onClick={() => setUploadStep(aiResult ? "suggested" : "manual")}
                      className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors"
                    >
                      ← Back
                    </button>
                  )}
                </div>
                {uploadStep === "manual" && (
                  <button
                    type="button"
                    disabled={!uploadFile || !uploadDiv || !uploadSec}
                    onClick={() => setUploadStep("naming")}
                    className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50"
                  >
                    Next →
                  </button>
                )}
                {uploadStep === "naming" && (
                  <button
                    type="submit"
                    disabled={uploading}
                    className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 flex items-center gap-2"
                  >
                    {uploading && <SpinnerIcon className="h-3 w-3" />}
                    {uploading ? "Uploading…" : "Upload"}
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Edit submittal modal ─────────────────────────────────────────── */}
      {editSubmittal && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
          onClick={e => { if (e.target === e.currentTarget) setEditSubmittal(null) }}>
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[460px] mx-4 sm:mx-0 p-6">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-[15px] font-bold text-[#0F172A]">Edit Submittal</h2>
              <button onClick={() => setEditSubmittal(null)} className="text-[#64748B] hover:text-[#64748B] transition-colors"><XIcon className="h-4 w-4" /></button>
            </div>
            <p className="text-[12px] text-[#64748B] mb-4 truncate">{editSubmittal.file_name}</p>

            <div className="space-y-3">
              <div>
                <label className="block text-[12px] font-medium text-[#64748B] mb-1">Status</label>
                <select value={editStatus} onChange={e => setEditStatus(e.target.value)}
                  className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                  {["Received","Under Review","Approved","Approved with Comments","Rejected","Revise and Resubmit","Needs Review"].map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[12px] font-medium text-[#64748B] mb-1">Division</label>
                <select value={editDiv} onChange={e => {
                  const d = CSI_DIVISIONS.find(d => d.num === e.target.value)
                  setEditDiv(e.target.value); setEditDivName(d?.name ?? ""); setEditSec(""); setEditSecName("")
                }} className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                  <option value="">Select division…</option>
                  {CSI_DIVISIONS.map(d => <option key={d.num} value={d.num}>{d.num} — {d.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[12px] font-medium text-[#64748B] mb-1">Section</label>
                <select value={editSec} disabled={!editDiv} onChange={e => {
                  const s = (CSI_SECTIONS[editDiv] ?? []).find(s => s.code === e.target.value)
                  setEditSec(e.target.value); setEditSecName(s?.name ?? "")
                }} className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 disabled:opacity-50">
                  <option value="">{editDiv ? "Select section…" : "Select a division first"}</option>
                  {(CSI_SECTIONS[editDiv] ?? []).map(s => <option key={s.code} value={s.code}>{s.code} — {s.name}</option>)}
                </select>
              </div>
              {editSubmittal.ai_reasoning && (
                <div className="rounded-md bg-[#F4F5F7] px-3 py-2">
                  <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-0.5">AI Reasoning</p>
                  <p className="text-[12px] text-[#64748B] italic">{editSubmittal.ai_reasoning}</p>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setEditSubmittal(null)}
                className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors">
                Cancel
              </button>
              <button onClick={saveEdit} disabled={editSaving}
                className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 flex items-center gap-2">
                {editSaving && <SpinnerIcon className="h-3 w-3" />}
                {editSaving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Batch upload modal ───────────────────────────────────────────── */}
      {showBatch && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
          onClick={e => { if (e.target === e.currentTarget) closeBatch() }}>
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[700px] mx-4 sm:mx-0 max-h-[85vh] flex flex-col">

            {/* Header */}
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E2E8F0] flex-shrink-0">
              <div>
                <h2 className="text-[15px] font-bold text-[#0F172A]">Batch Upload</h2>
                <p className="text-[12px] text-[#64748B] mt-0.5">AI will classify each file — review before uploading</p>
              </div>
              <button onClick={closeBatch} className="text-[#64748B] hover:text-[#64748B] transition-colors">
                <XIcon className="h-4 w-4" />
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0">

              {/* ── Select phase ── */}
              {batchPhase === "select" && (
                <div
                  onDragOver={e => { e.preventDefault(); setBatchDragOver(true) }}
                  onDragLeave={() => setBatchDragOver(false)}
                  onDrop={e => { e.preventDefault(); setBatchDragOver(false); initBatchFiles(Array.from(e.dataTransfer.files)) }}
                  className={`border-2 border-dashed rounded-xl p-10 text-center transition-colors ${batchDragOver ? "border-[#7B9BB5]/60 bg-[#7B9BB5]/5" : "border-[#E2E8F0]"}`}
                >
                  <div className="w-12 h-12 rounded-xl bg-[#7B9BB5]/10 flex items-center justify-center mx-auto mb-3">
                    <LayersIcon />
                  </div>
                  <p className="text-[14px] font-semibold text-[#0F172A] mb-1">Drop files here</p>
                  <p className="text-[12px] text-[#64748B] mb-4">PDF, DOC, DOCX, XLS, XLSX, DWG, RVT</p>
                  <label className="cursor-pointer h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors inline-flex items-center gap-2">
                    <PlusIcon /> Choose files
                    <input type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.dwg,.rvt" className="hidden"
                      onChange={e => { if (e.target.files) initBatchFiles(Array.from(e.target.files)) }} />
                  </label>
                  {batchItems.length > 0 && (
                    <p className="mt-4 text-[13px] text-[#7B9BB5]">{batchItems.length} file{batchItems.length !== 1 ? "s" : ""} selected</p>
                  )}
                </div>
              )}

              {/* ── Classifying + review phase ── */}
              {(batchPhase === "classifying" || batchPhase === "review" || batchPhase === "uploading" || batchPhase === "done") && (
                <div className="space-y-1.5">
                  {/* Column headers */}
                  <div className="grid gap-2 px-2 pb-1" style={{ gridTemplateColumns: "1fr 155px 195px 20px 20px 20px" }}>
                    <span className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest">File</span>
                    <span className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest">Division</span>
                    <span className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest">Section</span>
                    <span /><span /><span />
                  </div>
                  {batchItems.map(item => {
                    const isEditable = batchPhase === "review" || batchPhase === "classifying"
                    const hasName = item.nameMatl || item.nameMfr || item.nameDims
                    return (
                      <div key={item.id} className="bg-[#F4F5F7] rounded-lg overflow-hidden mb-1">
                        {/* Main row */}
                        <div className="grid gap-2 items-center px-2 py-1.5" style={{ gridTemplateColumns: "1fr 155px 195px 20px 20px 20px" }}>
                          <div className="min-w-0 flex flex-col gap-0.5">
                            {isEditable ? (
                              <input
                                type="text"
                                value={item.customName}
                                onChange={e => updateBatchItem(item.id, { customName: e.target.value })}
                                placeholder={item.file.name.replace(/\.[^.]+$/, "")}
                                title={`Original file: ${item.file.name}`}
                                className="h-6 px-1.5 rounded border border-[#E2E8F0] text-[11px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 w-full placeholder:text-[#64748B]"
                              />
                            ) : (
                              <span className="text-[12px] text-[#0F172A] truncate" title={item.file.name}>{item.customName || item.file.name}</span>
                            )}
                            <span className="text-[10px] text-[#64748B] truncate" title={item.file.name}>{item.file.name}</span>
                          </div>

                          <select value={item.divNum} disabled={!isEditable}
                            onChange={e => {
                              const d = CSI_DIVISIONS.find(d => d.num === e.target.value)
                              updateBatchItem(item.id, { divNum: e.target.value, divName: d?.name ?? "", secCode: "", secName: "", status: "ready" })
                            }}
                            className="h-7 px-1.5 rounded-md border border-[#E2E8F0] text-[11px] text-[#0F172A] bg-white focus:outline-none disabled:opacity-60 w-full">
                            <option value="">Division…</option>
                            {CSI_DIVISIONS.map(d => <option key={d.num} value={d.num}>{d.num} — {d.name}</option>)}
                          </select>

                          <select value={item.secCode} disabled={!isEditable || !item.divNum}
                            onChange={e => {
                              const s = (CSI_SECTIONS[item.divNum] ?? []).find(s => s.code === e.target.value)
                              updateBatchItem(item.id, { secCode: e.target.value, secName: s?.name ?? "", status: "ready" })
                            }}
                            className="h-7 px-1.5 rounded-md border border-[#E2E8F0] text-[11px] text-[#0F172A] bg-white focus:outline-none disabled:opacity-60 w-full">
                            <option value="">{item.divNum ? "Section…" : "—"}</option>
                            {(CSI_SECTIONS[item.divNum] ?? []).map(s => <option key={s.code} value={s.code}>{s.code} — {s.name}</option>)}
                          </select>

                          {/* Status */}
                          <div className="flex items-center justify-center">
                            {(item.status === "classifying" || item.status === "uploading") && <SpinnerIcon className="h-3.5 w-3.5" />}
                            {item.status === "pending"      && <span className="w-2 h-2 rounded-full bg-[#E2E8F0]" />}
                            {item.status === "ready"        && <span className="w-2 h-2 rounded-full bg-emerald-400" />}
                            {item.status === "error"        && <span className="w-2 h-2 rounded-full bg-amber-400" title={item.errorMsg} />}
                            {item.status === "done"         && <span className="w-2 h-2 rounded-full bg-emerald-400" />}
                            {item.status === "upload-error" && <span className="w-2 h-2 rounded-full bg-red-400" title={item.errorMsg} />}
                          </div>

                          {/* Expand naming */}
                          {isEditable && (
                            <button type="button" onClick={() => updateBatchItem(item.id, { expanded: !item.expanded })}
                              title="Edit name (Material / Manufacturer / Dimensions)"
                              className={`flex items-center justify-center transition-colors ${item.expanded || hasName ? "text-[#7B9BB5]" : "text-[#64748B] hover:text-[#64748B]"}`}>
                              <svg className={`h-3 w-3 transition-transform ${item.expanded ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                              </svg>
                            </button>
                          )}

                          {/* Remove */}
                          {isEditable && (
                            <button type="button" onClick={() => setBatchItems(prev => prev.filter(it => it.id !== item.id))}
                              className="text-[#64748B] hover:text-red-400 transition-colors flex items-center justify-center">
                              <XIcon className="h-3 w-3" />
                            </button>
                          )}
                        </div>

                        {/* Expanded naming row */}
                        {item.expanded && isEditable && (
                          <div className="border-t border-[#E2E8F0] px-2 pb-2 pt-2 grid grid-cols-3 gap-2">
                            <div>
                              <label className="block text-[10px] font-medium text-[#64748B] mb-1">Material</label>
                              <Combobox value={item.nameMatl} onChange={v => updateBatchItem(item.id, { nameMatl: v })} options={nameOpts.materials} placeholder="e.g. Gypsum Board" />
                            </div>
                            <div>
                              <label className="block text-[10px] font-medium text-[#64748B] mb-1">Manufacturer</label>
                              <Combobox value={item.nameMfr} onChange={v => updateBatchItem(item.id, { nameMfr: v })} options={nameOpts.manufacturers} placeholder="e.g. USG" />
                            </div>
                            <div>
                              <label className="block text-[10px] font-medium text-[#64748B] mb-1">Dimensions</label>
                              <Combobox value={item.nameDims} onChange={v => updateBatchItem(item.id, { nameDims: v })} options={nameOpts.dimensions} placeholder='e.g. 5/8"' />
                            </div>
                            {hasName && (
                              <div className="col-span-3 text-[11px] text-[#7B9BB5] truncate">
                                {[item.nameMatl, item.nameMfr, item.nameDims].filter(Boolean).join(" — ")}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}

                  {batchPhase === "classifying" && (
                    <p className="text-[12px] text-[#64748B] pt-2 text-center">
                      Analyzing {batchItems.filter(it => it.status === "classifying").length > 0
                        ? `"${batchItems.find(it => it.status === "classifying")?.file.name ?? ""}"`
                        : "files"}…
                    </p>
                  )}

                  {batchPhase === "done" && (() => {
                    const done = batchItems.filter(it => it.status === "done").length
                    const errs = batchItems.filter(it => it.status === "upload-error").length
                    return (
                      <div className="mt-3 rounded-lg border border-[#E2E8F0] bg-[#F4F5F7] px-4 py-3 text-center">
                        <p className="text-[13px] font-semibold text-[#0F172A]">
                          {done} file{done !== 1 ? "s" : ""} uploaded successfully
                          {errs > 0 && <span className="text-red-400"> · {errs} failed</span>}
                        </p>
                      </div>
                    )
                  })()}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex-shrink-0 border-t border-[#E2E8F0] px-6 py-4 flex justify-between items-center">
              <button onClick={closeBatch} className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors">
                {batchPhase === "done" ? "Close" : "Cancel"}
              </button>
              <div className="flex items-center gap-3">
                {batchPhase === "review" && (
                  <p className="text-[12px] text-[#64748B]">
                    {batchItems.filter(it => it.status === "ready").length} ready ·{" "}
                    {batchItems.filter(it => it.status === "error" && it.divNum && it.secCode).length} manual ·{" "}
                    {batchItems.filter(it => it.status === "error" && (!it.divNum || !it.secCode)).length} unassigned
                  </p>
                )}
                {batchPhase === "select" && (
                  <button
                    disabled={batchItems.length === 0}
                    onClick={classifyBatch}
                    className="h-8 px-5 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-40 flex items-center gap-2"
                  >
                    <SpinnerIcon className="h-3 w-3 hidden" />
                    Analyze {batchItems.length > 0 ? `${batchItems.length} files` : "files"}
                  </button>
                )}
                {batchPhase === "review" && (
                  <button
                    disabled={!batchItems.some(it => it.divNum && it.secCode)}
                    onClick={uploadBatch}
                    className="h-8 px-5 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-40"
                  >
                    Upload {batchItems.filter(it => it.divNum && it.secCode).length} files
                  </button>
                )}
                {batchPhase === "uploading" && (
                  <div className="flex items-center gap-2 text-[13px] text-[#64748B]">
                    <SpinnerIcon className="h-3.5 w-3.5" /> Uploading…
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Manage divisions modal ────────────────────────────────────────── */}
      {showManage && (
        <div
          className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
          onClick={e => { if (e.target === e.currentTarget) setShowManage(false) }}
        >
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[360px] mx-4 sm:mx-0 p-5">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-[15px] font-bold text-[#0F172A]">Manage Divisions</h2>
              <button onClick={() => setShowManage(false)} className="text-[#64748B] hover:text-[#64748B] transition-colors">
                <XIcon className="h-4 w-4" />
              </button>
            </div>
            <p className="text-[12px] text-[#64748B] mb-3">Uncheck divisions to hide them from the sidebar.</p>
            <div className="space-y-0.5 max-h-[420px] overflow-y-auto">
              {CSI_DIVISIONS.map(d => {
                const hidden = hiddenDivisions.has(d.num)
                return (
                  <button
                    key={d.num}
                    onClick={() => toggleDivisionVisibility(d.num)}
                    className="w-full flex items-center gap-2.5 h-8 px-2 rounded-md hover:bg-[#0F172A]/[0.04] transition-colors text-left"
                  >
                    <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${hidden ? "border-[#E2E8F0] bg-transparent" : "border-[#7B9BB5] bg-[#7B9BB5]"}`}>
                      {!hidden && <CheckIcon />}
                    </span>
                    <span className="text-[11px] font-mono text-[#64748B] w-5 text-right flex-shrink-0">{d.num}</span>
                    <span className={`text-[13px] truncate transition-colors ${hidden ? "text-[#64748B]" : "text-[#0F172A]"}`}>{d.name}</span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// ─── Inline submittal-log cell editors ───────────────────────────────────────

/** A bare date input — emits null when cleared. */
function DateCell({ value, onChange }: {
  value: string | null
  onChange: (v: string | null) => void
}) {
  return (
    <input
      type="date"
      value={value ?? ""}
      onChange={e => onChange(e.target.value || null)}
      className="w-[124px] h-7 px-1.5 rounded border border-[#E2E8F0] text-[12px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40"
    />
  )
}

/**
 * Searchable vendor picker over subcontractors + suppliers. The dropdown is
 * fixed-positioned (anchored to the trigger via getBoundingClientRect) so it
 * is never clipped by the horizontally-scrolling table.
 */
function VendorCell({ subId, supplierId, subs, suppliers, onChange }: {
  subId: string | null
  supplierId: string | null
  subs: SubcontractorRow[]
  suppliers: SupplierRow[]
  onChange: (subId: string | null, supplierId: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ]       = useState("")
  const [pos, setPos]   = useState<{ top: number; left: number } | null>(null)
  const ref    = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [open])

  function toggle() {
    if (open) { setOpen(false); return }
    const r = btnRef.current?.getBoundingClientRect()
    if (r) setPos({ top: r.bottom + 4, left: r.left })
    setQ("")
    setOpen(true)
  }

  function pick(nextSub: string | null, nextSup: string | null) {
    onChange(nextSub, nextSup)
    setOpen(false)
  }

  const current =
    subId ? subs.find(v => v.id === subId)?.company_name :
    supplierId ? suppliers.find(v => v.id === supplierId)?.company_name : null

  const ql = q.trim().toLowerCase()
  const subMatches = subs.filter(v => !ql || v.company_name.toLowerCase().includes(ql))
  const supMatches = suppliers.filter(v => !ql || v.company_name.toLowerCase().includes(ql))

  return (
    <div ref={ref}>
      <button
        ref={btnRef}
        onClick={toggle}
        className={`w-[150px] h-7 px-2 rounded border text-[12px] text-left truncate bg-white transition-colors hover:border-[#7B9BB5]/60 ${open ? "border-[#7B9BB5]" : "border-[#E2E8F0]"} ${current ? "text-[#0F172A]" : "text-[#94A3B8]"}`}
      >
        {current ?? "Set vendor…"}
      </button>
      {open && pos && (
        <div
          style={{ position: "fixed", top: pos.top, left: pos.left }}
          className="z-50 w-[240px] bg-white border border-[#E2E8F0] rounded-lg shadow-xl"
        >
          <div className="p-1.5 border-b border-[#E2E8F0]">
            <input
              autoFocus
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Search vendors…"
              className="w-full h-7 px-2 rounded border border-[#E2E8F0] text-[12px] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40"
            />
          </div>
          <div className="max-h-60 overflow-y-auto py-1">
            {(subId || supplierId) && (
              <button onClick={() => pick(null, null)}
                className="w-full text-left px-2.5 py-1.5 text-[12px] text-[#94A3B8] hover:bg-[#F8F9FA]">
                Clear vendor
              </button>
            )}
            {subMatches.length > 0 && (
              <p className="px-2.5 pt-1 pb-0.5 text-[10px] font-bold uppercase tracking-wide text-[#94A3B8]">Subcontractors</p>
            )}
            {subMatches.map(v => (
              <button key={v.id} onClick={() => pick(v.id, null)}
                className={`w-full text-left px-2.5 py-1.5 text-[12px] hover:bg-[#F8F9FA] ${v.id === subId ? "text-[#7B9BB5] font-semibold" : "text-[#0F172A]"}`}>
                {v.company_name}{v.trade ? <span className="text-[#94A3B8]"> · {v.trade}</span> : null}
              </button>
            ))}
            {supMatches.length > 0 && (
              <p className="px-2.5 pt-1.5 pb-0.5 text-[10px] font-bold uppercase tracking-wide text-[#94A3B8]">Suppliers</p>
            )}
            {supMatches.map(v => (
              <button key={v.id} onClick={() => pick(null, v.id)}
                className={`w-full text-left px-2.5 py-1.5 text-[12px] hover:bg-[#F8F9FA] ${v.id === supplierId ? "text-[#7B9BB5] font-semibold" : "text-[#0F172A]"}`}>
                {v.company_name}{v.specialty ? <span className="text-[#94A3B8]"> · {v.specialty}</span> : null}
              </button>
            ))}
            {subMatches.length === 0 && supMatches.length === 0 && (
              <p className="px-2.5 py-2 text-[12px] text-[#94A3B8]">No vendors match.</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
