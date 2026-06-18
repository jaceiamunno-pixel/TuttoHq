"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { getDocumentProxy, renderPageAsImage } from "unpdf"
import {
  DEFAULT_STYLE, FONT_PRESETS, MARKUP_COLORS, STROKE_PRESETS,
  boundingBox, deserializeMarkups, hitTest, newMarkupId, serializeMarkups, translateMarkup,
  type Markup, type MarkupDoc, type MarkupStyle, type Point,
} from "@/lib/drawing-markup"
import { SpinnerIcon } from "../../app/dashboard/_shared/icons"

// In-app drawing markup editor (ADR-005 Phase 2, Part 1 — editor + serialization
// only; NO persistence). Renders the sheet's first PDF page (via unpdf, the same
// client-side path the splitter uses) as a static background, overlays an SVG
// markup layer sized exactly to it, and produces the vector array defined in
// @/lib/drawing-markup. `onSave` just hands that array back — wiring it to a new
// drawing_revisions row is Part 2, after the jsonb column lands.

type Tool = "select" | "line" | "rect" | "arrow" | "text"

const RENDER_WIDTH = 1800 // page raster width (px); displayed scaled-to-fit

// ── Local toolbar icons (the shared icon set doesn't cover these) ────────────
const ic = "h-4 w-4"
const CursorIcon = () => <svg className={ic} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M5 3l5.5 16 2.2-6.3 6.3-2.2L5 3z" /></svg>
const PenIcon = () => <svg className={ic} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M4 20l4-1 9.5-9.5a2 2 0 000-2.8l-.7-.7a2 2 0 00-2.8 0L4.5 15.5 4 20z" /></svg>
const RectIcon = () => <svg className={ic} fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="4" y="6" width="16" height="12" rx="1" strokeWidth={1.8} /></svg>
const ArrowIcon = () => <svg className={ic} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M5 19L19 5M19 5h-7M19 5v7" /></svg>
const TextIcon = () => <svg className={ic} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M5 6h14M12 6v13M9 19h6" /></svg>
const UndoIcon = () => <svg className={ic} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M9 14L4 9l5-5M4 9h11a5 5 0 010 10h-3" /></svg>
const RedoIcon = () => <svg className={ic} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M15 14l5-5-5-5M20 9H9a5 5 0 000 10h3" /></svg>
const TrashIcon = () => <svg className={ic} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M5 7h14M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-7 0v12a1 1 0 001 1h6a1 1 0 001-1V7" /></svg>

const TOOLS: { tool: Tool; label: string; Icon: () => React.ReactElement }[] = [
  { tool: "select", label: "Select", Icon: CursorIcon },
  { tool: "line", label: "Pen", Icon: PenIcon },
  { tool: "rect", label: "Box", Icon: RectIcon },
  { tool: "arrow", label: "Arrow", Icon: ArrowIcon },
  { tool: "text", label: "Text", Icon: TextIcon },
]

const STROKE_OPTS: { key: keyof typeof STROKE_PRESETS; label: string }[] = [
  { key: "thin", label: "S" }, { key: "medium", label: "M" }, { key: "thick", label: "L" },
]

export default function MarkupEditor({ fileUrl, initialMarkups, baseRevisionId, baseLabel, markupRevisionId, onSave }: {
  fileUrl: string
  /** Markup[] or a stored MarkupDoc — deserializeMarkups handles either. */
  initialMarkups?: Markup[] | MarkupDoc | null
  /** The revision this layer is drawn over (its base) — recorded in the doc. */
  baseRevisionId?: string | null
  baseLabel?: string | null
  /** Existing markup-layer revision id (UPDATE target); null until first save. */
  markupRevisionId?: string | null
  /** Persist the doc; returns the (new/updated) markup-layer id. May be async. */
  onSave?: (doc: MarkupDoc, markupRevisionId: string | null) => Promise<string | void> | string | void
}) {
  // ── Background page render ────────────────────────────────────────────────
  const [pageImg, setPageImg] = useState<string | null>(null)
  const [aspect, setAspect] = useState<number | null>(null) // width / height
  const [renderState, setRenderState] = useState<"loading" | "ready" | "error">("loading")

  useEffect(() => {
    let alive = true
    setRenderState("loading"); setPageImg(null); setAspect(null)
    ;(async () => {
      try {
        const ab = await (await fetch(fileUrl)).arrayBuffer()
        const pdf = await getDocumentProxy(new Uint8Array(ab))
        const dataUrl = await renderPageAsImage(pdf, 1, { width: RENDER_WIDTH, toDataURL: true }) as string
        if (!alive) return
        // Measure intrinsic size for the fit math + normalized coordinate space.
        const dims = await new Promise<{ w: number; h: number }>((res, rej) => {
          const img = new Image()
          img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight })
          img.onerror = () => rej(new Error("decode failed"))
          img.src = dataUrl
        })
        if (!alive) return
        setPageImg(dataUrl)
        setAspect(dims.w / dims.h)
        setRenderState("ready")
      } catch {
        if (alive) setRenderState("error")
      }
    })()
    return () => { alive = false }
  }, [fileUrl])

  // ── Fit the page into the available area (compute displayed px size) ───────
  const areaRef = useRef<HTMLDivElement>(null)
  const [area, setArea] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      const cr = entries[0].contentRect
      setArea({ w: cr.width, h: cr.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Displayed page box (px) = the largest aspect-correct rect fitting `area`.
  const disp = useMemo(() => {
    if (!aspect || area.w <= 0 || area.h <= 0) return { w: 0, h: 0 }
    const w = Math.min(area.w, area.h * aspect)
    return { w, h: w / aspect }
  }, [aspect, area])

  // ── Markup state + undo/redo history ──────────────────────────────────────
  // `initialMarkups` is read once here as the seed. The editor is conditionally
  // mounted (markup mode on the viewer), so it remounts — and re-seeds — on each
  // open; that, not a sync effect, is what makes reopening round-trip the saved
  // markups. (A sync effect would also wipe undo history on every save, since
  // saving changes the prop's identity.)
  const [present, setPresent] = useState<Markup[]>(() => initialMarkups ? deserializeMarkups(initialMarkups) : [])
  const [past, setPast] = useState<Markup[][]>([])
  const [future, setFuture] = useState<Markup[][]>([])

  const commit = useCallback((next: Markup[]) => {
    setPast(p => [...p, present]); setPresent(next); setFuture([])
  }, [present])
  // Commit a mutation whose starting point was snapshotted earlier (drag/draw).
  const commitFrom = useCallback((snapshot: Markup[], next: Markup[]) => {
    setPast(p => [...p, snapshot]); setPresent(next); setFuture([])
  }, [])
  // Plain setState calls (no setState nested inside another updater — that
  // double-fires under dev StrictMode and would duplicate history entries).
  const undo = useCallback(() => {
    if (past.length === 0) return
    setPast(past.slice(0, -1))
    setFuture(f => [present, ...f])
    setPresent(past[past.length - 1])
    setSelectedId(null)
  }, [past, present])
  const redo = useCallback(() => {
    if (future.length === 0) return
    setFuture(future.slice(1))
    setPast(p => [...p, present])
    setPresent(future[0])
    setSelectedId(null)
  }, [future, present])

  // ── Tool + style + selection ──────────────────────────────────────────────
  const [tool, setTool] = useState<Tool>("select")
  const [style, setStyle] = useState<MarkupStyle>(DEFAULT_STYLE)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const nextZ = useMemo(() => present.reduce((m, x) => Math.max(m, x.z), 0) + 1, [present])

  // Draft = the shape being drawn right now (kept out of `present` until commit).
  const [draft, setDraft] = useState<Markup | null>(null)
  const drawSnapshot = useRef<Markup[] | null>(null)
  // Drag = moving an existing markup in select mode.
  const dragRef = useRef<{ id: string; start: Point; original: Markup; snapshot: Markup[]; moved: boolean } | null>(null)
  // Inline text editing overlay.
  const [editing, setEditing] = useState<{ id: string | null; x: number; y: number; value: string } | null>(null)
  const [saving, setSaving] = useState(false)
  // The markup-layer revision being edited. Seeded from the prop (reopen),
  // updated to the returned id after the first save so same-session re-saves
  // UPDATE the same row instead of stacking a new one.
  const [markupRevId, setMarkupRevId] = useState<string | null>(markupRevisionId ?? null)

  const svgRef = useRef<SVGSVGElement>(null)
  const pxToNorm = useCallback((clientX: number, clientY: number): Point => {
    const r = svgRef.current!.getBoundingClientRect()
    const x = r.width ? (clientX - r.left) / r.width : 0
    const y = r.height ? (clientY - r.top) / r.height : 0
    return { x: x < 0 ? 0 : x > 1 ? 1 : x, y: y < 0 ? 0 : y > 1 ? 1 : y }
  }, [])

  // Apply the current style to the selected markup (and record it for undo).
  const applyStyle = useCallback((patch: Partial<MarkupStyle>) => {
    setStyle(s => ({ ...s, ...patch }))
    if (selectedId) {
      commit(present.map(m => m.id === selectedId ? { ...m, style: { ...m.style, ...patch } } : m))
    }
  }, [selectedId, present, commit])

  const deleteSelected = useCallback(() => {
    if (!selectedId) return
    commit(present.filter(m => m.id !== selectedId)); setSelectedId(null)
  }, [selectedId, present, commit])

  // ── Pointer interaction ───────────────────────────────────────────────────
  function onPointerDown(e: React.PointerEvent) {
    if (editing) return // let the text input own the click
    const p = pxToNorm(e.clientX, e.clientY)

    if (tool === "text") {
      setEditing({ id: null, x: p.x, y: p.y, value: "" })
      return
    }

    if (tool === "select") {
      // Topmost (highest z) markup under the cursor wins.
      const hit = [...present].sort((a, b) => b.z - a.z).find(m => hitTest(m, p))
      if (hit) {
        setSelectedId(hit.id)
        setStyle(hit.style)
        dragRef.current = { id: hit.id, start: p, original: hit, snapshot: present, moved: false }
        svgRef.current?.setPointerCapture(e.pointerId)
      } else {
        setSelectedId(null)
      }
      return
    }

    // Drawing tools: open a draft, snapshot for undo, capture the pointer.
    drawSnapshot.current = present
    svgRef.current?.setPointerCapture(e.pointerId)
    const base = { id: newMarkupId(), z: nextZ, style }
    if (tool === "line") setDraft({ ...base, type: "line", points: [p] })
    else if (tool === "rect") setDraft({ ...base, type: "rect", x: p.x, y: p.y, w: 0, h: 0 })
    else if (tool === "arrow") setDraft({ ...base, type: "arrow", x1: p.x, y1: p.y, x2: p.x, y2: p.y })
  }

  function onPointerMove(e: React.PointerEvent) {
    const drag = dragRef.current
    if (drag) {
      const p = pxToNorm(e.clientX, e.clientY)
      const dx = p.x - drag.start.x, dy = p.y - drag.start.y
      if (dx !== 0 || dy !== 0) drag.moved = true
      const moved = translateMarkup(drag.original, dx, dy)
      setPresent(prev => prev.map(m => m.id === drag.id ? moved : m)) // live, no history
      return
    }
    if (!draft) return
    const p = pxToNorm(e.clientX, e.clientY)
    if (draft.type === "line") setDraft({ ...draft, points: [...draft.points, p] })
    else if (draft.type === "rect") setDraft({ ...draft, w: p.x - draft.x, h: p.y - draft.y })
    else if (draft.type === "arrow") setDraft({ ...draft, x2: p.x, y2: p.y })
  }

  function onPointerUp(e: React.PointerEvent) {
    svgRef.current?.releasePointerCapture?.(e.pointerId)
    const drag = dragRef.current
    if (drag) {
      dragRef.current = null
      if (drag.moved) commitFrom(drag.snapshot, present) // `present` already holds the moved shape
      return
    }
    if (!draft) return
    const snap = drawSnapshot.current ?? present
    drawSnapshot.current = null
    const committed = finalizeDraft(draft)
    setDraft(null)
    if (committed) { commitFrom(snap, [...snap, committed]); setSelectedId(committed.id) }
  }

  // Reject degenerate drafts (a click with no drag); normalize rect to +w/+h.
  function finalizeDraft(d: Markup): Markup | null {
    if (d.type === "line") return d.points.length >= 2 ? d : null
    if (d.type === "rect") {
      const x = Math.min(d.x, d.x + d.w), y = Math.min(d.y, d.y + d.h)
      const w = Math.abs(d.w), h = Math.abs(d.h)
      return w > 0.004 && h > 0.004 ? { ...d, x, y, w, h } : null
    }
    if (d.type === "arrow") return Math.hypot(d.x2 - d.x1, d.y2 - d.y1) > 0.004 ? d : null
    return d
  }

  // ── Inline text commit ────────────────────────────────────────────────────
  function commitText() {
    if (!editing) return
    const text = editing.value.trim()
    if (editing.id) {
      // Editing an existing label: replace text, or delete if cleared.
      commit(text ? present.map(m => m.id === editing.id && m.type === "text" ? { ...m, text } : m)
                  : present.filter(m => m.id !== editing.id))
    } else if (text) {
      commit([...present, { id: newMarkupId(), z: nextZ, style, type: "text", x: editing.x, y: editing.y, text }])
    }
    setEditing(null)
  }

  function beginEditText(m: Markup) {
    if (m.type !== "text") return
    setEditing({ id: m.id, x: m.x, y: m.y, value: m.text })
    setSelectedId(m.id)
  }

  // Hand the full serialized doc (with base provenance) + the layer id to the
  // parent's save. Async so the toolbar shows a saving state; the returned id
  // (new or updated layer) is captured so the next save is an UPDATE, not a new
  // layer.
  async function save() {
    if (!onSave || present.length === 0) return
    setSaving(true)
    try {
      const id = await onSave(serializeMarkups(present, { revisionId: baseRevisionId ?? null, label: baseLabel ?? null }), markupRevId)
      if (typeof id === "string") setMarkupRevId(id)
    } finally { setSaving(false) }
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return // typing text
      const meta = e.ctrlKey || e.metaKey
      if (meta && e.key.toLowerCase() === "z") {
        e.preventDefault(); e.shiftKey ? redo() : undo()
      } else if (meta && e.key.toLowerCase() === "y") {
        e.preventDefault(); redo()
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
        e.preventDefault(); deleteSelected()
      } else if (e.key === "Escape") {
        setDraft(null); setSelectedId(null); setEditing(null)
      } else if (e.key === "v") setTool("select")
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [undo, redo, deleteSelected, selectedId])

  // ── Render helpers (normalized → displayed px) ────────────────────────────
  const W = disp.w, H = disp.h
  const px = (n: number) => n * W
  const py = (n: number) => n * H
  const strokePx = (m: Markup) => Math.max(0.75, m.style.strokeWidth * H)

  // Selection + dragging are handled at the <svg> level (single pointer handler
  // + hit-test), so individual shapes carry no pointer handlers of their own.
  function renderMarkup(m: Markup) {
    const common = {
      stroke: m.style.color, strokeWidth: strokePx(m), fill: "none" as const,
      strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
      style: { cursor: tool === "select" ? "move" : "default" },
    }
    switch (m.type) {
      case "line":
        return <polyline key={m.id} points={m.points.map(p => `${px(p.x)},${py(p.y)}`).join(" ")} {...common} />
      case "rect": {
        const b = boundingBox(m)
        return <rect key={m.id} x={px(b.x)} y={py(b.y)} width={px(b.w)} height={py(b.h)} {...common} />
      }
      case "arrow": {
        const x1 = px(m.x1), y1 = py(m.y1), x2 = px(m.x2), y2 = py(m.y2)
        const ang = Math.atan2(y2 - y1, x2 - x1)
        const head = Math.max(7, strokePx(m) * 3.5)
        const a1 = ang + Math.PI - 0.45, a2 = ang + Math.PI + 0.45
        return (
          <g key={m.id}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} {...common} />
            <polygon
              points={`${x2},${y2} ${x2 + head * Math.cos(a1)},${y2 + head * Math.sin(a1)} ${x2 + head * Math.cos(a2)},${y2 + head * Math.sin(a2)}`}
              fill={m.style.color} stroke="none" />
          </g>
        )
      }
      case "text": {
        const fontPx = Math.max(6, m.style.fontSize * H)
        return (
          <text key={m.id} x={px(m.x)} y={py(m.y) + fontPx} fill={m.style.color}
            fontSize={fontPx} fontFamily="ui-sans-serif, system-ui, sans-serif"
            style={{ cursor: tool === "select" ? "move" : "default", userSelect: "none" }}
            onDoubleClick={() => tool === "select" && beginEditText(m)}>
            {m.text}
          </text>
        )
      }
    }
    return null
  }

  function renderSelection() {
    const m = present.find(x => x.id === selectedId)
    if (!m) return null
    const b = boundingBox(m)
    const pad = 4
    return (
      <rect x={px(b.x) - pad} y={py(b.y) - pad} width={px(b.w) + pad * 2} height={py(b.h) + pad * 2}
        fill="none" stroke="#2563EB" strokeWidth={1} strokeDasharray="4 3" pointerEvents="none" />
    )
  }

  const ordered = useMemo(() => [...present].sort((a, b) => a.z - b.z), [present])
  const cursor = tool === "select" ? "default" : tool === "text" ? "text" : "crosshair"

  // ── UI ────────────────────────────────────────────────────────────────────
  const toolBtn = (active: boolean) =>
    `h-8 px-2.5 rounded-md text-[12px] font-semibold inline-flex items-center gap-1.5 transition-colors ${
      active ? "bg-[#7B9BB5] text-white" : "text-[#475569] border border-[#E2E8F0] hover:bg-[#7B9BB5]/10"}`

  return (
    <div className="flex flex-col h-full w-full bg-[#F1F3F5]">
      {/* Toolbar */}
      <div className="flex-shrink-0 flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 bg-white border-b border-[#E2E8F0]">
        <div className="flex items-center gap-1">
          {TOOLS.map(({ tool: t, label, Icon }) => (
            <button key={t} onClick={() => { setTool(t); if (t !== "select") setSelectedId(null) }}
              className={toolBtn(tool === t)} title={label}><Icon />{label}</button>
          ))}
        </div>

        <div className="w-px h-6 bg-[#E2E8F0]" />

        {/* Color swatches */}
        <div className="flex items-center gap-1.5">
          {MARKUP_COLORS.map(c => (
            <button key={c} onClick={() => applyStyle({ color: c })} title={c}
              className={`h-5 w-5 rounded-full border transition-transform ${style.color === c ? "ring-2 ring-offset-1 ring-[#7B9BB5] scale-110" : "border-black/10 hover:scale-110"}`}
              style={{ backgroundColor: c }} />
          ))}
        </div>

        <div className="w-px h-6 bg-[#E2E8F0]" />

        {/* Stroke width */}
        <div className="flex items-center gap-1">
          {STROKE_OPTS.map(({ key, label }) => (
            <button key={key} onClick={() => applyStyle({ strokeWidth: STROKE_PRESETS[key] })}
              className={toolBtn(style.strokeWidth === STROKE_PRESETS[key])} title={`${key} stroke`}>{label}</button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <button onClick={undo} disabled={past.length === 0} className="h-8 w-8 rounded-md border border-[#E2E8F0] text-[#475569] inline-flex items-center justify-center hover:bg-[#7B9BB5]/10 disabled:opacity-40" title="Undo (Ctrl+Z)"><UndoIcon /></button>
          <button onClick={redo} disabled={future.length === 0} className="h-8 w-8 rounded-md border border-[#E2E8F0] text-[#475569] inline-flex items-center justify-center hover:bg-[#7B9BB5]/10 disabled:opacity-40" title="Redo (Ctrl+Shift+Z)"><RedoIcon /></button>
          <button onClick={deleteSelected} disabled={!selectedId} className="h-8 w-8 rounded-md border border-[#E2E8F0] text-[#475569] inline-flex items-center justify-center hover:bg-red-50 hover:text-red-500 hover:border-red-200 disabled:opacity-40" title="Delete selected (Del)"><TrashIcon /></button>
          <span className="text-[11px] text-[#94A3B8] tabular-nums px-1">{present.length} markup{present.length === 1 ? "" : "s"}</span>
          <button onClick={save} disabled={saving || present.length === 0}
            className="h-8 px-3.5 rounded-md bg-[#7B9BB5] text-white text-[12px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 inline-flex items-center gap-1.5">
            {saving && <SpinnerIcon className="h-3 w-3" />}
            {saving ? "Saving…" : "Save markup"}
          </button>
        </div>
      </div>

      {/* Canvas area */}
      <div ref={areaRef} className="flex-1 min-h-0 flex items-center justify-center p-3 overflow-hidden">
        {renderState === "loading" && (
          <div className="flex items-center gap-2 text-[13px] text-[#64748B]"><SpinnerIcon className="h-4 w-4" /> Rendering sheet…</div>
        )}
        {renderState === "error" && (
          <div className="text-[13px] text-[#94A3B8] text-center px-6">Couldn’t render this sheet for markup.<br />The file may not be a PDF, or it failed to load.</div>
        )}
        {renderState === "ready" && pageImg && W > 0 && (
          <div className="relative shadow-lg" style={{ width: W, height: H }}>
            <img src={pageImg} alt="sheet" draggable={false} className="block w-full h-full select-none" />
            <svg
              ref={svgRef}
              className="absolute inset-0"
              width={W} height={H}
              style={{ touchAction: "none", cursor }}
              // While placing text, swallow the mousedown default: clicking the
              // (non-focusable) SVG would otherwise move focus to <body> right
              // after the input mounts, blurring it before a key is pressed.
              onMouseDown={e => { if (tool === "text") e.preventDefault() }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            >
              {ordered.map(m => renderMarkup(m))}
              {draft && renderMarkup(draft)}
              {tool === "select" && renderSelection()}
            </svg>

            {/* Inline text editor overlay */}
            {editing && (
              <input
                autoFocus
                value={editing.value}
                onChange={e => setEditing({ ...editing, value: e.target.value })}
                onBlur={commitText}
                onKeyDown={e => {
                  if (e.key === "Enter") { e.preventDefault(); commitText() }
                  else if (e.key === "Escape") { e.preventDefault(); setEditing(null) }
                }}
                placeholder="Type, Enter to add"
                className="absolute z-10 px-1 py-0 bg-white/95 border border-[#7B9BB5] rounded outline-none"
                style={{
                  left: px(editing.x), top: py(editing.y),
                  fontSize: Math.max(11, style.fontSize * H),
                  color: style.color, lineHeight: 1.1, minWidth: 80,
                }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}
