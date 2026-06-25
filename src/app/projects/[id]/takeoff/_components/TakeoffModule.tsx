"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import CountViewer, { type ViewerMark } from "./CountViewer"
import TakeoffControls from "./TakeoffControls"
import TakeoffMatrix from "./TakeoffMatrix"
import { computeMatrix } from "../_lib/matrix"
import { exportTakeoffToExcel } from "../_lib/excel"
import { nextTagColor } from "../_lib/colors"
import * as api from "../_lib/api"
import type {
  Takeoff, TakeoffBundle, TakeoffCategory, TakeoffRoom, TakeoffTag, CountSheet,
} from "../_lib/types"

const EMPTY_BUNDLE: Omit<TakeoffBundle, "takeoff"> = { categories: [], rooms: [], tags: [], marks: [] }

// Bid Takeoff — two-pane workspace. LEFT: the reused pdf.js sheet viewer with our
// count-dot overlay. RIGHT: takeoff/category/tag/room controls + the live matrix +
// Excel export. Project-scoped: every takeoff belongs to this project.
export default function TakeoffModule({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [takeoffs, setTakeoffs] = useState<Takeoff[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [data, setData] = useState<Omit<TakeoffBundle, "takeoff">>(EMPTY_BUNDLE)

  const [sheets, setSheets] = useState<CountSheet[]>([])
  const [sheetId, setSheetId] = useState<string | null>(null)

  const [activeTagId, setActiveTagId] = useState<string | null>(null)
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null)

  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  // Load the selected takeoff's bundle; seed the active tag/room.
  useEffect(() => {
    if (!selectedId) { setData(EMPTY_BUNDLE); setActiveTagId(null); setActiveRoomId(null); return }
    let alive = true
    api.getBundle(selectedId)
      .then(b => {
        if (!alive) return
        setData({ categories: b.categories, rooms: b.rooms, tags: b.tags, marks: b.marks })
        const rooms = [...b.rooms].sort((a, z) => a.sort_order - z.sort_order)
        const tags = [...b.tags].sort((a, z) => a.sort_order - z.sort_order)
        setActiveRoomId(rooms[0]?.id ?? null)
        setActiveTagId(tags[0]?.id ?? null)
      })
      .catch(e => { if (alive) setError(e instanceof Error ? e.message : "Failed to load takeoff") })
    return () => { alive = false }
  }, [selectedId])

  const selectedTakeoff = takeoffs.find(t => t.id === selectedId) ?? null
  const selectedSheet = sheets.find(s => s.id === sheetId) ?? null
  const tagById = useMemo(() => new Map(data.tags.map(t => [t.id, t])), [data.tags])

  const matrix = useMemo(
    () => computeMatrix(data.categories, data.rooms, data.tags, data.marks),
    [data.categories, data.rooms, data.tags, data.marks],
  )

  // Dots for the open sheet only (this sheet's source_ref, page 0).
  const viewerMarks: ViewerMark[] = useMemo(() => {
    if (!sheetId) return []
    return data.marks
      .filter(m => m.source_ref === sheetId && m.page === 0)
      .map(m => {
        const tag = tagById.get(m.tag_id)
        return { id: m.id, x: m.x, y: m.y, color: tag?.color ?? "#64748B", code: tag?.code ?? "?" }
      })
  }, [data.marks, sheetId, tagById])

  const canPlace = !!(selectedId && sheetId && activeTagId && activeRoomId)

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

  // ── Count place / delete ──────────────────────────────────────────────────
  const onPlace = (x: number, y: number) => {
    if (!selectedId || !activeTagId || !activeRoomId || !sheetId) return
    run(async () => {
      const mark = await api.createMark(selectedId, {
        tag_id: activeTagId, room_id: activeRoomId, source_ref: sheetId, page: 0, x, y,
      })
      setData(d => ({ ...d, marks: [...d.marks, mark] }))
    })
  }
  const onDeleteMark = (markId: string) => {
    if (!selectedId) return
    run(async () => {
      await api.deleteMark(selectedId, markId)
      setData(d => ({ ...d, marks: d.marks.filter(m => m.id !== markId) }))
    })
  }

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
    setData(d => ({
      ...d,
      rooms: d.rooms.filter(x => x.id !== id),
      marks: d.marks.filter(m => m.room_id !== id), // server cascaded its marks
    }))
    setActiveRoomId(prev => (prev === id ? null : prev))
  })

  // ── Tag actions ───────────────────────────────────────────────────────────
  const onAddTag = () => run(async () => {
    const sorted = [...data.categories].sort((a, z) => a.sort_order - z.sort_order)
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
    setData(d => ({
      ...d,
      tags: d.tags.filter(x => x.id !== id),
      marks: d.marks.filter(m => m.tag_id !== id), // server cascaded its marks
    }))
    setActiveTagId(prev => (prev === id ? null : prev))
  })

  // ── Reorder (swap sort_order with the neighbor in display order) ───────────
  function makeMove<T extends { id: string; sort_order: number }>(
    list: T[],
    patch: (id: string, sortOrder: number) => Promise<T>,
    apply: (rows: T[]) => void,
  ) {
    return (id: string, dir: -1 | 1) => run(async () => {
      const sorted = [...list].sort((a, z) => a.sort_order - z.sort_order)
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
  const activeRoom = data.rooms.find(r => r.id === activeRoomId) ?? null

  if (loading) {
    return <div className="h-full flex items-center justify-center text-[13px] text-[#64748B]">Loading takeoff…</div>
  }

  return (
    <div className="flex h-full min-h-0">
      {/* LEFT — sheet header + reused viewer with count overlay */}
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex-shrink-0 flex items-center gap-2 px-3 py-2 border-b border-[#E2E8F0] bg-white">
          <span className="text-[11px] font-bold uppercase tracking-wide text-[#475569]">Sheet</span>
          <select
            value={sheetId ?? ""}
            onChange={e => setSheetId(e.target.value || null)}
            disabled={sheets.length === 0}
            className="border border-[#E2E8F0] rounded px-2 py-1 text-[12px] focus:outline-none focus:border-[#5A7A94] max-w-[280px]"
          >
            {sheets.length === 0 && <option value="">No sheets in Drawings</option>}
            {sheets.map(s => (
              <option key={s.id} value={s.id}>{[s.sheet_number, s.sheet_title].filter(Boolean).join(" — ") || "Untitled sheet"}</option>
            ))}
          </select>
          <div className="ml-auto text-[11px]">
            {canPlace && activeTag && activeRoom ? (
              <span className="inline-flex items-center gap-1.5 text-[#475569]">
                Counting
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-white font-semibold" style={{ backgroundColor: activeTag.color }}>{activeTag.code}</span>
                into <span className="font-semibold text-[#1A2840]">{activeRoom.name}</span>
              </span>
            ) : (
              <span className="text-[#94A3B8]">{!selectedId ? "Create a takeoff to start" : !activeTagId ? "Add/select a tag" : !activeRoomId ? "Select a room" : "Select a sheet"}</span>
            )}
          </div>
        </div>
        <div className="flex-1 min-h-0 bg-[#F1F3F5]">
          {selectedSheet && selectedSheet.file_url ? (
            <CountViewer
              baseUrl={selectedSheet.file_url}
              sheetKey={selectedSheet.id}
              title={[selectedSheet.sheet_number, selectedSheet.sheet_title].filter(Boolean).join(" — ")}
              marks={viewerMarks}
              canPlace={canPlace}
              onPlace={onPlace}
              onDelete={onDeleteMark}
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
        <TakeoffControls
          takeoffs={takeoffs}
          selectedTakeoffId={selectedId}
          onSelectTakeoff={setSelectedId}
          onCreateTakeoff={onCreateTakeoff}
          onDeleteTakeoff={onDeleteTakeoff}
          categories={[...data.categories].sort((a, z) => a.sort_order - z.sort_order)}
          rooms={[...data.rooms].sort((a, z) => a.sort_order - z.sort_order)}
          tags={[...data.tags].sort((a, z) => a.sort_order - z.sort_order)}
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
        {selectedId && <div className="mt-4"><TakeoffMatrix matrix={matrix} onExport={onExport} exporting={exporting} /></div>}
      </div>
    </div>
  )
}
