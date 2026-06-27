"use client"

import { apiFetch } from "@/lib/api-client"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { presignAndUpload } from "@/lib/storage-upload"
import { SUBMITTAL_TYPES, type SubmittalType, type BulkImportAnalysis } from "@/lib/bulk-import-detect"
import type { MatchOutcome, MatchedRow, ScoredCandidate } from "@/lib/bulk-import-match"

// Bulk Import — Stage 2a modal. Drop many signed PDFs (or one — same engine,
// per the design's single-upload-is-batch-of-one decision). Each file is
// uploaded to staging, analyzed read-only, then MATCHED against existing
// spec-book-built rows in the project's submittal log. On user confirm,
// commit attaches the PDF to its matched log row. Model A: never silently
// creates a row.

// Bounded concurrency: process N PDFs at a time so a 50-PDF batch can't OOM
// the function or saturate the user's uplink. Same lesson as the photo
// batch pipeline (DailyModule Add Photos).
const CONCURRENCY = 3

type RowStatus = "queued" | "uploading" | "analyzing" | "matching" | "ready" | "error" | "committing" | "committed"

interface Row {
  id: string
  file: File
  status: RowStatus
  uploadPercent: number
  errorMsg?: string
  storagePath?: string
  analysis?: BulkImportAnalysis
  // User-editable overrides, seeded from the analysis. Empty strings until
  // analysis lands.
  section: string
  type: SubmittalType | ""
  coverSplit: number
  /** yyyy-mm-dd. Pre-filled from the architect's PDF /Stamp annotation
   *  /CreationDate (the architect's signing action). Empty when no
   *  stamp annotation is present on the cover pages — the row flags
   *  for manual entry rather than falling back to the submission date. */
  approvalDate: string
  /** yyyy-mm-dd. Pre-filled from Waters' Text4 ("Date Submitted" on
   *  the coversheet) — the GC's submission date, kept distinct from
   *  approvalDate. Surfaced as a small subtitle under the approval
   *  input + persisted to submittal_attachments.submitted_date on
   *  commit (trigger propagates to submittals.sent_to_ae_date). */
  submittedDate: string
  /** Pre-filled from the coversheet "Submittal No." AcroForm field when
   *  present; user confirms or overrides. */
  submittalNo: string
  reviewStatus: "Approved" | "Approved with Comments" | "Rejected" | "Revise and Resubmit"
  // ── Stage 2a state ──────────────────────────────────────────────────────
  /** Result of /api/bulk-import/match — auto / ambiguous / no-match / error. */
  match?: MatchOutcome
  /** The log row the user resolved this Bulk Import row against. For
   *  auto-match this defaults to outcome.targetRowId; for ambiguous-distinct
   *  the user picks; for no-match the user picks from a fallback dropdown
   *  (or marks as skip).
   *  null = unresolved, blocks commit. */
  pickedTargetRowId?: string | null
  /** When `matchSkip` is true, the row is intentionally excluded from
   *  commit (user chose "skip" on a no-match). The row stays visible but
   *  doesn't block bulk-commit gating. */
  matchSkip?: boolean
  /** Post-commit per-row result. */
  committedRowId?: string
  commitError?: string
  /** True when the commit hit the server-side same-bytes idempotency
   *  guard — the existing attachment row was returned, no new
   *  attachment was created, and the just-copied uploads/ object was
   *  cleaned. The row is in the intended attached state; the modal
   *  shows "Already attached" instead of "Attached to log row" to make
   *  the no-op explicit to the operator. */
  wasDuplicate?: boolean
  // ── Part C: exact-duplicate detection ───────────────────────────────────
  /** SHA-256 of the file bytes (lowercase hex). Computed server-side in
   *  /api/bulk-import/analyze (the buffer is already in memory there for
   *  text extraction). Passed to commit so the RPC stores it on the
   *  attachment row. */
  fileSha256?: string
  /** Result of /api/check-duplicate. When same_project_matches is
   *  non-empty, the row shows an amber "possible duplicate" badge —
   *  user can still commit (e.g. uploading a new revision whose bytes
   *  match the prior one). Never blocks the commit gate. */
  dupeMatch?: {
    same_project_matches: Array<{
      submittal_id: string; file_name: string; submittal_seq: number | null;
      submittal_number: string | null; revision_number: string | null;
    }>
    cross_project_matches: Array<{
      project_id: string | null; project_name: string | null; count: number;
    }>
  }
}

function newRow(file: File): Row {
  return {
    id: crypto.randomUUID(),
    file,
    status: "queued",
    uploadPercent: 0,
    section: "",
    type: "",
    coverSplit: 0,
    approvalDate: "",
    submittedDate: "",
    submittalNo: "",
    reviewStatus: "Approved",
    pickedTargetRowId: null,
    matchSkip: false,
  }
}

/** Decide whether a row is currently READY to commit. PLACEMENT-CRITICAL
 *  fields only — block when something would put the import in the wrong
 *  log row OR no log row at all. Metadata (sub#, approval date, cover
 *  split, review status) does NOT block; the modal still surfaces an
 *  amber cue for missing approval date but the commit gate ignores it.
 *
 *   BLOCKS on:
 *     - row not in "ready" state (still uploading/analyzing/matching/error)
 *     - section empty
 *     - type empty
 *     - match unresolved: no `match` yet, OR
 *       no-match with no fallback pick, OR
 *       ambiguous-distinct with no pick, OR
 *       match errored
 *   Does NOT block on:
 *     - approvalDate (metadata; amber cue stays on the input)
 *     - submittalNo  (metadata, GC-side label — not a join key)
 *     - coverSplit   (Library copy is Stage 2b, doesn't ship yet)
 *     - reviewStatus (always defaults to "Approved")
 *     - multi-section presence per se — the section input must be
 *       non-empty, but the analyzePdf pre-fill already populates it
 *       with the primary; if the user wants a sibling they edit it.
 *       Either way the section-empty rule above gates correctly.
 */
function commitReadiness(r: Row): "ready" | "blocked" | "skip" | "done" | "in-flight" {
  if (r.status === "committed" || r.committedRowId) return "done"
  if (r.status === "committing") return "in-flight"
  if (r.matchSkip) return "skip"
  if (r.status !== "ready") return "blocked"
  if (!r.section.trim() || !r.type) return "blocked"
  if (!r.match) return "blocked"  // match call still pending
  if (r.match.kind === "no-match") {
    return r.pickedTargetRowId ? "ready" : "blocked"
  }
  if (r.match.kind === "ambiguous-distinct") {
    return r.pickedTargetRowId ? "ready" : "blocked"
  }
  if (r.match.kind === "auto-match") {
    return "ready"
  }
  // error
  return "blocked"
}

function effectiveTargetRowId(r: Row): string | null {
  if (!r.match) return null
  if (r.match.kind === "auto-match") return r.pickedTargetRowId ?? r.match.targetRowId
  if (r.match.kind === "ambiguous-distinct") return r.pickedTargetRowId ?? null
  if (r.match.kind === "no-match") return r.pickedTargetRowId ?? null
  return null
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={`${className} animate-spin`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" strokeWidth="3" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  )
}

function FlagIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
    </svg>
  )
}

export default function BulkImportModal({
  projectId,
  onClose,
}: {
  projectId: string
  onClose: () => void
}) {
  const [rows, setRows] = useState<Row[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  // Top-level error banner — captures anything that escapes a worker's own
  // catch so the UI never sits silently empty. The runner also writes
  // per-row errors via updateRow(..., { status: "error" }).
  const [globalError, setGlobalError] = useState<string | null>(null)

  // Single-runner guard. Multiple concurrent worker pools would race the
  // same row ids; prevent another runBatch() while one is already in
  // flight (e.g. user adds files mid-run).
  const runningRef = useRef(false)

  // ── Always-fresh row snapshot ────────────────────────────────────────────
  // Earlier this component used the setRows(prev => { read = prev.find(...);
  // return prev }) pattern to read state inside async callbacks. That broke
  // in production because React 18 can bail out of a setState whose updater
  // returns the same reference — meaning the snapshot side-effect never ran
  // and the worker silently did nothing. rowsRef is assigned on every render
  // and read directly inside the workers, so the snapshot is always live.
  const rowsRef = useRef<Row[]>([])
  rowsRef.current = rows

  function updateRow(id: string, patch: Partial<Row>) {
    setRows(prev => prev.map(r => r.id === id ? { ...r, ...patch } : r))
  }

  // ── Fallback log-row picker for no-match cases ──────────────────────────
  // Lazily loaded on first open; cached in state so opening the picker for
  // multiple rows doesn't re-query.
  const [logRows, setLogRows] = useState<MatchedRow[] | null>(null)
  const [logRowsLoading, setLogRowsLoading] = useState(false)
  const [logRowsError, setLogRowsError] = useState<string | null>(null)
  const [pickerForRowId, setPickerForRowId] = useState<string | null>(null)
  const [pickerQuery, setPickerQuery] = useState("")

  async function ensureLogRowsLoaded() {
    if (logRows !== null || logRowsLoading) return
    setLogRowsLoading(true)
    setLogRowsError(null)
    try {
      const res = await apiFetch(`/api/bulk-import/log-rows?project_id=${encodeURIComponent(projectId)}&limit=500`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error ?? `Failed (HTTP ${res.status})`)
      setLogRows(Array.isArray(data?.rows) ? data.rows : [])
    } catch (e) {
      setLogRowsError(e instanceof Error ? e.message : "Failed to load log rows")
    } finally {
      setLogRowsLoading(false)
    }
  }

  function openLogRowPicker(rowId: string) {
    setPickerForRowId(rowId)
    setPickerQuery("")
    ensureLogRowsLoaded().catch(() => {})
  }
  function closeLogRowPicker() {
    setPickerForRowId(null)
    setPickerQuery("")
  }

  // ── Match a single row's analysis against the spec book ─────────────────
  // Called after analyze lands. Single API call per row, no AI, no loops.
  //
  // The `fresh` parameter is how `processRow` passes the just-analyzed
  // values directly, bypassing `rowsRef`. Reason: `processRow` calls
  // `updateRow(id, {analysis, section, type, ...})` then SYNCHRONOUSLY
  // calls `matchRow(id)` — but `rowsRef.current = rows` only re-aims on
  // render, so right after the queued setRows the ref still points at the
  // pre-update array. `row.analysis` is undefined there, so the original
  // code's `if (!row.analysis) return` early-exited silently and the row
  // ended up in `status: "ready"` with `match: undefined` — looked
  // complete in the UI, blocked commit via the `!r.match` gate.
  //
  // Same shape of race that bit `processRow` earlier (the rowsRef pattern
  // in commit 620e81e). Audited the modal for other instances; the
  // remaining rowsRef reads are either (a) read-then-await-then-render
  // (runBatch, doCommit) or (b) post-debounce (scheduleRematch's 400ms),
  // both of which are safe.
  //
  // Debounced re-matches from scheduleRematch keep calling matchRow(id)
  // without `fresh` — they're safe because by 400ms React has rendered.
  const matchRow = useCallback(async (
    id: string,
    fresh?: { section: string; type: SubmittalType | ""; description: string | null },
  ) => {
    const row = rowsRef.current.find(r => r.id === id)
    if (!row) return
    const section     = fresh?.section     ?? row.section
    const type        = fresh?.type        ?? row.type
    const description = fresh?.description ?? row.analysis?.coverFields?.specSectionTitle ?? null
    updateRow(id, { status: "matching" })
    try {
      const res = await apiFetch("/api/bulk-import/match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: projectId,
          rows: [{
            client_row_id: id,
            section: section || null,
            submittal_type: type || null,
            description,
          }],
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error ?? `Match failed (HTTP ${res.status})`)
      const outcome = data?.results?.[0]?.outcome as MatchOutcome | undefined
      if (!outcome) throw new Error("Match returned no outcome")
      // Auto-confirm the picked target for auto-match. Ambiguous-distinct
      // defaults to the highest-fuzzy candidate but stays "unconfirmed"
      // until the user clicks — we don't silently choose.
      updateRow(id, {
        status: "ready",
        match: outcome,
        pickedTargetRowId:
          outcome.kind === "auto-match" ? outcome.targetRowId : null,
      })
    } catch (err) {
      console.error("[bulk-import] matchRow failed for", row.file.name, err)
      updateRow(id, {
        status: "ready",  // match failure doesn't kill the analyze result
        match: { kind: "error", message: err instanceof Error ? err.message : "match failed" },
      })
    }
  }, [projectId])

  const processRow = useCallback(async (id: string) => {
    const row = rowsRef.current.find(r => r.id === id)
    if (!row) {
      // Defensive: a removeRow could race this. Nothing to do.
      return
    }
    if (row.status !== "queued") {
      // Already past queued — another worker pass picked it up.
      return
    }

    try {
      updateRow(id, { status: "uploading", uploadPercent: 0 })
      const { path } = await presignAndUpload(
        "submittals",
        "bulk-import-staging",
        row.file,
        (p) => updateRow(id, { uploadPercent: p.percent }),
      )
      updateRow(id, { storagePath: path, status: "analyzing", uploadPercent: 100 })

      const res = await apiFetch("/api/bulk-import/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storage_path: path, file_name: row.file.name }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data?.error ?? `Analyze failed (HTTP ${res.status})`)
      }

      const analysis = data?.analysis as BulkImportAnalysis | undefined
      if (!analysis || typeof analysis.cover?.coverSplit !== "number") {
        // Belt-and-braces: a 200 OK whose body lacks the expected shape
        // (e.g. an auth-redirect HTML page that snuck through). Don't crash
        // — surface a real error on the row.
        throw new Error("Analyze returned no analysis payload")
      }

      const seedSection = analysis.suggestedSection ?? ""
      const seedType    = (analysis.suggestedType ?? "") as SubmittalType | ""
      const seedSubmittalNo = analysis.suggestedSubmittalNo ?? ""
      // Sub# cosmetic fix — Waters revision files store an "-R1"-suffixed
      // value in the form's Text5 widget (e.g. "30-R" / "032-" appears in
      // the UI because the AcroForm's display width clips the value mid-
      // suffix). The filename always carries the clean GC submittal #
      // ("_Sub_No_032_" or "_Sub_No_032-R1_") — prefer the filename pattern
      // when present. Doesn't affect matching (sub# is metadata, not a
      // join key) — purely cosmetic.
      const filenameSubNo = row.file.name.match(/_Sub_No_(\d{2,4})(?:-R\d+)?/i)?.[1]
      const finalSubmittalNo = filenameSubNo ?? seedSubmittalNo

      // file_sha256 comes back from /analyze (server-side hash of the
      // staged buffer). Kick a non-fatal dupe-check in parallel — the row
      // continues without dupeMatch if the check fails.
      const fileSha256 = typeof data?.file_sha256 === "string" ? data.file_sha256 : undefined
      updateRow(id, {
        status: "ready",
        analysis,
        section: seedSection,
        type: seedType,
        coverSplit: analysis.cover.coverSplit,
        // approvalDate = architect stamp /CreationDate (NEVER Text4).
        // Empty when no stamp found — row flags amber for manual entry.
        approvalDate:  analysis.suggestedApprovalDate ?? "",
        // submittedDate = Text4 (GC's submission). Separate so it never
        // gets confused with the architect's approval date.
        submittedDate: analysis.suggestedSubmittedDate ?? "",
        submittalNo: finalSubmittalNo,
        fileSha256,
      })
      if (fileSha256) {
        void (async () => {
          try {
            const dRes = await apiFetch("/api/check-duplicate", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sha256: fileSha256, project_id: projectId }),
            })
            if (dRes.ok) updateRow(id, { dupeMatch: await dRes.json() })
          } catch (err) {
            console.warn(`[bulk-import] dupe-check failed for ${row.file.name}`, err)
          }
        })()
      }
      // Chain into match. Pass the freshly-analyzed values directly so we
      // don't race the queued setRows above (rowsRef hasn't repointed yet).
      matchRow(id, {
        section: seedSection,
        type: seedType,
        description: analysis.coverFields?.specSectionTitle ?? null,
      }).catch(err => {
        console.error("[bulk-import] matchRow threw", err)
      })
    } catch (err) {
      console.error("[bulk-import] processRow failed for", row.file.name, err)
      updateRow(id, {
        status: "error",
        errorMsg: err instanceof Error ? err.message : "Unknown error",
      })
    }
  }, [matchRow])

  // Drain queued rows in batches of CONCURRENCY. Re-reads the live ref each
  // pass so files added mid-run get picked up automatically without
  // requiring a second kickoff.
  const runBatch = useCallback(async () => {
    if (runningRef.current) return
    runningRef.current = true
    try {
      while (true) {
        const queuedIds = rowsRef.current
          .filter(r => r.status === "queued")
          .map(r => r.id)
        if (queuedIds.length === 0) break

        const batch = queuedIds.slice(0, CONCURRENCY)
        // Each processRow has its own try/catch; the .catch here is a
        // belt-and-braces backstop so a programmer error inside processRow
        // can't escape to the modal and leave rows stranded.
        await Promise.all(batch.map(id => processRow(id).catch(err => {
          console.error("[bulk-import] processRow threw unexpectedly", err)
          updateRow(id, {
            status: "error",
            errorMsg: err instanceof Error ? err.message : "Worker crashed",
          })
        })))
      }
    } catch (err) {
      console.error("[bulk-import] runBatch threw", err)
      setGlobalError(err instanceof Error ? err.message : "Batch processing failed")
    } finally {
      runningRef.current = false
    }
  }, [processRow])

  // Drive the runner from a useEffect that watches the rows array. Every
  // time a new row lands in "queued" (or a previous worker finishes), the
  // effect fires and runBatch is invoked. The runningRef inside runBatch
  // short-circuits redundant kickoffs so this never duplicates work.
  // Replacing the previous `setTimeout(() => runBatch(), 0)` which could
  // be skipped by a backgrounded tab or a thrown render-time callback.
  useEffect(() => {
    const hasQueued = rows.some(r => r.status === "queued")
    if (!hasQueued) return
    if (runningRef.current) return
    runBatch().catch(err => {
      console.error("[bulk-import] runBatch threw from effect", err)
      setGlobalError(err instanceof Error ? err.message : "Batch processing failed")
    })
  }, [rows, runBatch])

  function addFiles(files: FileList | File[]) {
    const incoming = Array.from(files).filter(f => f.type === "application/pdf" || /\.pdf$/i.test(f.name))
    if (incoming.length === 0) return
    setGlobalError(null)
    setRows(prev => [...prev, ...incoming.map(newRow)])
    // The useEffect on `rows` picks this up and kicks runBatch — no
    // setTimeout fragility.
  }

  function onPickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    if (!files || files.length === 0) return
    addFiles(files)
    e.currentTarget.value = ""  // allow re-pick of same file
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files)
  }

  function removeRow(id: string) {
    setRows(prev => prev.filter(r => r.id !== id))
  }

  // ── Commit (Stage 2a) — bulk write of resolved rows to the log ──────────
  // Sends every resolved row to /api/bulk-import/commit in one call. The
  // server processes per-row and returns a status array; we apply per-row
  // updates on response. No retry loops — the user can re-click commit on
  // any failed rows.
  const [committing, setCommitting] = useState(false)
  const [commitSummary, setCommitSummary] = useState<{ ok: number; err: number } | null>(null)

  const doCommit = useCallback(async () => {
    if (committing) return
    const toCommit = rowsRef.current.filter(r => commitReadiness(r) === "ready")
    if (toCommit.length === 0) return
    setCommitting(true)
    setCommitSummary(null)
    // Mark each row as committing for visual state.
    setRows(prev => prev.map(r => commitReadiness(r) === "ready" ? { ...r, status: "committing" } : r))
    try {
      const payload = {
        project_id: projectId,
        rows: toCommit.map(r => ({
          client_row_id: r.id,
          target_row_id: effectiveTargetRowId(r),
          staging_path: r.storagePath,
          file_name: r.file.name,
          file_size: r.file.size,
          approval_date:  r.approvalDate  || null,
          submitted_date: r.submittedDate || null,
          submittal_number: r.submittalNo || null,
          revision_number: null,
          review_status: r.reviewStatus,
          file_sha256: r.fileSha256 ?? null,
        })),
      }
      const res = await apiFetch("/api/bulk-import/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error ?? `Commit failed (HTTP ${res.status})`)
      const results: Array<{
        client_row_id: string; status: "ok" | "error";
        row_id?: string; error?: string; was_duplicate?: boolean;
      }> = Array.isArray(data?.results) ? data.results : []
      let ok = 0, err = 0
      setRows(prev => prev.map(r => {
        const result = results.find(x => x.client_row_id === r.id)
        if (!result) return r.status === "committing" ? { ...r, status: "ready" } : r  // server skipped — restore
        if (result.status === "ok") {
          ok++
          return {
            ...r,
            status: "committed",
            committedRowId: result.row_id,
            commitError: undefined,
            wasDuplicate: result.was_duplicate === true,
          }
        } else {
          err++
          return { ...r, status: "ready", commitError: result.error ?? "Commit failed" }
        }
      }))
      setCommitSummary({ ok, err })
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Commit failed"
      setGlobalError(msg)
      // Roll committing rows back to ready so the user can retry.
      setRows(prev => prev.map(r => r.status === "committing" ? { ...r, status: "ready", commitError: msg } : r))
    } finally {
      setCommitting(false)
    }
  }, [projectId, committing])

  // Aggregates for the footer summary + commit gating.
  const totals = useMemo(() => {
    const total = rows.length
    const ready = rows.filter(r => r.status === "ready").length
    const errored = rows.filter(r => r.status === "error").length
    const inFlight = rows.filter(r => r.status === "uploading" || r.status === "analyzing" || r.status === "matching").length
    const flagged = rows.filter(r => r.status === "ready" && r.analysis?.needsAttention).length
    const missingDate = rows.filter(r => r.status === "ready" && !r.approvalDate).length
    const missingSection = rows.filter(r => r.status === "ready" && !r.section).length
    const missingType = rows.filter(r => r.status === "ready" && !r.type).length
    const commitReady   = rows.filter(r => commitReadiness(r) === "ready").length
    const commitBlocked = rows.filter(r => commitReadiness(r) === "blocked").length
    const commitDone    = rows.filter(r => commitReadiness(r) === "done").length
    const commitSkip    = rows.filter(r => commitReadiness(r) === "skip").length
    return { total, ready, errored, inFlight, flagged, missingDate, missingSection, missingType, commitReady, commitBlocked, commitDone, commitSkip }
  }, [rows])

  // When the user edits section or type after a match has resolved, the
  // stored match is stale. Re-run match for that row. Debounced via a
  // single setTimeout per row, cleared on subsequent edits.
  const reMatchTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  function scheduleRematch(id: string) {
    if (reMatchTimers.current[id]) clearTimeout(reMatchTimers.current[id])
    reMatchTimers.current[id] = setTimeout(() => { matchRow(id).catch(() => {}) }, 400)
  }

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-stretch sm:items-center justify-center"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-white sm:rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[min(96vw,1200px)] sm:max-h-[92vh] flex flex-col">

        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-[#E2E8F0]">
          <div>
            <h2 className="text-[16px] font-bold text-[#0F172A] leading-tight">Bulk Import — Approved Submittals</h2>
            <p className="text-[12px] text-[#64748B] mt-0.5">
              Drop signed submittal PDFs. Each row matches against an existing spec-book log row, then commits on confirm. Resolve any flagged rows before committing — the section drives log placement.
            </p>
          </div>
          <button onClick={onClose} className="text-[#64748B] hover:text-[#0F172A] flex-shrink-0" aria-label="Close">
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto px-5 py-4 space-y-4">

          {globalError && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 flex items-start gap-2">
              <FlagIcon className="h-4 w-4 text-red-600 flex-shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <p className="text-[12px] font-semibold text-red-700">Batch processing hit a snag.</p>
                <p className="text-[11px] text-red-600 mt-0.5 break-words">{globalError}</p>
              </div>
              <button onClick={() => setGlobalError(null)} className="text-red-600 hover:text-red-800 flex-shrink-0" aria-label="Dismiss">
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
          )}

          {/* Drop / pick zone */}
          <div
            onDragOver={e => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            className={`rounded-lg border-2 border-dashed p-6 text-center transition-colors ${dragOver ? "border-[#7B9BB5] bg-[#7B9BB5]/[0.06]" : "border-[#E2E8F0] bg-[#F8F9FA]"}`}
          >
            <p className="text-[13px] text-[#0F172A] font-medium">Drop signed submittal PDFs here</p>
            <p className="text-[11px] text-[#64748B] mt-1">or</p>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="mt-2 h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors"
            >
              Choose PDFs
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,.pdf"
              multiple
              onChange={onPickFiles}
              className="hidden"
            />
            <p className="text-[11px] text-[#64748B] mt-2">Single PDF works too — runs through the same review.</p>
          </div>

          {/* Review table */}
          {rows.length > 0 && (
            <div className="rounded-lg border border-[#E2E8F0] overflow-x-auto">
              <table className="w-full text-[12px] border-collapse">
                <thead className="bg-[#F8F9FA]">
                  <tr className="text-left text-[10px] font-bold text-[#64748B] uppercase tracking-wider">
                    <th className="px-3 py-2 w-[24%]">File</th>
                    <th className="px-3 py-2 w-[13%]">Spec section</th>
                    <th className="px-3 py-2 w-[13%]">Type</th>
                    <th className="px-3 py-2 w-[8%]">Sub #</th>
                    <th className="px-3 py-2 w-[10%]">Cover split</th>
                    <th className="px-3 py-2 w-[12%]">Approval date</th>
                    <th className="px-3 py-2 w-[14%]">Status</th>
                    <th className="px-3 py-2 w-[6%]"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => {
                    const flagged = r.status === "ready" && (r.analysis?.needsAttention || !r.section || !r.type || !r.approvalDate)
                    return (
                    <tr key={r.id} className={`border-t border-[#E2E8F0] ${flagged ? "bg-amber-50/50" : ""}`}>
                      {/* File + status */}
                      <td className="px-3 py-2 align-top">
                        <div className="flex items-start gap-2">
                          <div className="min-w-0">
                            <p className="text-[#0F172A] truncate font-medium" title={r.file.name}>{r.file.name}</p>
                            <p className="text-[10px] text-[#64748B] mt-0.5">
                              {fmtBytes(r.file.size)}
                              {r.analysis ? ` · ${r.analysis.pageCount} pages` : ""}
                              {/* Template-agnostic section-source label —
                                  describes the tier the extractor picked,
                                  not which coversheet vendor it matched.
                                  Detected template (waters / bam-thp) is
                                  informational, shown after the tier when
                                  known. */}
                              {r.analysis?.sectionSource === "form" && " · section from coversheet form"}
                              {r.analysis?.sectionSource === "page" && " · section from coversheet text"}
                              {r.analysis?.sectionSource === "filename" && " · section from filename"}
                              {r.analysis?.coverTemplate === "waters"  && r.analysis.sectionSource !== "none"  && " (Waters coversheet)"}
                              {r.analysis?.coverTemplate === "bam-thp" && r.analysis.sectionSource !== "none"  && " (BAM/THP coversheet)"}
                            </p>
                            {(() => {
                              const cf = r.analysis?.coverFields
                              if (!cf) return null
                              const parts = [
                                cf.submitter   ? `from ${cf.submitter}`  : null,
                                cf.projectName ? cf.projectName          : null,
                                cf.specSectionTitle ? cf.specSectionTitle : null,
                              ].filter(Boolean) as string[]
                              if (parts.length === 0) return null
                              return (
                                <p className="text-[10px] text-[#475569] mt-0.5 truncate" title={parts.join(" · ")}>
                                  {parts.join(" · ")}
                                </p>
                              )
                            })()}
                            {r.status === "uploading" && (
                              <p className="text-[10px] text-[#64748B] mt-1 flex items-center gap-1">
                                <Spinner className="h-3 w-3" /> Uploading… {r.uploadPercent}%
                              </p>
                            )}
                            {r.status === "analyzing" && (
                              <p className="text-[10px] text-[#64748B] mt-1 flex items-center gap-1">
                                <Spinner className="h-3 w-3" /> Reading PDF…
                              </p>
                            )}
                            {r.status === "error" && (
                              <p className="text-[11px] font-semibold text-red-700 mt-1 flex items-start gap-1 break-words">
                                <FlagIcon className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                                <span className="min-w-0 flex-1">{r.errorMsg ?? "Failed — see browser console"}</span>
                              </p>
                            )}
                            {r.status === "ready" && r.analysis?.notes && r.analysis.notes.length > 0 && (
                              <ul className="mt-1 space-y-0.5">
                                {r.analysis.notes.map((n, i) => (
                                  <li key={i} className="text-[10px] text-amber-700 flex items-start gap-1">
                                    <FlagIcon className="h-3 w-3 flex-shrink-0 mt-0.5" />
                                    <span>{n}</span>
                                  </li>
                                ))}
                              </ul>
                            )}
                            {r.dupeMatch && r.dupeMatch.same_project_matches.length > 0 && (
                              <p
                                className="text-[10px] text-amber-700 flex items-start gap-1 mt-1"
                                title={`Same bytes as: ${r.dupeMatch.same_project_matches.map(m =>
                                  (m.submittal_seq != null ? `Sub ${m.submittal_seq}` : m.file_name) +
                                  (m.revision_number ? ` (${m.revision_number})` : "")
                                ).join(", ")}. You can still commit — nothing is auto-blocked.`}
                              >
                                <FlagIcon className="h-3 w-3 flex-shrink-0 mt-0.5" />
                                <span>
                                  ⚠ Possible duplicate — same bytes as{" "}
                                  {r.dupeMatch.same_project_matches.slice(0, 2).map((m, i) => (
                                    <span key={m.submittal_id} className="font-semibold">
                                      {i > 0 ? ", " : ""}
                                      {m.submittal_seq != null ? `Sub ${m.submittal_seq}` : m.file_name}
                                      {m.revision_number ? ` (${m.revision_number})` : ""}
                                    </span>
                                  ))}
                                  {r.dupeMatch.same_project_matches.length > 2 ? ` +${r.dupeMatch.same_project_matches.length - 2} more` : ""}
                                </span>
                              </p>
                            )}
                            {r.dupeMatch && r.dupeMatch.cross_project_matches.length > 0 && (
                              <p className="text-[10px] text-[#64748B] italic mt-0.5 truncate">
                                Also on{" "}
                                {r.dupeMatch.cross_project_matches.length === 1
                                  ? (r.dupeMatch.cross_project_matches[0].project_name ?? "another project")
                                  : `${r.dupeMatch.cross_project_matches.length} other projects`}
                              </p>
                            )}
                            {/* Match outcome strip */}
                            {r.status === "matching" && (
                              <p className="text-[10px] text-[#64748B] mt-1 flex items-center gap-1">
                                <Spinner className="h-3 w-3" /> Matching to log…
                              </p>
                            )}
                            {r.status === "committing" && (
                              <p className="text-[10px] text-[#64748B] mt-1 flex items-center gap-1">
                                <Spinner className="h-3 w-3" /> Committing…
                              </p>
                            )}
                            {r.status === "committed" && !r.wasDuplicate && (
                              <p className="text-[10px] text-emerald-700 mt-1 font-semibold">
                                ✓ Attached to log row
                              </p>
                            )}
                            {r.status === "committed" && r.wasDuplicate && (
                              <p
                                className="text-[10px] text-[#475569] mt-1 font-semibold flex items-center gap-1"
                                title="The same file was already attached to this submittal — no new attachment was created. Server-side idempotency guard caught the re-commit."
                              >
                                ↺ Already attached (no-op)
                              </p>
                            )}
                            {r.commitError && r.status !== "committed" && (
                              <p className="text-[10px] text-red-700 mt-1 break-words">
                                Commit failed: {r.commitError}
                              </p>
                            )}
                            {r.status === "ready" && r.match?.kind === "auto-match" && (
                              <p className="text-[10px] text-emerald-700 mt-1 truncate" title={[r.match.target.csi_section, r.match.target.submittal_type, r.match.target.material_name].filter(Boolean).join(" · ")}>
                                ✓ Auto-match: {r.match.target.csi_section} {r.match.target.submittal_type}
                                {r.match.target.material_name && ` — ${r.match.target.material_name}`}
                                {r.match.duplicateCount && r.match.duplicateCount > 1 && (
                                  <span className="text-[#64748B]"> (collapsed {r.match.duplicateCount} spec-book duplicates)</span>
                                )}
                              </p>
                            )}
                            {r.status === "ready" && r.match?.kind === "ambiguous-distinct" && (
                              <div className="mt-1">
                                <p className="text-[10px] text-amber-700 font-semibold">⚠ {r.match.candidates.length} candidates — pick one to commit:</p>
                                <select
                                  value={r.pickedTargetRowId ?? ""}
                                  onChange={e => updateRow(r.id, { pickedTargetRowId: e.target.value || null })}
                                  className="mt-0.5 w-full h-7 px-1.5 rounded border border-amber-400 bg-amber-50 text-[11px]"
                                >
                                  <option value="">— pick a log row —</option>
                                  {(r.match.candidates as ScoredCandidate[]).map(c => (
                                    <option key={c.id} value={c.id}>
                                      {c.csi_section} {c.submittal_type} — {c.material_name ?? "(no name)"} (seq {c.submittal_seq ?? "?"})
                                    </option>
                                  ))}
                                </select>
                              </div>
                            )}
                            {r.status === "ready" && r.match?.kind === "no-match" && !r.matchSkip && (
                              <div className="mt-1 rounded border border-amber-300 bg-amber-50/80 px-2 py-1.5">
                                <p className="text-[10px] text-amber-900 font-semibold flex items-start gap-1">
                                  <FlagIcon className="h-3 w-3 flex-shrink-0 mt-0.5 text-amber-700" />
                                  <span>Needs routing — section {r.section || "?"} isn&apos;t in this project&apos;s spec book.</span>
                                </p>
                                {!r.pickedTargetRowId ? (
                                  <>
                                    <p className="text-[10px] text-amber-800 mt-0.5 ml-4">
                                      Pick a log row to file this under, or skip the file. (Not an error — it just doesn&apos;t auto-place.)
                                    </p>
                                    <div className="flex items-center gap-2 mt-1 ml-4">
                                      <button
                                        onClick={() => openLogRowPicker(r.id)}
                                        className="h-6 px-2 rounded bg-[#7B9BB5] text-white hover:bg-[#6A8AA4] text-[10px] font-semibold"
                                      >Pick a log row</button>
                                      <button
                                        onClick={() => updateRow(r.id, { matchSkip: true })}
                                        className="h-6 px-2 rounded border border-[#E2E8F0] text-[#64748B] hover:bg-white text-[10px]"
                                      >Skip this file</button>
                                    </div>
                                  </>
                                ) : (
                                  <p className="text-[10px] text-[#475569] mt-0.5 ml-4">
                                    Routed to log row {r.pickedTargetRowId.slice(0,8)}…
                                    <button onClick={() => updateRow(r.id, { pickedTargetRowId: null })} className="ml-2 underline text-[#7B9BB5]">change</button>
                                  </p>
                                )}
                              </div>
                            )}
                            {r.status === "ready" && r.matchSkip && (
                              <p className="text-[10px] text-[#64748B] mt-1 italic">
                                Skipped — won't commit.
                                <button onClick={() => updateRow(r.id, { matchSkip: false })} className="ml-2 underline text-[#7B9BB5] not-italic">undo</button>
                              </p>
                            )}
                            {r.status === "ready" && r.match?.kind === "error" && (
                              <p className="text-[10px] text-red-700 mt-1">
                                Match failed: {r.match.message}
                                <button onClick={() => matchRow(r.id)} className="ml-2 underline text-[#7B9BB5]">retry</button>
                              </p>
                            )}
                          </div>
                        </div>
                      </td>

                      {/* Spec section — editable. Edits trigger re-match. */}
                      <td className="px-3 py-2 align-top">
                        <input
                          type="text"
                          value={r.section}
                          onChange={e => { updateRow(r.id, { section: e.target.value, pickedTargetRowId: null }); scheduleRematch(r.id) }}
                          placeholder={r.status === "ready" ? "XX YY ZZ" : "…"}
                          disabled={r.status !== "ready"}
                          className={`w-full h-7 px-2 rounded border text-[12px] tabular-nums ${
                            flagged && r.analysis?.sectionFlag
                              ? "border-amber-400 bg-amber-50"
                              : "border-[#E2E8F0]"
                          } disabled:opacity-50`}
                        />
                        {r.analysis?.suggestedSectionDivision && (
                          <p className="text-[10px] text-[#64748B] mt-0.5 truncate" title={r.analysis.suggestedSectionDivision}>
                            {r.analysis.suggestedSectionDivision}
                          </p>
                        )}
                      </td>

                      {/* Submittal type — fixed-vocab dropdown. Edits trigger re-match. */}
                      <td className="px-3 py-2 align-top">
                        <select
                          value={r.type}
                          onChange={e => { updateRow(r.id, { type: e.target.value as SubmittalType | "", pickedTargetRowId: null }); scheduleRematch(r.id) }}
                          disabled={r.status !== "ready"}
                          className={`w-full h-7 px-1.5 rounded border text-[12px] ${
                            flagged && r.analysis?.typeFlag
                              ? "border-amber-400 bg-amber-50"
                              : "border-[#E2E8F0]"
                          } disabled:opacity-50`}
                        >
                          <option value="">— pick —</option>
                          {SUBMITTAL_TYPES.map(t => (
                            <option key={t} value={t}>{t}</option>
                          ))}
                        </select>
                      </td>

                      {/* Submittal number — pre-filled from coversheet form.
                          Subtle dashed-border + italic placeholder hint when
                          the value was guessed positionally (e.g. THP's
                          unlabeled Text1..Text10 form fields), so the user
                          knows to verify. */}
                      <td className="px-3 py-2 align-top">
                        {(() => {
                          const guessed = r.status === "ready"
                            && !!r.submittalNo
                            && r.analysis?.coverFieldsConfidence.submittalNo === "positional"
                          return <>
                            <input
                              type="text"
                              value={r.submittalNo}
                              onChange={e => updateRow(r.id, { submittalNo: e.target.value })}
                              placeholder={r.status === "ready" ? "—" : ""}
                              disabled={r.status !== "ready"}
                              title={guessed ? "Guessed from the coversheet form by widget position — verify before commit" : undefined}
                              className={`w-full h-7 px-2 rounded text-[12px] tabular-nums disabled:opacity-50 ${
                                guessed
                                  ? "border border-dashed border-amber-400 bg-amber-50 italic"
                                  : "border border-[#E2E8F0]"
                              }`}
                            />
                            {guessed && (
                              <p className="text-[9px] text-amber-700 mt-0.5 leading-tight">guess · verify</p>
                            )}
                          </>
                        })()}
                      </td>

                      {/* Coversheet split — number input */}
                      <td className="px-3 py-2 align-top">
                        <div className="flex items-center gap-1">
                          <input
                            type="number"
                            min={0}
                            max={r.analysis?.pageCount ?? 9999}
                            value={r.coverSplit}
                            onChange={e => updateRow(r.id, { coverSplit: Math.max(0, parseInt(e.target.value || "0", 10)) })}
                            disabled={r.status !== "ready"}
                            className={`w-14 h-7 px-2 rounded border text-[12px] tabular-nums ${
                              flagged && r.analysis?.cover.uncertain
                                ? "border-amber-400 bg-amber-50"
                                : "border-[#E2E8F0]"
                            } disabled:opacity-50`}
                          />
                          <span className="text-[10px] text-[#64748B] whitespace-nowrap">
                            of {r.analysis?.pageCount ?? "?"}
                          </span>
                        </div>
                      </td>

                      {/* Approval date — architect stamp /CreationDate.
                          Empty (amber) when no stamp found on the PDF —
                          NEVER falls back to the GC's submission date.
                          The Text4 "Date Submitted" surfaces as a small
                          subtitle below the input so the user can see
                          when the GC sent the package without confusing
                          it with the architect's approval. */}
                      <td className="px-3 py-2 align-top">
                        {(() => {
                          const missing = r.status === "ready" && !r.approvalDate
                          const stamp = r.analysis?.approvalStamp ?? null
                          return <>
                            <input
                              type="date"
                              value={r.approvalDate}
                              onChange={e => updateRow(r.id, { approvalDate: e.target.value })}
                              disabled={r.status !== "ready"}
                              title={stamp ? `From architect stamp /CreationDate — ${stamp.author ?? "unknown author"}, page ${stamp.page}` : undefined}
                              className={`w-full h-7 px-2 rounded text-[12px] disabled:opacity-50 ${
                                missing
                                  ? "border border-amber-400 bg-amber-50"
                                  : "border border-[#E2E8F0]"
                              }`}
                            />
                            {r.submittedDate && (
                              <p className="text-[9px] text-[#94A3B8] mt-0.5 leading-tight" title="GC's submission date (Text4) — not the architect approval">
                                GC submitted {r.submittedDate}
                              </p>
                            )}
                            {missing && (
                              <p className="text-[9px] text-amber-700 mt-0.5 leading-tight">no stamp · enter manually</p>
                            )}
                            {stamp && (
                              <p className="text-[9px] text-emerald-700 mt-0.5 leading-tight" title={stamp.stampName ?? undefined}>
                                stamp: {stamp.author ?? "unknown"}
                              </p>
                            )}
                          </>
                        })()}
                      </td>

                      {/* Approval status — default Approved */}
                      <td className="px-3 py-2 align-top">
                        <select
                          value={r.reviewStatus}
                          onChange={e => updateRow(r.id, { reviewStatus: e.target.value as Row["reviewStatus"] })}
                          disabled={r.status !== "ready"}
                          className="w-full h-7 px-1.5 rounded border border-[#E2E8F0] text-[12px] disabled:opacity-50"
                        >
                          <option>Approved</option>
                          <option>Approved with Comments</option>
                          <option>Rejected</option>
                          <option>Revise and Resubmit</option>
                        </select>
                      </td>

                      {/* Per-row actions */}
                      <td className="px-3 py-2 align-top text-right">
                        <button
                          onClick={() => removeRow(r.id)}
                          title="Remove from review"
                          className="text-[#64748B] hover:text-red-600 transition-colors"
                        >
                          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </td>
                    </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Footer — Stage 2a commit. Disabled until every row is either
            ready (resolved match + section + type + date) or skipped. */}
        <div className="border-t border-[#E2E8F0] px-5 py-3 flex items-center justify-between gap-3">
          <div className="text-[11px] text-[#64748B] flex flex-wrap items-center gap-x-3 gap-y-1">
            {totals.total > 0 ? (
              <>
                <span>{totals.total} file{totals.total === 1 ? "" : "s"}</span>
                {totals.inFlight > 0 && (
                  <span className="flex items-center gap-1"><Spinner className="h-3 w-3" /> {totals.inFlight} processing</span>
                )}
                {totals.commitReady > 0 && <span className="text-emerald-700 font-semibold">{totals.commitReady} ready to commit</span>}
                {totals.commitBlocked > 0 && (
                  <span className="flex items-center gap-1 text-amber-700">
                    <FlagIcon className="h-3 w-3" /> {totals.commitBlocked} need attention
                  </span>
                )}
                {totals.commitDone > 0 && <span className="text-emerald-700">{totals.commitDone} committed</span>}
                {totals.commitSkip > 0 && <span className="text-[#64748B]">{totals.commitSkip} skipped</span>}
                {totals.errored > 0 && <span className="text-red-600">{totals.errored} failed</span>}
              </>
            ) : (
              <span>Drop PDFs to start.</span>
            )}
            {commitSummary && (
              <span className={commitSummary.err === 0 ? "text-emerald-700 font-semibold" : "text-amber-700"}>
                Last commit: {commitSummary.ok} ok{commitSummary.err > 0 ? ` · ${commitSummary.err} failed` : ""}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[#0F172A] hover:bg-[#F8F9FA] text-[12px]"
            >
              Close
            </button>
            <button
              onClick={doCommit}
              // Disabled ONLY when nothing is ready OR a commit is already
              // in flight. We deliberately allow committing the ready rows
              // even when other rows in the batch are still blocked
              // (typically no-match rows the user is still routing). The
              // doCommit handler filters to commitReadiness === "ready"
              // before sending — blocked rows stay in the modal so the
              // user can keep working them after the partial commit.
              disabled={committing || totals.commitReady === 0}
              title={
                totals.commitReady === 0 && totals.commitBlocked > 0 ? `${totals.commitBlocked} row${totals.commitBlocked === 1 ? "" : "s"} still need routing` :
                totals.commitReady === 0 ? "Nothing ready to commit" :
                totals.commitBlocked > 0 ? `Commit ${totals.commitReady} ready row${totals.commitReady === 1 ? "" : "s"} now — ${totals.commitBlocked} other${totals.commitBlocked === 1 ? "" : "s"} stay in the modal to keep routing` :
                `Commit ${totals.commitReady} row${totals.commitReady === 1 ? "" : "s"} to the log`
              }
              className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[12px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
            >
              {committing && <Spinner className="h-3 w-3" />}
              Commit {totals.commitReady > 0 ? totals.commitReady : ""} to log
            </button>
          </div>
        </div>
      </div>

      {/* No-match fallback log-row picker — overlay. */}
      {pickerForRowId && (
        <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center" onClick={e => { if (e.target === e.currentTarget) closeLogRowPicker() }}>
          <div className="bg-white rounded-lg border border-[#E2E8F0] shadow-2xl w-full sm:w-[min(90vw,720px)] max-h-[80vh] flex flex-col">
            <div className="px-4 py-3 border-b border-[#E2E8F0] flex items-center justify-between">
              <h3 className="text-[14px] font-bold text-[#0F172A]">Pick a log row to attach to</h3>
              <button onClick={closeLogRowPicker} className="text-[#64748B] hover:text-[#0F172A]" aria-label="Close">
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="px-4 py-3 border-b border-[#E2E8F0]">
              <input
                type="text"
                value={pickerQuery}
                onChange={e => setPickerQuery(e.target.value)}
                placeholder="Filter by section, type, or material name…"
                className="w-full h-8 px-3 rounded border border-[#E2E8F0] text-[12px]"
                autoFocus
              />
            </div>
            <div className="flex-1 overflow-auto">
              {logRowsLoading && <p className="px-4 py-3 text-[12px] text-[#64748B]">Loading log rows…</p>}
              {logRowsError && <p className="px-4 py-3 text-[12px] text-red-700">{logRowsError}</p>}
              {logRows && logRows.length === 0 && !logRowsLoading && (
                <p className="px-4 py-3 text-[12px] text-[#64748B]">No spec-built log rows available in this project. (Either none exist or all already have an attached PDF.)</p>
              )}
              {logRows && logRows.length > 0 && (() => {
                const q = pickerQuery.trim().toLowerCase()
                const filtered = q
                  ? logRows.filter(lr =>
                      (lr.csi_section ?? "").toLowerCase().includes(q) ||
                      (lr.submittal_type ?? "").toLowerCase().includes(q) ||
                      (lr.material_name ?? "").toLowerCase().includes(q),
                    )
                  : logRows
                return (
                  <ul className="divide-y divide-[#E2E8F0]">
                    {filtered.slice(0, 100).map(lr => (
                      <li key={lr.id}>
                        <button
                          onClick={() => {
                            updateRow(pickerForRowId, { pickedTargetRowId: lr.id })
                            closeLogRowPicker()
                          }}
                          className="w-full text-left px-4 py-2 hover:bg-[#F8F9FA] text-[12px]"
                        >
                          <span className="font-semibold tabular-nums text-[#0F172A]">{lr.csi_section ?? "?"}</span>
                          <span className="text-[#64748B] ml-2">{lr.submittal_type ?? "?"}</span>
                          <span className="text-[#0F172A] ml-2">{lr.material_name ?? "(no name)"}</span>
                          <span className="text-[10px] text-[#64748B] ml-2">seq {lr.submittal_seq ?? "?"}</span>
                        </button>
                      </li>
                    ))}
                    {filtered.length > 100 && (
                      <li className="px-4 py-2 text-[10px] text-[#64748B] italic">…{filtered.length - 100} more — refine the filter to narrow.</li>
                    )}
                  </ul>
                )
              })()}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
