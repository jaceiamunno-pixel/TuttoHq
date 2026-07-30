"use client"

import { useState, useEffect, useMemo, useRef, useCallback } from "react"
import type { DailyReport, Project, TeamMember } from "../_shared/types"
import { PlusIcon, SpinnerIcon } from "../_shared/icons"
import { presignAndUpload } from "@/lib/storage-upload"
import { useNavRegion, useFocusTrap } from "@/components/keyboard-nav"
import { SkeletonTable } from "@/components/skeleton"
import { DAILY_0050_LIVE } from "@/lib/daily-flags"
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
import {
  drainPhotoQueue,
  getCountsByReport,
  getInFlightIds,
  subscribeToPhotoSync,
} from "@/lib/photo-sync"
import ReportList from "./daily/ReportList"
import ReportCalendar from "./daily/ReportCalendar"
import ReportComposer from "./daily/ReportComposer"
import ReportDetail from "./daily/ReportDetail"
import {
  emptyDailyForm,
  nonEmptyCrew,
  crewHeadcount,
  parseCrewJson,
  type DailyForm,
  type ServerPhoto,
} from "./daily/types"

// Daily Reports orchestrator (flagship rebuild). All state, the offline-
// first draft/photo/pending-report machinery, and every server call live
// here; presentation is decomposed into _modules/daily/* (ReportList,
// ReportCalendar, ReportComposer, ReportDetail, CrewSection, PhotoSection,
// WeatherField). Every child takes `canEdit` — the field-role read-only
// seam (ADR-020) — which defaults true until the role plumbing lands.
//
// The offline-first create contract (queue pending row → tag photos →
// optimistic POST) is preserved verbatim from the pre-split module — see
// createDaily's header comment.

export default function DailyModule({ globalProjectId, appProjects, teamMembers, canEdit = true }: {
  globalProjectId: string
  appProjects: Project[]
  teamMembers: TeamMember[]
  // ADR-020: false for field users without a daily_reports can_edit grant.
  // Hides every mutation affordance (composer, Edit/Submit/Delete, photo
  // upload, captions); the DB write gates (0049) are the enforcement.
  canEdit?: boolean
}) {
  // ── Server data ────────────────────────────────────────────────────────
  const [dailyReports, setDailyReports]       = useState<DailyReport[]>([])
  const [dailyLoading, setDailyLoading]       = useState(false)
  const [photoCounts, setPhotoCounts]         = useState<Map<string, number>>(new Map())
  const [userNames, setUserNames]             = useState<Record<string, string>>({})

  // ── View / selection state ─────────────────────────────────────────────
  const [viewMode, setViewMode]               = useState<"list" | "calendar">("list")
  const [calMonth, setCalMonth]               = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1) })
  const [selected, setSelected]               = useState<DailyReport | null>(null)
  const [composerMode, setComposerMode]       = useState<"closed" | "new" | "edit">("closed")
  const { regionProps: dailyLogProps } = useNavRegion<HTMLTableSectionElement>({ id: "daily-log", order: 20 })

  // Desktop = two-pane (list/calendar left, detail right); below lg the
  // detail renders as a modal sheet, exactly like the pre-split module.
  const [isDesktop, setIsDesktop] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)")
    const update = () => setIsDesktop(mq.matches)
    update()
    mq.addEventListener("change", update)
    return () => mq.removeEventListener("change", update)
  }, [])

  // ── Composer form (single bag — keys mirror the IDB draft fields) ──────
  const [form, setForm]                       = useState<DailyForm>(() => emptyDailyForm(globalProjectId))
  const patch = useCallback((p: Partial<DailyForm>) => setForm(f => ({ ...f, ...p })), [])
  const dailyFileRef  = useRef<HTMLInputElement>(null)
  const [dailySaving, setDailySaving]         = useState(false)
  const [dailySaveError, setDailySaveError]   = useState("")
  const [dailyEditSaving, setDailyEditSaving] = useState(false)

  // ── Detail-pane photo state ────────────────────────────────────────────
  const [dailyPhotos, setDailyPhotos]                 = useState<ServerPhoto[]>([])
  const [dailyPhotosLoading, setDailyPhotosLoading]   = useState(false)
  const [dailyPhotoUploading, setDailyPhotoUploading] = useState(false)

  // ── Local-first draft persistence (IndexedDB) ──────────────────────────
  // A captured photo lives in IDB tied to `draftId` from the instant it
  // leaves the camera; the form's fields persist alongside so the entire
  // draft survives a refresh/app restart while offline.
  const [draftId, setDraftId]                 = useState<string | null>(null)
  const [draftCreatedAt, setDraftCreatedAt]   = useState<number>(0)
  const [draftPhotos, setDraftPhotos]         = useState<DailyDraftPhotoRow[]>([])
  const [photoCompressProgress, setPhotoCompressProgress] = useState<{ done: number; total: number } | null>(null)
  const [dailyPhotoUploadError, setDailyPhotoUploadError] = useState("")
  const [dailyGeneratingPdf, setDailyGeneratingPdf]   = useState(false)
  const [dailySubmitting, setDailySubmitting]         = useState(false)

  // ── Sync surfaces ──────────────────────────────────────────────────────
  const [viewIdbPhotos, setViewIdbPhotos]   = useState<DailyDraftPhotoRow[]>([])
  const [syncingCounts, setSyncingCounts]   = useState<Map<string, number>>(new Map())
  const [stuckCounts, setStuckCounts]       = useState<Map<string, number>>(new Map())
  const [inFlightIds, setInFlightIds]       = useState<ReadonlySet<string>>(() => new Set())
  const [pendingReports, setPendingReports] = useState<PendingDailyReportRow[]>([])

  // ── Soft-delete undo toast (4h — commit-then-reverse, 10 s) ────────────
  const [undoDelete, setUndoDelete] = useState<{ id: string; date: string } | null>(null)
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function loadDaily(pid = globalProjectId) {
    setDailyLoading(true)
    const qs = pid ? `?project_id=${encodeURIComponent(pid)}` : ""
    fetch(`/api/daily-reports${qs}`)
      .then(r => r.json())
      .then(d => {
        setDailyReports(d.reports ?? [])
        setPhotoCounts(new Map(Object.entries((d.photo_counts ?? {}) as Record<string, number>)))
        setUserNames((d.user_names ?? {}) as Record<string, string>)
      })
      .catch(() => setDailyReports([]))
      .finally(() => setDailyLoading(false))
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadDaily() }, [globalProjectId])

  // Pre-select the current global project when the composer opens for a
  // fresh draft. A restored draft keeps whatever project it had.
  useEffect(() => {
    if (composerMode === "new" && !draftId) patch({ project_id: globalProjectId })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composerMode, globalProjectId, draftId])

  // ── Draft restore ──────────────────────────────────────────────────────
  // On mount, rehydrate an active draft from IDB and pop the composer so
  // the user lands on exactly what they had before the refresh / restart.
  // Skipped for view-only users (ADR-020): a stale local draft — e.g. from
  // before a grant was downgraded — must not pop a composer they can't use.
  // The draft stays in IDB untouched in case edit access returns.
  useEffect(() => {
    if (typeof window === "undefined" || !canEdit) return
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
      setForm(prev => ({
        ...prev,
        ...(f.report_date            ? { report_date: f.report_date } : {}),
        ...(f.project_id           !== undefined ? { project_id: f.project_id } : {}),
        ...(f.prepared_by          !== undefined ? { prepared_by: f.prepared_by } : {}),
        ...(f.weather_conditions   !== undefined ? { weather_conditions: f.weather_conditions } : {}),
        ...(f.temperature          !== undefined ? { temperature: f.temperature } : {}),
        ...(f.manpower_count       !== undefined ? { manpower_count: f.manpower_count } : {}),
        ...(f.work_performed       !== undefined ? { work_performed: f.work_performed } : {}),
        ...(f.equipment            !== undefined ? { equipment: f.equipment } : {}),
        ...(f.materials_delivered  !== undefined ? { materials_delivered: f.materials_delivered } : {}),
        ...(f.visitors             !== undefined ? { visitors: f.visitors } : {}),
        ...(f.issues_delays        !== undefined ? { issues_delays: f.issues_delays } : {}),
        ...(f.safety_notes         !== undefined ? { safety_notes: f.safety_notes } : {}),
        crew: parseCrewJson(f.crew),
      }))
      const photos = await listDailyDraftPhotos(id)
      if (cancelled) return
      setDraftId(id)
      setDraftCreatedAt(draft.createdAt)
      setDraftPhotos(photos)
      setComposerMode("new")
    })().catch(err => console.error("[daily draft] restore failed", err))
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Debounced persist of the form into the IDB draft row (~300 ms).
  useEffect(() => {
    if (!draftId) return
    const handle = setTimeout(() => {
      const crewRows = nonEmptyCrew(form.crew)
      putDailyDraft({
        id: draftId,
        createdAt: draftCreatedAt || Date.now(),
        updatedAt: Date.now(),
        fields: {
          report_date:          form.report_date,
          project_id:           form.project_id,
          prepared_by:          form.prepared_by,
          weather_conditions:   form.weather_conditions,
          temperature:          form.temperature,
          manpower_count:       form.manpower_count,
          work_performed:       form.work_performed,
          equipment:            form.equipment,
          materials_delivered:  form.materials_delivered,
          visitors:             form.visitors,
          issues_delays:        form.issues_delays,
          safety_notes:         form.safety_notes,
          // Crew serializes into the string bag so the IDB schema (and
          // every pre-existing draft) is untouched.
          crew:                 crewRows.length ? JSON.stringify(crewRows) : "",
        },
      }).catch(err => console.error("[daily draft] persist failed", err))
    }, 300)
    return () => clearTimeout(handle)
  }, [draftId, draftCreatedAt, form])

  // Mint a draft synchronously on "New Report" click so the photo picker
  // never races the IDB write.
  function openNewDailyDraft(prefill?: Partial<DailyForm>) {
    setDailyPhotoUploadError("")
    setDailySaveError("")
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
    if (prefill) patch(prefill)
    setComposerMode("new")
  }

  // ── Sync orchestration ─────────────────────────────────────────────────
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

  async function refreshPendingReports() {
    try {
      setPendingReports(await listPendingDailyReports())
    } catch (err) {
      console.error("[daily sync] pending refresh failed", err)
    }
  }

  // Drain on mount, then subscribe so badges + detail photos refresh after
  // any drain pass (capture, online event, periodic tick).
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
      const id = selectedRef.current?.id
      if (id) {
        fetch(`/api/photos?entity_type=daily_report&entity_id=${id}`)
          .then(r => r.ok ? r.json() : [])
          .then(setDailyPhotos)
          .catch(() => {})
        listPhotosForSavedReport(id).then(setViewIdbPhotos).catch(() => {})
      }
    })
    return () => { cancelled = true; unsubscribe() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Online event → drain. The periodic tick is the safety net.
  useEffect(() => {
    if (typeof window === "undefined") return
    const handler = () => { drainPhotoQueue().catch(() => {}) }
    window.addEventListener("online", handler)
    return () => window.removeEventListener("online", handler)
  }, [])

  // Periodic drain every 30 s while visible; paused on hidden, immediate
  // drain when a locked phone wakes back up.
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

  // Ref mirror so the sync subscriber reads the *current* selection.
  const selectedRef = useRef<DailyReport | null>(null)
  useEffect(() => { selectedRef.current = selected }, [selected])

  useEffect(() => {
    if (selected) {
      setDailyPhotos([])
      setViewIdbPhotos([])
      loadDailyPhotos(selected.id)
      listPhotosForSavedReport(selected.id).then(setViewIdbPhotos).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id])

  async function loadDailyPhotos(id: string) {
    setDailyPhotosLoading(true)
    const res = await fetch(`/api/photos?entity_type=daily_report&entity_id=${id}`)
    if (res.ok) setDailyPhotos(await res.json())
    setDailyPhotosLoading(false)
  }

  // ── Delete (4h): soft + undo once 0050 is live, hard-confirm before ────
  async function deleteDaily(reportId: string) {
    if (!DAILY_0050_LIVE) {
      if (!confirm("Delete this daily report? This cannot be undone.")) return
      await fetch(`/api/daily-reports/${reportId}`, { method: "DELETE" })
      setSelected(null)
      loadDaily()
      return
    }
    const report = dailyReports.find(r => r.id === reportId)
    const res = await fetch(`/api/daily-reports/${reportId}`, { method: "DELETE" })
    if (!res.ok) return
    setSelected(null)
    setDailyReports(rs => rs.filter(r => r.id !== reportId))
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
    setUndoDelete({ id: reportId, date: report?.report_date ?? "" })
    undoTimerRef.current = setTimeout(() => setUndoDelete(null), 10_000)
  }
  useEffect(() => () => { if (undoTimerRef.current) clearTimeout(undoTimerRef.current) }, [])

  async function undoDeleteDaily() {
    if (!undoDelete) return
    const id = undoDelete.id
    setUndoDelete(null)
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
    const res = await fetch(`/api/daily-reports/${id}/restore`, { method: "POST" })
    if (!res.ok) console.error("[daily delete] undo failed", res.status)
    loadDaily()
  }

  // ── Submit (4g): explicit action; stamps status/submitted_at/_by ───────
  async function submitDaily(reportId: string) {
    setDailySubmitting(true)
    try {
      const res = await fetch(`/api/daily-reports/${reportId}/submit`, { method: "POST" })
      if (res.ok) {
        const data = await res.json().catch(() => ({}))
        const row = data.report as DailyReport | undefined
        if (row) {
          setSelected(s => s && s.id === reportId ? { ...s, ...row } : s)
          setDailyReports(rs => rs.map(r => r.id === reportId ? { ...r, ...row } : r))
        } else {
          loadDaily()
        }
      }
    } finally { setDailySubmitting(false) }
  }

  async function generateDailyPdf(reportId: string) {
    setDailyGeneratingPdf(true)
    try {
      const res = await fetch(`/api/daily-reports/${reportId}/pdf`, { method: "POST" })
      const data = await res.json()
      if (res.ok && data.url) { window.open(data.url, "_blank"); loadDaily() }
    } finally { setDailyGeneratingPdf(false) }
  }

  // Detail-pane capture: compress → IDB tagged with the saved report's id →
  // drain. Multi-file: one reusable compressor drives the batch.
  async function uploadDetailPhotos(files: File[]) {
    if (!selected || files.length === 0) return
    setDailyPhotoUploading(true)
    const compressor = createPhotoCompressor()
    try {
      const reportId = selected.id
      for (const file of files) {
        try {
          const photo = await compressor.compress(file)
          const existing = await listPhotosForSavedReport(reportId)
          await addDailyDraftPhoto(reportId, photo, existing.length, reportId)
        } catch (err) {
          console.error("[daily detail capture] compression failed", err)
        }
      }
      setViewIdbPhotos(await listPhotosForSavedReport(selected.id))
      await refreshSyncingCounts()
      drainPhotoQueue().catch(() => {})
    } catch (err) {
      console.error("[daily detail capture] failed", err)
    } finally {
      compressor.dispose()
      setDailyPhotoUploading(false)
    }
  }

  async function deleteDailyPhoto(photoId: string) {
    await fetch(`/api/photos?id=${photoId}`, { method: "DELETE" })
    if (selected) await loadDailyPhotos(selected.id)
    loadDaily() // refresh the photo-count badges
  }

  async function saveCaption(photoId: string, caption: string) {
    // Optimistic — the caption edit is inline, a failed PATCH just reverts
    // on the next photo load.
    setDailyPhotos(ps => ps.map(p => p.id === photoId ? { ...p, caption: caption || null } : p))
    await fetch("/api/photos", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: photoId, caption: caption || null }),
    }).catch(() => {})
  }

  // Composer photo capture: compress each picked file into IDB tied to the
  // active draft, then re-list from IDB so the UI mirrors storage exactly.
  async function ingestPhotosToDraft(files: File[]) {
    if (files.length === 0) return
    if (!draftId) {
      setDailyPhotoUploadError("Internal error: no active draft.")
      return
    }
    setDailyPhotoUploadError("")
    setPhotoCompressProgress({ done: 0, total: files.length })
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
    setSelected(r)
    setForm({
      report_date:         r.report_date,
      project_id:          r.project_id ?? "",
      prepared_by:         r.prepared_by ?? "",
      weather_conditions:  r.weather_conditions ?? "",
      temperature:         r.temperature ?? "",
      manpower_count:      r.manpower_count != null ? String(r.manpower_count) : "",
      work_performed:      r.work_performed ?? "",
      equipment:           r.equipment ?? "",
      materials_delivered: r.materials_delivered ?? "",
      visitors:            r.visitors ?? "",
      issues_delays:       r.issues_delays ?? "",
      safety_notes:        r.safety_notes ?? "",
      crew:                r.crew ?? [],
    })
    setDailySaveError("")
    setComposerMode("edit")
  }

  /** The form's fields as the flat string bag the POST route + pending
   *  queue accept. Crew rides along as a JSON string; the derived
   *  headcount overwrites manpower_count for back-compat readers. */
  function formToFields(): Record<string, string> {
    const bag: Record<string, string> = {
      report_date: form.report_date, project_id: form.project_id, prepared_by: form.prepared_by,
      weather_conditions: form.weather_conditions, temperature: form.temperature,
      manpower_count: form.manpower_count, work_performed: form.work_performed,
      equipment: form.equipment, materials_delivered: form.materials_delivered,
      visitors: form.visitors, issues_delays: form.issues_delays, safety_notes: form.safety_notes,
    }
    if (DAILY_0050_LIVE) {
      const crewRows = nonEmptyCrew(form.crew)
      if (crewRows.length) {
        bag.crew = JSON.stringify(crewRows)
        bag.manpower_count = String(crewHeadcount(crewRows))
      }
    }
    const fields: Record<string, string> = {}
    Object.entries(bag).forEach(([k, v]) => { if (v) fields[k] = v })
    return fields
  }

  // OFFLINE-FIRST report creation.
  //
  // The critical contract is: the photo→report link MUST exist locally and
  // immediately, before any network call. So:
  //
  //   1. The report's durable identity IS the draft id (draftId). Reusing
  //      it makes a retry after a partial failure upsert the SAME server
  //      row instead of creating a duplicate (route.ts upserts on id).
  //   2. putPendingDailyReport() queues the report's form bag in IDB
  //      FIRST (PENDING_REPORTS_STORE shares no scope with the photo
  //      store, so it lands even under a photo-write storm).
  //   3. tagDraftWithSavedReport() then stamps every draft photo with
  //      savedReportId — after the report is already queued.
  //   4. Optimistic POST. 2xx → remove the pending row; anything else →
  //      leave it for the drain runner's backoff retry.
  //   5. Uncaught failures keep the form open + draft intact so Retry
  //      re-runs against the same id and the server upsert collapses
  //      both attempts onto one row.
  async function createDaily(e: React.FormEvent) {
    e.preventDefault()
    setDailySaving(true)
    setDailySaveError("")
    setDailyPhotoUploadError("")
    const clientReportId = draftId ?? crypto.randomUUID()
    try {
      const fields = formToFields()

      // Optional generic attachment (non-photo file). Best-effort: if
      // offline the presigned-url request throws and we proceed without it.
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

      // Queue the pending POST FIRST, THEN link the photos (see header).
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

      // Optimistic POST. Pending row stays on any failure.
      try {
        const res = await fetch("/api/daily-reports", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...fields, client_id: clientReportId }),
        })
        if (res.ok) {
          await removePendingDailyReport(clientReportId)
        } else {
          const data = await res.json().catch(() => ({}))
          console.error("[daily create] non-OK POST", res.status, data)
        }
      } catch (err) {
        console.warn("[daily create] POST failed, queued for sync:", err)
      }

      // Regardless of POST outcome, the report exists in the user's world
      // (pending list + already-linked photos). Reset the form.
      if (typeof window !== "undefined") {
        window.localStorage.removeItem(ACTIVE_DAILY_DRAFT_KEY)
      }
      setDraftId(null)
      setDraftCreatedAt(0)
      setDraftPhotos([])
      setComposerMode("closed")
      setForm(emptyDailyForm(""))
      if (dailyFileRef.current) dailyFileRef.current.value = ""

      loadDaily()
      await refreshPendingReports()
      refreshSyncingCounts()
      drainPhotoQueue().catch(() => {})
    } catch (err) {
      // Surface loudly, keep the form open, DO NOT reset the draft — the
      // user's Retry re-runs createDaily against the same draftId (= report
      // id) and the server upsert collapses both attempts onto one row.
      console.error("[daily create] failed", err)
      const msg = err instanceof Error ? err.message : "unknown error"
      setDailySaveError(`Could not create the report (${msg}). Your photos are saved — tap "Create Report" to retry.`)
    } finally { setDailySaving(false) }
  }

  async function saveDaily(e: React.FormEvent) {
    e.preventDefault()
    if (!selected) return
    setDailyEditSaving(true)
    try {
      const crewRows = nonEmptyCrew(form.crew)
      const body: Record<string, unknown> = {
        report_date: form.report_date,
        project_id: form.project_id || null,
        prepared_by: form.prepared_by || null,
        weather_conditions: form.weather_conditions || null,
        temperature: form.temperature || null,
        manpower_count: form.manpower_count ? parseInt(form.manpower_count) : null,
        work_performed: form.work_performed || null,
        equipment: form.equipment || null,
        materials_delivered: form.materials_delivered || null,
        visitors: form.visitors || null,
        issues_delays: form.issues_delays || null,
        safety_notes: form.safety_notes || null,
      }
      if (DAILY_0050_LIVE) {
        body.crew = crewRows.length ? crewRows : null
        if (crewRows.length) body.manpower_count = crewHeadcount(crewRows)
      }
      const res = await fetch(`/api/daily-reports/${selected.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (res.ok) { setSelected(null); setComposerMode("closed"); loadDaily() }
    } finally { setDailyEditSaving(false) }
  }

  // ── Merged list (pending + server) ─────────────────────────────────────
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
        crew:               parseCrewJson(p.fields.crew),
        created_at:         new Date(p.createdAt).toISOString(),
        uploaded_by:        "",
        file_path:          p.fields.file_path || null,
        file_name:          p.fields.file_name || null,
      }))
    return [...pendingAsReports, ...dailyReports]
  }, [pendingReports, dailyReports])

  // Photo-count badges: server counts + local photos still pending sync.
  const displayPhotoCounts = useMemo(() => {
    const map = new Map(photoCounts)
    for (const src of [syncingCounts, stuckCounts]) {
      for (const [id, n] of src) map.set(id, (map.get(id) ?? 0) + n)
    }
    return map
  }, [photoCounts, syncingCounts, stuckCounts])

  // Copy-from-last source (3b): most recent report on the composer's
  // project. Copies crew/equipment/prepared-by only — never work
  // performed, issues, or photos.
  const copySource = useMemo(() => {
    if (composerMode !== "new") return null
    return mergedReports.find(r => (r.project_id ?? "") === form.project_id) ?? null
  }, [composerMode, mergedReports, form.project_id])

  function copyFromLast() {
    if (!copySource) return
    patch({
      prepared_by: copySource.prepared_by ?? "",
      equipment:   copySource.equipment ?? "",
      ...(DAILY_0050_LIVE && copySource.crew?.length
        ? { crew: copySource.crew.map(c => ({ ...c })) }
        : {}),
      ...(copySource.manpower_count != null ? { manpower_count: String(copySource.manpower_count) } : {}),
    })
  }

  const projectLocation = useMemo(
    () => appProjects.find(p => p.id === form.project_id)?.location ?? null,
    [appProjects, form.project_id],
  )

  // ── Desktop keyboard nav (3e): ↑/↓ move selection, Esc closes ──────────
  useEffect(() => {
    if (!isDesktop) return
    function onKey(e: KeyboardEvent) {
      if (composerMode !== "closed") return
      // The lightbox owns its own keys while open.
      if (document.querySelector("[data-daily-lightbox]")) return
      const t = e.target as HTMLElement | null
      if (t && t.closest?.("input, textarea, select, [contenteditable=true]")) return
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        // Focus inside the table rows → the roving-focus nav region owns it.
        if (t && t.closest?.("[data-nav-item]")) return
        if (mergedReports.length === 0) return
        e.preventDefault()
        const idx = selected ? mergedReports.findIndex(r => r.id === selected.id) : -1
        const next = e.key === "ArrowDown"
          ? Math.min(idx + 1, mergedReports.length - 1)
          : Math.max(idx - 1, 0)
        setSelected(mergedReports[next < 0 ? 0 : next])
      } else if (e.key === "Escape" && selected) {
        e.preventDefault()
        setSelected(null)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [isDesktop, composerMode, mergedReports, selected])

  // Mobile detail modal: trap focus; Escape closes and restores focus.
  const mobileModalRef = useRef<HTMLDivElement>(null)
  useFocusTrap(mobileModalRef, !!selected && !isDesktop && composerMode === "closed", () => setSelected(null))

  function selectReport(r: DailyReport) {
    setSelected(r)
    setComposerMode("closed")
  }

  const detailProps = selected ? {
    report: selected,
    pendingSync: pendingIds.has(selected.id),
    photos: dailyPhotos,
    photosLoading: dailyPhotosLoading,
    idbPhotos: viewIdbPhotos,
    inFlightIds,
    photoUploading: dailyPhotoUploading,
    canEdit,
    generatingPdf: dailyGeneratingPdf,
    submitting: dailySubmitting,
    userNames,
    onClose: () => setSelected(null),
    onEdit: openDailyForEdit,
    onPdf: generateDailyPdf,
    onDelete: deleteDaily,
    onSubmit: submitDaily,
    onAddPhotos: uploadDetailPhotos,
    onDeletePhoto: deleteDailyPhoto,
    onCaption: saveCaption,
  } : null

  return (
    <>
      {/* Action bar */}
      <div className="flex-shrink-0 border-b border-[#E2E8F0] bg-white flex items-center justify-between gap-2 px-4 py-2.5">
        <div className="flex items-center gap-3 min-w-0">
          <p className="text-[13px] font-semibold text-[#0F172A] whitespace-nowrap">
            Daily Reports <span className="text-[#64748B] font-normal ml-1">({mergedReports.length})</span>
          </p>
          <div className="flex rounded-md border border-[#E2E8F0] overflow-clip">
            {(["list", "calendar"] as const).map(m => (
              <button key={m} onClick={() => setViewMode(m)}
                className={`h-8 px-3 text-[12px] font-medium transition-colors ${viewMode === m ? "bg-[#7B9BB5] text-white" : "bg-white text-[#64748B] hover:bg-[#F8F9FA]"}`}>
                {m === "list" ? "List" : "Calendar"}
              </button>
            ))}
          </div>
        </div>
        {canEdit ? (
          <button onClick={() => openNewDailyDraft()} className="h-9 sm:h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors flex items-center gap-1.5 flex-shrink-0">
            <PlusIcon /> New Report
          </button>
        ) : (
          <span className="text-[11px] font-semibold text-[#64748B] bg-[#F4F5F7] border border-[#E2E8F0] px-2 py-1 rounded-full flex-shrink-0">View only</span>
        )}
      </div>

      {/* Two-pane on lg+: list/calendar left, detail right. Below lg the
          left region is full-width and detail opens as a modal sheet. */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        <div className={`flex-1 min-w-0 overflow-y-auto min-h-0 ${selected && isDesktop ? "lg:flex-none lg:w-[44%] lg:max-w-[600px] lg:border-r lg:border-[#E2E8F0]" : ""}`}>
          {dailyLoading ? (
            <div className="mx-4 my-4"><SkeletonTable rows={8} cols={5} /></div>
          ) : mergedReports.length === 0 && viewMode === "list" ? (
            <div className="flex flex-col items-center justify-center h-full py-24 text-center">
              <div className="w-14 h-14 rounded-2xl bg-[#7B9BB5]/10 border border-[#7B9BB5]/20 flex items-center justify-center mb-4">
                <svg className="w-7 h-7 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              </div>
              <p className="text-[15px] font-bold text-[#0F172A]">No daily reports yet</p>
              <p className="text-[13px] text-[#64748B] mt-1.5">Log daily site activity, weather, and manpower.</p>
              {canEdit && (
                <button onClick={() => openNewDailyDraft()} className="mt-5 h-9 px-5 rounded-lg bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors inline-flex items-center gap-2">
                  <PlusIcon /> New Report
                </button>
              )}
            </div>
          ) : viewMode === "calendar" ? (
            <ReportCalendar
              reports={mergedReports}
              month={calMonth}
              onMonth={setCalMonth}
              selectedId={selected?.id ?? null}
              onSelect={selectReport}
              onNewForDate={canEdit ? (date => openNewDailyDraft({ report_date: date })) : undefined}
              canEdit={canEdit}
            />
          ) : (
            <ReportList
              reports={mergedReports}
              pendingIds={pendingIds}
              syncingCounts={syncingCounts}
              stuckCounts={stuckCounts}
              photoCounts={displayPhotoCounts}
              selectedId={selected?.id ?? null}
              onSelect={selectReport}
              onEdit={openDailyForEdit}
              onPdf={generateDailyPdf}
              onDelete={deleteDaily}
              canEdit={canEdit}
              generatingPdf={dailyGeneratingPdf}
              navRegionProps={dailyLogProps}
            />
          )}
        </div>

        {/* Desktop detail pane */}
        {isDesktop && selected && detailProps && composerMode !== "edit" && (
          <div className="hidden lg:flex flex-1 min-w-0 flex-col bg-white">
            <ReportDetail {...detailProps} />
          </div>
        )}
      </div>

      {/* Mobile detail modal */}
      {!isDesktop && selected && detailProps && composerMode === "closed" && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-end sm:items-center justify-center"
          onClick={e => { if (e.target === e.currentTarget) setSelected(null) }}>
          <div ref={mobileModalRef} role="dialog" aria-modal="true"
            className="bg-white rounded-t-2xl sm:rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[620px] h-[92dvh] sm:h-auto sm:max-h-[85vh] flex flex-col overflow-hidden">
            <ReportDetail {...detailProps} />
          </div>
        </div>
      )}

      {/* Composer (new + edit) */}
      {composerMode !== "closed" && (
        <ReportComposer
          mode={composerMode}
          form={form}
          patch={patch}
          appProjects={appProjects}
          teamMembers={teamMembers}
          projectLocation={projectLocation}
          canEdit={canEdit}
          saving={composerMode === "new" ? dailySaving : dailyEditSaving}
          saveError={dailySaveError}
          draftPhotos={draftPhotos}
          compressProgress={photoCompressProgress}
          photoError={dailyPhotoUploadError}
          onIngestPhotos={ingestPhotosToDraft}
          fileRef={dailyFileRef}
          copySource={copySource ? { date: copySource.report_date } : null}
          onCopyLast={copyFromLast}
          onSave={composerMode === "new" ? createDaily : saveDaily}
          onClose={() => {
            // Draft id + photos persist across close — reopening "New
            // Report" rehydrates from IDB.
            setComposerMode("closed")
            setDailyPhotoUploadError("")
          }}
        />
      )}

      {/* Soft-delete undo toast (10 s) */}
      {undoDelete && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] bg-[#0F172A] text-white rounded-lg shadow-xl px-4 py-2.5 flex items-center gap-3">
          <span className="text-[13px]">Report deleted</span>
          <button onClick={undoDeleteDaily}
            className="text-[13px] font-semibold text-[#9DC0DC] hover:text-white transition-colors underline underline-offset-2">
            Undo
          </button>
          <SpinnerIcon className="h-3 w-3 opacity-40" />
        </div>
      )}
    </>
  )
}
