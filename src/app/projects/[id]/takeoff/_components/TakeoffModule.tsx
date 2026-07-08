"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import CountViewer, { type ViewerMark, type ViewerMeasuredMark, type ViewerMode, type ViewerScaleSeg } from "./CountViewer"
import TakeoffControls from "./TakeoffControls"
import TakeoffMatrix from "./TakeoffMatrix"
import { computeMatrix } from "../_lib/matrix"
import { exportTakeoffToExcel } from "../_lib/excel"
import { nextTagColor } from "../_lib/colors"
import { anchorOf, resolveMeasure, measuredUnitLabel, fmtQty, scaleKey } from "../_lib/measure"
import { useMarkSync } from "../_lib/useMarkSync"
import * as api from "../_lib/api"
import type {
  Takeoff, TakeoffBundle, TakeoffCategory, TakeoffRoom, TakeoffTag, CountSheet,
  TakeoffPageScale, MarkKind, ScaleUnit,
} from "../_lib/types"

// data = the takeoff's structure (categories/rooms/tags). Marks are owned by the
// optimistic sync hook (useMarkSync) so placement is instant and never blocks on
// the network — see that file for the queue/flush/reconcile design.
type TakeoffData = Pick<TakeoffBundle, "categories" | "rooms" | "tags">
const EMPTY_DATA: TakeoffData = { categories: [], rooms: [], tags: [] }

const bySort = (a: { sort_order: number }, z: { sort_order: number }) => a.sort_order - z.sort_order

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || !el.tagName) return false
  const tag = el.tagName
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!el.isContentEditable
}

// Per-takeoff "remember last-used tag/room" (client-only, best-effort).
const lsKey = (takeoffId: string, k: "tag" | "room") => `ttq:takeoff:${takeoffId}:${k}`
const lsGet = (k: string): string | null => { try { return window.localStorage.getItem(k) } catch { return null } }
const lsSet = (k: string, v: string) => { try { window.localStorage.setItem(k, v) } catch { /* private mode */ } }

const markKindForMode = (m: ViewerMode): MarkKind => (m === "linear" ? "linear" : m === "area" ? "area" : "count")

// Bid Takeoff — two-pane workspace. LEFT: the reused pdf.js sheet viewer with our
// overlay (count dots + linear/area measurements + per-page scale calibration).
// RIGHT: takeoff/category/tag/room controls + the live matrix + Excel export.
// Project-scoped: every takeoff belongs to this project.
export default function TakeoffModule({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [takeoffs, setTakeoffs] = useState<Takeoff[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [data, setData] = useState<TakeoffData>(EMPTY_DATA)
  const [scales, setScales] = useState<TakeoffPageScale[]>([])

  const [sheets, setSheets] = useState<CountSheet[]>([])
  const [sheetId, setSheetId] = useState<string | null>(null)
  const [page, setPage] = useState(0)          // 0-indexed page of the open sheet
  const [pageCount, setPageCount] = useState(1)

  const [activeTagId, setActiveTagId] = useState<string | null>(null)
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null)

  const [mode, setMode] = useState<ViewerMode>("count")
  const [scaleDraft, setScaleDraft] = useState<{ seg: ViewerScaleSeg; segLen: number } | null>(null)

  const [eraseMode, setEraseMode] = useState(false)
  const [shiftHeld, setShiftHeld] = useState(false)
  const erasing = eraseMode || shiftHeld

  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Optimistic mark sync. Callbacks are stable; only marks/counters re-render.
  const {
    marks: syncMarks, place: placeMark, remove: removeMark, undo: undoMark, canUndo,
    pendingCount, failedCount, syncing, retry: retryMarks,
    reset: resetMarks, pruneByTag, pruneByRoom,
  } = useMarkSync()

  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await fn() } catch (e) { setError(e instanceof Error ? e.message : "Something went wrong") }
    finally { setBusy(false) }
  }, [])

  // Initial load: this project's takeoffs + drawing sheets.
  useEffect(() => {
    let alive = true
    setLoading(true)
    Promise.all([api.listTakeoffs(projectId), api.listSheets(projectId)])
      .then(([tks, shts]) => {
        if (!alive) return
        setTakeoffs(tks)
        setSelectedId(tks[0]?.id ?? null)
        setSheets(shts)
        setSheetId(shts[0]?.id ?? null)
      })
      .catch(e => { if (alive) setError(e instanceof Error ? e.message : "Failed to load") })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [projectId])

  // Load the selected takeoff's bundle; hand marks to the sync hook; seed the
  // active tag/room (preferring the last-used pair for this takeoff).
  useEffect(() => {
    if (!selectedId) { setData(EMPTY_DATA); setScales([]); setActiveTagId(null); setActiveRoomId(null); resetMarks([], null); return }
    let alive = true
    api.getBundle(selectedId)
      .then(b => {
        if (!alive) return
        setData({ categories: b.categories, rooms: b.rooms, tags: b.tags })
        setScales(b.page_scales ?? [])
        resetMarks(b.marks, selectedId)
        const rooms = [...b.rooms].sort(bySort)
        const tags = [...b.tags].sort(bySort)
        const storedTag = lsGet(lsKey(selectedId, "tag"))
        const storedRoom = lsGet(lsKey(selectedId, "room"))
        setActiveTagId(tags.find(t => t.id === storedTag)?.id ?? tags[0]?.id ?? null)
        setActiveRoomId(rooms.find(r => r.id === storedRoom)?.id ?? rooms[0]?.id ?? null)
      })
      .catch(e => { if (alive) setError(e instanceof Error ? e.message : "Failed to load takeoff") })
    return () => { alive = false }
  }, [selectedId, resetMarks])

  // Reset paging when the open sheet changes (the viewer reports the real count).
  useEffect(() => { setPage(0); setPageCount(1) }, [sheetId])

  // Remember the last-used tag/room per takeoff.
  useEffect(() => { if (selectedId && activeTagId) lsSet(lsKey(selectedId, "tag"), activeTagId) }, [selectedId, activeTagId])
  useEffect(() => { if (selectedId && activeRoomId) lsSet(lsKey(selectedId, "room"), activeRoomId) }, [selectedId, activeRoomId])

  const selectedTakeoff = takeoffs.find(t => t.id === selectedId) ?? null
  const selectedSheet = sheets.find(s => s.id === sheetId) ?? null
  const tagById = useMemo(() => new Map(data.tags.map(t => [t.id, t])), [data.tags])
  const sortedTags = useMemo(() => [...data.tags].sort(bySort), [data.tags])
  const sortedRooms = useMemo(() => [...data.rooms].sort(bySort), [data.rooms])

  // Scale for the sheet + page we're on — the gate for any measurement display.
  // Keyed by (source_ref, page): a second sheet with no row shows "needs scale"
  // even when another sheet is calibrated.
  const scaleByKey = useMemo(() => new Map(scales.map(s => [scaleKey(s.source_ref, s.page), s])), [scales])
  const currentScale = sheetId ? scaleByKey.get(scaleKey(sheetId, page)) : undefined

  // A tag is ONE kind (count XOR measured). Derive each tag's established kind from
  // its marks (measured wins over count) so we can block cross-kind placement.
  const tagKind = useMemo(() => {
    const m = new Map<string, MarkKind>()
    for (const mk of syncMarks) {
      if (mk.kind !== "count") m.set(mk.tag_id, mk.kind)
      else if (!m.has(mk.tag_id)) m.set(mk.tag_id, "count")
    }
    return m
  }, [syncMarks])

  const matrix = useMemo(
    () => computeMatrix(data.categories, data.rooms, data.tags, syncMarks, scales),
    [data.categories, data.rooms, data.tags, syncMarks, scales],
  )

  // Count dots for the open sheet + current page only. React key is the mark's
  // stable _key (survives the temp→real id swap, so a saved dot never remounts).
  const viewerMarks: ViewerMark[] = useMemo(() => {
    if (!sheetId) return []
    return syncMarks
      .filter(m => m.kind === "count" && m.source_ref === sheetId && m.page === page)
      .map(m => {
        const tag = tagById.get(m.tag_id)
        return { id: m._key, x: m.x, y: m.y, color: tag?.color ?? "#64748B", code: tag?.code ?? "?" }
      })
  }, [syncMarks, sheetId, page, tagById])

  // Measured marks for this sheet+page, with their real-world quantity resolved at
  // render time from THIS page's scale — so recalibrating reprices with no rewrite.
  const measuredViewerMarks: ViewerMeasuredMark[] = useMemo(() => {
    if (!sheetId) return []
    return syncMarks
      .filter(m => m.kind !== "count" && m.points && m.source_ref === sheetId && m.page === page)
      .map(m => {
        const kind = m.kind as "linear" | "area"
        const tag = tagById.get(m.tag_id)
        const code = tag?.code ?? "?"
        const real = resolveMeasure(m.kind, m.raw_measure, currentScale)
        const label = real == null
          ? `${code} · — set scale`
          : `${code} · ${fmtQty(real)} ${measuredUnitLabel(kind, currentScale!.unit)}`
        return { id: m._key, kind, points: m.points!, color: tag?.color ?? "#64748B", label }
      })
  }, [syncMarks, sheetId, page, tagById, currentScale])

  const canPlace = !!(selectedId && sheetId && activeTagId && activeRoomId)
  const canScale = !!(selectedId && sheetId)

  // ── One-kind-per-tag guard ─────────────────────────────────────────────────
  const conflictKind = useCallback((want: MarkKind): MarkKind | null => {
    if (!activeTagId) return null
    const have = tagKind.get(activeTagId)
    return have && have !== want ? have : null
  }, [activeTagId, tagKind])
  const kindLabel = (k: MarkKind) => (k === "count" ? "count" : k === "linear" ? "linear-measure" : "area-measure")

  // ── Count place / delete (instant, optimistic) ────────────────────────────
  const onPlace = useCallback((x: number, y: number) => {
    if (!selectedId || !activeTagId || !activeRoomId || !sheetId || erasing) return
    const clash = conflictKind("count")
    if (clash) { setError(`This tag already holds ${kindLabel(clash)} marks — a tag is a single kind. Pick or add another tag.`); return }
    placeMark({ tag_id: activeTagId, room_id: activeRoomId, source_ref: sheetId, page, x, y, kind: "count", points: null, raw_measure: null })
  }, [selectedId, activeTagId, activeRoomId, sheetId, page, erasing, conflictKind, placeMark])

  // ── Measurement commit (linear/area) ──────────────────────────────────────
  const onCommitMeasure = useCallback((kind: "linear" | "area", points: [number, number][], rawMeasure: number) => {
    if (!selectedId || !activeTagId || !activeRoomId || !sheetId || erasing) return
    const clash = conflictKind(kind)
    if (clash) { setError(`This tag already holds ${kindLabel(clash)} marks — a tag is a single kind. Pick or add another tag.`); return }
    const [ax, ay] = anchorOf(kind, points)
    placeMark({ tag_id: activeTagId, room_id: activeRoomId, source_ref: sheetId, page, x: ax, y: ay, kind, points, raw_measure: rawMeasure })
  }, [selectedId, activeTagId, activeRoomId, sheetId, page, erasing, conflictKind, placeMark])

  const onDeleteMark = useCallback((key: string) => removeMark(key), [removeMark])
  const onDeleteMany = useCallback((keys: string[]) => { for (const k of keys) removeMark(k) }, [removeMark])

  // ── Scale calibration ──────────────────────────────────────────────────────
  const onScaleDrawn = useCallback((seg: ViewerScaleSeg, segLen: number) => setScaleDraft({ seg, segLen }), [])
  const confirmScale = (realLength: number, unit: ScaleUnit) => {
    const draft = scaleDraft
    if (!draft || !selectedId || !sheetId) return
    setScaleDraft(null)
    run(async () => {
      const scale = await api.upsertScale(selectedId, {
        source_ref: sheetId, page, unit, units_per_px: realLength / draft.segLen,
        cal_x1: draft.seg.x1, cal_y1: draft.seg.y1, cal_x2: draft.seg.x2, cal_y2: draft.seg.y2,
      })
      setScales(prev => [...prev.filter(s => !(s.source_ref === sheetId && s.page === page)), scale])
    })
  }
  const clearScale = () => {
    if (!selectedId || !currentScale) return
    const sr = currentScale.source_ref
    run(async () => {
      await api.deleteScale(selectedId, sr, page)
      setScales(prev => prev.filter(s => !(s.source_ref === sr && s.page === page)))
    })
  }

  // ── Room quick-switch (buttons + [ ] keys) ────────────────────────────────
  const cycleRoom = useCallback((dir: -1 | 1) => {
    if (sortedRooms.length === 0) return
    const i = sortedRooms.findIndex(r => r.id === activeRoomId)
    const next = sortedRooms[(((i < 0 ? 0 : i) + dir) % sortedRooms.length + sortedRooms.length) % sortedRooms.length]
    if (next) setActiveRoomId(next.id)
  }, [sortedRooms, activeRoomId])

  // ── Keyboard-first flow ────────────────────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return
      if ((e.metaKey || e.ctrlKey) && (e.key === "z" || e.key === "Z")) { e.preventDefault(); undoMark(); return }
      if (e.altKey || e.metaKey || e.ctrlKey) return
      if (/^[1-9]$/.test(e.key)) {
        const t = sortedTags[parseInt(e.key, 10) - 1]
        if (t) { setActiveTagId(t.id); e.preventDefault() }
        return
      }
      // Tool modes
      if (e.key === "c" || e.key === "C") { setMode("count"); e.preventDefault(); return }
      if (e.key === "l" || e.key === "L") { setMode("linear"); e.preventDefault(); return }
      if (e.key === "a" || e.key === "A") { setMode("area"); e.preventDefault(); return }
      if (e.key === "s" || e.key === "S") { setMode("scale"); e.preventDefault(); return }
      if (e.key === "e" || e.key === "E") { setEraseMode(m => !m); e.preventDefault(); return }
      if (e.key === "Escape") { if (eraseMode) { setEraseMode(false); e.preventDefault() } return }
      if (e.key === "[") { cycleRoom(-1); e.preventDefault(); return }
      if (e.key === "]") { cycleRoom(1); e.preventDefault(); return }
      if (e.key === "PageUp") { setPage(p => Math.max(0, p - 1)); e.preventDefault(); return }
      if (e.key === "PageDown") { setPage(p => Math.min(Math.max(0, pageCount - 1), p + 1)); e.preventDefault(); return }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [sortedTags, cycleRoom, eraseMode, pageCount, undoMark])

  // Shift-hold = temporary erase (Bluebeam-style); release exits.
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.key === "Shift") setShiftHeld(true) }
    const up = (e: KeyboardEvent) => { if (e.key === "Shift") setShiftHeld(false) }
    const clear = () => setShiftHeld(false)
    window.addEventListener("keydown", down)
    window.addEventListener("keyup", up)
    window.addEventListener("blur", clear)
    return () => {
      window.removeEventListener("keydown", down)
      window.removeEventListener("keyup", up)
      window.removeEventListener("blur", clear)
    }
  }, [])

  // Guard against closing the tab while anything is still unsent.
  useEffect(() => {
    if (!syncing) return
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = "" }
    window.addEventListener("beforeunload", h)
    return () => window.removeEventListener("beforeunload", h)
  }, [syncing])

  // ── Takeoff actions ───────────────────────────────────────────────────────
  const onCreateTakeoff = (name: string) => run(async () => {
    const t = await api.createTakeoff(projectId, name)
    setTakeoffs(prev => [t, ...prev])
    setSelectedId(t.id)
  })
  const onDeleteTakeoff = (id: string) => run(async () => {
    await api.deleteTakeoff(id)
    setTakeoffs(prev => prev.filter(t => t.id !== id))
    setSelectedId(prev => (prev === id ? null : prev))
  })

  // ── Category actions ──────────────────────────────────────────────────────
  const nextSort = (list: { sort_order: number }[]) => (list.length ? Math.max(...list.map(i => i.sort_order)) + 1 : 0)

  const onAddCategory = (name: string) => run(async () => {
    const c = await api.createCategory(selectedId!, name, nextSort(data.categories))
    setData(d => ({ ...d, categories: [...d.categories, c] }))
  })
  const onRenameCategory = (id: string, name: string) => run(async () => {
    const c = await api.updateCategory(selectedId!, id, { name })
    setData(d => ({ ...d, categories: d.categories.map(x => x.id === id ? c : x) }))
  })
  const onRemoveCategory = (id: string) => run(async () => {
    await api.deleteCategory(selectedId!, id)
    setData(d => ({ ...d, categories: d.categories.filter(x => x.id !== id) }))
  })

  // ── Room actions ──────────────────────────────────────────────────────────
  const onAddRoom = (name: string) => run(async () => {
    const r = await api.createRoom(selectedId!, name, nextSort(data.rooms))
    setData(d => ({ ...d, rooms: [...d.rooms, r] }))
  })
  const onRenameRoom = (id: string, name: string) => run(async () => {
    const r = await api.updateRoom(selectedId!, id, { name })
    setData(d => ({ ...d, rooms: d.rooms.map(x => x.id === id ? r : x) }))
  })
  const onRemoveRoom = (id: string) => run(async () => {
    await api.deleteRoom(selectedId!, id)
    setData(d => ({ ...d, rooms: d.rooms.filter(x => x.id !== id) }))
    pruneByRoom(id) // server cascaded its marks; drop them + any queued locally
    setActiveRoomId(prev => (prev === id ? null : prev))
  })

  // ── Tag actions ───────────────────────────────────────────────────────────
  const onAddTag = () => run(async () => {
    const sorted = [...data.categories].sort(bySort)
    const tag = await api.createTag(selectedId!, {
      code: `T${data.tags.length + 1}`,
      description: null,
      color: nextTagColor(data.tags.map(t => t.color)),
      category_id: sorted[0]?.id ?? null,
      sort_order: nextSort(data.tags),
    })
    setData(d => ({ ...d, tags: [...d.tags, tag] }))
    setActiveTagId(tag.id)
  })
  const onUpdateTag = (id: string, patch: { code?: string; description?: string | null; category_id?: string | null }) => run(async () => {
    const t = await api.updateTag(selectedId!, id, patch)
    setData(d => ({ ...d, tags: d.tags.map(x => x.id === id ? t : x) }))
  })
  const onRemoveTag = (id: string) => run(async () => {
    await api.deleteTag(selectedId!, id)
    setData(d => ({ ...d, tags: d.tags.filter(x => x.id !== id) }))
    pruneByTag(id) // server cascaded its marks; drop them + any queued locally
    setActiveTagId(prev => (prev === id ? null : prev))
  })

  // ── Reorder (swap sort_order with the neighbor in display order) ───────────
  function makeMove<T extends { id: string; sort_order: number }>(
    list: T[],
    patch: (id: string, sortOrder: number) => Promise<T>,
    apply: (rows: T[]) => void,
  ) {
    return (id: string, dir: -1 | 1) => run(async () => {
      const sorted = [...list].sort(bySort)
      const i = sorted.findIndex(x => x.id === id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= sorted.length) return
      const a = sorted[i], b = sorted[j]
      const [ua, ub] = await Promise.all([patch(a.id, b.sort_order), patch(b.id, a.sort_order)])
      const map = new Map(list.map(x => [x.id, x]))
      map.set(ua.id, ua); map.set(ub.id, ub)
      apply([...map.values()])
    })
  }
  const onMoveCategory = makeMove(
    data.categories,
    (id, s) => api.updateCategory(selectedId!, id, { sort_order: s }),
    rows => setData(d => ({ ...d, categories: rows as TakeoffCategory[] })),
  )
  const onMoveRoom = makeMove(
    data.rooms,
    (id, s) => api.updateRoom(selectedId!, id, { sort_order: s }),
    rows => setData(d => ({ ...d, rooms: rows as TakeoffRoom[] })),
  )
  const onMoveTag = makeMove(
    data.tags,
    (id, s) => api.updateTag(selectedId!, id, { sort_order: s }),
    rows => setData(d => ({ ...d, tags: rows as TakeoffTag[] })),
  )

  // ── Export ────────────────────────────────────────────────────────────────
  const onExport = () => {
    if (!selectedTakeoff) return
    setExporting(true)
    exportTakeoffToExcel({
      projectName,
      takeoffName: selectedTakeoff.name,
      matrix,
      dateStr: new Date().toISOString().slice(0, 10),
    })
      .catch(e => setError(e instanceof Error ? e.message : "Export failed"))
      .finally(() => setExporting(false))
  }

  const activeTag = activeTagId ? tagById.get(activeTagId) : null
  const activeTagNumber = (() => {
    const i = sortedTags.findIndex(t => t.id === activeTagId)
    return i >= 0 && i < 9 ? i + 1 : null
  })()
  const measuring = mode === "linear" || mode === "area"

  const navBtn = "h-6 w-6 inline-flex items-center justify-center rounded border border-[#E2E8F0] text-[#475569] text-[13px] leading-none hover:bg-[#F1F5F9] disabled:opacity-30 transition-colors"
  const modeBtn = (active: boolean) =>
    `px-2 py-1 text-[11px] font-semibold border-y border-r first:border-l first:rounded-l last:rounded-r transition-colors ${active ? "bg-[#5A7A94] text-white border-[#5A7A94]" : "border-[#E2E8F0] text-[#475569] hover:bg-[#F1F5F9]"}`

  if (loading) {
    return <div className="h-full flex items-center justify-center text-[13px] text-[#64748B]">Loading takeoff…</div>
  }

  return (
    <div className="flex h-full min-h-0">
      {/* LEFT — sheet header + reused viewer with count/measure overlay */}
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex-shrink-0 border-b border-[#E2E8F0] bg-white">
          {/* Row A — sheet + page + tool modes + save status + erase */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-bold uppercase tracking-wide text-[#475569]">Sheet</span>
              <select
                value={sheetId ?? ""}
                onChange={e => { setSheetId(e.target.value || null); setPage(0); setPageCount(1) }}
                disabled={sheets.length === 0}
                className="border border-[#E2E8F0] rounded px-2 py-1 text-[12px] focus:outline-none focus:border-[#5A7A94] max-w-[240px]"
              >
                {sheets.length === 0 && <option value="">No sheets in Drawings</option>}
                {sheets.map(s => (
                  <option key={s.id} value={s.id}>{[s.sheet_number, s.sheet_title].filter(Boolean).join(" — ") || "Untitled sheet"}</option>
                ))}
              </select>
            </div>

            {selectedSheet && pageCount > 1 && (
              <div className="flex items-center gap-1">
                <span className="text-[11px] font-bold uppercase tracking-wide text-[#475569]">Page</span>
                <button className={navBtn} disabled={page <= 0} onClick={() => setPage(p => Math.max(0, p - 1))} title="Previous page (PgUp)">‹</button>
                <span className="text-[12px] tabular-nums font-semibold text-[#1A2840] px-0.5 min-w-[44px] text-center">{page + 1} / {pageCount}</span>
                <button className={navBtn} disabled={page >= pageCount - 1} onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))} title="Next page (PgDn)">›</button>
              </div>
            )}

            {/* Tool mode selector */}
            {selectedId && (
              <div className="inline-flex" role="group" aria-label="Tool">
                <button className={modeBtn(mode === "count" && !erasing)} onClick={() => setMode("count")} title="Count tool (C)">Count</button>
                <button className={modeBtn(mode === "linear" && !erasing)} onClick={() => setMode("linear")} title="Linear measure (L)">Linear</button>
                <button className={modeBtn(mode === "area" && !erasing)} onClick={() => setMode("area")} title="Area measure (A)">Area</button>
                <button className={modeBtn(mode === "scale" && !erasing)} onClick={() => setMode("scale")} title="Set scale (S)">Scale</button>
              </div>
            )}

            {/* Scale status for the current page */}
            {selectedId && sheetId && (
              currentScale ? (
                <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-semibold bg-[#CCFBF1] text-[#0F766E] border border-[#5EEAD4]" title="This page is calibrated">
                  ✓ Scaled ({currentScale.unit})
                  <button onClick={() => setMode("scale")} className="underline underline-offset-2 hover:no-underline" title="Recalibrate">edit</button>
                  <button onClick={clearScale} className="opacity-70 hover:opacity-100" title="Clear scale">✕</button>
                </span>
              ) : (
                <button
                  onClick={() => setMode("scale")}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-semibold bg-[#FEF3C7] text-[#92400E] border border-[#FCD34D]"
                  title="No scale on this page — measurements can't be priced until you set one"
                >⚠ Needs scale</button>
              )
            )}

            <div className="ml-auto flex items-center gap-2">
              {failedCount > 0 ? (
                <button
                  onClick={retryMarks}
                  className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-semibold bg-[#FEF2F2] text-[#B91C1C] border border-[#FCA5A5]"
                  title="Some marks failed to save — click to retry"
                >⚠ {failedCount} unsaved · Retry</button>
              ) : syncing ? (
                <span className="inline-flex items-center gap-1 text-[11px] text-[#94A3B8]">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#F59E0B] animate-pulse" /> Saving{pendingCount > 1 ? ` ${pendingCount}` : ""}…
                </span>
              ) : syncMarks.length > 0 ? (
                <span className="inline-flex items-center gap-1 text-[11px] text-[#94A3B8]">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#16A34A]" /> Saved
                </span>
              ) : null}

              <button
                onClick={() => setEraseMode(m => !m)}
                disabled={!selectedId}
                className={`inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-semibold border transition-colors disabled:opacity-40 ${erasing ? "bg-[#DC2626] text-white border-[#DC2626]" : "border-[#E2E8F0] text-[#475569] hover:bg-[#F1F5F9]"}`}
                title="Erase mode (E) — click a mark or drag a box to delete. Hold Shift to erase temporarily. Esc to exit."
              >{erasing ? "Erasing — Esc" : "Erase"}</button>

              <button
                onClick={undoMark}
                disabled={!canUndo}
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-semibold border border-[#E2E8F0] text-[#475569] hover:bg-[#F1F5F9] disabled:opacity-40 transition-colors"
                title="Undo last mark (Ctrl+Z)"
              >↶ Undo</button>
            </div>
          </div>

          {/* Row B — sticky context line (what a click does right now) */}
          {selectedId && (
            <div className="flex flex-wrap items-center gap-2 px-3 pb-2 -mt-0.5 text-[11px]">
              {erasing ? (
                <span className="text-[#DC2626] font-semibold">Erase — click a mark or drag a box to delete</span>
              ) : mode === "scale" ? (
                <span className="text-[#0F766E]">Set scale — draw a segment over a known dimension, then enter its real length.</span>
              ) : (
                <>
                  <span className="text-[#475569]">{measuring ? (mode === "area" ? "Area into" : "Linear into") : "Counting"}</span>
                  {activeTag ? (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-white font-semibold" style={{ backgroundColor: activeTag.color }}>
                      {activeTagNumber && <span className="opacity-75">{activeTagNumber}·</span>}{activeTag.code}
                    </span>
                  ) : <span className="text-[#94A3B8]">— add or select a tag</span>}
                  {!measuring && <span className="text-[#64748B]">into</span>}
                  <div className="inline-flex items-center gap-0.5">
                    <button className={navBtn} disabled={sortedRooms.length === 0} onClick={() => cycleRoom(-1)} title="Previous room ([)">‹</button>
                    <select
                      value={activeRoomId ?? ""}
                      onChange={e => setActiveRoomId(e.target.value || null)}
                      disabled={sortedRooms.length === 0}
                      className="border border-[#5A7A94] rounded px-2 py-0.5 text-[12px] font-semibold text-[#1A2840] bg-[#5A7A94]/5 focus:outline-none focus:border-[#3d5a72] max-w-[180px]"
                      title="Current room"
                    >
                      {sortedRooms.length === 0 && <option value="">No rooms yet</option>}
                      {sortedRooms.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </select>
                    <button className={navBtn} disabled={sortedRooms.length === 0} onClick={() => cycleRoom(1)} title="Next room (])">›</button>
                  </div>
                  {measuring && !currentScale && <span className="ml-1 text-[#92400E] font-semibold">page needs a scale to price these</span>}
                  {!canPlace && <span className="ml-1 text-[#94A3B8]">{!sheetId ? "Select a sheet" : !activeTagId ? "Add/select a tag" : !activeRoomId ? "Select a room" : ""}</span>}
                </>
              )}
            </div>
          )}
        </div>

        <div className="flex-1 min-h-0 bg-[#F1F3F5]">
          {selectedSheet && selectedSheet.file_url ? (
            <CountViewer
              baseUrl={selectedSheet.file_url}
              sheetKey={selectedSheet.id}
              title={[selectedSheet.sheet_number, selectedSheet.sheet_title].filter(Boolean).join(" — ")}
              page={page}
              mode={mode}
              marks={viewerMarks}
              measuredMarks={measuredViewerMarks}
              scaleSeg={currentScale ? { x1: currentScale.cal_x1, y1: currentScale.cal_y1, x2: currentScale.cal_x2, y2: currentScale.cal_y2 } : null}
              draftColor={activeTag?.color ?? "#5A7A94"}
              canPlace={canPlace}
              canMeasure={canPlace}
              canScale={canScale}
              erasing={erasing}
              onPlace={onPlace}
              onDelete={onDeleteMark}
              onDeleteMany={onDeleteMany}
              onCommitMeasure={onCommitMeasure}
              onScaleDrawn={onScaleDrawn}
              onPagesLoaded={setPageCount}
            />
          ) : (
            <div className="h-full flex items-center justify-center text-center px-6">
              <p className="text-[13px] text-[#94A3B8] max-w-xs">
                {sheets.length === 0
                  ? "No drawing sheets yet. Upload sheets under Drawings, then take off quantities here."
                  : "Select a sheet to start."}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* RIGHT — controls + matrix */}
      <div className="w-[460px] shrink-0 overflow-y-auto border-l border-[#E2E8F0] bg-[#FBFCFD] p-3">
        {error && (
          <div className="mb-3 rounded border border-[#FCA5A5] bg-[#FEF2F2] px-2.5 py-1.5 text-[12px] text-[#B91C1C]">{error}</div>
        )}
        {failedCount > 0 && (
          <div className="mb-3 flex items-center justify-between gap-2 rounded border border-[#FCA5A5] bg-[#FEF2F2] px-2.5 py-1.5 text-[12px] text-[#B91C1C]">
            <span>{failedCount} mark{failedCount > 1 ? "s" : ""} didn’t save.</span>
            <button onClick={retryMarks} className="font-semibold underline underline-offset-2">Retry</button>
          </div>
        )}
        <TakeoffControls
          takeoffs={takeoffs}
          selectedTakeoffId={selectedId}
          onSelectTakeoff={setSelectedId}
          onCreateTakeoff={onCreateTakeoff}
          onDeleteTakeoff={onDeleteTakeoff}
          categories={[...data.categories].sort(bySort)}
          rooms={sortedRooms}
          tags={sortedTags}
          activeTagId={activeTagId}
          activeRoomId={activeRoomId}
          setActiveTagId={setActiveTagId}
          setActiveRoomId={setActiveRoomId}
          onAddCategory={onAddCategory}
          onRenameCategory={onRenameCategory}
          onRemoveCategory={onRemoveCategory}
          onMoveCategory={onMoveCategory}
          onAddRoom={onAddRoom}
          onRenameRoom={onRenameRoom}
          onRemoveRoom={onRemoveRoom}
          onMoveRoom={onMoveRoom}
          onAddTag={onAddTag}
          onUpdateTag={onUpdateTag}
          onRemoveTag={onRemoveTag}
          onMoveTag={onMoveTag}
          busy={busy}
        />
        {selectedId && (
          <>
            <div className="mt-4"><TakeoffMatrix matrix={matrix} onExport={onExport} exporting={exporting} /></div>
            <div className="mt-4 border-t border-[#E2E8F0] pt-2 text-[10px] leading-relaxed text-[#94A3B8]">
              <span className="font-semibold text-[#64748B]">Shortcuts</span> · <b className="text-[#475569]">C/L/A/S</b> count/linear/area/scale · <b className="text-[#475569]">1–9</b> pick tag · <b className="text-[#475569]">[ ]</b> room · <b className="text-[#475569]">E</b> erase · <b className="text-[#475569]">⏎</b> finish shape · <b className="text-[#475569]">Ctrl+Z</b> undo{pageCount > 1 && <> · <b className="text-[#475569]">PgUp/PgDn</b> page</>}
            </div>
          </>
        )}
      </div>

      {scaleDraft && (
        <ScaleDialog
          page={page}
          defaultUnit={currentScale?.unit ?? "ft"}
          onSave={confirmScale}
          onCancel={() => setScaleDraft(null)}
        />
      )}
    </div>
  )
}

// Modal: after the user draws a calibration segment, capture its real-world length
// + unit. units_per_px is computed by the caller (realLength / drawn segment length).
function ScaleDialog({ page, defaultUnit, onSave, onCancel }: {
  page: number
  defaultUnit: ScaleUnit
  onSave: (realLength: number, unit: ScaleUnit) => void
  onCancel: () => void
}) {
  const [len, setLen] = useState("")
  const [unit, setUnit] = useState<ScaleUnit>(defaultUnit)
  const num = parseFloat(len)
  const valid = Number.isFinite(num) && num > 0
  const submit = () => { if (valid) onSave(num, unit) }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onCancel}>
      <div className="w-[320px] rounded-lg bg-white p-4 shadow-xl" onClick={e => e.stopPropagation()}>
        <h3 className="text-[13px] font-bold text-[#1A2840]">Set scale — page {page + 1}</h3>
        <p className="mt-1 text-[11px] text-[#64748B]">Enter the real-world length of the segment you drew.</p>
        <div className="mt-3 flex items-center gap-2">
          <input
            autoFocus
            type="number"
            min="0"
            step="any"
            value={len}
            onChange={e => setLen(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") submit(); if (e.key === "Escape") onCancel() }}
            placeholder="e.g. 20"
            className="w-24 border border-[#E2E8F0] rounded px-2 py-1.5 text-[13px] focus:outline-none focus:border-[#5A7A94]"
          />
          <select
            value={unit}
            onChange={e => setUnit(e.target.value as ScaleUnit)}
            className="border border-[#E2E8F0] rounded px-2 py-1.5 text-[13px] focus:outline-none focus:border-[#5A7A94]"
          >
            <option value="ft">ft</option>
            <option value="in">in</option>
            <option value="m">m</option>
          </select>
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button onClick={onCancel} className="px-2.5 py-1 rounded text-[12px] text-[#64748B] hover:bg-[#F1F5F9]">Cancel</button>
          <button onClick={submit} disabled={!valid} className="px-3 py-1 rounded bg-[#5A7A94] text-white text-[12px] font-semibold disabled:opacity-40">Save scale</button>
        </div>
      </div>
    </div>
  )
}
