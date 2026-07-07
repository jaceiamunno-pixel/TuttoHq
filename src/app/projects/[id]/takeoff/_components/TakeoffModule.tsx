"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import CountViewer, { type ViewerMark } from "./CountViewer"
import TakeoffControls from "./TakeoffControls"
import TakeoffMatrix from "./TakeoffMatrix"
import { computeMatrix } from "../_lib/matrix"
import { exportTakeoffToExcel } from "../_lib/excel"
import { nextTagColor } from "../_lib/colors"
import { useMarkSync } from "../_lib/useMarkSync"
import * as api from "../_lib/api"
import type {
  Takeoff, TakeoffBundle, TakeoffCategory, TakeoffRoom, TakeoffTag, CountSheet,
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

// Bid Takeoff — two-pane workspace. LEFT: the reused pdf.js sheet viewer with our
// count-dot overlay. RIGHT: takeoff/category/tag/room controls + the live matrix +
// Excel export. Project-scoped: every takeoff belongs to this project.
export default function TakeoffModule({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [takeoffs, setTakeoffs] = useState<Takeoff[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [data, setData] = useState<TakeoffData>(EMPTY_DATA)

  const [sheets, setSheets] = useState<CountSheet[]>([])
  const [sheetId, setSheetId] = useState<string | null>(null)
  const [page, setPage] = useState(0)          // 0-indexed page of the open sheet
  const [pageCount, setPageCount] = useState(1)

  const [activeTagId, setActiveTagId] = useState<string | null>(null)
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null)

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
    if (!selectedId) { setData(EMPTY_DATA); setActiveTagId(null); setActiveRoomId(null); resetMarks([], null); return }
    let alive = true
    api.getBundle(selectedId)
      .then(b => {
        if (!alive) return
        setData({ categories: b.categories, rooms: b.rooms, tags: b.tags })
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

  const matrix = useMemo(
    () => computeMatrix(data.categories, data.rooms, data.tags, syncMarks),
    [data.categories, data.rooms, data.tags, syncMarks],
  )

  // Dots for the open sheet + current page only. React key is the mark's stable
  // _key (survives the temp→real id swap, so a saved dot never remounts).
  const viewerMarks: ViewerMark[] = useMemo(() => {
    if (!sheetId) return []
    return syncMarks
      .filter(m => m.source_ref === sheetId && m.page === page)
      .map(m => {
        const tag = tagById.get(m.tag_id)
        return { id: m._key, x: m.x, y: m.y, color: tag?.color ?? "#64748B", code: tag?.code ?? "?" }
      })
  }, [syncMarks, sheetId, page, tagById])

  const canPlace = !!(selectedId && sheetId && activeTagId && activeRoomId)

  // ── Count place / delete (instant, optimistic) ────────────────────────────
  const onPlace = useCallback((x: number, y: number) => {
    if (!selectedId || !activeTagId || !activeRoomId || !sheetId) return
    if (erasing) return
    placeMark({ tag_id: activeTagId, room_id: activeRoomId, source_ref: sheetId, page, x, y })
  }, [selectedId, activeTagId, activeRoomId, sheetId, page, erasing, placeMark])
  const onDeleteMark = useCallback((key: string) => removeMark(key), [removeMark])
  const onDeleteMany = useCallback((keys: string[]) => { for (const k of keys) removeMark(k) }, [removeMark])

  // ── Room quick-switch (buttons + [ ] keys) ────────────────────────────────
  const cycleRoom = useCallback((dir: -1 | 1) => {
    if (sortedRooms.length === 0) return
    const i = sortedRooms.findIndex(r => r.id === activeRoomId)
    const next = sortedRooms[(((i < 0 ? 0 : i) + dir) % sortedRooms.length + sortedRooms.length) % sortedRooms.length]
    if (next) setActiveRoomId(next.id)
  }, [sortedRooms, activeRoomId])

  // ── Keyboard-first counting flow ──────────────────────────────────────────
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

  // Guard against closing the tab while any count is still unsent.
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

  const navBtn = "h-6 w-6 inline-flex items-center justify-center rounded border border-[#E2E8F0] text-[#475569] text-[13px] leading-none hover:bg-[#F1F5F9] disabled:opacity-30 transition-colors"

  if (loading) {
    return <div className="h-full flex items-center justify-center text-[13px] text-[#64748B]">Loading takeoff…</div>
  }

  return (
    <div className="flex h-full min-h-0">
      {/* LEFT — sheet header + reused viewer with count overlay */}
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex-shrink-0 border-b border-[#E2E8F0] bg-white">
          {/* Row A — sheet + page + save status + erase */}
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

            <div className="ml-auto flex items-center gap-2">
              {failedCount > 0 ? (
                <button
                  onClick={retryMarks}
                  className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-semibold bg-[#FEF2F2] text-[#B91C1C] border border-[#FCA5A5]"
                  title="Some counts failed to save — click to retry"
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
                title="Erase mode (E) — click a dot or drag a box to delete. Hold Shift to erase temporarily. Esc to exit."
              >{erasing ? "Erasing — Esc" : "Erase"}</button>

              <button
                onClick={undoMark}
                disabled={!canUndo}
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-semibold border border-[#E2E8F0] text-[#475569] hover:bg-[#F1F5F9] disabled:opacity-40 transition-colors"
                title="Undo last count (Ctrl+Z)"
              >↶ Undo</button>
            </div>
          </div>

          {/* Row B — sticky "counting into" (active tag + current room switcher) */}
          {selectedId && (
            <div className="flex flex-wrap items-center gap-2 px-3 pb-2 -mt-0.5 text-[11px]">
              <span className="text-[#475569]">Counting</span>
              {activeTag ? (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-white font-semibold" style={{ backgroundColor: activeTag.color }}>
                  {activeTagNumber && <span className="opacity-75">{activeTagNumber}·</span>}{activeTag.code}
                </span>
              ) : <span className="text-[#94A3B8]">— add or select a tag</span>}
              <span className="text-[#64748B]">into</span>
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
              {erasing
                ? <span className="ml-1 text-[#DC2626] font-semibold">Erase — click a dot or drag a box to delete</span>
                : !canPlace && <span className="ml-1 text-[#94A3B8]">{!sheetId ? "Select a sheet" : !activeTagId ? "Add/select a tag" : !activeRoomId ? "Select a room" : ""}</span>}
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
              marks={viewerMarks}
              canPlace={canPlace}
              erasing={erasing}
              onPlace={onPlace}
              onDelete={onDeleteMark}
              onDeleteMany={onDeleteMany}
              onPagesLoaded={setPageCount}
            />
          ) : (
            <div className="h-full flex items-center justify-center text-center px-6">
              <p className="text-[13px] text-[#94A3B8] max-w-xs">
                {sheets.length === 0
                  ? "No drawing sheets yet. Upload sheets under Drawings, then count them here."
                  : "Select a sheet to start counting."}
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
            <span>{failedCount} count{failedCount > 1 ? "s" : ""} didn’t save.</span>
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
              <span className="font-semibold text-[#64748B]">Shortcuts</span> · <b className="text-[#475569]">1–9</b> pick tag · <b className="text-[#475569]">[ ]</b> prev/next room · <b className="text-[#475569]">E</b> erase (click or drag a box) · <b className="text-[#475569]">Ctrl+Z</b> undo{pageCount > 1 && <> · <b className="text-[#475569]">PgUp/PgDn</b> page</>}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
