"use client"

import { useState, useEffect, useMemo, useRef } from "react"
import SubmittalCoversheet from "@/components/submittals/SubmittalCoversheet"
import type {
  Division, SubmittalFile, SubmittalRecord, AiResult, NameOptions, UploadStep,
  BatchItem, BatchPhase, Project, TeamMember, OpenFileCtx, FileModalStep,
  CoverFormData, CoverContact, StagedSubmittal, SpecSectionRow, PendingDoc,
  VendorRow, VendorPersonRow,
} from "../_shared/types"
import { SUBMITTAL_TYPE_OPTIONS } from "../_shared/types"
import { CSI_DIVISIONS, CSI_SECTIONS, SECTION_PALETTE, sectionColorMap } from "../_shared/csi"
import { getDot, fmtDate } from "../_shared/format"
import { SearchIcon, XIcon, PlusIcon, CheckIcon, SpinnerIcon, LayersIcon } from "../_shared/icons"
import { StatusBadge } from "../_shared/badges"
import { Combobox, inputCls, labelCls } from "../_shared/ui"
import { presignAndUpload } from "@/lib/storage-upload"
import { isProjectTransmittalCopy } from "@/lib/storage-paths"
import { truncateForDisplay } from "@/lib/title-normalize"
import { hashFileInBrowser } from "@/lib/file-hash"
import { formatSectionNumber, padSectionSeq, compareBySectionOrder } from "@/lib/section-number"
import { exportSubmittalLogToExcel } from "../_shared/excel-export"
import PackageCreateModal from "@/components/packages/PackageCreateModal"
import PackagesView from "@/components/packages/PackagesView"
import OverflowMenu, { type OverflowEntry } from "@/components/overflow-menu"
import BulkImportModal from "@/components/bulk-import/BulkImportModal"
import { useNavRegion, useFocusTrap } from "@/components/keyboard-nav"
import { SkeletonTable } from "@/components/skeleton"
import { usePendingAction } from "@/hooks/usePendingAction"
import { PendingActionToasts } from "@/components/pending-action-toasts"
import { REVIEW_STATUSES, isReviewStatus, type ReviewStatus } from "@/lib/review-status"

// Status options for the inline Status dropdown in the submittal log — the
// canonical vocabulary (0046 CHECK), in lifecycle order. 'Sent to Sub' and
// 'Transmitted' were retired (one word per state: 'Sent to A/E'); the
// sub-return leg is tracked by returned_to_sub_date, not a status.
const LOG_STATUS_OPTIONS = REVIEW_STATUSES

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

// ─── Ball-in-Court (derived — display only, no schema) ───────────────────────
// Who currently "holds" the submittal, derived purely from which workflow date
// is the latest filled in the chain. Evaluated latest-milestone-first: the most
// advanced date that is set wins.
type BallInCourtParty = "GC_REVIEW" | "AE" | "GC_RETURN" | "SUB" | "NOT_STARTED"

function getBallInCourt(s: SubmittalRecord): { party: BallInCourtParty; label: string; sinceDate: string | null } {
  if (s.returned_to_sub_date)  return { party: "SUB",         label: "Returned to sub",     sinceDate: s.returned_to_sub_date }
  if (s.returned_from_ae_date) return { party: "GC_RETURN",   label: "GC — to return",      sinceDate: s.returned_from_ae_date }
  if (s.sent_to_ae_date)       return { party: "AE",          label: "Architect/Engineer",  sinceDate: s.sent_to_ae_date }
  if (s.received_date)         return { party: "GC_REVIEW",   label: "GC — in review",      sinceDate: s.received_date }
  return { party: "NOT_STARTED", label: "Not started", sinceDate: null }
}

/** Days the ball has sat with the current party: floor(today − sinceDate). Null until started. */
function daysInCourt(s: SubmittalRecord, today: string): number | null {
  const since = getBallInCourt(s).sinceDate
  if (!since) return null
  const t1 = Date.parse(since), t2 = Date.parse(today)
  if (Number.isNaN(t1) || Number.isNaN(t2)) return null
  return Math.floor((t2 - t1) / 86_400_000)
}

/** Soft overdue flag: a due date exists, today is past it, and the sub doesn't already hold it. */
function isOverdue(s: SubmittalRecord, today: string): boolean {
  if (!s.due_date) return false
  if (getBallInCourt(s).party === "SUB") return false
  return today > s.due_date // both are YYYY-MM-DD — lexical compare == date compare
}

// Chip tone per party — same rounded-full status-chip palette as Late / On Time.
const BIC_TONE: Record<BallInCourtParty, string> = {
  GC_REVIEW:   "bg-sky-100 text-sky-700",
  AE:          "bg-violet-100 text-violet-700",
  GC_RETURN:   "bg-amber-100 text-amber-800",
  SUB:         "bg-green-100 text-green-700",
  NOT_STARTED: "bg-[#F1F5F9] text-[#94A3B8]",
}

// Party filter buckets for the log toolbar (GC = either GC milestone).
const COURT_FILTERS = [
  { key: "all",         label: "All" },
  { key: "gc",          label: "GC" },
  { key: "ae",          label: "A/E" },
  { key: "sub",         label: "Sub" },
  { key: "not_started", label: "Not started" },
] as const
type CourtFilter = (typeof COURT_FILTERS)[number]["key"]

function courtBucket(party: BallInCourtParty): CourtFilter {
  if (party === "GC_REVIEW" || party === "GC_RETURN") return "gc"
  if (party === "AE")  return "ae"
  if (party === "SUB") return "sub"
  return "not_started"
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

// Plain (no-AI) matcher for the Submittal-Log filter-as-you-type search.
// Field set (identical to the Library search): title, CSI section number,
// section name, submittal type, division (number + name). Partial,
// case-insensitive. q must be pre-trimmed + lowercased.
function submittalMatchesQuery(s: SubmittalRecord, q: string): boolean {
  if (!q) return true
  const hay = [
    s.file_name, s.csi_section, s.section_name,
    s.submittal_type, s.csi_division, s.division_name,
  ].filter(Boolean).join("  ").toLowerCase()
  return hay.includes(q)
}

// Suggested next revision label after the current one: bump the last number,
// keep whatever surrounds it ("R0" → "R1", "Rev 2" → "Rev 3"). No digits (or
// no current label) suggests "R1" — every revision-uploadable row has a
// current attachment (the 0044 floor guarantees R0), and an unparseable label
// just means the user types their own. Suggestion only; the input is editable.
function nextRevisionLabel(current: string | null | undefined): string {
  const m = (current ?? "").match(/^(.*?)(\d+)(\D*)$/)
  if (!m) return "R1"
  return `${m[1]}${Number(m[2]) + 1}${m[3]}`
}

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

  // Library delete (detach-or-delete). Branch is decided server-side; the
  // client uses file.source only to render the right confirm copy.
  const [libDeleteTarget, setLibDeleteTarget] = useState<{ file: SubmittalFile; secCode: string } | null>(null)
  const [libDeleting, setLibDeleting]         = useState(false)

  // Per-row Clear/Delete on the Submittal Log. Both go through
  // POST /library-delete — the server decides detach-vs-delete from the DB
  // row; this state only drives the dialog copy (branched on the row's own
  // spec_section_id / storage_path) and the local post-state.
  const [rowDeleteTarget, setRowDeleteTarget] = useState<SubmittalRecord | null>(null)
  const [rowDeleteBusy, setRowDeleteBusy]     = useState(false)
  const [rowDeleteError, setRowDeleteError]   = useState<string | null>(null)

  // Project lookup for Library row badges. The cross-project Library stacks
  // rows from every project under the same CSI section; without a project
  // chip on each row two rows that share a title (e.g. a cover sheet of the
  // same library item dispatched into two projects) read as duplicates.
  const projectById = useMemo(
    () => new Map(appProjects.map(p => [p.id, p])),
    [appProjects],
  )

  // Search
  const [query, setQuery]                 = useState("")
  const [searchResults, setSearchResults] = useState<SubmittalRecord[] | null>(null)
  const [searching, setSearching]         = useState(false)
  const [searchError, setSearchError]     = useState<string | null>(null)
  const [searchAiSummary, setSearchAiSummary] = useState<string | null>(null)
  // Library search — plain, debounced, no AI (/api/library-search). Results
  // mode replaces the folder tree while a query is active.
  const [libQuery, setLibQuery]           = useState("")
  const [libResults, setLibResults]       = useState<SubmittalFile[] | null>(null)
  const [libSearching, setLibSearching]   = useState(false)
  const libSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Upload modal
  const [showUpload, setShowUpload]         = useState(false)
  const [uploadFile, setUploadFile]         = useState<File | null>(null)
  // Storage path of the file once it has been PUT straight to storage (presigned
  // URL flow). Both /api/classify and /api/upload reference this — the file is
  // never streamed through a Vercel function.
  const [uploadFilePath, setUploadFilePath] = useState<string | null>(null)
  // SHA-256 of the picked file (Web Crypto). Computed in parallel with the
  // storage PUT + AI classify so the dupe-check API call doesn't add
  // perceived latency. Passed in the /api/upload metadata.
  const [uploadFileSha256, setUploadFileSha256] = useState<string | null>(null)
  // Result of /api/check-duplicate. When same_project_matches is non-empty,
  // the modal renders an amber "possible duplicate" banner. Never blocks
  // submission — the user can always proceed (e.g. uploading a new
  // revision of a previously-stored file).
  const [uploadDupeMatch, setUploadDupeMatch] = useState<{
    same_project_matches: Array<{
      submittal_id: string; file_name: string; submittal_seq: number | null;
      section_seq: number | null; csi_section: string | null;
      submittal_number: string | null; revision_number: string | null;
    }>
    cross_project_matches: Array<{
      project_id: string | null; project_name: string | null; count: number;
    }>
  } | null>(null)
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

  // Detail / preview modal (full-screen submittal view, read-only fields +
  // PDF preview, plus inline title edit that locks the row against future
  // automated rewrites).
  const [detailSubmittal, setDetailSubmittal]   = useState<SubmittalRecord | null>(null)
  const detailModalRef = useRef<HTMLDivElement>(null)
  const [detailTitleEditing, setDetailTitleEditing] = useState(false)

  // ── Global keyboard navigation (Part 1) ──────────────────────────────────
  // The submittal log table is one navigable region: ArrowUp/Down move rows,
  // ArrowRight / Enter open the focused row's detail view (clicks the row's
  // [data-nav-primary] title button). The detail modal traps focus while open
  // and Escape restores focus to the row. closeDetailModal is a hoisted
  // declaration below, so referencing it here is safe.
  const { regionProps: logRegionProps } = useNavRegion<HTMLDivElement>({ id: "submittal-log", order: 10 })
  useFocusTrap(detailModalRef, !!detailSubmittal, () => closeDetailModal())
  const [detailTitleDraft, setDetailTitleDraft]     = useState("")
  const [detailTitleSaving, setDetailTitleSaving]   = useState(false)
  const [detailTitleError, setDetailTitleError]     = useState<string | null>(null)

  // Bulk Import — Stage 1. Detect + review-only; commit ships in Stage 2.
  const [showBulkImport, setShowBulkImport]     = useState(false)

  // Submittal-log tracker — vendors, grouping, inline-save debounce. One unified
  // vendors list (each row flagged sub/supplier) + their people, loaded once.
  const [vendors, setVendors]                   = useState<VendorRow[]>([])
  const [vendorPeople, setVendorPeople]         = useState<VendorPersonRow[]>([])
  const [groupBySection, setGroupBySection]     = useState(true)
  // Ball-in-Court (derived, display only) — toolbar party filter, overdue-only
  // toggle, and the sortable days-in-court column (null = default grouping sort).
  const [courtFilter, setCourtFilter] = useState<CourtFilter>("all")
  const [overdueOnly, setOverdueOnly] = useState(false)
  const [courtSort, setCourtSort]     = useState<null | "asc" | "desc">(null)
  // Sub-package selection (Session I) — "Select" mode adds a checkbox column.
  const [selectMode, setSelectMode]             = useState(false)
  const [selectedIds, setSelectedIds]           = useState<Set<string>>(new Set())
  const [showPackageModal, setShowPackageModal] = useState(false)
  // "Mark fulfilled by other submittal" bulk action (migration 0043). In-flight
  // guard + monotonic key source for the undo toast (so back-to-back marks stack
  // their own undoable toast instead of clobbering each other).
  const [markingFulfilled, setMarkingFulfilled] = useState(false)
  const fulfilledUndoSeq = useRef(0)
  // "Set status" bulk action — same in-flight guard + monotonic undo-key
  // pattern as the fulfilled mark above.
  const [settingStatus, setSettingStatus] = useState(false)
  const statusUndoSeq = useRef(0)
  const saveTimers     = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const pendingPatches = useRef<Map<string, Record<string, unknown>>>(new Map())
  // Monotonic id so an out-of-order Submittal Log response can't clobber a newer one.
  const logReqSeq      = useRef(0)
  // Reset Submittal Log
  // Reset options now live in the toolbar's More (⋯) menu; the setter is kept so
  // openResetConfirm() stays byte-for-byte unchanged.
  const [, setResetMenuOpen]                    = useState(false)
  const [resetScope, setResetScope]             = useState<"all" | "spec_ingestion" | null>(null)
  const [resetCount, setResetCount]             = useState<number | null>(null)
  const [resetting, setResetting]               = useState(false)
  // Source PDF preview
  const [sourceModal, setSourceModal]           = useState<
    { url: string; page: number; spec_number: string; spec_title: string; file_name: string } | null>(null)
  const [sourceLoadingId, setSourceLoadingId]   = useState<string | null>(null)

  // Revision history (Stage 2a-v2): map of submittal_id → attachment count,
  // populated alongside the log fetch. Drives the "Rev R2 · 3 of 3" badge.
  const [attachmentCounts, setAttachmentCounts] = useState<Record<string, number>>({})
  // Spec sections where the parser couldn't extract a clean title and fell
  // back to the MasterFormat division name. Set of spec_section_id strings.
  // Submittal rows pointing at one of these show a small "title needs review"
  // badge so the user knows to set the title manually.
  const [titleReviewSet, setTitleReviewSet] = useState<Set<string>>(new Set())
  // Slide-out state: which row's revision history is open + loaded attachments.
  const [revHistorySub, setRevHistorySub]       = useState<SubmittalRecord | null>(null)
  const [revHistoryItems, setRevHistoryItems]   = useState<Array<{
    id: string; storage_path: string; file_name: string; file_size: number | null;
    revision_label: string; is_current: boolean; approval_date: string | null;
    review_status: string | null; submittal_number: string | null;
    uploaded_at: string; source: string;
  }> | null>(null)
  const [revHistoryLoading, setRevHistoryLoading] = useState(false)
  const [revHistoryError,   setRevHistoryError]   = useState<string | null>(null)
  // Per-row "Upload Rev" modal — file + user-editable revision label. The
  // label defaults to the next number after the row's current revision
  // (revision_number is trigger-synced from the current attachment).
  const [revUploadSub,   setRevUploadSub]   = useState<SubmittalRecord | null>(null)
  const [revUploadFile,  setRevUploadFile]  = useState<File | null>(null)
  const [revUploadLabel, setRevUploadLabel] = useState("")
  const [revUploadBusy,  setRevUploadBusy]  = useState(false)
  const [revUploadError, setRevUploadError] = useState<string | null>(null)
  // Post-submit outcome — kept on screen (modal stays open) because a
  // non-current or duplicate result is the whole point of the message.
  const [revUploadDone, setRevUploadDone] = useState<null | { tone: "ok" | "warn" | "info"; message: string }>(null)
  // Deferred-with-undo mechanism for destructive actions. Wired here to the
  // per-attachment delete in the slide-out (the DELETE fires only after the 8s
  // undo window closes; Undo cancels it before it ever runs).
  const pendingDelete = usePendingAction()

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
  // Batch cover-sheet queue — after a batch upload, "Add cover sheets" walks
  // every uploaded PDF through the standard cover form one at a time. The
  // project is picked ONCE on the first step and applies to the whole queue.
  // null = no queue (single-file cover flows unchanged).
  const [coverQueue, setCoverQueue]           = useState<OpenFileCtx[] | null>(null)
  const [coverQueueIndex, setCoverQueueIndex] = useState(0)
  // Guards the async generate path: closeFileModal() bumps this, so a
  // /api/generate-cover response that resolves AFTER the user closed the modal
  // (X / backdrop / Cancel) can't advance a dead queue or reopen the form
  // from its stale closure. The download itself still completes.
  const coverFlowSeq = useRef(0)
  // Log rows whose stored file is ALREADY a generated transmittal
  // (project-submittals/ copy) hide the attach-to choice: "original" there
  // would merge the new cover onto the previous one and overwrite the row
  // with a double-covered file. Those rows keep the stripped-copy source.
  const [coverSourceLocked, setCoverSourceLocked] = useState(false)
  // Reviewer-stamp name. The generated coversheet stamps the user's
  // user_profiles.full_name as "Reviewed By". If it's not set yet, the cover
  // modal captures it inline (one-time) and saves via PATCH /api/profile before
  // generating. `myFullName === undefined` = still loading.
  const [myFullName, setMyFullName] = useState<string | null | undefined>(undefined)
  const [stampNameInput, setStampNameInput] = useState("")
  const [savingStampName, setSavingStampName] = useState(false)
  // Sync submittal project filter with global project selection
  useEffect(() => { setActiveProjectId(globalProjectId || null) }, [globalProjectId])

  const [transmittalSub, setTransmittalSub]           = useState<SubmittalRecord | null>(null)
  const [transmittalLoading, setTransmittalLoading]   = useState(false)
  const [transmittalPdfUrl, setTransmittalPdfUrl]     = useState<string | null>(null)
  const [showTransmittalConfirm, setShowTransmittalConfirm] = useState(false)
  const [pendingStaged, setPendingStaged]             = useState<StagedSubmittal[]>([])
  const [pendingSections, setPendingSections]         = useState<SpecSectionRow[]>([])
  const [pendingDocuments, setPendingDocuments]       = useState<PendingDoc[]>([])
  const [pendingHiddenCount, setPendingHiddenCount]   = useState(0)
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

  // Load the user's saved review-stamp name once, to decide whether the cover
  // modal must capture it inline.
  useEffect(() => {
    fetch("/api/profile")
      .then(r => r.json())
      .then((d: { full_name?: string | null }) => setMyFullName(d.full_name ?? null))
      .catch(() => setMyFullName(null))
  }, [])

  // Debounced Library search → /api/library-search (plain ilike, no AI).
  useEffect(() => {
    const q = libQuery.trim()
    if (libSearchTimer.current) clearTimeout(libSearchTimer.current)
    if (!q) { setLibResults(null); setLibSearching(false); return }
    setLibSearching(true)
    libSearchTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/library-search?q=${encodeURIComponent(q)}`)
        const data = await res.json()
        setLibResults(res.ok ? (data.files ?? []) : [])
      } catch { setLibResults([]) }
      finally { setLibSearching(false) }
    }, 250)
    return () => { if (libSearchTimer.current) clearTimeout(libSearchTimer.current) }
  }, [libQuery])

  useEffect(() => {
    try {
      const saved = localStorage.getItem("submittal-hidden-divisions")
      if (saved) setHiddenDivisions(new Set(JSON.parse(saved)))
    } catch (err) {
      console.error("[library] failed to restore hidden divisions from localStorage", err)
    }
  }, [])

  useEffect(() => {
    if (showUpload || showBatch) {
      fetch("/api/submittal-names")
        .then(r => r.json())
        .then(d => setNameOpts(d))
        .catch(err => console.error("[library] failed to load submittal names", err))
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
    setUploadFileSha256(null)
    setUploadDupeMatch(null)
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

  function closeFileModal() { coverFlowSeq.current++; setOpenFileCtx(null); setModalProjectId(""); setCoverForm(null); setCoverEditId(null); setCoverQueue(null); setCoverQueueIndex(0); setCoverSourceLocked(false) }

  // Strip a real file extension off a display name. Deliberately NOT a
  // generic /\.[^.]+$/ — Library display titles are normalized names that
  // routinely end in decimals ('… — 0.625"'), which a bare last-dot strip
  // would truncate onto the generated cover.
  function stripFileExt(name: string) { return name.replace(/\.(pdf|docx?|xlsx?|dwg|rvt)$/i, "") }

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
    // Rows already carrying a generated transmittal lose the attach-to choice
    // entirely (see coverSourceLocked); other log rows just default safe.
    setCoverSourceLocked(isProjectTransmittalCopy(s.storage_path))
    setCoverForm({
      // Log rows default to the stripped Library copy: a previous cover
      // generation may have REPLACED storage_path with a merged transmittal,
      // so "original" here can stack the new cover on the old one. The radio
      // in the form lets the user flip to the full stored file deliberately.
      contentSource: "stripped",
      projectName: proj?.name ?? "", projectNumber: proj?.number ?? "",
      projectLocation: proj?.location ?? "", gcName: proj?.gc_name ?? "",
      architect: proj?.architect ?? "", specSectionNo: s.csi_section ?? "",
      specSectionTitle: s.section_name ?? "",
      description: stripFileExt(s.file_name),
      // An unnumbered row (section_seq NULL) carries NO number — pass "" so the
      // cover omits it, never a fabricated "001". Submittal numbers print on
      // transmittals and are meaningful to the CM; the system must not invent one.
      dateSubmitted: today, submittalNo: s.section_seq != null ? padSectionSeq(s.section_seq) : "",
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

  // ctxArg — the batch cover queue advances by passing the NEXT item's ctx
  // directly (setOpenFileCtx hasn't flushed yet inside the same handler).
  // Plain clicks omit it and use the openFileCtx state as before.
  function initCoverForm(ctxArg?: OpenFileCtx) {
    const ctx = ctxArg ?? openFileCtx
    if (!ctx) return
    const proj = appProjects.find(p => p.id === modalProjectId)
    const today = new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" })
    const myName = teamMembers.find(m => m.email === userEmail)?.name ?? userEmail ?? ""
    setCoverSelectedId("")
    setCoverSourceLocked(false)
    setCoverForm({ contentSource: "original", projectName: proj?.name ?? "", projectNumber: proj?.number ?? "", projectLocation: proj?.location ?? "", gcName: proj?.gc_name ?? "", architect: proj?.architect ?? "", specSectionNo: ctx.secCode, specSectionTitle: ctx.secName, description: stripFileExt(ctx.file.file_name), dateSubmitted: today, submittalNo: "1", revisionNo: "00", dueDate: "", isCritical: false, partyRequired: false, copyTo: "", reviewedBy: "", certifiedBy: "", notes: "", sendToType: "", sendToCompany: "", sendToContact: "", sendToEmail: "", sendToPhone: "", sendToAddress: "", transmittedBy: myName, transmittedByCompany: proj?.gc_name ?? "" })
    setFileModalStep("form")
    if (modalProjectId) loadCoverContacts(modalProjectId)
  }

  // ── Batch cover-sheet queue ────────────────────────────────────────────────
  // Built from the batch modal's "done" phase: every successfully uploaded PDF
  // (we have its new submittals row id) becomes a queue entry. Eligibility is
  // keyed on the mime the row was STORED with (from the /api/upload response),
  // because that's the exact gate /api/generate-cover merges on — a filename
  // check would admit rows the server then silently returns cover-only for.
  function isCoverableBatchItem(it: BatchItem): boolean {
    return it.status === "done" && !!it.submittalId && it.uploadedMime === "application/pdf"
  }
  function startBatchCoverQueue() {
    const entries: OpenFileCtx[] = batchItems
      .filter(isCoverableBatchItem)
      .map(it => ({
        file: {
          id: it.submittalId!,
          file_name: it.uploadedName || it.customName || it.file.name,
          file_url: "",
          mime_type: "application/pdf",
          file_size: it.file.size,
          created_at: new Date().toISOString(),
        },
        divNum: it.divNum, divName: it.divName, secCode: it.secCode, secName: it.secName,
      }))
    if (entries.length === 0) return
    closeBatch()
    setCoverQueue(entries)
    setCoverQueueIndex(0)
    setCoverEditId(null)
    setCoverForm(null)
    setOpenFileCtx(entries[0])
    setModalProjectId(globalProjectId || "")
    setFileModalStep("project")
  }

  // Advance to the next queued document (re-initializing the form for it).
  // Returns false when there is no queue / no next item — the caller closes
  // the modal as usual.
  function advanceCoverQueue(): boolean {
    if (!coverQueue || coverQueueIndex + 1 >= coverQueue.length) return false
    const next = coverQueue[coverQueueIndex + 1]
    setCoverQueueIndex(coverQueueIndex + 1)
    setOpenFileCtx(next)
    initCoverForm(next)
    return true
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
    setCoverSourceLocked(isProjectTransmittalCopy(s.storage_path))
    const proj = appProjects.find(p => p.id === pid)
    const today = new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" })
    const myName = teamMembers.find(m => m.email === userEmail)?.name ?? userEmail ?? ""
    setCoverForm({
      // Same rationale as openEditCoverSheet: log-row storage_path may already
      // be a merged transmittal, so default to the clean stripped copy.
      contentSource: "stripped",
      projectName: proj?.name ?? "", projectNumber: proj?.number ?? "",
      projectLocation: proj?.location ?? "", gcName: proj?.gc_name ?? "",
      architect: proj?.architect ?? "", specSectionNo: s.csi_section ?? "",
      specSectionTitle: s.section_name ?? "",
      description: stripFileExt(s.file_name),
      // See openEditCoverSheet: unnumbered rows pass "" (never a fabricated "001").
      dateSubmitted: today, submittalNo: s.section_seq != null ? padSectionSeq(s.section_seq) : "",
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

    // One-time review-stamp name capture. If the user has no saved full_name,
    // persist the inline-entered name via PATCH /api/profile before generating —
    // the coversheet resolves "Reviewed By" server-side from user_profiles.
    if (!myFullName) {
      const name = stampNameInput.trim()
      if (!name) { alert("Please enter your name for the review stamp."); return }
      setSavingStampName(true)
      try {
        const pRes = await fetch("/api/profile", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ full_name: name }) })
        const pJson = await pRes.json().catch(() => ({}))
        if (!pRes.ok) { alert(pJson.error ?? "Could not save your name."); return }
        setMyFullName(pJson.full_name ?? name)
      } finally {
        setSavingStampName(false)
      }
    }

    setGeneratingCover(true)
    const flowSeq = coverFlowSeq.current
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
      a.download = stripFileExt(openFileCtx.file.file_name) + "_transmittal.pdf"
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      // The user closed the modal (X / backdrop / Cancel) while the PDF was
      // generating — this closure's queue/index are stale. Keep the download,
      // touch nothing else.
      if (coverFlowSeq.current !== flowSeq) return
      const pid = modalProjectId
      // Queue mode: move straight to the next uploaded document's form instead
      // of closing. The log refresh waits for the final item.
      if (!advanceCoverQueue()) {
        closeFileModal()
        if (pid) loadSubmittals(pid)
      }
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
    } catch (err) {
      console.error(`[library] failed to load files for section ${code}`, err)
      setSectionFiles(prev => ({ ...prev, [code]: [] }))
    } finally {
      setLoadingSections(prev => { const n = new Set(prev); n.delete(code); return n })
    }
  }

  // Submittal-Log search filters live as the user types (see
  // displaySubmittals). The form's only job is to swallow Enter so the page
  // doesn't reload — no AI call, no /api/search. (The AI route stays in the
  // codebase for the separate semantic-search phase.)
  function handleSearch(e: React.FormEvent) {
    e.preventDefault()
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

  // Library delete. The server branches: spec_ingestion rows DETACH (file
  // removed, log row kept as an empty placeholder); manual/gmail rows are
  // soft-deleted entirely. On success we refetch the affected section + the
  // folder tree so counts update.
  async function confirmLibraryDelete() {
    if (!libDeleteTarget) return
    setLibDeleting(true)
    try {
      const res = await fetch(`/api/submittals/${libDeleteTarget.file.id}/library-delete`, { method: "POST" })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error ?? "Delete failed")
      }
      const code = libDeleteTarget.secCode
      setLibDeleteTarget(null)
      refetchSection(code)
      loadTree()
    } catch (err) {
      alert(err instanceof Error ? err.message : "Delete failed")
    } finally {
      setLibDeleting(false)
    }
  }

  // `silent` refreshes the list WITHOUT flipping logLoading — the loading state
  // swaps the table for a skeleton (unmounts it), which resets the user's scroll
  // on a 1200-row log. A silent refetch keeps the table mounted; React updates in
  // place by stable row key, so scroll is preserved. Used after a per-attachment
  // delete, whose post-state (promotion vs placeholder reset) is server-derived.
  function loadSubmittals(pid = activeProjectId, opts?: { silent?: boolean }) {
    // The Submittal Log is strictly scoped to the current project — it must
    // never run the cross-project query (that is the Library's job). With no
    // project selected, show nothing rather than every company submittal.
    if (!pid) {
      logReqSeq.current++
      setLogSubmittals([])
      setLogLoading(false)
      return
    }
    if (!opts?.silent) setLogLoading(true)
    const seq = ++logReqSeq.current
    fetch(`/api/submittals?project_id=${encodeURIComponent(pid)}`)
      .then(r => r.json())
      .then(d => { if (seq === logReqSeq.current) setLogSubmittals(d.submittals ?? []) })
      .catch(() => { if (seq === logReqSeq.current) setLogSubmittals([]) })
      .finally(() => { if (seq === logReqSeq.current) setLogLoading(false) })
    // Parallel: pull revision counts for the project. Cheap (single
    // groupBy server-side, ~31 rows today). Used to show the revision
    // badge on rows with >= 2 attachments.
    fetch(`/api/projects/${encodeURIComponent(pid)}/attachment-counts`)
      .then(r => r.json())
      .then(d => { if (seq === logReqSeq.current) setAttachmentCounts(d.counts ?? {}) })
      .catch(() => { if (seq === logReqSeq.current) setAttachmentCounts({}) })
    // Parallel: pull the set of spec_section_ids where the parser used a
    // MasterFormat fallback. Rows pointing at one of these get a
    // "title needs review" badge.
    fetch(`/api/projects/${encodeURIComponent(pid)}/sections-needing-review`)
      .then(r => r.json())
      .then(d => { if (seq === logReqSeq.current) setTitleReviewSet(new Set(d.spec_section_ids ?? [])) })
      .catch(() => { if (seq === logReqSeq.current) setTitleReviewSet(new Set()) })
  }

  // Open the revision-history slide-out for a row. Lazily fetches the
  // full attachment list for that submittal_id.
  async function openRevHistory(s: SubmittalRecord) {
    setRevHistorySub(s)
    setRevHistoryItems(null)
    setRevHistoryError(null)
    setRevHistoryLoading(true)
    try {
      const res = await fetch(`/api/submittals/${encodeURIComponent(s.id)}/attachments`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error ?? `Failed (HTTP ${res.status})`)
      setRevHistoryItems(Array.isArray(data?.attachments) ? data.attachments : [])
    } catch (e) {
      setRevHistoryError(e instanceof Error ? e.message : "Failed to load revisions")
    } finally {
      setRevHistoryLoading(false)
    }
  }
  function closeRevHistory() {
    // Dismissing the panel cancels any pending attachment deletes — a closed
    // slide-out means "didn't happen", same as navigating away. The deferred
    // DELETE never fires.
    pendingDelete.pending.forEach(p => {
      if (p.key.startsWith("att:")) pendingDelete.cancel(p.key)
    })
    setRevHistorySub(null)
    setRevHistoryItems(null)
    setRevHistoryError(null)
  }

  // Delete a single revision attachment from the open slide-out. Destructive:
  // removes the submittal_attachments row + its storage object server-side and,
  // if it was the current revision, re-promotes the next-newest (or resets the
  // parent to an empty placeholder when it was the last one).
  //
  // Deferred-with-undo (no native confirm — the 8s undo window IS the
  // confirmation): the row is marked immediately (dimmed + "Undo"), but the
  // DELETE does not fire until the window closes. Undo cancels it before it
  // ever runs. On success we refresh the panel (new current / empty-placeholder
  // state) + the underlying log row and revision counts; on failure the row is
  // already un-marked and we surface the error.
  function deleteRevAttachment(att: { id: string; revision_label: string }) {
    if (!revHistorySub) return
    const sub = revHistorySub
    setRevHistoryError(null)
    pendingDelete.schedule({
      key: `att:${att.id}`,
      label: `Deleting Rev ${att.revision_label}…`,
      onCommit: async () => {
        const res = await fetch(
          `/api/submittals/${encodeURIComponent(sub.id)}/attachments/${encodeURIComponent(att.id)}`,
          { method: "DELETE" },
        )
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data?.error ?? `Failed (HTTP ${res.status})`)
        await openRevHistory(sub)
        // Silent refetch: reflect the server-derived post-state (promoted revision
        // or placeholder reset) WITHOUT the skeleton swap that resets scroll.
        loadSubmittals(activeProjectId, { silent: true })
      },
      onError: (e) => {
        setRevHistoryError(e instanceof Error ? e.message : "Failed to delete revision")
      },
    })
  }

  // ── Per-row "Upload Rev" (revision upload) ──────────────────────────────────
  // File → storage via the standard presign flow ({company_id}/uploads/…), then
  // POST /api/submittals/[id]/attachments records it through the
  // add_submittal_attachment RPC. The route computes sha256 server-side and
  // reports the outcome honestly: current / superseded (older revision than
  // what's on file) / duplicate (same bytes + label already recorded). The
  // modal shows the server's message verbatim — never write review_status or
  // any status from here.
  function openRevUpload(s: SubmittalRecord) {
    setRevUploadSub(s)
    setRevUploadFile(null)
    setRevUploadLabel(nextRevisionLabel(s.revision_number))
    setRevUploadError(null)
    setRevUploadDone(null)
  }
  function closeRevUpload() {
    if (revUploadBusy) return
    setRevUploadSub(null)
    setRevUploadFile(null)
    setRevUploadLabel("")
    setRevUploadError(null)
    setRevUploadDone(null)
  }
  async function submitRevUpload() {
    if (!revUploadSub || !revUploadFile || revUploadBusy) return
    const label = revUploadLabel.trim()
    if (!label) { setRevUploadError("Enter a revision label."); return }
    if (label.length > 24) { setRevUploadError("Revision label is 24 characters max."); return }
    setRevUploadBusy(true)
    setRevUploadError(null)
    try {
      const { path } = await presignAndUpload("submittals", "uploads", revUploadFile)
      const res = await fetch(`/api/submittals/${encodeURIComponent(revUploadSub.id)}/attachments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storage_path: path,
          file_name: revUploadFile.name,
          revision_label: label,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error ?? `Failed (HTTP ${res.status})`)
      setRevUploadDone({
        tone: data.outcome === "current" ? "ok" : data.outcome === "superseded" ? "warn" : "info",
        message: typeof data.message === "string" ? data.message : "Uploaded.",
      })
      // Reflect the server-derived post-state (new current revision or
      // unchanged row) without the skeleton swap; also refreshes the
      // revision-count badges. Re-pull the slide-out if it's open on this row.
      loadSubmittals(activeProjectId, { silent: true })
      if (revHistorySub?.id === revUploadSub.id) void openRevHistory(revUploadSub)
    } catch (e) {
      setRevUploadError(e instanceof Error ? e.message : "Upload failed")
    } finally {
      setRevUploadBusy(false)
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadSubmittals(activeProjectId) }, [activeProjectId])

  // ── Submittal-log inline editing ─────────────────────────────────────────────
  // Vendors for the inline picker — the whole company-scoped vendors master plus
  // their people, loaded client-side (mirrors the directory's load-all pattern).
  function loadVendors() {
    fetch("/api/vendors?all=1").then(r => r.json())
      .then(d => setVendors(Array.isArray(d.vendors) ? d.vendors : [])).catch(() => {})
    fetch("/api/vendor-people").then(r => r.json())
      .then(d => setVendorPeople(Array.isArray(d.people) ? d.people : [])).catch(() => {})
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (activeModule === "submittals") loadVendors() }, [activeModule])

  // Vendor column label: "Firm — Person", or just the firm when no person is
  // set, or "" when no vendor (renders "Set vendor…").
  function vendorLabel(s: SubmittalRecord): string {
    if (!s.vendor_id) return ""
    const firm = vendors.find(v => v.id === s.vendor_id)?.company_name ?? "—"
    const person = s.vendor_person_id
      ? vendorPeople.find(p => p.id === s.vendor_person_id)?.name : null
    return person ? `${firm} — ${person}` : firm
  }

  // ── Inline vendor create ──────────────────────────────────────────────────────
  // New firms/people SAVE to the system (reusable). company_id is set server-side
  // by the column DEFAULT + RLS — never trusted from the client. `kind` records
  // the is_subcontractor/is_supplier flag on the new vendor so it also surfaces
  // correctly in the Directory and project-assignment pickers.
  async function createVendor(name: string, field: string, kind: "sub" | "sup"): Promise<VendorRow | null> {
    const r = await fetch("/api/vendors", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        company_name: name,
        is_subcontractor: kind === "sub",
        is_supplier: kind === "sup",
        ...(kind === "sub" ? { trade: field } : { specialty: field }),
      }),
    }).catch(() => null)
    if (!r || !r.ok) return null
    const { vendor } = await r.json() as { vendor: VendorRow }
    setVendors(prev => [...prev, vendor].sort((a, b) => a.company_name.localeCompare(b.company_name)))
    return vendor
  }
  type NewPerson = { name: string; email: string; phone: string; role: string }
  async function createVendorPerson(vendorId: string, d: NewPerson): Promise<VendorPersonRow | null> {
    const r = await fetch("/api/vendor-people", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vendor_id: vendorId, ...d }),
    }).catch(() => null)
    if (!r || !r.ok) return null
    const { person } = await r.json() as { person: VendorPersonRow }
    setVendorPeople(prev => [...prev, person])
    return person
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

  const selectedSubmittals = logSubmittals.filter(s => selectedIds.has(s.id))

  // Patch ONE log row in local state, no refetch — preserves the user's scroll
  // (loadSubmittals flips logLoading → skeleton → the table unmounts and jumps to
  // top). Client-only: no server write (the mutation already happened). Mirrors
  // patchSubmittal's optimistic state write across both the log and search views.
  function patchLogRowLocal(id: string, updates: Partial<SubmittalRecord>) {
    setLogSubmittals(prev => prev.map(s => s.id === id ? { ...s, ...updates } as SubmittalRecord : s))
    setSearchResults(prev => prev ? prev.map(s => s.id === id ? { ...s, ...updates } as SubmittalRecord : s) : prev)
  }

  // ── "Fulfilled by other submittal" bulk mark (migration 0043) ────────────────
  // Some spec requirements are satisfied by ANOTHER line item (e.g. the Product
  // Data submittal already carries the warranty + certificate). Those rows must
  // NOT be deleted — they're real spec requirements the log must still show as
  // addressed. This flips fulfilled_by_other on the current selection.
  //
  // Non-destructive (display-only substitution, stored title untouched), so the
  // model is commit-then-reverse: the POST fires now (optimistic, reconciled
  // against the server's actual `updated` set), then the shared pending-action
  // toast offers an exact Undo that posts the reverse value. Mixed selection →
  // mark all true; an all-already-fulfilled selection → unmark (value false).
  async function bulkMarkFulfilled() {
    const subs = selectedSubmittals
    if (subs.length === 0 || markingFulfilled) return
    const allFulfilled = subs.every(s => s.fulfilled_by_other === true)
    const value = !allFulfilled
    const ids = subs.map(s => s.id)
    const prior = new Map(subs.map(s => [s.id, s.fulfilled_by_other === true]))

    setMarkingFulfilled(true)
    // Optimistic flip of every selected row.
    ids.forEach(id => patchLogRowLocal(id, { fulfilled_by_other: value }))

    let updated: string[]
    try {
      const res = await fetch("/api/submittals/bulk-fulfilled", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, value }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error ?? `Failed (HTTP ${res.status})`)
      updated = Array.isArray(data.updated) ? data.updated : []
    } catch {
      // Revert every optimistic flip to its captured prior value.
      ids.forEach(id => patchLogRowLocal(id, { fulfilled_by_other: prior.get(id) ?? false }))
      setMarkingFulfilled(false)
      return
    } finally {
      setMarkingFulfilled(false)
    }

    // Reconcile: any id the server did NOT report as changed reverts to its prior
    // stored value (RLS skipped it, or it was already at `value`). Never assume
    // the request set equals the updated set.
    const updatedSet = new Set(updated)
    ids.forEach(id => {
      if (!updatedSet.has(id)) patchLogRowLocal(id, { fulfilled_by_other: prior.get(id) ?? false })
    })

    const n = updated.length
    if (n === 0) return

    // Undo toast — the SAME pending-action affordance the module already uses for
    // deletes. The mark already committed, so onCommit is a no-op (the toast just
    // auto-dismisses after the standard window); Undo posts the exact reverse.
    const changed = [...updated]
    fulfilledUndoSeq.current += 1
    pendingDelete.schedule({
      key: `fulfilled:${fulfilledUndoSeq.current}`,
      label: value
        ? `${n} row${n === 1 ? "" : "s"} marked fulfilled by other`
        : `${n} row${n === 1 ? "" : "s"} unmarked fulfilled by other`,
      onCommit: async () => {},
      onUndo: () => {
        changed.forEach(id => patchLogRowLocal(id, { fulfilled_by_other: !value }))
        fetch("/api/submittals/bulk-fulfilled", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: changed, value: !value }),
        }).catch(() => { /* optimistic reverse — reconciles on next load */ })
      },
    })
  }

  // ── "Set status" bulk action ─────────────────────────────────────────────────
  // Sets review_status on the current selection in one POST. Same
  // commit-then-reverse model as bulkMarkFulfilled above: optimistic patch,
  // reconcile against the server's actual `updated` set, then an undo toast.
  //
  // Undo is PER-ROW: a mixed selection carries mixed prior statuses, so the
  // reverse groups the changed ids by their captured prior value and posts one
  // bulk-status call per distinct prior (≤ 8 groups) — never a blanket revert
  // to a single status.
  //
  // review_status ONLY — the date chain (received/sent/returned) that
  // Ball-in-Court derives from is deliberately never written here.
  async function bulkSetStatus(status: ReviewStatus) {
    const subs = selectedSubmittals
    if (subs.length === 0 || settingStatus) return
    const ids = subs.map(s => s.id)
    // Prior per-row status (local state = last server fetch; prod has 0 nulls,
    // so the "Not Started" fallback is the DB default, not a guess).
    const prior = new Map<string, ReviewStatus>(
      subs.map(s => [s.id, isReviewStatus(s.review_status) ? s.review_status : "Not Started"]))

    setSettingStatus(true)
    // Optimistic set of every selected row.
    ids.forEach(id => patchLogRowLocal(id, { review_status: status }))

    let updated: string[]
    try {
      const res = await fetch("/api/submittals/bulk-status", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, status }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error ?? `Failed (HTTP ${res.status})`)
      updated = Array.isArray(data.updated) ? data.updated : []
    } catch {
      // Revert every optimistic set to its captured prior value.
      ids.forEach(id => patchLogRowLocal(id, { review_status: prior.get(id) ?? "Not Started" }))
      setSettingStatus(false)
      return
    } finally {
      setSettingStatus(false)
    }

    // Reconcile: any id the server did NOT report as updated reverts to its
    // prior stored value (RLS or the active-only gate skipped it). Never assume
    // the request set equals the updated set.
    const updatedSet = new Set(updated)
    ids.forEach(id => {
      if (!updatedSet.has(id)) patchLogRowLocal(id, { review_status: prior.get(id) ?? "Not Started" })
    })

    const n = updated.length
    if (n === 0) return

    // Undo toast — the SAME pending-action affordance as the fulfilled mark.
    // The set already committed, so onCommit is a no-op; Undo restores each
    // row's own prior status (grouped by prior value → one POST per group).
    const changed = [...updated]
    statusUndoSeq.current += 1
    pendingDelete.schedule({
      key: `bulkstatus:${statusUndoSeq.current}`,
      label: `${n} row${n === 1 ? "" : "s"} set to ${status}`,
      onCommit: async () => {},
      onUndo: () => {
        const groups = new Map<ReviewStatus, string[]>()
        for (const id of changed) {
          const p = prior.get(id) ?? "Not Started"
          patchLogRowLocal(id, { review_status: p })
          const g = groups.get(p) ?? []
          g.push(id)
          groups.set(p, g)
        }
        for (const [p, groupIds] of groups) {
          if (p === status) continue // already at the target — nothing to reverse
          fetch("/api/submittals/bulk-status", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids: groupIds, status: p }),
          }).catch(() => { /* optimistic reverse — reconciles on next load */ })
        }
      },
    })
  }

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
  // search filter; `groupBySection` flips between section/section_seq vs seq only.
  const [exporting, setExporting] = useState(false)
  const [exportingPdf, setExportingPdf] = useState(false)
  // The currently-displayed log rows in render order — search filter applied
  // (displaySubmittals), then the same sort the table uses (grouped vs. seq).
  // Shared by both the Excel and PDF exports so they stay identical.
  function orderedExportRows(): SubmittalRecord[] {
    const exportRows = [...displaySubmittals]
    if (groupBySection) {
      exportRows.sort(compareBySectionOrder)
    } else {
      exportRows.sort((a, b) => (a.submittal_seq ?? 0) - (b.submittal_seq ?? 0))
    }
    return exportRows
  }
  async function handleExportLog() {
    if (!activeProjectId) return
    const project = appProjects.find(p => p.id === activeProjectId)
    if (!project) return
    setExporting(true)
    try {
      await exportSubmittalLogToExcel({
        rows: orderedExportRows(),
        projectName: project.name,
        gcName: project.gc_name,
        vendors,
        vendorPeople,
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
  // PDF counterpart — same rows, rendered as a single landscape table. The PDF
  // engine is dynamic-imported so pdf-lib stays out of the main bundle.
  async function handleExportLogPdf() {
    if (!activeProjectId) return
    const project = appProjects.find(p => p.id === activeProjectId)
    if (!project) return
    setExportingPdf(true)
    try {
      const { exportSubmittalLogToPdf } = await import("../_shared/pdf-log-export")
      await exportSubmittalLogToPdf({
        rows: orderedExportRows(),
        projectName: project.name,
        gcName: project.gc_name,
        vendors,
        vendorPeople,
      })
    } catch (err) {
      alert(err instanceof Error ? err.message : "Export failed")
    } finally {
      setExportingPdf(false)
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
    } catch (err) {
      console.error("[library] failed to fetch reset preview count", err)
      setResetCount(0)
    }
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
    if (!pid) { setPendingStaged([]); setPendingSections([]); setPendingDocuments([]); setPendingHiddenCount(0); return }
    setPendingLoading(true)
    fetch(`/api/staged-submittals?project_id=${encodeURIComponent(pid)}`)
      .then(r => r.json())
      .then(d => {
        setPendingStaged(d.staged ?? [])
        setPendingSections(d.sections ?? [])
        setPendingDocuments(d.documents ?? [])
        setPendingHiddenCount(d.hiddenCount ?? 0)
      })
      .catch(() => { setPendingStaged([]); setPendingSections([]); setPendingDocuments([]); setPendingHiddenCount(0) })
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
    setEditStatus(s.review_status ?? "Not Started")
    setEditDiv(s.csi_division ?? "")
    setEditDivName(s.division_name ?? "")
    setEditSec(s.csi_section ?? "")
    setEditSecName(s.section_name ?? "")
  }

  // Detail view — full-screen modal triggered by clicking a row's title.
  // Read-only fields + inline PDF preview (when storage_path exists). Title
  // is the one editable field; saving stamps title_locked=true server-side.
  function openDetailModal(s: SubmittalRecord) {
    setDetailSubmittal(s)
    setDetailTitleEditing(false)
    setDetailTitleDraft(s.file_name)
    setDetailTitleError(null)
  }
  function closeDetailModal() {
    setDetailSubmittal(null)
    setDetailTitleEditing(false)
    setDetailTitleDraft("")
    setDetailTitleError(null)
  }
  async function saveDetailTitle() {
    if (!detailSubmittal) return
    const next = detailTitleDraft.trim()
    if (next.length === 0) { setDetailTitleError("Title cannot be empty."); return }
    if (next === detailSubmittal.file_name) {
      // No-op edit — just close the editor without a network round-trip.
      setDetailTitleEditing(false)
      return
    }
    setDetailTitleSaving(true)
    setDetailTitleError(null)
    try {
      const res = await fetch(`/api/submittals/${detailSubmittal.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_name: next }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || "Save failed")
      }
      // Optimistic local update everywhere — log + search + the modal itself.
      const patch = { file_name: next, title_locked: true } as Partial<SubmittalRecord>
      setLogSubmittals(prev => prev.map(x => x.id === detailSubmittal.id ? { ...x, ...patch } as SubmittalRecord : x))
      setSearchResults(prev => prev ? prev.map(x => x.id === detailSubmittal.id ? { ...x, ...patch } as SubmittalRecord : x) : prev)
      setDetailSubmittal(prev => prev ? { ...prev, ...patch } as SubmittalRecord : prev)
      setDetailTitleEditing(false)
    } catch (err) {
      setDetailTitleError(err instanceof Error ? err.message : "Save failed")
    } finally {
      setDetailTitleSaving(false)
    }
  }

  // Per-row Clear/Delete on the Submittal Log — one flow, wired to
  // POST /library-delete, which already implements the correct split
  // server-side (decided from the DB row, never trusted from the client):
  //
  //   spec_ingestion (spec_section_id NOT NULL) → DETACH. Attachments +
  //     storage objects removed, row KEPT as an empty placeholder. A spec row
  //     is STRUCTURE (the spec book says "this section requires this
  //     submittal") — deleting it destroys the slot future imports land on
  //     (the incident: two cleared-by-delete rows → a Product Data PDF got
  //     misrouted onto Certification). So spec rows are cleared, never
  //     deleted; empty spec placeholders get NO control at all.
  //
  //   manual / gmail (spec_section_id NULL) → soft-delete the row
  //     (status='deleted') AND remove attachments + storage objects. (The
  //     older DELETE /api/submittals/[id] soft-deletes the row but leaves the
  //     file behind — that route stays for other callers; the log uses
  //     library-delete so no orphaned storage objects accumulate.)
  //
  // NO undo affordance: the row-half is recoverable in principle, but the
  // STORAGE OBJECTS ARE GONE — an "Undo" chip would promise a restore we
  // can't deliver. The truthful confirm dialog is the guard.
  function openRowDelete(s: SubmittalRecord) {
    // Spec placeholder with no file: nothing to clear. The buttons aren't
    // rendered for this case; guard anyway so no path can show a dialog that
    // "succeeds" as a no-op.
    if (s.spec_section_id && !s.storage_path) return
    setRowDeleteError(null)
    setRowDeleteTarget(s)
  }

  // Map library-delete's error statuses to copy a CM can act on.
  function rowDeleteErrorMessage(status: number, serverError?: string): string {
    switch (status) {
      case 400: return "This row was already deleted — likely from another tab. Refresh the log to catch up."
      case 401: return "You're signed out. Sign in again, then retry."
      case 403: return "This submittal belongs to a different company, so it can't be changed from here."
      case 404: return "This submittal no longer exists. Refresh the log to catch up."
      case 409: return serverError || "This row can't be deleted — clear the file instead."
      default:  return serverError || `Something went wrong (HTTP ${status}). Nothing was changed — try again.`
    }
  }

  async function confirmRowDelete() {
    if (!rowDeleteTarget) return
    const s = rowDeleteTarget
    const isSpec = s.spec_section_id != null // ⟺ source === 'spec_ingestion', same rule the server uses
    setRowDeleteBusy(true)
    setRowDeleteError(null)
    try {
      const res = await fetch(`/api/submittals/${encodeURIComponent(s.id)}/library-delete`, { method: "POST" })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setRowDeleteError(rowDeleteErrorMessage(res.status, typeof d?.error === "string" ? d.error : undefined))
        return
      }
      setRowDeleteTarget(null)
      if (isSpec) {
        // The row survives as an empty placeholder. Patch it IN PLACE — the end
        // state is deterministic (the route's DETACH_RESET shape) — instead of a
        // full reload, so the user's scroll on a long log is preserved. KEEP
        // section_seq (the number identifies the spec SLOT, not the file) and
        // every identity field; null only the file-derived columns.
        patchLogRowLocal(s.id, {
          storage_path: null,
          file_size: null,
          mime_type: null,
          received_file_name: null,
          returned_from_ae_date: null,
          sent_to_ae_date: null,
          received_at: null,
          submittal_number: null,
          review_status: "Received",
          revision_number: "00",
        })
        // Drop the row's revision badge (it now has zero attachments).
        setAttachmentCounts(prev => {
          if (!(s.id in prev)) return prev
          const next = { ...prev }
          delete next[s.id]
          return next
        })
      } else {
        // Row is gone from the log. Drop it from both live views.
        setLogSubmittals(prev => prev.filter(x => x.id !== s.id))
        setSearchResults(prev => prev ? prev.filter(x => x.id !== s.id) : prev)
      }
      // Clear the section cache so a section-view toggle re-fetches fresh, and
      // refresh the sidebar tree (neither touches the log table's scroll).
      setSectionFiles(prev => {
        const next = { ...prev }
        if (s.csi_section) delete next[s.csi_section]
        return next
      })
      loadTree()
    } catch (err) {
      setRowDeleteError(err instanceof Error ? err.message : "Network error — nothing was changed. Try again.")
    } finally {
      setRowDeleteBusy(false)
    }
  }

  async function saveEdit() {
    if (!editSubmittal) return
    setEditSaving(true)
    const div = CSI_DIVISIONS.find(d => d.num === editDiv)
    const sec = (CSI_SECTIONS[editDiv] ?? []).find(s => s.code === editSec)
    const updates: Record<string, string | null> = {
      // Always a concrete vocabulary value — the PATCH route 400s on
      // anything outside REVIEW_STATUSES (including null).
      review_status: editStatus,
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

  // subNum stays the internal submittal_seq (unchanged call sites); the number
  // the CM READS is the section number, derived from the row.
  async function handleTransmittal(sub: SubmittalRecord, subNum: number) {
    void subNum
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
      const submittalNoLabel = formatSectionNumber(sub.csi_section, sub.section_seq)
      const emailSubject = `Submittal Transmittal — ${proj?.name ?? ""} — ${submittalNoLabel} — ${title} — ${div}`
      const today = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
      const senderName = sub.transmitted_by ?? ""
      const senderCompany = sub.transmitted_by_company ?? proj?.gc_name ?? ""
      const emailBody = [
        "Please find attached the following submittal for your review:",
        "",
        `Project: ${proj?.name ?? ""}`,
        `Submittal No.: ${submittalNoLabel}`,
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
        // Status only — sent_to_ae_date itself is written by the package
        // send path; this single-transmittal flow just moves the label.
        review_status: "Sent to A/E",
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
      // Fire hash + dupe-check in parallel with the storage PUT + classify.
      // Both are non-fatal; failure leaves dupeMatch undefined and the
      // row uploads normally.
      void (async () => {
        try {
          const sha = await hashFileInBrowser(item.file)
          updateBatchItem(item.id, { fileSha256: sha })
          const dRes = await fetch("/api/check-duplicate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sha256: sha, project_id: null }),   // Library shelf scope (project-independent)
          })
          if (dRes.ok) updateBatchItem(item.id, { dupeMatch: await dRes.json() })
        } catch (err) {
          console.warn(`[library] batch hash/dupe-check failed for ${item.file.name}`, err)
        }
      })()
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
      } catch (err) {
        console.error(`[library] classify failed for ${item.file.name}`, err)
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
            project_id:    null,   // Library shelf upload — never the open project
            file_sha256:   item.fileSha256 || null,
          }),
        })
        // Keep the new row's id + normalized display title + stored mime —
        // they let the post-upload "Add cover sheets" queue target each
        // document directly and gate eligibility on the DB's own mime value.
        const data = await res.json().catch(() => ({}))
        updateBatchItem(item.id, res.ok
          ? { status: "done", submittalId: data.record?.id, uploadedName: data.record?.file_name, uploadedMime: data.record?.mime_type ?? null }
          : { status: "upload-error", errorMsg: "Upload failed" })
      } catch (err) {
        console.error(`[library] upload failed for ${item.file.name}`, err)
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
    // Library uploads are PROJECT-INDEPENDENT. A file uploaded to the
    // Library shelf must NEVER inherit whatever project the user happens to
    // have open — project_id stays null (server defaults null when omitted).
    // Putting a Library file into a project is a separate, explicit per-row
    // action (the Cover/attach flow), not a side effect of uploading.
    if (aiResult?.confidence != null) payload.ai_confidence = aiResult.confidence
    if (aiResult?.reasoning)          payload.ai_reasoning  = aiResult.reasoning
    if (uploadFileSha256)             payload.file_sha256   = uploadFileSha256

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

      // Library upload is project-independent — just refresh the Library +
      // log views. Attaching a Library file to a project (with a cover sheet)
      // is a separate, explicit per-row action, never an upload side effect.
      loadSubmittals()

      // Offer a cover sheet for the just-uploaded PDF right away — same modal
      // flow the row's Cover button opens, so the user doesn't have to hunt
      // the new row down. Declining is one click (Cancel / click-outside).
      const rec = data.record
      if (rec?.id && rec.mime_type === "application/pdf") {
        handleFileOpen(
          {
            id: rec.id, file_name: rec.file_name, file_url: "",
            mime_type: rec.mime_type, file_size: rec.file_size ?? null,
            created_at: rec.created_at ?? new Date().toISOString(),
          },
          rec.csi_division ?? uploadDiv, rec.division_name ?? uploadDivName,
          rec.csi_section ?? uploadSec, rec.section_name ?? uploadSecName,
        )
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed")
    } finally {
      setUploading(false)
    }
  }

  // One Library file row, reused by the folder tree AND the search results
  // so both render identically (Open=stripped, Original, Cover, Delete).
  function renderLibFile(file: SubmittalFile) {
    const proj = file.project_id ? projectById.get(file.project_id) : null
    const projLabel = proj ? (proj.number?.trim() || proj.name) : null
    return (
      <div key={file.id} className="flex items-center gap-2 py-1.5 group">
        <span className={`flex-shrink-0 w-1.5 h-1.5 rounded-full ${getDot(file.mime_type)}`} />
        <span className="flex-1 min-w-0 text-[12px] text-[#0F172A] truncate" title={file.file_name}>{file.file_name}</span>
        {file.source === "spec_ingestion" && file.submittal_type && (
          <span className="flex-shrink-0 text-[10px] text-[#64748B] bg-[#F1F5F9] px-1.5 py-0.5 rounded font-medium">· {file.submittal_type}</span>
        )}
        {projLabel && (
          <span className="flex-shrink-0 text-[10px] text-[#7B9BB5] bg-[#7B9BB5]/10 px-1.5 py-0.5 rounded font-medium" title={proj?.name ?? ""}>{projLabel}</span>
        )}
        {file.mime_type === "application/pdf" ? (
          <>
            <a href={`/api/download/${file.id}?stripped=1`} target="_blank" rel="noopener noreferrer"
              title="Library view — front matter (coversheet + architect-stamp page + routing/blanks) auto-stripped when detected. Original is one click away."
              className="flex-shrink-0 text-[11px] text-[#7B9BB5] hover:text-[#5A7A94] font-medium px-2 py-0.5 rounded hover:bg-[#7B9BB5]/10 transition-colors">Open</a>
            <a href={`/api/download/${file.id}`} target="_blank" rel="noopener noreferrer"
              title="Original full PDF — coversheet + stamp + content, exactly as uploaded."
              className="flex-shrink-0 text-[10px] text-[#94A3B8] hover:text-[#475569] font-medium px-1.5 py-0.5 rounded hover:bg-[#0F172A]/[0.04] transition-colors">Original (w/ stamp)</a>
          </>
        ) : (
          <a href={file.file_url} target="_blank" rel="noopener noreferrer"
            className="flex-shrink-0 text-[11px] text-[#7B9BB5] hover:text-[#5A7A94] font-medium px-2 py-0.5 rounded hover:bg-[#7B9BB5]/10 transition-colors">Open</a>
        )}
        <button onClick={() => handleFileOpen(file, file.csi_division ?? "", file.division_name ?? "", file.csi_section ?? "", file.section_name ?? "")}
          className="flex-shrink-0 text-[11px] text-[#64748B] hover:text-[#0F172A] font-medium px-2 py-0.5 rounded hover:bg-[#0F172A]/[0.04] transition-colors">Cover</button>
        <button onClick={() => setLibDeleteTarget({ file, secCode: file.csi_section ?? "" })}
          title={file.source === "spec_ingestion" ? "Remove the file — keeps the submittal log entry" : "Delete this Library item"}
          className="flex-shrink-0 text-[11px] text-[#94A3B8] hover:text-red-500 font-medium px-2 py-0.5 rounded hover:bg-red-50 transition-colors">Delete</button>
      </div>
    )
  }

  // Submittal-Log search is PLAIN + client-side filter-as-you-type over the
  // already-loaded (and project-scoped) logSubmittals — no /api/search, no
  // AI, no cross-project bleed. Matches the agreed field set via
  // submittalMatchesQuery.
  const trimmedLogQuery = query.trim().toLowerCase()
  const isSearchMode = trimmedLogQuery.length > 0
  const displaySubmittals = isSearchMode
    ? logSubmittals.filter(s => submittalMatchesQuery(s, trimmedLogQuery))
    : logSubmittals
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

        {/* Library search bar — plain, filter-as-you-type, no AI */}
        {activeModule === "library" && (
          <div className="flex-shrink-0 border-b border-[#E2E8F0] bg-white px-4 py-2">
            <div className="relative">
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#94A3B8] pointer-events-none"><SearchIcon /></span>
              <input
                type="search"
                value={libQuery}
                onChange={e => setLibQuery(e.target.value)}
                placeholder="Search the Library by title, CSI section, type, or division…"
                className="w-full h-8 pl-8 pr-8 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 focus:border-[#7B9BB5]/50 placeholder:text-[#94A3B8]"
              />
              {libQuery && (
                <button type="button" onClick={() => setLibQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-[#94A3B8] hover:text-[#0F172A]">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
                </button>
              )}
            </div>
          </div>
        )}

        {/* Submittal Log action bar */}
        {activeModule === "submittals" && (
        <div className="flex-shrink-0 border-b border-[#E2E8F0] bg-white">
          <div className="flex flex-wrap items-center px-4 py-2.5 gap-2 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <div className="flex rounded-md border border-[#E2E8F0] overflow-hidden flex-shrink-0">
                {(["log", "pending", "packages"] as const).map(v => (
                  <button key={v} onClick={() => setSubmittalsView(v)}
                    className={`h-7 px-3 text-[12px] font-medium whitespace-nowrap transition-colors ${submittalsView === v ? "bg-[#7B9BB5] text-white" : "bg-white text-[#64748B] hover:bg-[#F8F9FA]"}`}>
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
                      ? `${displaySubmittals.length} match${displaySubmittals.length === 1 ? "" : "es"}`
                      : `${logSubmittals.length} submittal${logSubmittals.length === 1 ? "" : "s"}`)
                  : "Staged from spec book — review and commit"}
              </p>
            </div>
            <div className="flex items-center gap-2 ml-auto flex-wrap justify-end">
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
              {submittalsView === "log" && activeProjectId && displaySubmittals.length > 0 && (
                <button
                  onClick={handleExportLogPdf}
                  disabled={exportingPdf}
                  title="Export the current view as a PDF table"
                  className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[12px] font-semibold text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors flex items-center gap-1.5 whitespace-nowrap disabled:opacity-60"
                >
                  {exportingPdf ? <SpinnerIcon className="h-3.5 w-3.5" /> : (
                    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                    </svg>
                  )}
                  <span className="hidden sm:inline">{exportingPdf ? "Exporting…" : "Export PDF"}</span>
                </button>
              )}
              {/* Secondary actions collapsed into a reusable More (⋯) menu —
                  declutter only; every item keeps its exact existing handler. */}
              {(() => {
                const moreItems: OverflowEntry[] = []
                if (submittalsView === "log" && !isSearchMode) {
                  moreItems.push({ key: "group", label: "Group by section", checked: groupBySection, keepOpen: true, onClick: () => setGroupBySection(!groupBySection) })
                }
                if (submittalsView === "log" && !isSearchMode && activeProjectId) {
                  moreItems.push({ key: "select", label: selectMode ? "Done selecting" : "Select", icon: <CheckIcon />, onClick: () => { if (selectMode) exitSelectMode(); else setSelectMode(true) } })
                }
                if (submittalsView === "log" && activeProjectId) {
                  moreItems.push({ key: "bulk", label: "Bulk import", description: "Import previously approved submittals (review only).", icon: <LayersIcon />, onClick: () => setShowBulkImport(true) })
                }
                moreItems.push({ key: "upload", label: "Upload to Library", icon: <PlusIcon />, onClick: () => onNavigate("library") })
                if (submittalsView === "log" && activeProjectId) {
                  moreItems.push("separator")
                  moreItems.push({ key: "reset-spec", label: "Reset spec-ingested only", description: "Removes AI-extracted rows; keeps manual & email entries.", onClick: () => openResetConfirm("spec_ingestion") })
                  moreItems.push({ key: "reset-all", label: "Reset all submittals", description: "Deletes every submittal in this project.", danger: true, onClick: () => openResetConfirm("all") })
                }
                return <OverflowMenu items={moreItems} />
              })()}
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
          {/* Ball-in-Court filters — client-side over the already-fetched log rows. */}
          <div className="flex flex-wrap items-center gap-2 px-4 pb-2.5">
            <span className="text-[10px] font-bold text-[#64748B] uppercase tracking-wider">Ball-in-court</span>
            <div className="flex rounded-md border border-[#E2E8F0] overflow-hidden">
              {COURT_FILTERS.map(f => (
                <button key={f.key} type="button" onClick={() => setCourtFilter(f.key)}
                  className={`h-7 px-2.5 text-[12px] font-medium whitespace-nowrap transition-colors ${courtFilter === f.key ? "bg-[#7B9BB5] text-white" : "bg-white text-[#64748B] hover:bg-[#F8F9FA]"}`}>
                  {f.label}
                </button>
              ))}
            </div>
            <button type="button" onClick={() => setOverdueOnly(v => !v)}
              title="Show only items past their due date and not yet returned to the sub"
              className={`h-7 px-2.5 rounded-md border text-[12px] font-medium whitespace-nowrap transition-colors ${overdueOnly ? "border-red-300 bg-red-50 text-red-700" : "border-[#E2E8F0] text-[#64748B] hover:bg-[#F8F9FA]"}`}>
              Overdue only
            </button>
            {(courtFilter !== "all" || overdueOnly) && (
              <button type="button" onClick={() => { setCourtFilter("all"); setOverdueOnly(false) }}
                className="h-7 px-2 text-[12px] font-medium text-[#94A3B8] hover:text-[#0F172A] transition-colors">
                Clear
              </button>
            )}
          </div>
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
            <div className="px-4 py-4 max-w-7xl">
              {libQuery.trim() ? (
                libSearching && libResults === null ? (
                  <div className="flex items-center gap-2 py-8 text-[13px] text-[#64748B]"><SpinnerIcon className="h-4 w-4" /> Searching…</div>
                ) : (libResults ?? []).length === 0 ? (
                  <p className="text-[13px] text-[#64748B] py-10 text-center">No Library matches for “{libQuery.trim()}”.</p>
                ) : (
                  <div className="bg-white rounded-xl border border-[#E2E8F0] overflow-hidden">
                    <div className="px-4 py-2.5 bg-[#F8F9FA] border-b border-[#E2E8F0] text-[12px] text-[#64748B]">
                      {(libResults ?? []).length} match{(libResults ?? []).length === 1 ? "" : "es"}
                    </div>
                    <div className="divide-y divide-[#E2E8F0] px-4">
                      {(libResults ?? []).map(f => renderLibFile(f))}
                    </div>
                  </div>
                )
              ) : treeLoading ? (
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
                                ) : (sectionFiles[sec.code] ?? []).map(file => {
                                  const proj = file.project_id ? projectById.get(file.project_id) : null
                                  const projLabel = proj ? (proj.number?.trim() || proj.name) : null
                                  return (
                                  <div key={file.id} className="flex items-center gap-2 py-1.5 group">
                                    <span className={`flex-shrink-0 w-1.5 h-1.5 rounded-full ${getDot(file.mime_type)}`} />
                                    <span className="flex-1 min-w-0 text-[12px] text-[#0F172A] truncate" title={file.file_name}>{file.file_name}</span>
                                    {file.source === "spec_ingestion" && file.submittal_type && (
                                      <span className="flex-shrink-0 text-[10px] text-[#64748B] bg-[#F1F5F9] px-1.5 py-0.5 rounded font-medium">· {file.submittal_type}</span>
                                    )}
                                    {projLabel && (
                                      <span
                                        className="flex-shrink-0 text-[10px] text-[#7B9BB5] bg-[#7B9BB5]/10 px-1.5 py-0.5 rounded font-medium"
                                        title={proj?.name ?? ""}
                                      >{projLabel}</span>
                                    )}
                                    {file.mime_type === "application/pdf" ? (
                                      <>
                                        <a
                                          href={`/api/download/${file.id}?stripped=1`}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          title="Library view — front matter (coversheet + architect-stamp page + routing/blanks) auto-stripped when detected. Original is one click away."
                                          className="flex-shrink-0 text-[11px] text-[#7B9BB5] hover:text-[#5A7A94] font-medium px-2 py-0.5 rounded hover:bg-[#7B9BB5]/10 transition-colors"
                                        >Open</a>
                                        <a
                                          href={`/api/download/${file.id}`}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          title="Original full PDF — coversheet + stamp + content, exactly as uploaded."
                                          className="flex-shrink-0 text-[10px] text-[#94A3B8] hover:text-[#475569] font-medium px-1.5 py-0.5 rounded hover:bg-[#0F172A]/[0.04] transition-colors"
                                        >Original (w/ stamp)</a>
                                      </>
                                    ) : (
                                      <a
                                        href={file.file_url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="flex-shrink-0 text-[11px] text-[#7B9BB5] hover:text-[#5A7A94] font-medium px-2 py-0.5 rounded hover:bg-[#7B9BB5]/10 transition-colors"
                                      >Open</a>
                                    )}
                                    <button
                                      onClick={() => handleFileOpen(file, div.num, div.name, sec.code, sec.name)}
                                      className="flex-shrink-0 text-[11px] text-[#64748B] hover:text-[#0F172A] font-medium px-2 py-0.5 rounded hover:bg-[#0F172A]/[0.04] transition-colors"
                                    >Cover</button>
                                    <button
                                      onClick={() => setLibDeleteTarget({ file, secCode: sec.code })}
                                      title={file.source === "spec_ingestion"
                                        ? "Remove the file — keeps the submittal log entry"
                                        : "Delete this Library item"}
                                      className="flex-shrink-0 text-[11px] text-[#94A3B8] hover:text-red-500 font-medium px-2 py-0.5 rounded hover:bg-red-50 transition-colors"
                                    >Delete</button>
                                  </div>
                                  )
                                })}
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
                    <div className="flex flex-col gap-0.5">
                      <p className="text-[13px] font-semibold text-[#0F172A]">Pending Review <span className="text-[#64748B] font-normal ml-1">({staged.length} staged)</span></p>
                      {pendingHiddenCount > 0 && (
                        <p className="text-[11px] text-[#94A3B8]">
                          {pendingHiddenCount} submittal{pendingHiddenCount === 1 ? "" : "s"} hidden — out of project scope.{" "}
                          <a href="/settings?tab=projects" className="text-[#7B9BB5] font-medium hover:underline">Edit scope</a>
                        </p>
                      )}
                    </div>
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
                                <tr key={r.id} className={`border-b border-[#E2E8F0]/60 last:border-0 transition-colors ${r.reference_only ? "bg-[#F8F9FA] opacity-60" : "hover:bg-[#F8F9FA]"}`}>
                                  <td className="px-3 py-2 w-8 align-top">
                                    <input type="checkbox" checked={r.is_selected}
                                      onChange={() => patchStaged([r.id], { is_selected: !r.is_selected })}
                                      className="accent-[#7B9BB5] mt-0.5" />
                                  </td>
                                  <td className="px-2 py-2 w-14 align-top text-[12px] font-semibold text-[#64748B] whitespace-nowrap">{[r.article, r.letter].filter(Boolean).join(" ")}</td>
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
                                  <td className="px-2 py-2 align-top text-[12px] text-[#64748B]">
                                    {r.reference_only && (
                                      <span className="mr-1.5 inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-[#E2E8F0] text-[#94A3B8] align-middle" title="Cross-reference to another section — not a chase-able deliverable">Reference</span>
                                    )}
                                    {r.description}
                                  </td>
                                </tr>
                              )) : SUBMITTAL_TYPE_OPTIONS.flatMap(type => {
                                const group = rows.filter(r => r.submittal_type === type)
                                if (group.length === 0) return []
                                const ids = group.map(g => g.id)
                                const allSelected = group.every(g => g.is_selected)
                                // A type-group that is entirely cross-references is
                                // de-emphasized like a detailed reference row.
                                const groupRefOnly = group.every(g => g.reference_only)
                                return [(
                                  <tr key={`${secId}-${type}`} className={`border-b border-[#E2E8F0]/60 last:border-0 transition-colors ${groupRefOnly ? "bg-[#F8F9FA] opacity-60" : "hover:bg-[#F8F9FA]"}`}>
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
                                    <td className="px-2 py-2 align-top text-[12px] text-[#0F172A] font-medium">
                                      {groupRefOnly && (
                                        <span className="mr-1.5 inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-[#E2E8F0] text-[#94A3B8] align-middle" title="Cross-references to other sections — not chase-able deliverables">Reference</span>
                                      )}
                                      {typeLabels[type] ?? type}
                                    </td>
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
            <div className="px-4 py-4"><SkeletonTable rows={8} cols={7} /></div>
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
            // Sort + colour-band the rows. Grouped: spec section, then
            // section_seq (so the displayed number matches row position).
            // Ungrouped: per-project submittal number.
            // Date-only "today" for all ball-in-court math (matches lateState).
            const today = new Date().toISOString().slice(0, 10)
            // Client-side ball-in-court filtering over the already-fetched rows.
            const rows = displaySubmittals.filter(s => {
              if (courtFilter !== "all" && courtBucket(getBallInCourt(s).party) !== courtFilter) return false
              if (overdueOnly && !isOverdue(s, today)) return false
              return true
            })
            if (courtSort) {
              // Sort by days-in-court; longest-waiting first (desc) is the default.
              // Not-started rows (null days) always sink to the bottom.
              rows.sort((a, b) => {
                const da = daysInCourt(a, today), db = daysInCourt(b, today)
                if (da === null && db === null) return 0
                if (da === null) return 1
                if (db === null) return -1
                return courtSort === "desc" ? db - da : da - db
              })
            } else if (groupBySection) {
              rows.sort(compareBySectionOrder)
            } else {
              rows.sort((a, b) => (a.submittal_seq ?? 0) - (b.submittal_seq ?? 0))
            }
            const colorIdx = sectionColorMap(rows.map(r => r.csi_section))
            const colorFor = (sec: string | null) => SECTION_PALETTE[colorIdx.get(sec ?? "—") ?? 0]
            const HEADERS = ["Subm. #", "Spec #", "Description", "Ball-in-Court", "Type of Subm.", "Vendor",
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
                if (!s.vendor_id) continue
                const key = s.vendor_id
                const label = vendors.find(v => v.id === s.vendor_id)?.company_name ?? "Unknown"
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
                  const id = e.target.value
                  if (!id) return
                  setSelectedIds(new Set(logSubmittals.filter(s => s.vendor_id === id).map(s => s.id)))
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
                {/* Bulk status set — command-select (value stays ""), one action
                    per pick. Options = the canonical vocabulary in lifecycle
                    order (REVIEW_STATUSES, same list as the per-row dropdown). */}
                <select value="" disabled={selectedIds.size === 0 || settingStatus}
                  onChange={e => { const v = e.target.value; if (isReviewStatus(v)) bulkSetStatus(v) }}
                  title="Set the review status of all selected rows in one action. Dates are not changed."
                  className="h-8 px-2 rounded-md border border-[#7B9BB5] text-[12px] font-semibold text-[#5A7A94] bg-white hover:bg-[#7B9BB5]/[0.08] transition-colors focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 disabled:opacity-50 disabled:cursor-not-allowed">
                  <option value="">{settingStatus ? "Setting…" : "Set status…"}</option>
                  {LOG_STATUS_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
                {(() => {
                  // All-fulfilled selection → the button unmarks; any other
                  // selection (mixed or none-fulfilled) → it marks all true.
                  const allFulfilled = selectedSubmittals.length > 0
                    && selectedSubmittals.every(s => s.fulfilled_by_other === true)
                  return (
                    <button disabled={selectedIds.size === 0 || markingFulfilled} onClick={bulkMarkFulfilled}
                      title="Mark the selected rows as satisfied by another submittal — the rows stay in the log; their description shows &quot;Fulfilled by other submittal&quot;."
                      className="h-8 px-3 rounded-md border border-[#7B9BB5] text-[#5A7A94] text-[12px] font-semibold hover:bg-[#7B9BB5]/[0.08] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 whitespace-nowrap">
                      {markingFulfilled ? <SpinnerIcon className="h-3.5 w-3.5" /> : null}
                      {allFulfilled ? "Unmark fulfilled" : "Mark fulfilled by other"}
                    </button>
                  )
                })()}
                <button disabled={selectedIds.size === 0} onClick={() => setShowPackageModal(true)}
                  className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[12px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 whitespace-nowrap">
                  <PlusIcon /> Create Package
                </button>
              </div>
            )}
            {/* Desktop tracker table — horizontal scroll on the outer pane,
                frozen header sticks against it. Registered as the "submittal-log"
                keyboard-nav region; each <tr> below is a [data-nav-item]. */}
            <div className="hidden sm:block" {...logRegionProps}>
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
                    h === "Ball-in-Court" ? (
                      <th key={h} className="text-left px-3 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-wider whitespace-nowrap">
                        <button type="button"
                          onClick={() => setCourtSort(c => c === null ? "desc" : c === "desc" ? "asc" : null)}
                          title="Sort by days-in-court (longest-waiting first)"
                          className="inline-flex items-center gap-1 uppercase tracking-wider hover:text-[#0F172A] transition-colors">
                          {h}
                          <span className={`text-[9px] ${courtSort ? "text-[#7B9BB5]" : "text-[#CBD5E1]"}`}>
                            {courtSort === "desc" ? "▼" : courtSort === "asc" ? "▲" : "↕"}
                          </span>
                        </button>
                      </th>
                    ) : (
                      <th key={h} className="text-left px-3 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-wider whitespace-nowrap">{h}</th>
                    )
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(s => {
                  const c = colorFor(s.csi_section)
                  const appr = approvalDays(s)
                  const late = lateState(s)
                  const hasSource = s.source === "spec_ingestion" && !!s.spec_section_id
                  // Has-attachment indicator: spec-built placeholder rows
                  // (no PDF yet) read as visually quieter; rows with an
                  // attachment get a darker title + a small PDF icon and
                  // a subtle white-tinted background to stand out from
                  // the section-color tint that applies to all rows.
                  const hasAttachment = !!s.storage_path
                  return (
                  <tr key={s.id} data-nav-item className={`border-b border-[#E2E8F0]/60 ${c.bg} ${hasAttachment ? "shadow-[inset_0_0_0_999px_rgba(255,255,255,0.45)]" : ""} ${showSelect && selectedIds.has(s.id) ? "ring-1 ring-inset ring-[#7B9BB5]/40" : ""} outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#7B9BB5] focus-visible:bg-[#7B9BB5]/[0.06]`}>
                    {showSelect && (
                      <td className="px-3 py-1.5">
                        <input type="checkbox" checked={selectedIds.has(s.id)}
                          onChange={() => toggleRowSelected(s.id)}
                          className="accent-[#7B9BB5] align-middle" />
                      </td>
                    )}
                    <td className={`px-3 py-1.5 tabular-nums ${hasAttachment ? "text-[#0F172A] font-semibold" : "text-[#94A3B8] font-medium"} border-l-4 ${c.border} whitespace-nowrap`}>{formatSectionNumber(s.csi_section, s.section_seq)}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      <span className={`inline-block px-1.5 py-0.5 rounded font-mono text-[11px] font-semibold ${c.chip}`}>{s.csi_section ?? "—"}</span>
                    </td>
                    <td className="px-3 py-1.5">
                      {s.fulfilled_by_other ? (
                        // Display-only substitution — the stored file_name/title is
                        // never overwritten, so unmarking restores it with zero loss.
                        <span className="font-bold">Fulfilled by other submittal</span>
                      ) : (
                      <div className="flex items-center gap-1.5 max-w-[520px]">
                        {hasAttachment ? (
                          <svg className="h-3.5 w-3.5 flex-shrink-0 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-label="Attached">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                          </svg>
                        ) : (
                          <svg className="h-3.5 w-3.5 flex-shrink-0 text-[#CBD5E1]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-label="Awaiting submittal">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                        )}
                        <button
                          type="button"
                          data-nav-primary
                          onClick={() => openDetailModal(s)}
                          title={s.file_name}
                          className={`flex-1 min-w-0 text-left truncate hover:underline focus:outline-none focus:underline ${hasAttachment ? "text-[#0F172A] font-medium" : "text-[#94A3B8] italic"}`}>
                          {s.file_name}
                        </button>
                        {s.title_locked && (
                          <span title="Title was set manually — automated re-process will not overwrite it"
                            className="flex-shrink-0 text-[#94A3B8]">
                            <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 11c-1.1 0-2 .9-2 2v3h4v-3c0-1.1-.9-2-2-2zm6 0V7a6 6 0 10-12 0v4H4v10h16V11h-2zm-10 0V7a4 4 0 118 0v4H8z" /></svg>
                          </span>
                        )}
                        {s.sender_email && (
                          <span title={`Received from ${s.sender_email}`} className="flex-shrink-0 text-[#94A3B8]">
                            <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
                          </span>
                        )}
                        {/* Title-needs-review badge: shown when this
                            submittal's spec_section had no clean title
                            extractable from the spec book (parser used
                            the MasterFormat division name as last resort).
                            User clicks the title to edit it manually. */}
                        {s.spec_section_id && titleReviewSet.has(s.spec_section_id) && (
                          <span
                            title="The parser couldn't extract a clean title for this spec section from the spec book. Click the title to set it manually."
                            className="flex-shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wider bg-amber-100 text-amber-800">
                            Title needs review
                          </span>
                        )}
                        {/* Revision badge: shown only when this submittal
                            has >= 2 attachments. Click → slide-out with
                            the full history. The label uses the parent
                            row's revision_number (kept in sync by the DB
                            trigger to match the current attachment). */}
                        {attachmentCounts[s.id] && attachmentCounts[s.id] >= 2 && (
                          <button
                            type="button"
                            onClick={() => openRevHistory(s)}
                            title={`${attachmentCounts[s.id]} revisions on file — click to view history`}
                            className="flex-shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold tabular-nums bg-[#7B9BB5]/10 text-[#5A7A94] hover:bg-[#7B9BB5]/20 transition-colors">
                            <span>Rev {s.revision_number ?? "?"}</span>
                            <span className="text-[#94A3B8]">· {attachmentCounts[s.id]} of {attachmentCounts[s.id]}</span>
                          </button>
                        )}
                      </div>
                      )}
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      {(() => {
                        const bic = getBallInCourt(s)
                        const days = daysInCourt(s, today)
                        const overdue = isOverdue(s, today)
                        return (
                          <span
                            title={bic.sinceDate
                              ? `Since ${fmtDate(bic.sinceDate)}${overdue && s.due_date ? ` — overdue (due ${fmtDate(s.due_date)})` : ""}`
                              : "No workflow dates yet"}
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ${BIC_TONE[bic.party]}`}>
                            {bic.label}
                            {days !== null && (
                              <span className={`tabular-nums ${overdue ? "text-red-700 font-bold" : "opacity-60"}`}>· {days} d</span>
                            )}
                          </span>
                        )
                      })()}
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      {/* Inline type edit — same idiom as the review-status select below.
                          "" ⇄ NULL: untyped rows stay untyped, and a typed row can be
                          cleared back to untyped (the column is nullable by design). */}
                      <select value={s.submittal_type ?? ""}
                        onChange={e => patchSubmittal(s.id, { submittal_type: e.target.value || null })}
                        className="h-7 px-1.5 rounded border border-[#E2E8F0] text-[12px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                        <option value="">—</option>
                        {SUBMITTAL_TYPE_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </td>
                    <td className="px-2 py-1.5">
                      <VendorCell
                        vendorId={s.vendor_id} personId={s.vendor_person_id}
                        vendors={vendors} people={vendorPeople}
                        onChange={sel => patchSubmittal(s.id, {
                          vendor_id: sel.vendorId,
                          vendor_person_id: sel.personId,
                        })}
                        onCreateVendor={createVendor} onCreatePerson={createVendorPerson} />
                    </td>
                    <td className="px-2 py-1.5"><DateCell value={s.received_date} onChange={v => patchSubmittal(s.id, { received_date: v })} /></td>
                    <td className="px-2 py-1.5"><DateCell value={s.sent_to_ae_date} onChange={v => patchSubmittal(s.id, { sent_to_ae_date: v })} /></td>
                    <td className="px-2 py-1.5"><DateCell value={s.returned_from_ae_date} onChange={v => patchSubmittal(s.id, { returned_from_ae_date: v })} /></td>
                    <td className="px-2 py-1.5"><DateCell value={s.returned_to_sub_date} onChange={v => patchSubmittal(s.id, { returned_to_sub_date: v })} /></td>
                    <td className="px-3 py-1.5 text-center tabular-nums text-[#64748B]">{appr ?? "—"}</td>
                    <td className="px-2 py-1.5">
                      <select value={s.review_status ?? "Not Started"}
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
                          <>
                            <button
                              onClick={() => window.open(`/api/download/${s.id}?stripped=1`, "_blank")}
                              title="Library view — front matter (Waters cover + architect-stamp page + routing/blanks) auto-stripped. Original is one click away."
                              className="text-[11px] text-[#64748B] hover:text-[#0F172A] px-1.5 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">
                              Open
                            </button>
                            <button
                              onClick={() => window.open(`/api/download/${s.id}`, "_blank")}
                              title="Original full PDF — Waters coversheet + architect stamp + all content, exactly as uploaded. This is the record-of-truth file."
                              className="text-[10px] text-[#94A3B8] hover:text-[#475569] px-1 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">
                              Original (w/ stamp)
                            </button>
                            <button
                              onClick={() => openRevUpload(s)}
                              title="Upload a new revision of this document — it is added to the revision history; the file on record stays intact."
                              className="text-[11px] text-[#7B9BB5] hover:text-[#5A7A94] px-1.5 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">
                              Upload Rev
                            </button>
                          </>
                        )}
                        <button onClick={() => openEditModal(s)} className="text-[11px] text-[#64748B] hover:text-[#0F172A] px-1.5 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">Edit</button>
                        <button onClick={() => s.project_id ? openEditCoverSheet(s) : openTransmittal(s)} className="text-[11px] text-[#7B9BB5] px-1.5 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">Cover</button>
                        <button onClick={() => handleTransmittal(s, s.submittal_seq ?? 0)} disabled={transmittalLoading && transmittalSub?.id === s.id}
                          className="text-[11px] text-emerald-700 hover:text-emerald-800 px-1.5 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50 flex items-center gap-1">
                          {transmittalLoading && transmittalSub?.id === s.id ? <SpinnerIcon className="h-3 w-3" /> : null}Transmit
                        </button>
                        {s.source === "spec_ingestion" ? (
                          // Spec rows are STRUCTURE — never delete the placeholder.
                          // Offer Clear (remove the file, keep the row) only when
                          // there's a file to clear; an empty placeholder has no
                          // destructive action.
                          s.storage_path && (
                            <button onClick={() => openRowDelete(s)} className="text-[11px] text-[#64748B] hover:text-amber-600 px-1.5 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors" title="Clear the document — the spec log row stays">Clear</button>
                          )
                        ) : (
                          <button onClick={() => openRowDelete(s)} className="text-[11px] text-[#64748B] hover:text-red-400 px-1.5 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors" title="Delete this submittal from the log">Delete</button>
                        )}
                      </div>
                    </td>
                  </tr>
                  )
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={HEADERS.length + (showSelect ? 1 : 0)} className="px-4 py-10 text-center text-[13px] text-[#64748B]">
                      No submittals match the current ball-in-court filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            </div>
            {/* Mobile card list */}
            <div className="sm:hidden px-3 py-3 space-y-2">
              {rows.map(s => {
                const c = colorFor(s.csi_section)
                const late = lateState(s)
                const vendor = vendorLabel(s)
                const bic = getBallInCourt(s)
                const courtDays = daysInCourt(s, today)
                const overdue = isOverdue(s, today)
                return (
                <div key={s.id} className={`rounded-xl border border-[#E2E8F0] border-l-4 ${c.border} p-3 shadow-sm ${c.bg}`}>
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <div className="flex items-center gap-1.5 min-w-0">
                      {showSelect && (
                        <input type="checkbox" checked={selectedIds.has(s.id)}
                          onChange={() => toggleRowSelected(s.id)}
                          className="accent-[#7B9BB5] flex-shrink-0" />
                      )}
                      <span className="text-[11px] font-bold tabular-nums text-[#64748B] flex-shrink-0" title={formatSectionNumber(s.csi_section, s.section_seq)}>{padSectionSeq(s.section_seq)}</span>
                      {s.fulfilled_by_other ? (
                        // Display-only substitution (stored title untouched) — mirrors
                        // the desktop table's description cell.
                        <span className="flex-1 min-w-0 text-[13px] font-bold text-[#0F172A] leading-tight truncate">Fulfilled by other submittal</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => openDetailModal(s)}
                          title={s.file_name}
                          className="flex-1 min-w-0 text-left text-[13px] font-medium text-[#0F172A] leading-tight truncate hover:underline focus:outline-none">
                          {s.file_name}
                        </button>
                      )}
                      {s.title_locked && (
                        <span title="Title was set manually — automated re-process will not overwrite it"
                          className="flex-shrink-0 text-[#94A3B8]">
                          <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 11c-1.1 0-2 .9-2 2v3h4v-3c0-1.1-.9-2-2-2zm6 0V7a6 6 0 10-12 0v4H4v10h16V11h-2zm-10 0V7a4 4 0 118 0v4H8z" /></svg>
                        </span>
                      )}
                    </div>
                    <StatusBadge status={s.review_status ?? "Not Started"} />
                  </div>
                  <div className="mb-1.5">
                    <span
                      title={bic.sinceDate ? `Since ${fmtDate(bic.sinceDate)}` : "No workflow dates yet"}
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ${BIC_TONE[bic.party]}`}>
                      {bic.label}
                      {courtDays !== null && (
                        <span className={`tabular-nums ${overdue ? "text-red-700 font-bold" : "opacity-60"}`}>· {courtDays} d</span>
                      )}
                    </span>
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
                    {s.source === "spec_ingestion" ? (
                      s.storage_path && (
                        <button onClick={() => openRowDelete(s)} className="text-[11px] text-amber-600 px-2 py-1 rounded border border-[#E2E8F0] bg-white transition-colors" title="Clear the document — the spec log row stays">Clear</button>
                      )
                    ) : (
                      <button onClick={() => openRowDelete(s)} className="text-[11px] text-red-400 px-2 py-1 rounded border border-[#E2E8F0] bg-white transition-colors">Delete</button>
                    )}
                  </div>
                </div>
                )
              })}
              {rows.length === 0 && (
                <p className="px-1 py-8 text-center text-[13px] text-[#64748B]">No submittals match the current filter.</p>
              )}
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
          projectCmName={appProjects.find(p => p.id === globalProjectId)?.cm_name ?? null}
          userName={myFullName || (teamMembers.find(m => m.email === userEmail)?.name ?? userEmail ?? "")}
          submittals={selectedSubmittals}
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
              Clicking <strong>Yes</strong> will mark this submittal as <span className="text-amber-700 font-semibold">Sent to A/E</span> and log the date and recipient.
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
                Yes, mark as Sent to A/E
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Per-row Clear/Delete confirm (Submittal Log → library-delete) ──
          The copy branches on the row's own spec_section_id/storage_path and
          must tell the truth: spec rows keep the log entry (only the file
          goes); manual rows leave the log entirely. In BOTH cases the stored
          document is unrecoverable — no undo is offered anywhere. */}
      {rowDeleteTarget && (() => {
        const s = rowDeleteTarget
        const isSpec = s.spec_section_id != null
        const name = truncateForDisplay(s.file_name)
        return (
          <div
            className="fixed inset-0 bg-black/60 z-[60] flex items-center justify-center p-4"
            onClick={e => { if (e.target === e.currentTarget && !rowDeleteBusy) setRowDeleteTarget(null) }}
          >
            <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-5">
              <h2 className="text-[15px] font-bold text-[#0F172A] mb-2">
                {isSpec ? "Clear the document from this row?" : "Delete this submittal?"}
              </h2>
              <p className="text-[13px] text-[#475569] mb-4 leading-relaxed">
                {isSpec ? (
                  <>The row stays — it&apos;s a spec-book requirement. The document attached to{" "}
                  <span className="font-semibold text-[#0F172A]">{name}</span> is permanently removed from
                  storage and cannot be recovered. The log entry keeps its section, number, title and type
                  as an empty placeholder, ready for the next import.</>
                ) : s.storage_path ? (
                  <>This removes <span className="font-semibold text-[#0F172A]">{name}</span> from the log.
                  {" "}Its attached document is also permanently removed from storage and cannot be recovered.</>
                ) : (
                  <>This removes <span className="font-semibold text-[#0F172A]">{name}</span> from the log.</>
                )}
              </p>
              {rowDeleteError && (
                <p className="text-[12px] text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2 mb-4 leading-relaxed">
                  {rowDeleteError}
                </p>
              )}
              <div className="flex gap-2 justify-end">
                <button
                  disabled={rowDeleteBusy}
                  onClick={() => setRowDeleteTarget(null)}
                  className="h-9 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50">
                  Cancel
                </button>
                <button
                  disabled={rowDeleteBusy}
                  onClick={confirmRowDelete}
                  className={`h-9 px-4 rounded-md text-white text-[13px] font-semibold transition-colors disabled:opacity-50 flex items-center gap-1.5 ${isSpec ? "bg-amber-600 hover:bg-amber-700" : "bg-red-600 hover:bg-red-700"}`}>
                  {rowDeleteBusy ? <SpinnerIcon className="h-3.5 w-3.5" /> : null}
                  {isSpec ? "Clear document" : "Delete submittal"}
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* ── Library delete confirm (detach-or-delete) ─────────────────────── */}
      {libDeleteTarget && (() => {
        const isSpec = libDeleteTarget.file.source === "spec_ingestion"
        const name = truncateForDisplay(libDeleteTarget.file.file_name)
        return (
          <div
            className="fixed inset-0 bg-black/60 z-[60] flex items-center justify-center p-4"
            onClick={e => { if (e.target === e.currentTarget && !libDeleting) setLibDeleteTarget(null) }}
          >
            <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-5">
              <h2 className="text-[15px] font-bold text-[#0F172A] mb-2">
                {isSpec ? "Remove file from Library?" : "Delete Library item?"}
              </h2>
              <p className="text-[13px] text-[#475569] mb-5 leading-relaxed">
                {isSpec ? (
                  <>This permanently deletes the stored PDF for <span className="font-semibold text-[#0F172A]">{name}</span>.
                  {" "}The submittal log entry stays exactly as it is — section, title, type, number and project are untouched;
                  it just returns to an empty placeholder, ready for re-import. Only the file is removed.</>
                ) : (
                  <>This permanently deletes <span className="font-semibold text-[#0F172A]">{name}</span> and its file.
                  {" "}This item exists only in the Library (no spec-book log entry), so the entire record is removed.</>
                )}
              </p>
              <div className="flex gap-2 justify-end">
                <button
                  disabled={libDeleting}
                  onClick={() => setLibDeleteTarget(null)}
                  className="h-9 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50">
                  Cancel
                </button>
                <button
                  disabled={libDeleting}
                  onClick={confirmLibraryDelete}
                  className="h-9 px-4 rounded-md bg-red-600 text-white text-[13px] font-semibold hover:bg-red-700 transition-colors disabled:opacity-50 flex items-center gap-1.5">
                  {libDeleting ? <SpinnerIcon className="h-3.5 w-3.5" /> : null}
                  {isSpec ? "Remove file" : "Delete item"}
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* ── File open modal ───────────────────────────────────────────────── */}
      {openFileCtx && fileModalStep === "project" && (
        <div
          className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
          onClick={e => { if (e.target === e.currentTarget && !coverQueue) closeFileModal() }}
        >
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[460px] mx-4 sm:mx-0 p-6">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-[15px] font-bold text-[#0F172A]">{coverQueue ? "Add Cover Sheets" : "Open Submittal"}</h2>
              <button onClick={closeFileModal} className="text-[#64748B] hover:text-[#64748B] transition-colors">
                <XIcon className="h-4 w-4" />
              </button>
            </div>
            <p className="text-[12px] text-[#64748B] mb-4 truncate">
              {coverQueue
                ? `${coverQueue.length} uploaded document${coverQueue.length !== 1 ? "s" : ""} — you'll get a prefilled cover form for each`
                : openFileCtx.file.file_name}
            </p>

            <div className="mb-4">
              <label className="block text-[12px] font-medium text-[#64748B] mb-1">
                {coverQueue ? "Which project are these for? (printed on every cover — applies to all)" : "Which project is this for?"}
              </label>
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
                {!coverQueue && (
                  <button
                    onClick={openFileDirectly}
                    className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors"
                  >
                    Skip &amp; Open
                  </button>
                )}
                <button
                  onClick={() => coverQueue ? initCoverForm() : setFileModalStep("coversheet")}
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
          onClick={e => { if (e.target === e.currentTarget && !coverQueue) closeFileModal() }}
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
                onClick={() => initCoverForm()}
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
          onClick={e => { if (e.target === e.currentTarget && !coverQueue) closeFileModal() }}
        >
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[680px] mx-4 sm:mx-0">
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E2E8F0]">
              <div className="min-w-0">
                <h2 className="text-[15px] font-bold text-[#0F172A]">Submittal Transmittal</h2>
                {coverQueue && (
                  <p className="text-[11px] text-[#64748B] truncate">
                    Document {coverQueueIndex + 1} of {coverQueue.length} — {openFileCtx.file.file_name}
                  </p>
                )}
              </div>
              <button onClick={closeFileModal} className="text-[#64748B] hover:text-[#64748B] transition-colors">
                <XIcon className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleGenerateCover}>
              <div className="px-6 py-4 space-y-3 overflow-y-auto max-h-[75vh]">

                {/* Which stored copy the cover is merged onto. Only PDFs get a
                    merge at all, so the choice is hidden for other types —
                    and for log rows whose stored file is already a generated
                    transmittal (coverSourceLocked), where "original" would
                    stack the new cover on the previous one. */}
                {openFileCtx.file.mime_type === "application/pdf" && !coverSourceLocked && (
                  <div className="rounded-lg border border-[#E2E8F0] bg-[#F8F9FA] px-3 py-2.5">
                    <label className={labelCls}>Attach cover to</label>
                    <div className="flex flex-col gap-1.5">
                      <label className="flex items-start gap-2 cursor-pointer">
                        <input
                          type="radio" name="coverContentSource"
                          checked={coverForm.contentSource === "original"}
                          onChange={() => setCoverForm(prev => ({ ...prev!, contentSource: "original" }))}
                          className="mt-0.5 accent-[#7B9BB5]"
                        />
                        <span className="text-[12px] text-[#0F172A]">
                          Original (w/ stamp)
                          <span className="text-[#64748B]"> — the full stored document, nothing removed</span>
                        </span>
                      </label>
                      <label className="flex items-start gap-2 cursor-pointer">
                        <input
                          type="radio" name="coverContentSource"
                          checked={coverForm.contentSource === "stripped"}
                          onChange={() => setCoverForm(prev => ({ ...prev!, contentSource: "stripped" }))}
                          className="mt-0.5 accent-[#7B9BB5]"
                        />
                        <span className="text-[12px] text-[#0F172A]">
                          Library copy
                          <span className="text-[#64748B]"> — detected front matter (old coversheet / stamp pages) removed; uses the original when nothing was stripped (stripping can take a minute right after upload)</span>
                        </span>
                      </label>
                    </div>
                  </div>
                )}

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
                        submittalNumber={Number.isFinite(parseInt(coverForm!.submittalNo, 10)) ? padSectionSeq(parseInt(coverForm!.submittalNo, 10)) : ""}
                        revisionNumber="00"
                        dateSubmitted={coverForm!.dateSubmitted}
                        submittalDueDate=""
                        copyTo=""
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* One-time review-stamp name capture (only when no saved full_name) */}
              {myFullName === null && (
                <div className="px-6 py-3 border-t border-[#E2E8F0] bg-[#F8F9FA]">
                  <label className={labelCls}>Your name (appears on the review stamp)</label>
                  <input
                    type="text"
                    value={stampNameInput}
                    onChange={e => setStampNameInput(e.target.value)}
                    required
                    maxLength={120}
                    placeholder="e.g. Jane Smith"
                    className={inputCls}
                  />
                  <p className="text-[11px] text-[#64748B] mt-1">Saved to your profile — you&apos;ll only be asked once.</p>
                </div>
              )}

              <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#E2E8F0]">
                <button
                  type="button"
                  onClick={closeFileModal}
                  className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors"
                >
                  {coverQueue ? "Cancel all" : "Cancel"}
                </button>
                {coverQueue && (
                  <button
                    type="button"
                    disabled={generatingCover || savingStampName}
                    onClick={() => { if (!advanceCoverQueue()) closeFileModal() }}
                    className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50"
                  >
                    Skip this document
                  </button>
                )}
                <button
                  type="submit"
                  disabled={generatingCover || savingStampName}
                  className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 flex items-center gap-2"
                >
                  {(generatingCover || savingStampName) && <SpinnerIcon className="h-3 w-3" />}
                  {savingStampName ? "Saving…" : generatingCover ? "Generating…" : "Generate & Download"}
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
                    setUploadFileSha256(null)
                    setUploadDupeMatch(null)
                    setAiResult(null)
                    setUploadError(null)
                    if (!f) { setUploadStep("file"); return }
                    setUploadStep("classifying")
                    // Compute SHA-256 in parallel with the storage PUT —
                    // the browser already has the bytes, so this is free.
                    // The dupe-check fires once the hash is ready. Both
                    // are non-fatal: a failure leaves uploadFileSha256
                    // null and the upload proceeds without the hash
                    // (backfill will fill it in).
                    void (async () => {
                      try {
                        const sha = await hashFileInBrowser(f)
                        setUploadFileSha256(sha)
                        const res = await fetch("/api/check-duplicate", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ sha256: sha, project_id: null }),   // Library shelf scope (project-independent)
                        })
                        if (res.ok) setUploadDupeMatch(await res.json())
                      } catch (err) {
                        console.warn("[library] hash/dupe-check failed (non-fatal)", err)
                      }
                    })()
                    // PUT the file straight to storage first; its path then
                    // feeds both /api/classify and /api/upload.
                    let path: string
                    try {
                      ;({ path } = await presignAndUpload("submittals", "uploads", f))
                      setUploadFilePath(path)
                    } catch (err) {
                      console.error("[library] presign/upload failed", err)
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
                    } catch (err) {
                      console.error("[library] classify request failed", err)
                    }
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

              {uploadDupeMatch && uploadDupeMatch.same_project_matches.length > 0 && (
                <div className="rounded-md bg-amber-50 border border-amber-300 px-3 py-2 text-[12px] text-amber-900">
                  <p className="font-semibold">⚠ Possible duplicate</p>
                  <p className="mt-1">
                    This exact file already exists {globalProjectId ? "in this project" : "in your Library"} as{" "}
                    {uploadDupeMatch.same_project_matches.map((m, i) => (
                      <span key={m.submittal_id}>
                        {i > 0 ? ", " : ""}
                        <span className="font-medium">
                          {m.section_seq != null ? formatSectionNumber(m.csi_section, m.section_seq) : m.file_name}
                          {m.revision_number ? ` (${m.revision_number})` : ""}
                        </span>
                      </span>
                    ))}.
                    {" "}You can still upload it (e.g. as a new revision) — nothing is auto-blocked.
                  </p>
                </div>
              )}

              {uploadDupeMatch && uploadDupeMatch.cross_project_matches.length > 0 && (
                <p className="text-[11px] text-[#64748B] italic">
                  This file also exists on{" "}
                  {uploadDupeMatch.cross_project_matches.length === 1
                    ? (uploadDupeMatch.cross_project_matches[0].project_name ?? "another project")
                    : `${uploadDupeMatch.cross_project_matches.length} other projects`}
                  {" "}(re-using the same datasheet across jobs is normal).
                </p>
              )}

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
                  {REVIEW_STATUSES.map(s => (
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

      {/* ── Detail / preview modal ───────────────────────────────────────── */}
      {detailSubmittal && (() => {
        const s = detailSubmittal
        const proj = s.project_id ? appProjects.find(p => p.id === s.project_id) : null
        const fmt = (v: string | null | undefined) => v && v.trim() !== "" ? v : "—"
        const fmtDateField = (v: string | null | undefined) => v ? fmtDate(v) : "—"
        const hasPdf = !!s.storage_path && s.mime_type === "application/pdf"
        return (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-stretch sm:items-center justify-center"
          onClick={e => { if (e.target === e.currentTarget) closeDetailModal() }}>
          <div ref={detailModalRef} role="dialog" aria-modal="true" className="bg-white sm:rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[min(96vw,1100px)] sm:max-h-[92vh] flex flex-col">
            {/* Header */}
            <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-[#E2E8F0]">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[11px] text-[#64748B] mb-1">
                  <span className="font-mono font-semibold">{formatSectionNumber(s.csi_section, s.section_seq)}</span>
                  {s.submittal_type && <><span>·</span><span>{s.submittal_type}</span></>}
                  {s.title_locked && (
                    <span title="Title set manually — automated re-process will not overwrite it" className="ml-1 inline-flex items-center gap-0.5 text-[#94A3B8]">
                      <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 11c-1.1 0-2 .9-2 2v3h4v-3c0-1.1-.9-2-2-2zm6 0V7a6 6 0 10-12 0v4H4v10h16V11h-2zm-10 0V7a4 4 0 118 0v4H8z" /></svg>
                      <span className="text-[10px]">Locked</span>
                    </span>
                  )}
                </div>
                {detailTitleEditing ? (
                  <div className="flex items-center gap-2">
                    <input
                      autoFocus
                      value={detailTitleDraft}
                      onChange={e => setDetailTitleDraft(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === "Enter") { e.preventDefault(); saveDetailTitle() }
                        if (e.key === "Escape") {
                          e.preventDefault()
                          setDetailTitleDraft(s.file_name)
                          setDetailTitleEditing(false)
                          setDetailTitleError(null)
                        }
                      }}
                      disabled={detailTitleSaving}
                      className="flex-1 h-9 px-3 rounded-md border border-[#7B9BB5]/60 bg-white text-[15px] font-semibold text-[#0F172A] focus:outline-none focus:ring-2 focus:ring-[#7B9BB5]/30" />
                    <button onClick={saveDetailTitle} disabled={detailTitleSaving}
                      className="h-9 px-3 rounded-md bg-[#7B9BB5] text-white text-[12px] font-semibold hover:bg-[#6A8AA4] disabled:opacity-50 flex items-center gap-1">
                      {detailTitleSaving && <SpinnerIcon className="h-3 w-3" />}{detailTitleSaving ? "Saving…" : "Save"}
                    </button>
                    <button onClick={() => { setDetailTitleDraft(s.file_name); setDetailTitleEditing(false); setDetailTitleError(null) }}
                      disabled={detailTitleSaving}
                      className="h-9 px-3 rounded-md border border-[#E2E8F0] text-[12px] text-[#64748B] hover:bg-[#F4F5F7] disabled:opacity-50">Cancel</button>
                  </div>
                ) : (
                  <div className="flex items-start gap-2">
                    <h2 className="text-[16px] font-bold text-[#0F172A] leading-tight break-words">{s.file_name}</h2>
                    <button onClick={() => { setDetailTitleDraft(s.file_name); setDetailTitleEditing(true); setDetailTitleError(null) }}
                      title="Edit title" className="flex-shrink-0 text-[11px] text-[#7B9BB5] hover:text-[#5A7A94] px-2 py-1 rounded hover:bg-[#7B9BB5]/10 transition-colors mt-0.5">
                      Edit title
                    </button>
                  </div>
                )}
                {detailTitleError && (
                  <p className="text-[12px] text-red-500 mt-1">{detailTitleError}</p>
                )}
              </div>
              <button onClick={closeDetailModal} className="text-[#64748B] hover:text-[#0F172A] flex-shrink-0">
                <XIcon className="h-5 w-5" />
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-auto px-5 py-4 grid grid-cols-1 lg:grid-cols-[1fr_1.4fr] gap-5">
              {/* Field grid */}
              <div className="space-y-4">
                <div>
                  <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-1">Project</p>
                  <p className="text-[13px] text-[#0F172A]">{proj ? `${proj.number?.trim() ? `${proj.number} · ` : ""}${proj.name}` : "—"}</p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-1">Division</p>
                    <p className="text-[13px] text-[#0F172A]">{fmt(s.csi_division)} {s.division_name ? `· ${s.division_name}` : ""}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-1">Section</p>
                    <p className="text-[13px] text-[#0F172A]">{fmt(s.csi_section)} {s.section_name ? `· ${s.section_name}` : ""}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-1">Submittal #</p>
                    <p className="text-[13px] text-[#0F172A] tabular-nums">{formatSectionNumber(s.csi_section, s.section_seq)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-1">Type</p>
                    <p className="text-[13px] text-[#0F172A]">{fmt(s.submittal_type)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-1">Status</p>
                    <p className="text-[13px] text-[#0F172A]">{fmt(s.review_status)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-1">Revision</p>
                    <p className="text-[13px] text-[#0F172A]">{fmt(s.revision_number)}</p>
                  </div>
                </div>
                <div>
                  <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-1">Material / Manufacturer / Dimensions</p>
                  <p className="text-[13px] text-[#0F172A]">{[s.material_name, s.manufacturer, s.dimensions].filter(Boolean).join(" — ") || "—"}</p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-1">Received</p>
                    <p className="text-[13px] text-[#0F172A]">{fmtDateField(s.received_date)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-1">Sent to A/E</p>
                    <p className="text-[13px] text-[#0F172A]">{fmtDateField(s.sent_to_ae_date)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-1">Returned from A/E</p>
                    <p className="text-[13px] text-[#0F172A]">{fmtDateField(s.returned_from_ae_date)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-1">Returned to Sub</p>
                    <p className="text-[13px] text-[#0F172A]">{fmtDateField(s.returned_to_sub_date)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-1">Due date</p>
                    <p className="text-[13px] text-[#0F172A]">{fmtDateField(s.due_date)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-1">Sent to sub</p>
                    <p className="text-[13px] text-[#0F172A]">{fmtDateField(s.sent_to_sub_date)}</p>
                  </div>
                </div>
                <div>
                  <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-1">Send-to</p>
                  <p className="text-[13px] text-[#0F172A]">
                    {[s.send_to_company, s.send_to_contact, s.send_to_email].filter(Boolean).join(" · ") || "—"}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-1">Transmitted by</p>
                  <p className="text-[13px] text-[#0F172A]">{[s.transmitted_by, s.transmitted_by_company].filter(Boolean).join(" · ") || "—"}</p>
                </div>
                {s.sender_email && (
                  <div>
                    <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-1">Received from</p>
                    <p className="text-[13px] text-[#0F172A]">{s.sender_email}</p>
                  </div>
                )}
                <div>
                  <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-1">Source</p>
                  <p className="text-[13px] text-[#0F172A]">{fmt(s.source)}</p>
                </div>
              </div>
              {/* PDF preview / no-file state */}
              <div className="rounded-md border border-[#E2E8F0] bg-[#F8F9FA] min-h-[300px] sm:min-h-[480px] flex items-stretch overflow-hidden">
                {hasPdf ? (
                  <iframe
                    title={`PDF preview · ${s.file_name}`}
                    src={`/api/download/${s.id}#toolbar=1&navpanes=0`}
                    className="w-full h-full min-h-[300px] sm:min-h-[480px] border-0" />
                ) : s.storage_path ? (
                  <div className="m-auto text-center p-6">
                    <p className="text-[13px] text-[#64748B]">No inline preview for this file type.</p>
                    <button onClick={() => window.open(`/api/download/${s.id}`, "_blank")}
                      className="mt-2 h-8 px-3 rounded-md bg-[#7B9BB5] text-white text-[12px] font-semibold hover:bg-[#6A8AA4]">
                      Open file
                    </button>
                  </div>
                ) : (
                  <div className="m-auto text-center p-6">
                    <p className="text-[13px] text-[#64748B]">No file attached to this submittal.</p>
                  </div>
                )}
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[#E2E8F0]">
              {s.storage_path && (
                <button onClick={() => window.open(`/api/download/${s.id}`, "_blank")}
                  className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[12px] text-[#64748B] hover:bg-[#F4F5F7] transition-colors">
                  Open
                </button>
              )}
              <button onClick={() => { closeDetailModal(); openEditModal(s) }}
                className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[12px] text-[#64748B] hover:bg-[#F4F5F7] transition-colors">
                Edit metadata
              </button>
              <button onClick={closeDetailModal}
                className="h-8 px-3 rounded-md bg-[#7B9BB5] text-white text-[12px] font-semibold hover:bg-[#6A8AA4]">
                Close
              </button>
            </div>
          </div>
        </div>
        )
      })()}

      {/* ── Bulk Import modal (Stage 1 — review only) ────────────────────── */}
      {showBulkImport && activeProjectId && (
        <BulkImportModal
          projectId={activeProjectId}
          onClose={() => setShowBulkImport(false)}
          // Re-fetch the log after each commit batch so the newly attached
          // rows (including auto-split siblings — loadSubmittals refetches
          // the whole active project, not a scoped id set) appear without a
          // page refresh. The modal only fires this when ≥1 row committed,
          // so a plain close won't trigger a needless refetch.
          onDone={() => loadSubmittals(activeProjectId)}
        />
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
                            {item.dupeMatch && item.dupeMatch.same_project_matches.length > 0 && (
                              <span
                                className="text-[10px] text-amber-700 bg-amber-50 border border-amber-300 rounded px-1.5 py-0.5 self-start"
                                title={`Same bytes as: ${item.dupeMatch.same_project_matches.map(m =>
                                  (m.section_seq != null ? formatSectionNumber(m.csi_section, m.section_seq) : m.file_name) +
                                  (m.revision_number ? ` (${m.revision_number})` : "")
                                ).join(", ")}. You can still upload — nothing is auto-blocked.`}
                              >
                                ⚠ Possible duplicate {globalProjectId ? "in this project" : "in your Library"}
                              </span>
                            )}
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
                    const coverable = batchItems.filter(isCoverableBatchItem).length
                    return (
                      <div className="mt-3 rounded-lg border border-[#E2E8F0] bg-[#F4F5F7] px-4 py-3 text-center">
                        <p className="text-[13px] font-semibold text-[#0F172A]">
                          {done} file{done !== 1 ? "s" : ""} uploaded successfully
                          {errs > 0 && <span className="text-red-400"> · {errs} failed</span>}
                        </p>
                        {coverable > 0 && (
                          <p className="text-[12px] text-[#64748B] mt-1">
                            Want transmittal cover sheets? &ldquo;Add cover sheets&rdquo; walks you through a prefilled form for each uploaded PDF.
                          </p>
                        )}
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
                {batchPhase === "done" && (() => {
                  const coverable = batchItems.filter(isCoverableBatchItem).length
                  return coverable > 0 ? (
                    <button
                      onClick={startBatchCoverQueue}
                      className="h-8 px-5 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors"
                    >
                      Add cover sheets ({coverable})
                    </button>
                  ) : null
                })()}
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

      {/* Revision history slide-out — opens on revision-badge click. Shows
          every attachment for a submittal log row, newest first. Current
          revision (the one displayed in the log) is highlighted. Download
          links go through the existing /api/download/{id}/{path} pattern. */}
      {revHistorySub && (
        <div className="fixed inset-0 bg-black/50 z-[60] flex items-stretch justify-end"
          onClick={e => { if (e.target === e.currentTarget) closeRevHistory() }}>
          <div className="bg-white border-l border-[#E2E8F0] shadow-2xl w-full sm:w-[min(90vw,520px)] h-full flex flex-col">
            <div className="px-5 py-4 border-b border-[#E2E8F0] flex items-start justify-between">
              <div className="min-w-0">
                <h3 className="text-[14px] font-bold text-[#0F172A]">Revision history</h3>
                <p className="text-[11px] text-[#64748B] mt-0.5 truncate" title={revHistorySub.file_name}>
                  {revHistorySub.csi_section ?? "—"} · {revHistorySub.submittal_type ?? "—"}
                </p>
                {revHistorySub.material_name && (
                  <p className="text-[11px] text-[#475569] mt-0.5 truncate" title={revHistorySub.material_name}>
                    {revHistorySub.material_name}
                  </p>
                )}
              </div>
              <button onClick={closeRevHistory} className="text-[#64748B] hover:text-[#0F172A] flex-shrink-0" aria-label="Close">
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="flex-1 overflow-auto">
              {revHistoryLoading && <p className="px-5 py-4 text-[12px] text-[#64748B]">Loading revisions…</p>}
              {revHistoryError   && <p className="px-5 py-4 text-[12px] text-red-700">{revHistoryError}</p>}
              {revHistoryItems && revHistoryItems.length === 0 && !revHistoryLoading && (
                <p className="px-5 py-4 text-[12px] text-[#64748B]">No attachments on file.</p>
              )}
              {revHistoryItems && revHistoryItems.length > 0 && (
                <ul className="divide-y divide-[#E2E8F0]">
                  {revHistoryItems.map(att => {
                    // "Marked for deletion" state is derived from the pending
                    // mechanism — never duplicated into revHistoryItems.
                    const marked = pendingDelete.isPending(`att:${att.id}`)
                    return (
                    <li key={att.id} className={`px-5 py-3 ${att.is_current && !marked ? "bg-emerald-50/60" : ""} ${marked ? "opacity-50" : ""}`}>
                      <div className="flex items-start gap-2">
                        <div className={`flex-1 min-w-0 ${marked ? "line-through" : ""}`}>
                          <div className="flex items-center gap-2">
                            <span className="text-[12px] font-semibold tabular-nums text-[#0F172A]">{att.revision_label}</span>
                            {att.is_current && (
                              <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded">Current</span>
                            )}
                          </div>
                          <p className="text-[11px] text-[#475569] mt-1 truncate" title={att.file_name}>{att.file_name}</p>
                          <p className="text-[10px] text-[#64748B] mt-0.5">
                            Approved: {att.approval_date ?? "—"}
                            {att.review_status ? ` · ${att.review_status}` : ""}
                            {att.submittal_number ? ` · GC #${att.submittal_number}` : ""}
                          </p>
                          <p className="text-[10px] text-[#94A3B8] mt-0.5">
                            Uploaded {new Date(att.uploaded_at).toLocaleDateString()} · via {att.source}
                          </p>
                        </div>
                        <div className="flex-shrink-0 flex items-center gap-1">
                          {marked ? (
                            <div className="flex items-center gap-2 px-2 py-1">
                              <span className="text-[11px] text-[#64748B]">Deleting…</span>
                              <button
                                onClick={() => pendingDelete.cancel(`att:${att.id}`)}
                                className="text-[11px] font-semibold text-[#7B9BB5] hover:text-[#5A7A94] underline underline-offset-2 transition-colors">
                                Undo
                              </button>
                            </div>
                          ) : (
                            <>
                              <a
                                href={`/api/download/${encodeURIComponent(revHistorySub.id)}?path=${encodeURIComponent(att.storage_path)}`}
                                target="_blank" rel="noreferrer"
                                className="text-[11px] text-[#7B9BB5] hover:text-[#5A7A94] px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">
                                Download
                              </a>
                              <button
                                onClick={() => deleteRevAttachment(att)}
                                className="text-[11px] text-red-600 hover:text-red-700 px-2 py-1 rounded hover:bg-red-50 transition-colors">
                                Delete
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Upload-revision modal (per-row "Upload Rev") ─────────────────────
          File picker + editable revision label (defaults to the next number
          after the row's current revision). After submit the modal STAYS OPEN
          showing the server's outcome message — "became current", "older than
          what's on file", or "exact file already recorded" are the signal this
          feature exists to deliver. z-[70]: above the revision slide-out so
          both can be read together when the slide-out is open. */}
      {revUploadSub && (
        <div
          className="fixed inset-0 bg-black/60 z-[70] flex items-center justify-center"
          onClick={e => { if (e.target === e.currentTarget) closeRevUpload() }}
        >
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[420px] mx-4 sm:mx-0 p-5">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-[15px] font-bold text-[#0F172A]">Upload revision</h2>
              <button onClick={closeRevUpload} disabled={revUploadBusy}
                className="text-[#64748B] hover:text-[#0F172A] transition-colors disabled:opacity-50" aria-label="Close">
                <XIcon className="h-4 w-4" />
              </button>
            </div>
            <p className="text-[12px] text-[#64748B] truncate" title={revUploadSub.file_name}>
              {revUploadSub.csi_section ?? "—"} · {truncateForDisplay(revUploadSub.file_name, { maxLength: 48 })}
            </p>
            <p className="text-[11px] text-[#94A3B8] mt-0.5 mb-3">
              Current on file: Rev {revUploadSub.revision_number ?? "R0"} · the new file is added to the
              history; nothing is deleted or overwritten.
            </p>

            {revUploadDone ? (
              <>
                <p className={`text-[12px] rounded-md px-3 py-2.5 ${
                  revUploadDone.tone === "ok" ? "bg-emerald-50 text-emerald-800"
                  : revUploadDone.tone === "warn" ? "bg-amber-50 text-amber-800"
                  : "bg-[#F1F5F9] text-[#334155]"}`}>
                  {revUploadDone.message}
                </p>
                <div className="flex justify-end mt-4">
                  <button onClick={closeRevUpload}
                    className="h-8 px-4 rounded-md bg-[#0F172A] text-white text-[12px] font-semibold hover:bg-[#1E293B] transition-colors">
                    Done
                  </button>
                </div>
              </>
            ) : (
              <>
                <label className="block text-[11px] font-semibold text-[#475569] mb-1">Revised document</label>
                <input
                  type="file"
                  onChange={e => setRevUploadFile(e.target.files?.[0] ?? null)}
                  disabled={revUploadBusy}
                  className="block w-full text-[12px] text-[#334155] file:mr-3 file:h-8 file:px-3 file:rounded-md file:border-0 file:bg-[#F1F5F9] file:text-[12px] file:font-semibold file:text-[#334155] hover:file:bg-[#E2E8F0] file:transition-colors mb-3"
                />
                <label className="block text-[11px] font-semibold text-[#475569] mb-1">Revision label</label>
                <input
                  type="text"
                  value={revUploadLabel}
                  onChange={e => setRevUploadLabel(e.target.value)}
                  disabled={revUploadBusy}
                  maxLength={24}
                  placeholder="R1"
                  className="h-8 w-28 px-2 rounded border border-[#E2E8F0] text-[12px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40"
                />
                <p className="text-[11px] text-[#94A3B8] mt-1">
                  Suggested from the current revision — change it if the architect numbered this one differently.
                </p>
                {revUploadError && <p className="text-[12px] text-red-700 mt-2">{revUploadError}</p>}
                <div className="flex justify-end gap-2 mt-4">
                  <button onClick={closeRevUpload} disabled={revUploadBusy}
                    className="h-8 px-3 rounded-md text-[12px] font-semibold text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50">
                    Cancel
                  </button>
                  <button
                    onClick={() => void submitRevUpload()}
                    disabled={revUploadBusy || !revUploadFile || !revUploadLabel.trim()}
                    className="h-8 px-4 rounded-md bg-[#0F172A] text-white text-[12px] font-semibold hover:bg-[#1E293B] transition-colors disabled:opacity-40">
                    {revUploadBusy ? "Uploading…" : "Upload revision"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Shared toast stack for pending destructive actions (currently wired
          only to the per-attachment delete above). Self-hides when idle. */}
      <PendingActionToasts items={pendingDelete.pending} onUndo={pendingDelete.cancel} />
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
 * Two-step vendor picker on the unified vendors master. Step 1 picks/creates a
 * vendor FIRM (one list — each row is flagged sub/supplier, so no type filter);
 * step 2 picks/creates a PERSON under that firm (or "firm only", person null).
 * Commit writes vendor_id + vendor_person_id. New firms/people persist
 * (reusable) via the parent's create handlers. The dropdown is fixed-positioned
 * (anchored via getBoundingClientRect) so it is never clipped by the
 * horizontally-scrolling table.
 */
function VendorCell({
  vendorId, personId, vendors, people,
  onChange, onCreateVendor, onCreatePerson,
}: {
  vendorId: string | null
  personId: string | null
  vendors: VendorRow[]
  people: VendorPersonRow[]
  onChange: (sel: { vendorId: string | null; personId: string | null }) => void
  onCreateVendor: (name: string, field: string, kind: "sub" | "sup") => Promise<VendorRow | null>
  onCreatePerson: (vendorId: string, d: { name: string; email: string; phone: string; role: string }) => Promise<VendorPersonRow | null>
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos]   = useState<{ top: number; left: number } | null>(null)
  const [step, setStep] = useState<"firm" | "person">("firm")
  const [pendFirmId, setPendFirmId] = useState<string | null>(null)
  const [q, setQ] = useState("")
  // inline create state. addKind also tags the new vendor's is_subcontractor /
  // is_supplier flag (the field label switches between Trade and Specialty).
  const [addKind, setAddKind]     = useState<"sub" | "sup" | null>(null)
  const [firmName, setFirmName]   = useState("")
  const [firmField, setFirmField] = useState("")
  const [addingPerson, setAddingPerson] = useState(false)
  const [pName, setPName]   = useState("")
  const [pEmail, setPEmail] = useState("")
  const [pPhone, setPPhone] = useState("")
  const [pRole, setPRole]   = useState("")
  const [busy, setBusy]     = useState(false)
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

  function resetTransient() {
    setQ(""); setAddKind(null); setFirmName(""); setFirmField("")
    setAddingPerson(false); setPName(""); setPEmail(""); setPPhone(""); setPRole(""); setBusy(false)
  }

  function toggle() {
    if (open) { setOpen(false); return }
    const r = btnRef.current?.getBoundingClientRect()
    if (r) setPos({ top: r.bottom + 4, left: r.left })
    resetTransient()
    // Jump straight to person editing when a firm is already chosen; the back
    // arrow returns to firm selection.
    if (vendorId) { setPendFirmId(vendorId); setStep("person") }
    else          { setPendFirmId(null); setStep("firm") }
    setOpen(true)
  }

  function commit(firmId: string, pid: string | null) {
    onChange({ vendorId: firmId, personId: pid })
    setOpen(false)
  }

  function chooseFirm(firmId: string) {
    resetTransient()
    setPendFirmId(firmId); setStep("person")
  }

  async function submitNewFirm() {
    if (!addKind || !firmName.trim() || busy) return
    setBusy(true)
    const row = await onCreateVendor(firmName.trim(), firmField.trim(), addKind)
    setBusy(false)
    if (row) chooseFirm(row.id)
  }

  async function submitNewPerson() {
    if (!pendFirmId || !pName.trim() || busy) return
    setBusy(true)
    const d = { name: pName.trim(), email: pEmail.trim(), phone: pPhone.trim(), role: pRole.trim() }
    const row = await onCreatePerson(pendFirmId, d)
    setBusy(false)
    if (row) commit(pendFirmId, row.id)
  }

  // ----- closed-button label: "Firm — Person" / "Firm" / placeholder -----
  const firmLabel = vendorId ? vendors.find(v => v.id === vendorId)?.company_name : null
  const personLabel = personId ? people.find(p => p.id === personId)?.name : null
  const label = firmLabel ? (personLabel ? `${firmLabel} — ${personLabel}` : firmLabel) : null
  const hasVendor = !!vendorId

  const ql = q.trim().toLowerCase()
  const firmMatches = vendors.filter(v => !ql || v.company_name.toLowerCase().includes(ql))

  const pendFirm = vendors.find(v => v.id === pendFirmId)
  const peopleForFirm = people
    .filter(p => p.vendor_id === pendFirmId)
    .filter(p => !ql || (p.name ?? "").toLowerCase().includes(ql))

  const fieldCls = "w-full h-7 px-2 rounded border border-[#E2E8F0] text-[12px] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40"

  return (
    <div ref={ref}>
      <button
        ref={btnRef}
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`w-[150px] h-7 px-2 rounded border text-[12px] text-left truncate bg-white transition-colors hover:border-[#7B9BB5]/60 ${open ? "border-[#7B9BB5]" : "border-[#E2E8F0]"} ${label ? "text-[#0F172A]" : "text-[#94A3B8]"}`}
      >
        {label ?? "Set vendor…"}
      </button>
      {open && pos && (
        <div
          // data-nav-yield: the global arrow-key layer stands down while this
          // picker is open, so typing/searching and option movement behave
          // natively instead of being hijacked for row navigation.
          data-nav-yield
          style={{ position: "fixed", top: pos.top, left: pos.left }}
          className="z-50 w-[260px] bg-white border border-[#E2E8F0] rounded-lg shadow-xl"
        >
          {/* ── Step 1: firm ───────────────────────────────────────────── */}
          {step === "firm" && (
            <>
              <div className="p-1.5 border-b border-[#E2E8F0]">
                <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search vendors…" className={fieldCls} />
              </div>
              <div className="max-h-64 overflow-y-auto py-1">
                {hasVendor && (
                  <button onClick={() => { onChange({ vendorId: null, personId: null }); setOpen(false) }}
                    className="w-full text-left px-2.5 py-1.5 text-[12px] text-[#94A3B8] hover:bg-[#F8F9FA]">
                    Clear vendor
                  </button>
                )}
                {firmMatches.map(v => {
                  const sub = v.trade ?? v.specialty ?? null
                  return (
                    <button key={v.id} onClick={() => chooseFirm(v.id)}
                      className={`w-full text-left px-2.5 py-1.5 text-[12px] hover:bg-[#F8F9FA] ${v.id === vendorId ? "text-[#7B9BB5] font-semibold" : "text-[#0F172A]"}`}>
                      {v.company_name}{sub ? <span className="text-[#94A3B8]"> · {sub}</span> : null}
                    </button>
                  )
                })}
                {firmMatches.length === 0 && addKind === null && (
                  <p className="px-2.5 py-1 text-[12px] text-[#94A3B8]">No vendors match.</p>
                )}

                {addKind === null ? (
                  <div className="border-t border-[#E2E8F0] mt-1 pt-1">
                    <button onClick={() => { setAddKind("sub"); setFirmName(q); setFirmField("") }}
                      className="w-full text-left px-2.5 py-1.5 text-[12px] text-[#7B9BB5] hover:bg-[#F8F9FA]">+ Add new subcontractor</button>
                    <button onClick={() => { setAddKind("sup"); setFirmName(q); setFirmField("") }}
                      className="w-full text-left px-2.5 py-1.5 text-[12px] text-[#7B9BB5] hover:bg-[#F8F9FA]">+ Add new supplier</button>
                  </div>
                ) : (
                  <div className="border-t border-[#E2E8F0] mt-1 pt-2 px-2.5 pb-2 space-y-1.5">
                    <p className="text-[10px] font-bold uppercase tracking-wide text-[#94A3B8]">New {addKind === "sub" ? "subcontractor" : "supplier"}</p>
                    <input autoFocus value={firmName} onChange={e => setFirmName(e.target.value)} placeholder="Company name" className={fieldCls} />
                    <input value={firmField} onChange={e => setFirmField(e.target.value)} placeholder={addKind === "sub" ? "Trade (optional)" : "Specialty (optional)"} className={fieldCls} />
                    <div className="flex gap-1.5 pt-0.5">
                      <button disabled={!firmName.trim() || busy} onClick={submitNewFirm}
                        className="flex-1 h-7 rounded bg-[#7B9BB5] text-white text-[12px] font-semibold disabled:opacity-40">{busy ? "Saving…" : "Create"}</button>
                      <button onClick={() => setAddKind(null)} className="px-2 h-7 rounded border border-[#E2E8F0] text-[12px] text-[#64748B]">Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {/* ── Step 2: person ─────────────────────────────────────────── */}
          {step === "person" && (
            <>
              <div className="p-1.5 border-b border-[#E2E8F0] flex items-center gap-1.5">
                <button onClick={() => { resetTransient(); setStep("firm") }} title="Back to vendors"
                  className="h-7 w-7 flex items-center justify-center rounded border border-[#E2E8F0] text-[#64748B] hover:border-[#7B9BB5] flex-shrink-0">←</button>
                <span className="min-w-0 flex-1 text-[12px] font-semibold text-[#0F172A] truncate">{pendFirm?.company_name ?? "Firm"}</span>
                {/* Reachable Clear: opening a set vendor lands here on the person
                    step, so surface the same unset the firm step offers. */}
                {hasVendor && (
                  <button onClick={() => { onChange({ vendorId: null, personId: null }); setOpen(false) }}
                    title="Remove vendor from this submittal"
                    className="flex-shrink-0 h-7 px-2 rounded border border-[#E2E8F0] text-[11px] text-[#94A3B8] hover:border-[#EF4444] hover:text-[#EF4444]">Clear</button>
                )}
              </div>
              <div className="p-1.5 border-b border-[#E2E8F0]">
                <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search people…" className={fieldCls} />
              </div>
              <div className="max-h-60 overflow-y-auto py-1">
                <button onClick={() => pendFirmId && commit(pendFirmId, null)}
                  className="w-full text-left px-2.5 py-1.5 text-[12px] text-[#64748B] hover:bg-[#F8F9FA]">
                  Use firm only (no person)
                </button>
                {peopleForFirm.map(p => (
                  <button key={p.id} onClick={() => pendFirmId && commit(pendFirmId, p.id)}
                    className={`w-full text-left px-2.5 py-1.5 text-[12px] hover:bg-[#F8F9FA] ${p.id === personId ? "text-[#7B9BB5] font-semibold" : "text-[#0F172A]"}`}>
                    {p.name || "(unnamed)"}{p.role ? <span className="text-[#94A3B8]"> · {p.role}</span> : null}
                  </button>
                ))}
                {peopleForFirm.length === 0 && !addingPerson && (
                  <p className="px-2.5 py-1 text-[12px] text-[#94A3B8]">No people yet.</p>
                )}

                {addingPerson ? (
                  <div className="border-t border-[#E2E8F0] mt-1 pt-2 px-2.5 pb-2 space-y-1.5">
                    <p className="text-[10px] font-bold uppercase tracking-wide text-[#94A3B8]">New person</p>
                    <input autoFocus value={pName} onChange={e => setPName(e.target.value)} placeholder="Name" className={fieldCls} />
                    <input value={pEmail} onChange={e => setPEmail(e.target.value)} placeholder="Email (optional)" className={fieldCls} />
                    <input value={pPhone} onChange={e => setPPhone(e.target.value)} placeholder="Phone (optional)" className={fieldCls} />
                    <input value={pRole} onChange={e => setPRole(e.target.value)} placeholder="Role (optional)" className={fieldCls} />
                    <div className="flex gap-1.5 pt-0.5">
                      <button disabled={!pName.trim() || busy} onClick={submitNewPerson}
                        className="flex-1 h-7 rounded bg-[#7B9BB5] text-white text-[12px] font-semibold disabled:opacity-40">{busy ? "Saving…" : "Create"}</button>
                      <button onClick={() => setAddingPerson(false)} className="px-2 h-7 rounded border border-[#E2E8F0] text-[12px] text-[#64748B]">Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div className="border-t border-[#E2E8F0] mt-1 pt-1">
                    <button onClick={() => { setAddingPerson(true); setPName(q); setPEmail(""); setPPhone(""); setPRole("") }}
                      className="w-full text-left px-2.5 py-1.5 text-[12px] text-[#7B9BB5] hover:bg-[#F8F9FA]">+ Add new person</button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
