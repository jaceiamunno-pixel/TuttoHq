"use client"

import { useState, useEffect, useMemo, useRef } from "react"
import type { DailyReport, Project, TeamMember } from "../_shared/types"
import { fmtDateOnly } from "../_shared/format"
import { PlusIcon, SpinnerIcon, XIcon } from "../_shared/icons"
import { inputCls, labelCls } from "../_shared/ui"
import { presignAndUpload } from "@/lib/storage-upload"
import {
  ACTIVE_DAILY_DRAFT_KEY,
  type DailyDraftPhotoRow,
  type PendingDailyReportRow,
  addDailyDraftPhoto,
  getDailyDraft,
  listDailyDraftPhotos,
  listPendingDailyReports,
  listPhotosForSavedReport,
  putDailyDraft,
  putPendingDailyReport,
  removePendingDailyReport,
  tagDraftWithSavedReport,
} from "@/lib/idb-photos"
import { createPhotoCompressor } from "@/lib/photo-compression-client"
import { DraftPhotoThumb } from "@/components/photos/DraftPhotoThumb"
import {
  derivePhotoStatus,
  drainPhotoQueue,
  getCountsByReport,
  getInFlightIds,
  subscribeToPhotoSync,
} from "@/lib/photo-sync"

// Daily Reports module — extracted verbatim from dashboard/page.tsx (Step 4 of the split).
// State, handlers, photo sub-system, action bar, content, and both modals are
// unchanged; the load effect keys on globalProjectId (the module mounts only when
// Daily Reports is active, so the activeModule guard is no longer needed).

export default function DailyModule({ globalProjectId, appProjects, teamMembers }: {
  globalProjectId: string
  appProjects: Project[]
  teamMembers: TeamMember[]
}) {
  // Daily reports
  const [dailyReports, setDailyReports]               = useState<DailyReport[]>([])
  const [dailyLoading, setDailyLoading]               = useState(false)
  const [showNewDaily, setShowNewDaily]               = useState(false)
  const [viewDaily, setViewDaily]                     = useState<DailyReport | null>(null)
  const [dailyDate, setDailyDate]                     = useState(() => new Date().toISOString().slice(0, 10))
  const [dailyProjectId, setDailyProjectId]           = useState(globalProjectId)
  const [dailyPreparedBy, setDailyPreparedBy]         = useState("")
  const [dailyWeather, setDailyWeather]               = useState("")
  const [dailyTemp, setDailyTemp]                     = useState("")
  const [dailyManpower, setDailyManpower]             = useState("")
  const [dailyWorkPerformed, setDailyWorkPerformed]   = useState("")
  const [dailyEquipment, setDailyEquipment]           = useState("")
  const [dailyMaterials, setDailyMaterials]           = useState("")
  const [dailyVisitors, setDailyVisitors]             = useState("")
  const [dailyIssues, setDailyIssues]                 = useState("")
  const [dailySafety, setDailySafety]                 = useState("")
  const dailyFileRef  = useRef<HTMLInputElement>(null)
  const [dailySaving, setDailySaving]                 = useState(false)
  const [dailySaveError, setDailySaveError]           = useState("")
  const [dailyEditing, setDailyEditing]               = useState(false)
  const [dailyEditSaving, setDailyEditSaving]         = useState(false)
  const [dailyPhotos, setDailyPhotos]                 = useState<{id: string; url: string; file_name: string}[]>([])
  const [dailyPhotosLoading, setDailyPhotosLoading]   = useState(false)
  const [dailyPhotoUploading, setDailyPhotoUploading] = useState(false)
  const dailyPhotoRef = useRef<HTMLInputElement>(null)
  // Local-first draft persistence (Piece 1 — IndexedDB store, no upload yet).
  // A captured photo lives in IDB tied to `draftId` from the instant it leaves
  // the camera; the form's text fields are persisted alongside so the entire
  // draft survives a refresh/app restart while offline. The upload + sync
  // queue is a separate piece — these rows stay in IDB until that lands.
  const [draftId, setDraftId]                         = useState<string | null>(null)
  const [draftCreatedAt, setDraftCreatedAt]           = useState<number>(0)
  const [draftPhotos, setDraftPhotos]                 = useState<DailyDraftPhotoRow[]>([])
  const [photoCompressProgress, setPhotoCompressProgress] = useState<{ done: number; total: number } | null>(null)
  const [dailyPhotoUploadError, setDailyPhotoUploadError] = useState("")
  const dailyPhotosToAddRef = useRef<HTMLInputElement>(null)
  // Direct-camera capture on the New Report form. Same handler as the
  // picker — both routes feed ingestPhotosToDraft so behavior is
  // identical (compress → IDB → tied to the active draft). The picker
  // is multi-select from library/camera-via-OS; this one bypasses the
  // OS picker entirely and opens the rear camera in one tap.
  const dailyTakePhotoRef = useRef<HTMLInputElement>(null)
  const [dailyGeneratingPdf, setDailyGeneratingPdf]   = useState(false)
  // ── Sync surfaces ──────────────────────────────────────────────────────
  // viewDailyIdbPhotos: IDB photos for the currently-open report, merged
  // with the server-fetched dailyPhotos in the View modal grid so a photo
  // that hasn't drained yet still renders alongside the saved ones.
  // syncingCounts / stuckCounts drive the list-row badges (split so the
  // "stuck" count is visually distinct from "will eventually upload").
  // inFlightIds is a live in-memory snapshot of which photos this tab is
  // *currently* uploading — feeds derivePhotoStatus → "Uploading…" overlay.
  const [viewDailyIdbPhotos, setViewDailyIdbPhotos] = useState<DailyDraftPhotoRow[]>([])
  const [syncingCounts, setSyncingCounts]           = useState<Map<string, number>>(new Map())
  const [stuckCounts, setStuckCounts]               = useState<Map<string, number>>(new Map())
  const [inFlightIds, setInFlightIds]               = useState<ReadonlySet<string>>(() => new Set())
  // Pending daily-reports — the offline-first queue. Every entry here
  // represents a report the user has "created" locally whose POST to
  // /api/daily-reports has not yet been confirmed 2xx. Merged into the
  // list view so the report is visible immediately, with a "Pending sync"
  // badge until the runner removes it.
  const [pendingReports, setPendingReports]         = useState<PendingDailyReportRow[]>([])

  function loadDaily(pid = globalProjectId) {
    setDailyLoading(true)
    const qs = pid ? `?project_id=${encodeURIComponent(pid)}` : ""
    fetch(`/api/daily-reports${qs}`)
      .then(r => r.json())
      .then(d => setDailyReports(d.reports ?? []))
      .catch(() => setDailyReports([]))
      .finally(() => setDailyLoading(false))
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadDaily() }, [globalProjectId])

  // Pre-select the current global project when the New Daily Report modal
  // opens for a fresh draft. A restored draft keeps whatever project the
  // user had selected before the refresh.
  useEffect(() => { if (showNewDaily && !draftId) setDailyProjectId(globalProjectId) }, [showNewDaily, globalProjectId, draftId])

  // ── Draft restore (Piece 1) ────────────────────────────────────────────
  // On module mount, look for an active draft pointer. If found, rehydrate
  // the form + photos from IndexedDB and pop the form open so the user
  // lands on exactly what they had before the refresh / app restart /
  // offline window.
  useEffect(() => {
    if (typeof window === "undefined") return
    const id = window.localStorage.getItem(ACTIVE_DAILY_DRAFT_KEY)
    if (!id) return
    let cancelled = false
    ;(async () => {
      const draft = await getDailyDraft(id)
      if (cancelled) return
      if (!draft) {
        window.localStorage.removeItem(ACTIVE_DAILY_DRAFT_KEY)
        return
      }
      const f = draft.fields ?? {}
      if (f.report_date)           setDailyDate(f.report_date)
      if (f.project_id !== undefined)        setDailyProjectId(f.project_id)
      if (f.prepared_by !== undefined)       setDailyPreparedBy(f.prepared_by)
      if (f.weather_conditions !== undefined) setDailyWeather(f.weather_conditions)
      if (f.temperature !== undefined)       setDailyTemp(f.temperature)
      if (f.manpower_count !== undefined)    setDailyManpower(f.manpower_count)
      if (f.work_performed !== undefined)    setDailyWorkPerformed(f.work_performed)
      if (f.equipment !== undefined)         setDailyEquipment(f.equipment)
      if (f.materials_delivered !== undefined) setDailyMaterials(f.materials_delivered)
      if (f.visitors !== undefined)          setDailyVisitors(f.visitors)
      if (f.issues_delays !== undefined)     setDailyIssues(f.issues_delays)
      if (f.safety_notes !== undefined)      setDailySafety(f.safety_notes)
      const photos = await listDailyDraftPhotos(id)
      if (cancelled) return
      setDraftId(id)
      setDraftCreatedAt(draft.createdAt)
      setDraftPhotos(photos)
      setShowNewDaily(true)
    })().catch(err => console.error("[daily draft] restore failed", err))
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Debounced persist of every form field into the IDB draft row so a
  // refresh mid-typing loses at most ~300 ms of input.
  useEffect(() => {
    if (!draftId) return
    const handle = setTimeout(() => {
      putDailyDraft({
        id: draftId,
        createdAt: draftCreatedAt || Date.now(),
        updatedAt: Date.now(),
        fields: {
          report_date:          dailyDate,
          project_id:           dailyProjectId,
          prepared_by:          dailyPreparedBy,
          weather_conditions:   dailyWeather,
          temperature:          dailyTemp,
          manpower_count:       dailyManpower,
          work_performed:       dailyWorkPerformed,
          equipment:            dailyEquipment,
          materials_delivered:  dailyMaterials,
          visitors:             dailyVisitors,
          issues_delays:        dailyIssues,
          safety_notes:         dailySafety,
        },
      }).catch(err => console.error("[daily draft] persist failed", err))
    }, 300)
    return () => clearTimeout(handle)
  }, [draftId, draftCreatedAt, dailyDate, dailyProjectId, dailyPreparedBy, dailyWeather, dailyTemp, dailyManpower, dailyWorkPerformed, dailyEquipment, dailyMaterials, dailyVisitors, dailyIssues, dailySafety])

  // Mint a draft synchronously on "New Report" click so the photo picker
  // never races the IDB write — UUID gen + state update both run before
  // any user interaction with the form.
  function openNewDailyDraft() {
    setDailyPhotoUploadError("")
    if (dailyPhotosToAddRef.current) dailyPhotosToAddRef.current.value = ""
    if (dailyTakePhotoRef.current)  dailyTakePhotoRef.current.value  = ""
    if (!draftId) {
      const id = crypto.randomUUID()
      const now = Date.now()
      setDraftId(id)
      setDraftCreatedAt(now)
      setDraftPhotos([])
      if (typeof window !== "undefined") {
        window.localStorage.setItem(ACTIVE_DAILY_DRAFT_KEY, id)
      }
      putDailyDraft({ id, createdAt: now, updatedAt: now, fields: {} })
        .catch(err => console.error("[daily draft] mint failed", err))
    }
    setShowNewDaily(true)
  }

  // ── Sync orchestration (Piece 2) ───────────────────────────────────────
  // Refresh per-report sync surfaces. syncing/stuck come from IDB (cheap
  // index scan); inFlightIds is a pure in-memory snapshot of which photos
  // this tab is currently uploading. Called on mount and after every drain
  // event (including each inFlight enter/exit, so "Uploading…" overlay
  // appears live, not just at end-of-drain).
  async function refreshSyncingCounts() {
    try {
      const { syncing, stuck } = await getCountsByReport()
      setSyncingCounts(syncing)
      setStuckCounts(stuck)
      setInFlightIds(getInFlightIds())
    } catch (err) {
      console.error("[daily sync] count refresh failed", err)
    }
  }

  // Pulls the current pending-daily-reports queue from IDB into local
  // state. Called on mount, after every drain (via subscribeToPhotoSync),
  // and immediately after createDaily so the new pending row surfaces
  // in the list without waiting for a server roundtrip.
  async function refreshPendingReports() {
    try {
      setPendingReports(await listPendingDailyReports())
    } catch (err) {
      console.error("[daily sync] pending refresh failed", err)
    }
  }

  // Drain on mount, then subscribe so badges + view-modal photos refresh
  // after any drain pass (capture, online event, periodic tick).
  useEffect(() => {
    let cancelled = false
    refreshPendingReports()
    drainPhotoQueue().then(() => {
      if (!cancelled) {
        refreshSyncingCounts()
        refreshPendingReports()
      }
    })
    const unsubscribe = subscribeToPhotoSync(() => {
      if (cancelled) return
      refreshSyncingCounts()
      refreshPendingReports()
      // If the View modal is open, refresh its photo lists too.
      const id = viewDailyRef.current?.id
      if (id) {
        fetch(`/api/photos?entity_type=daily_report&entity_id=${id}`)
          .then(r => r.ok ? r.json() : [])
          .then(setDailyPhotos)
          .catch(() => {})
        listPhotosForSavedReport(id).then(setViewDailyIdbPhotos).catch(() => {})
      }
    })
    return () => { cancelled = true; unsubscribe() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Online event → drain. iOS Safari + Android Chrome both fire this when
  // the OS transitions out of airplane mode / regains network. Best-effort
  // only — the periodic tick is the safety net.
  useEffect(() => {
    if (typeof window === "undefined") return
    const handler = () => { drainPhotoQueue().catch(() => {}) }
    window.addEventListener("online", handler)
    return () => window.removeEventListener("online", handler)
  }, [])

  // Periodic drain every 30 s while the tab is visible. Paused on hidden
  // (browser tab in background, screen off) and immediately drained again
  // on visibilitychange → visible so a phone that was locked syncs as
  // soon as it wakes.
  useEffect(() => {
    if (typeof window === "undefined") return
    let interval: ReturnType<typeof setInterval> | null = null
    const start = () => {
      if (interval) return
      interval = setInterval(() => { drainPhotoQueue().catch(() => {}) }, 30_000)
    }
    const stop = () => {
      if (interval) { clearInterval(interval); interval = null }
    }
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        drainPhotoQueue().catch(() => {})
        start()
      } else {
        stop()
      }
    }
    if (document.visibilityState === "visible") start()
    document.addEventListener("visibilitychange", onVisibility)
    return () => { document.removeEventListener("visibilitychange", onVisibility); stop() }
  }, [])

  // A ref so the subscribe callback above can read the *current* viewDaily
  // without re-subscribing on every state change.
  const viewDailyRef = useRef<DailyReport | null>(null)
  useEffect(() => { viewDailyRef.current = viewDaily }, [viewDaily])

  useEffect(() => {
    if (viewDaily) {
      setDailyPhotos([])
      setViewDailyIdbPhotos([])
      loadDailyPhotos(viewDaily.id)
      listPhotosForSavedReport(viewDaily.id).then(setViewDailyIdbPhotos).catch(() => {})
    }
  }, [viewDaily?.id])

  async function deleteDaily(reportId: string) {
    if (!confirm("Delete this daily report? This cannot be undone.")) return
    await fetch(`/api/daily-reports/${reportId}`, { method: "DELETE" })
    setViewDaily(null)
    loadDaily()
  }

  async function generateDailyPdf(reportId: string) {
    setDailyGeneratingPdf(true)
    try {
      const res = await fetch(`/api/daily-reports/${reportId}/pdf`, { method: "POST" })
      const data = await res.json()
      if (res.ok && data.url) { window.open(data.url, "_blank"); loadDaily() }
    } finally { setDailyGeneratingPdf(false) }
  }

  async function loadDailyPhotos(id: string) {
    setDailyPhotosLoading(true)
    const res = await fetch(`/api/photos?entity_type=daily_report&entity_id=${id}`)
    if (res.ok) setDailyPhotos(await res.json())
    setDailyPhotosLoading(false)
  }

  // View-modal inline capture (Piece 2): compresses, writes to IDB tagged
  // with the saved report's id, then kicks the drain runner. Photo shows
  // up immediately in the grid with a "Syncing…" overlay until the upload
  // completes (which the sync subscriber then refreshes).
  //
  // The draftId field is reused to hold the savedReportId so a single
  // schema and the same IDB indexes service both creation-time and
  // view-modal capture paths. No separate "instant draft" row is created
  // — these photos never need form-field persistence.
  async function uploadDailyPhoto(file: File) {
    if (!viewDaily) return
    setDailyPhotoUploading(true)
    // Compress off the main thread (decode/downscale/HEIC-transcode in a
    // worker); falls back to the main-thread pipeline where unsupported.
    const compressor = createPhotoCompressor()
    try {
      const reportId = viewDaily.id
      const photo = await compressor.compress(file)
      const existing = await listPhotosForSavedReport(reportId)
      await addDailyDraftPhoto(reportId, photo, existing.length, reportId)
      setViewDailyIdbPhotos(await listPhotosForSavedReport(reportId))
      await refreshSyncingCounts()
      drainPhotoQueue().catch(() => {})
    } catch (err) {
      console.error("[daily view-modal capture] failed", err)
    } finally {
      compressor.dispose()
      setDailyPhotoUploading(false)
    }
  }

  async function deleteDailyPhoto(photoId: string) {
    await fetch(`/api/photos?id=${photoId}`, { method: "DELETE" })
    if (viewDaily) await loadDailyPhotos(viewDaily.id)
  }

  // Photo capture pipeline (Piece 1) — compress an arbitrary set of picked
  // files, write each as a JPEG into IndexedDB tied to the current draft,
  // then re-list from IDB so the UI mirrors persistent storage exactly.
  // No upload is attempted — that's the next piece.
  async function ingestPhotosToDraft(files: File[]) {
    if (files.length === 0) return
    if (!draftId) {
      setDailyPhotoUploadError("Internal error: no active draft.")
      return
    }
    setDailyPhotoUploadError("")
    setPhotoCompressProgress({ done: 0, total: files.length })
    // One reusable worker drives the whole batch off the main thread, so the
    // capture UI stays responsive and the run completes in a backgrounded
    // desktop tab. Per-file failures stay isolated (logged + flagged, batch
    // continues), exactly as before.
    const compressor = createPhotoCompressor()
    try {
      let nextOrder = draftPhotos.length
      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        try {
          const photo = await compressor.compress(file)
          await addDailyDraftPhoto(draftId, photo, nextOrder++)
        } catch (err) {
          console.error("[daily draft] photo compression failed", err)
          const msg = err instanceof Error ? err.message : "unknown error"
          setDailyPhotoUploadError(`${file.name}: could not be processed (${msg})`)
        }
        setPhotoCompressProgress({ done: i + 1, total: files.length })
      }
      const refreshed = await listDailyDraftPhotos(draftId)
      setDraftPhotos(refreshed)
    } finally {
      compressor.dispose()
      setPhotoCompressProgress(null)
    }
  }

  function openDailyForEdit(r: DailyReport) {
    setViewDaily(r)
    setDailyDate(r.report_date)
    setDailyProjectId(r.project_id ?? "")
    setDailyPreparedBy(r.prepared_by ?? "")
    setDailyWeather(r.weather_conditions ?? "")
    setDailyTemp(r.temperature ?? "")
    setDailyManpower(r.manpower_count != null ? String(r.manpower_count) : "")
    setDailyWorkPerformed(r.work_performed ?? "")
    setDailyEquipment(r.equipment ?? "")
    setDailyMaterials(r.materials_delivered ?? "")
    setDailyVisitors(r.visitors ?? "")
    setDailyIssues(r.issues_delays ?? "")
    setDailySafety(r.safety_notes ?? "")
    setDailyEditing(true)
  }

  // OFFLINE-FIRST report creation.
  //
  // The critical contract is: the photo→report link MUST exist locally and
  // immediately, before any network call. So:
  //
  //   1. The report's durable identity IS the draft id (draftId). Reusing
  //      it — rather than minting a fresh UUID per submit — makes a retry
  //      after a partial failure upsert the SAME server row instead of
  //      creating a duplicate (route.ts upserts onConflict:"id"). Draft
  //      ids are crypto.randomUUID(), so the server's UUID_RE matches.
  //      Falls back to a fresh UUID only when there is no draft.
  //   2. putPendingDailyReport() queues the report's form bag in IDB
  //      FIRST. It writes PENDING_REPORTS_STORE, which shares no scope
  //      with the photo store, so it lands even while a photo-write storm
  //      keeps the photo store busy. Even if the user closes the tab right
  //      now, the report will be drained on next open.
  //   3. tagDraftWithSavedReport(draftId, clientReportId) then stamps every
  //      draft photo with savedReportId in one IDB transaction. Its scope
  //      overlaps the photo store, so it can stall under an ingestion storm
  //      — hence it runs AFTER the report is already queued. The idempotent
  //      retry re-tags safely: cursor.update is skipped when savedReportId
  //      already matches.
  //   4. Optimistic POST. On 2xx → remove the pending row (server has
  //      it). On non-2xx or throw (offline) → leave it; drainReportsOnce
  //      retries with backoff. The UI doesn't block on this — the form
  //      closes and the report appears in the list either way.
  //   5. Any uncaught failure surfaces in dailySaveError with the form kept
  //      open and the draft intact, so Retry re-runs against the same id.
  //
  // Net effect: an offline create is locally indistinguishable from an
  // online one. Sync runner does the eventual upload, idempotently.
  async function createDaily(e: React.FormEvent) {
    e.preventDefault()
    setDailySaving(true)
    setDailySaveError("")
    setDailyPhotoUploadError("")
    // Reuse the draft id as the report id so a retry upserts the same row.
    const clientReportId = draftId ?? crypto.randomUUID()
    try {
      const dailyFields: Record<string, string> = { report_date: dailyDate, project_id: dailyProjectId, prepared_by: dailyPreparedBy, weather_conditions: dailyWeather, temperature: dailyTemp, manpower_count: dailyManpower, work_performed: dailyWorkPerformed, equipment: dailyEquipment, materials_delivered: dailyMaterials, visitors: dailyVisitors, issues_delays: dailyIssues, safety_notes: dailySafety }
      const fields: Record<string, string> = {}
      Object.entries(dailyFields).forEach(([k, v]) => { if (v) fields[k] = v })

      // Optional generic attachment (non-photo file). Best-effort: if
      // offline the presigned-url request throws and we proceed without
      // it. Photos are unaffected — they live in IDB and sync separately.
      // A future piece can queue the attachment binary itself.
      const dailyFile = dailyFileRef.current?.files?.[0]
      if (dailyFile) {
        try {
          const { path } = await presignAndUpload("submittals", "daily-reports", dailyFile)
          fields.file_path = path
          fields.file_name = dailyFile.name
        } catch (err) {
          console.warn("[daily create] attachment upload deferred (offline?):", err)
        }
      }

      // ─── Queue the pending POST FIRST (PENDING_REPORTS_STORE has no scope
      //     overlap with the photo store, so it lands even under an ingestion
      //     storm), THEN link the photos. See header note for why. ─────────
      await putPendingDailyReport({
        id: clientReportId,
        fields,
        createdAt: draftCreatedAt || Date.now(),
      })
      if (draftId) {
        try {
          await tagDraftWithSavedReport(draftId, clientReportId)
        } catch (err) {
          console.error("[daily create] tagDraftWithSavedReport failed", err)
        }
      }

      // ─── Optimistic POST. Pending row stays on any failure. ────────────
      try {
        const res = await fetch("/api/daily-reports", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...fields, client_id: clientReportId }),
        })
        if (res.ok) {
          await removePendingDailyReport(clientReportId)
        } else {
          // Non-2xx (RLS rejection, validation, 5xx, …): leave pending,
          // sync runner will retry with backoff. Log so the failure is
          // visible in DevTools rather than silent.
          const data = await res.json().catch(() => ({}))
          console.error("[daily create] non-OK POST", res.status, data)
        }
      } catch (err) {
        // fetch threw — almost certainly offline. The pending row sits
        // in IDB until the runner picks it up on reconnect.
        console.warn("[daily create] POST failed, queued for sync:", err)
      }

      // ─── Regardless of POST outcome, the report exists in the user's
      //     world (pending list + already-linked photos). Reset form.
      if (typeof window !== "undefined") {
        window.localStorage.removeItem(ACTIVE_DAILY_DRAFT_KEY)
      }
      setDraftId(null)
      setDraftCreatedAt(0)
      setDraftPhotos([])
      setShowNewDaily(false)
      setDailyDate(new Date().toISOString().slice(0, 10)); setDailyProjectId(""); setDailyPreparedBy(""); setDailyWeather(""); setDailyTemp(""); setDailyManpower(""); setDailyWorkPerformed(""); setDailyEquipment(""); setDailyMaterials(""); setDailyVisitors(""); setDailyIssues(""); setDailySafety("")
      if (dailyPhotosToAddRef.current) dailyPhotosToAddRef.current.value = ""
      if (dailyTakePhotoRef.current)  dailyTakePhotoRef.current.value  = ""

      loadDaily()
      await refreshPendingReports()
      refreshSyncingCounts()
      drainPhotoQueue().catch(() => {})
    } catch (err) {
      // Any uncaught failure on the create path — most likely an IndexedDB
      // write rejecting/stalling while photos are still being ingested —
      // lands here instead of vanishing as an unhandled rejection. Surface
      // it loudly, keep the form open, and DO NOT reset the draft, so the
      // user's Retry re-runs createDaily against the same draftId (= report
      // id) and the server upsert collapses both attempts onto one row.
      console.error("[daily create] failed", err)
      const msg = err instanceof Error ? err.message : "unknown error"
      setDailySaveError(`Could not create the report (${msg}). Your photos are saved — tap "Create Report" to retry.`)
    } finally { setDailySaving(false) }
  }

  async function saveDaily(e: React.FormEvent) {
    e.preventDefault()
    if (!viewDaily) return
    setDailyEditSaving(true)
    try {
      const res = await fetch(`/api/daily-reports/${viewDaily.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ report_date: dailyDate, project_id: dailyProjectId || null, prepared_by: dailyPreparedBy || null, weather_conditions: dailyWeather || null, temperature: dailyTemp || null, manpower_count: dailyManpower ? parseInt(dailyManpower) : null, work_performed: dailyWorkPerformed || null, equipment: dailyEquipment || null, materials_delivered: dailyMaterials || null, visitors: dailyVisitors || null, issues_delays: dailyIssues || null, safety_notes: dailySafety || null }),
      })
      if (res.ok) { setViewDaily(null); setDailyEditing(false); loadDaily() }
    } finally { setDailyEditSaving(false) }
  }

  // ── Merged list (pending + server) ─────────────────────────────────────
  // Pending rows are reports the user has "created" locally whose POST
  // hasn't been confirmed yet. They're rendered alongside server rows so
  // the user sees their just-created report immediately, even offline.
  // The DailyReport shape is reconstructed from the PendingDailyReportRow's
  // string-bag of fields so the same list/card markup works for both.
  const pendingIds = useMemo(() => new Set(pendingReports.map(p => p.id)), [pendingReports])
  const mergedReports: DailyReport[] = useMemo(() => {
    const serverIds = new Set(dailyReports.map(r => r.id))
    const pendingAsReports: DailyReport[] = pendingReports
      .filter(p => !serverIds.has(p.id))
      .map(p => ({
        id:                 p.id,
        report_date:        p.fields.report_date ?? "",
        project_id:         p.fields.project_id || null,
        prepared_by:        p.fields.prepared_by || null,
        weather_conditions: p.fields.weather_conditions || null,
        temperature:        p.fields.temperature || null,
        manpower_count:     p.fields.manpower_count ? parseInt(p.fields.manpower_count) : null,
        work_performed:     p.fields.work_performed || null,
        equipment:          p.fields.equipment || null,
        materials_delivered: p.fields.materials_delivered || null,
        visitors:           p.fields.visitors || null,
        issues_delays:      p.fields.issues_delays || null,
        safety_notes:       p.fields.safety_notes || null,
        created_at:         new Date(p.createdAt).toISOString(),
        uploaded_by:        "",
        file_path:          p.fields.file_path || null,
        file_name:          p.fields.file_name || null,
      }))
    return [...pendingAsReports, ...dailyReports]
  }, [pendingReports, dailyReports])

  return (
    <>
      {/* Daily reports action bar */}
      <div className="flex-shrink-0 border-b border-[#E2E8F0] bg-white flex items-center justify-between px-4 py-2.5">
        <p className="text-[13px] font-semibold text-[#0F172A]">Daily Reports <span className="text-[#64748B] font-normal ml-1">({mergedReports.length})</span></p>
        <button onClick={openNewDailyDraft} className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors flex items-center gap-1.5">
          <PlusIcon /> New Report
        </button>
      </div>

      {/* Daily reports */}
      <div className="flex-1 overflow-y-auto min-h-0">
          {(
            dailyLoading ? (
              <div className="flex items-center justify-center h-40 gap-2 text-[13px] text-[#64748B]">
                <SpinnerIcon className="h-4 w-4" /> Loading…
              </div>
            ) : mergedReports.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full py-24 text-center">
                <div className="w-14 h-14 rounded-2xl bg-[#7B9BB5]/10 border border-[#7B9BB5]/20 flex items-center justify-center mb-4">
                  <svg className="w-7 h-7 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                </div>
                <p className="text-[15px] font-bold text-[#0F172A]">No daily reports yet</p>
                <p className="text-[13px] text-[#64748B] mt-1.5">Log daily site activity, weather, and manpower.</p>
                <button onClick={openNewDailyDraft} className="mt-5 h-9 px-5 rounded-lg bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors inline-flex items-center gap-2">
                  <PlusIcon /> New Report
                </button>
              </div>
            ) : (
              <>
              {/* Desktop table */}
              <div className="hidden sm:block mx-4 my-4 rounded-xl border border-[#E2E8F0] overflow-clip bg-white">
            <table className="w-full text-[13px] border-collapse">
                <thead className="sticky top-0 bg-[#F8F9FA] z-10">
                  <tr className="border-b border-[#E2E8F0]">
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-10">#</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-28">Date</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest">Work Performed</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-28">Prepared By</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-28">Weather</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-20">Manpower</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-20">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {mergedReports.map((r, i) => {
                    const isPending = pendingIds.has(r.id)
                    return (
                    <tr key={r.id} className={`border-b border-[#E2E8F0]/60 hover:bg-[#F8F9FA] transition-colors cursor-pointer ${isPending ? "bg-amber-50/40" : ""}`} onClick={() => { setViewDaily(r); setDailyEditing(false) }}>
                      <td className="px-4 py-2.5 text-[#64748B] tabular-nums text-[12px]">{mergedReports.length - i}</td>
                      <td className="px-4 py-2.5 text-[#0F172A] font-medium text-[12px] whitespace-nowrap">
                        {fmtDateOnly(r.report_date)}
                        {isPending ? (
                          <span className="ml-2 inline-flex items-center gap-1 text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-full align-middle">
                            <SpinnerIcon className="h-2.5 w-2.5" /> Pending sync
                          </span>
                        ) : null}
                        {syncingCounts.get(r.id) ? (
                          <span className="ml-2 inline-flex items-center gap-1 text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-full align-middle">
                            <SpinnerIcon className="h-2.5 w-2.5" /> {syncingCounts.get(r.id)} syncing
                          </span>
                        ) : null}
                        {stuckCounts.get(r.id) ? (
                          <span className="ml-2 inline-flex items-center gap-1 text-[10px] font-semibold text-red-700 bg-red-50 border border-red-200 px-1.5 py-0.5 rounded-full align-middle">
                            {stuckCounts.get(r.id)} stuck
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-2.5 max-w-0">
                        <p className="text-[#64748B] text-[12px] truncate">{r.work_performed ?? <span className="text-[#64748B] italic">No description</span>}</p>
                      </td>
                      <td className="px-4 py-2.5 text-[#64748B] text-[12px]">{r.prepared_by ?? "—"}</td>
                      <td className="px-4 py-2.5 text-[#64748B] text-[12px]">{r.weather_conditions ?? "—"}{r.temperature ? ` · ${r.temperature}` : ""}</td>
                      <td className="px-4 py-2.5 text-[#64748B] text-[12px] text-center">{r.manpower_count ?? "—"}</td>
                      <td className="px-4 py-2.5">
                        {/* Server-only actions: Edit/PDF/Del all hit /api/daily-reports/[id]
                            which 404s for a row that hasn't been POSTed yet. Hidden on
                            pending rows; they come back when the row syncs. */}
                        {!isPending && (
                          <>
                            <button onClick={e => { e.stopPropagation(); openDailyForEdit(r) }}
                              className="text-[11px] text-[#64748B] hover:text-[#0F172A] px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">
                              Edit
                            </button>
                            <button onClick={e => { e.stopPropagation(); generateDailyPdf(r.id) }} disabled={dailyGeneratingPdf}
                              className="text-[11px] text-[#7B9BB5] hover:text-[#7B9BB5] px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50">PDF</button>
                            <button onClick={e => { e.stopPropagation(); deleteDaily(r.id) }}
                              className="text-[11px] text-red-400 hover:text-red-300 px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">Del</button>
                          </>
                        )}
                      </td>
                    </tr>
                    )
                  })}
                </tbody>
              </table>
              </div>
              {/* Mobile card list */}
              <div className="sm:hidden px-3 py-3 space-y-2">
                {mergedReports.map(r => {
                  const isPending = pendingIds.has(r.id)
                  return (
                  <div key={r.id} className={`bg-white rounded-xl border p-3 shadow-sm cursor-pointer ${isPending ? "border-amber-200 bg-amber-50/40" : "border-[#E2E8F0]"}`} onClick={() => { setViewDaily(r); setDailyEditing(false) }}>
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-[13px] font-semibold text-[#0F172A]">{fmtDateOnly(r.report_date)}</p>
                        {isPending ? (
                          <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-full">
                            <SpinnerIcon className="h-2.5 w-2.5" /> Pending sync
                          </span>
                        ) : null}
                        {syncingCounts.get(r.id) ? (
                          <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-full">
                            <SpinnerIcon className="h-2.5 w-2.5" /> {syncingCounts.get(r.id)} syncing
                          </span>
                        ) : null}
                        {stuckCounts.get(r.id) ? (
                          <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-red-700 bg-red-50 border border-red-200 px-1.5 py-0.5 rounded-full">
                            {stuckCounts.get(r.id)} stuck
                          </span>
                        ) : null}
                      </div>
                      {r.manpower_count != null && <span className="text-[11px] text-[#64748B]">{r.manpower_count} workers</span>}
                    </div>
                    {r.work_performed && <p className="text-[12px] text-[#64748B] mb-1 line-clamp-2">{r.work_performed}</p>}
                    <div className="flex items-center gap-3 text-[11px] text-[#64748B] mb-2">
                      {r.prepared_by && <span>{r.prepared_by}</span>}
                      {r.weather_conditions && <span>{r.weather_conditions}{r.temperature ? ` · ${r.temperature}` : ""}</span>}
                    </div>
                    {!isPending && (
                      <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                        <button onClick={() => openDailyForEdit(r)} className="text-[11px] text-[#64748B] px-2 py-1 rounded border border-[#E2E8F0] bg-[#F8F9FA]">Edit</button>
                        <button onClick={() => generateDailyPdf(r.id)} disabled={dailyGeneratingPdf} className="text-[11px] text-[#7B9BB5] px-2 py-1 rounded border border-[#E2E8F0] bg-[#F8F9FA] disabled:opacity-50">PDF</button>
                        <button onClick={() => deleteDaily(r.id)} className="text-[11px] text-red-400 px-2 py-1 rounded border border-[#E2E8F0] bg-[#F8F9FA]">Del</button>
                      </div>
                    )}
                  </div>
                  )
                })}
              </div>
              </>
            )
          )}
      </div>

      {/* ── New / Edit Daily Report modal ────────────────────────────────── */}
      {(showNewDaily || (viewDaily && dailyEditing)) && (() => {
        const isEdit = !!(viewDaily && dailyEditing)
        const onClose = () => {
          setShowNewDaily(false); setViewDaily(null); setDailyEditing(false);
          // Draft id + photos persist across modal close. Reopening "New
          // Report" will rehydrate from IDB. (Discarding a draft belongs to
          // the delete/cleanup piece, which is reviewed separately.)
          setDailyPhotoUploadError("")
          if (dailyPhotosToAddRef.current) dailyPhotosToAddRef.current.value = ""
          if (dailyTakePhotoRef.current)  dailyTakePhotoRef.current.value  = ""
        }
        const tareaClass = "w-full px-3 py-2 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 resize-none placeholder:text-[#64748B]"
        return (
          <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
            onClick={e => { if (e.target === e.currentTarget) onClose() }}>
            <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[680px] mx-4 sm:mx-0 max-h-[90vh] flex flex-col">
              <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E2E8F0] flex-shrink-0">
                <h2 className="text-[15px] font-bold text-[#0F172A]">{isEdit ? "Edit Daily Report" : "New Daily Report"}</h2>
                <button onClick={onClose} className="text-[#64748B] hover:text-[#64748B] transition-colors"><XIcon className="h-4 w-4" /></button>
              </div>
              <form onSubmit={isEdit ? saveDaily : createDaily} className="flex flex-col flex-1 min-h-0">
                <div className="px-6 py-4 space-y-4 overflow-y-auto flex-1 min-h-0">

                  {/* Row 1: Date, Project, Prepared By */}
                  <div className="flex flex-col sm:flex-row gap-3">
                    <div className="sm:w-36 sm:flex-shrink-0">
                      <label className={labelCls}>Date <span className="text-red-400">*</span></label>
                      <input type="date" required value={dailyDate} onChange={e => setDailyDate(e.target.value)} className={inputCls} />
                    </div>
                    <div className="flex-1">
                      <label className={labelCls}>Project</label>
                      <select value={dailyProjectId} onChange={e => setDailyProjectId(e.target.value)}
                        className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                        <option value="">None</option>
                        {appProjects.map(p => <option key={p.id} value={p.id}>{p.name}{p.number ? ` — ${p.number}` : ""}</option>)}
                      </select>
                    </div>
                    <div className="flex-1">
                      <label className={labelCls}>Prepared By</label>
                      <select value={dailyPreparedBy} onChange={e => setDailyPreparedBy(e.target.value)}
                        className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                        <option value="">Select…</option>
                        {teamMembers.map(m => <option key={m.id} value={m.name}>{m.name}</option>)}
                      </select>
                    </div>
                  </div>

                  {/* Row 2: Weather, Temp, Manpower */}
                  <div className="flex flex-col sm:flex-row gap-3">
                    <div className="flex-1">
                      <label className={labelCls}>Weather</label>
                      <select value={dailyWeather} onChange={e => setDailyWeather(e.target.value)}
                        className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                        <option value="">Select…</option>
                        {["Clear", "Partly Cloudy", "Cloudy", "Rain", "Heavy Rain", "Snow", "Fog", "Wind"].map(w => <option key={w} value={w}>{w}</option>)}
                      </select>
                    </div>
                    <div className="sm:w-28 sm:flex-shrink-0">
                      <label className={labelCls}>Temperature</label>
                      <input type="text" value={dailyTemp} onChange={e => setDailyTemp(e.target.value)} placeholder="e.g. 72°F" className={inputCls} />
                    </div>
                    <div className="sm:w-28 sm:flex-shrink-0">
                      <label className={labelCls}>Manpower</label>
                      <input type="number" min={0} value={dailyManpower} onChange={e => setDailyManpower(e.target.value)} placeholder="# workers" className={inputCls} />
                    </div>
                  </div>

                  {/* Work Performed */}
                  <div>
                    <label className={labelCls}>Work Performed</label>
                    <textarea rows={3} value={dailyWorkPerformed} onChange={e => setDailyWorkPerformed(e.target.value)}
                      placeholder="Describe the work completed on site today…" className={tareaClass} />
                  </div>

                  {/* Equipment & Materials side by side */}
                  <div className="flex flex-col sm:flex-row gap-3">
                    <div className="flex-1">
                      <label className={labelCls}>Equipment on Site</label>
                      <textarea rows={2} value={dailyEquipment} onChange={e => setDailyEquipment(e.target.value)}
                        placeholder="List equipment used…" className={tareaClass} />
                    </div>
                    <div className="flex-1">
                      <label className={labelCls}>Materials Delivered</label>
                      <textarea rows={2} value={dailyMaterials} onChange={e => setDailyMaterials(e.target.value)}
                        placeholder="List deliveries received…" className={tareaClass} />
                    </div>
                  </div>

                  {/* Visitors & Issues side by side */}
                  <div className="flex flex-col sm:flex-row gap-3">
                    <div className="flex-1">
                      <label className={labelCls}>Visitors / Inspections</label>
                      <textarea rows={2} value={dailyVisitors} onChange={e => setDailyVisitors(e.target.value)}
                        placeholder="Inspectors, owner reps, visitors…" className={tareaClass} />
                    </div>
                    <div className="flex-1">
                      <label className={labelCls}>Issues / Delays</label>
                      <textarea rows={2} value={dailyIssues} onChange={e => setDailyIssues(e.target.value)}
                        placeholder="Any delays, problems, or concerns…" className={tareaClass} />
                    </div>
                  </div>

                  {/* Safety Notes */}
                  <div>
                    <label className={labelCls}>Safety Notes</label>
                    <textarea rows={2} value={dailySafety} onChange={e => setDailySafety(e.target.value)}
                      placeholder="Safety observations, incidents, toolbox talks…" className={tareaClass} />
                  </div>
                  {!isEdit && (
                    <>
                      <div>
                        <label className={labelCls}>Attachment <span className="text-[#64748B] font-normal">(optional)</span></label>
                        <input ref={dailyFileRef} type="file" className="w-full text-[12px] text-[#64748B] file:mr-3 file:py-1 file:px-3 file:rounded file:border file:border-[#E2E8F0] file:bg-[#F4F5F7] file:text-[#64748B] file:text-[11px] file:cursor-pointer hover:file:bg-white/[0.05]" />
                      </div>
                      <div className="border-t border-[#E2E8F0] pt-4">
                        <label className={labelCls}>Photo Attachments <span className="text-[#64748B] font-normal">(optional, multiple — saved offline)</span></label>
                        <div className="flex items-center gap-2 mb-3 flex-wrap">
                          <button type="button" onClick={() => dailyPhotosToAddRef.current?.click()} disabled={!!photoCompressProgress}
                            className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] bg-[#F4F5F7] hover:bg-white/50 transition-colors font-medium disabled:opacity-50">
                            + Add Photos
                          </button>
                          <button type="button" onClick={() => dailyTakePhotoRef.current?.click()} disabled={!!photoCompressProgress}
                            className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] bg-[#F4F5F7] hover:bg-white/50 transition-colors font-medium disabled:opacity-50">
                            Take Photo
                          </button>
                          {draftPhotos.length > 0 && (
                            <span className="text-[12px] text-[#64748B]">{draftPhotos.length} photo{draftPhotos.length !== 1 ? 's' : ''} stored locally</span>
                          )}
                        </div>
                        <input ref={dailyPhotosToAddRef} type="file" accept="image/*" multiple className="hidden"
                          onChange={async e => {
                            const files = Array.from(e.target.files || [])
                            // Allow re-picking the same file (Chrome won't fire change otherwise).
                            e.currentTarget.value = ""
                            await ingestPhotosToDraft(files)
                          }} />
                        <input ref={dailyTakePhotoRef} type="file" accept="image/*" capture="environment" className="hidden"
                          onChange={async e => {
                            const files = Array.from(e.target.files || [])
                            e.currentTarget.value = ""
                            await ingestPhotosToDraft(files)
                          }} />
                        {photoCompressProgress && (
                          <p className="text-[12px] text-[#64748B] mb-2 flex items-center gap-1.5">
                            <SpinnerIcon className="h-3 w-3" /> Processing photo {Math.min(photoCompressProgress.done + 1, photoCompressProgress.total)} of {photoCompressProgress.total}…
                          </p>
                        )}
                        {draftPhotos.length > 0 && (
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                            {draftPhotos.map(p => (
                              <div key={p.id} className="relative aspect-square rounded-md border border-[#E2E8F0] bg-[#F4F5F7] overflow-hidden">
                                <DraftPhotoThumb blob={p.bytes} alt={p.filename} className="absolute inset-0 w-full h-full object-cover" />
                                <div className="absolute inset-x-0 bottom-0 bg-black/45 text-white text-[10px] px-1.5 py-0.5 truncate">
                                  {p.filename} · {(p.bytes.size / 1024).toFixed(0)} KB
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                        {dailyPhotoUploadError && (
                          <p className="text-[12px] text-red-500 mt-2">{dailyPhotoUploadError}</p>
                        )}
                      </div>
                    </>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2 px-6 py-4 border-t border-[#E2E8F0] flex-shrink-0">
                  {!isEdit && photoCompressProgress ? (
                    <p className="text-[12px] text-[#64748B] flex-1 mr-2 flex items-center gap-1.5">
                      <SpinnerIcon className="h-3 w-3" /> Processing {Math.min(photoCompressProgress.done + 1, photoCompressProgress.total)} of {photoCompressProgress.total} photos… Create enables when done.
                    </p>
                  ) : !isEdit && dailySaveError ? (
                    <p className="text-[12px] text-red-500 flex-1 mr-2">{dailySaveError}</p>
                  ) : <span />}
                  <div className="flex gap-2 flex-shrink-0">
                    <button type="button" onClick={onClose}
                      className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors">
                      Cancel
                    </button>
                    <button type="submit" disabled={isEdit ? dailyEditSaving : (dailySaving || !!photoCompressProgress || dailyPhotoUploading)}
                      className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 flex items-center gap-2">
                      {(isEdit ? dailyEditSaving : dailySaving) && <SpinnerIcon className="h-3 w-3" />}
                      {isEdit ? (dailyEditSaving ? "Saving…" : "Save Changes") : (dailySaving ? "Creating…" : "Create Report")}
                    </button>
                  </div>
                </div>
              </form>
            </div>
          </div>
        )
      })()}

      {/* ── View Daily Report modal ───────────────────────────────────────── */}
      {viewDaily && !dailyEditing && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
          onClick={e => { if (e.target === e.currentTarget) setViewDaily(null) }}>
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[620px] mx-4 sm:mx-0 max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E2E8F0] flex-shrink-0">
              <div>
                <p className="text-[11px] text-[#64748B] uppercase tracking-widest font-bold">Daily Report</p>
                <h2 className="text-[16px] font-bold text-[#0F172A] mt-0.5">
                  {fmtDateOnly(viewDaily.report_date)}
                  {pendingIds.has(viewDaily.id) ? (
                    <span className="ml-2 inline-flex items-center gap-1 text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-full align-middle">
                      <SpinnerIcon className="h-2.5 w-2.5" /> Pending sync
                    </span>
                  ) : null}
                </h2>
              </div>
              <div className="flex items-center gap-2">
                {/* Server-only actions hidden until the row syncs — Edit/PDF/Del
                    all 404 against /api/daily-reports/[id] for a pending row. */}
                {!pendingIds.has(viewDaily.id) && (
                  <>
                    <button onClick={() => openDailyForEdit(viewDaily)}
                      className="h-7 px-3 rounded-md border border-[#E2E8F0] text-[12px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors">
                      Edit
                    </button>
                    <button onClick={() => generateDailyPdf(viewDaily.id)} disabled={dailyGeneratingPdf}
                      className="h-7 px-3 rounded-md border border-[#E2E8F0] text-[12px] text-[#7B9BB5] hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50 flex items-center gap-1.5">
                      {dailyGeneratingPdf ? <><SpinnerIcon className="h-3 w-3" />Generating…</> : "PDF"}
                    </button>
                    <button onClick={() => deleteDaily(viewDaily.id)}
                      className="h-7 px-3 rounded-md border border-red-900/50 text-[12px] text-red-400 hover:bg-red-900/20 transition-colors">
                      Delete
                    </button>
                  </>
                )}
                <button onClick={() => setViewDaily(null)} className="text-[#64748B] hover:text-[#64748B] transition-colors">
                  <XIcon className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="px-6 py-4 space-y-4 overflow-y-auto flex-1 min-h-0">
              {/* Meta row */}
              <div className="flex flex-wrap gap-4 text-[12px]">
                {viewDaily.prepared_by && <span><span className="text-[#64748B]">Prepared by: </span><span className="text-[#0F172A]">{viewDaily.prepared_by}</span></span>}
                {viewDaily.weather_conditions && <span><span className="text-[#64748B]">Weather: </span><span className="text-[#0F172A]">{viewDaily.weather_conditions}{viewDaily.temperature ? ` · ${viewDaily.temperature}` : ""}</span></span>}
                {viewDaily.manpower_count != null && <span><span className="text-[#64748B]">Manpower: </span><span className="text-[#0F172A]">{viewDaily.manpower_count} workers</span></span>}
              </div>
              {[
                { label: "Work Performed", value: viewDaily.work_performed },
                { label: "Equipment on Site", value: viewDaily.equipment },
                { label: "Materials Delivered", value: viewDaily.materials_delivered },
                { label: "Visitors / Inspections", value: viewDaily.visitors },
                { label: "Issues / Delays", value: viewDaily.issues_delays },
                { label: "Safety Notes", value: viewDaily.safety_notes },
              ].filter(f => f.value).map(f => (
                <div key={f.label} className="rounded-md bg-[#F4F5F7] border border-[#E2E8F0] px-4 py-3">
                  <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-1.5">{f.label}</p>
                  <p className="text-[13px] text-[#0F172A] whitespace-pre-wrap">{f.value}</p>
                </div>
              ))}
              {viewDaily.file_name && (
                <div className="flex items-center gap-2 text-[12px] text-[#64748B] px-1">
                  <svg className="h-3.5 w-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                  <span>{viewDaily.file_name}</span>
                </div>
              )}

              {/* Photo section */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-bold text-[#64748B] uppercase tracking-widest">Photos</span>
                  <button type="button" onClick={() => dailyPhotoRef.current?.click()} disabled={dailyPhotoUploading}
                    className="h-7 px-3 rounded-md border border-[#E2E8F0] text-[12px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50 flex items-center gap-1.5">
                    {dailyPhotoUploading ? <><SpinnerIcon className="h-3 w-3" /> Uploading…</> : "+ Add Photo"}
                  </button>
                  <input ref={dailyPhotoRef} type="file" accept="image/*" capture="environment" className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; if (f) uploadDailyPhoto(f); e.target.value = "" }} />
                </div>
                {(() => {
                  // Merge server-fetched photos (already uploaded) with IDB
                  // photos still pending sync. The DB row uses the same id
                  // as the IDB row (server route upserts on client_id), so
                  // dedupe is exact-key.
                  const serverIds = new Set(dailyPhotos.map(p => p.id))
                  const pendingIdb = viewDailyIdbPhotos.filter(p => !serverIds.has(p.id))
                  if (dailyPhotosLoading && dailyPhotos.length === 0 && pendingIdb.length === 0) {
                    return <div className="flex justify-center py-3"><SpinnerIcon className="h-4 w-4 text-[#64748B]" /></div>
                  }
                  if (dailyPhotos.length === 0 && pendingIdb.length === 0) {
                    return <p className="text-[12px] text-[#64748B] italic">No photos yet — tap &quot;+ Add Photo&quot; to capture or upload</p>
                  }
                  return (
                    <div className="grid grid-cols-3 gap-2">
                      {dailyPhotos.map(ph => (
                        <div key={`srv:${ph.id}`} className="relative group aspect-square rounded-md overflow-hidden border border-[#E2E8F0] bg-[#F4F5F7]">
                          <img src={ph.url} alt={ph.file_name ?? ""} className="w-full h-full object-cover cursor-pointer"
                            onClick={() => window.open(ph.url, "_blank")} />
                          <button onClick={() => deleteDailyPhoto(ph.id)}
                            className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity h-6 w-6 rounded-full bg-red-500 text-white text-[11px] flex items-center justify-center shadow">
                            ✕
                          </button>
                        </div>
                      ))}
                      {pendingIdb.map(ph => {
                        const status = derivePhotoStatus(ph, inFlightIds)
                        const overlay = status === "uploading"
                          ? { bg: "bg-amber-500/90", label: "Uploading…", icon: <SpinnerIcon className="h-3 w-3" /> }
                          : status === "needs_attention"
                          ? { bg: "bg-red-600/90",   label: "Needs attention", icon: null }
                          : { bg: "bg-slate-600/85", label: "Waiting",   icon: null }
                        return (
                          <div key={`idb:${ph.id}`} className={`relative aspect-square rounded-md overflow-hidden border bg-[#F4F5F7] ${status === "needs_attention" ? "border-red-300" : "border-[#E2E8F0]"}`}>
                            <DraftPhotoThumb blob={ph.bytes} alt={ph.filename} className="w-full h-full object-cover" />
                            <div className={`absolute inset-x-0 bottom-0 ${overlay.bg} text-white text-[10px] font-semibold px-1.5 py-0.5 flex items-center justify-center gap-1`}>
                              {overlay.icon} {overlay.label}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )
                })()}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
