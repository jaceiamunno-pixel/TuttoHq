"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import dynamic from "next/dynamic"
import { rawMeasure as measureRaw, segLength, anchorOf } from "../_lib/measure"

// Reuse the existing read-only pdf.js sheet viewer BY IMPORT (no fork, no shared-
// state mutation). We render a clean sheet (markups=[]) and lay our own overlay
// OVER it — count dots, measured polylines/polygons, and the draw-in-progress.
// Anchoring trick: FlattenedMarkupView applies its zoom/pan transform directly to
// the <canvas>, so the canvas's live getBoundingClientRect() *is* the on-screen
// page rectangle. We read that rect each frame (read-only) and size two stacked
// layers — a clip layer pinned to the viewer's viewport (so overlay never spills
// over the toolbar/margins) and an inner layer pinned to the canvas box — then
// position each mark at its normalized (x,y) as a percentage inside the inner
// layer. The overlay is pointer-events:none, so the viewer keeps full pan (drag)
// + wheel-zoom; we read gestures on the wrapper: a near-zero-movement press is a
// "click" (place a count dot / add a measure vertex), a drag is a pan.
//
// Phase B — `mode` selects what a click does: 'count' places a dot (original
// behavior), 'linear'/'area' build a polyline/polygon, 'scale' draws the single
// calibration segment. Measurement geometry is computed in the SAME normalized
// space marks use, aspect-corrected at commit time (see _lib/measure.ts), so pan
// and zoom never affect a stored measure. Erase mode intercepts input on a full
// overlay and deletes count dots AND measured marks (click or drag-marquee).
const FlattenedMarkupView = dynamic(() => import("@/components/drawings/FlattenedMarkupView"), { ssr: false })

// Stable empty-markups reference — a fresh [] each render would re-trigger the
// viewer's composite effect (it deps on `markups`). One module constant avoids that.
const NO_MARKUPS: never[] = []

const MOVE_TOLERANCE = 5   // px between down/up still counts as a click (not a pan)
const HIT_RADIUS = 11      // px: click within this of a dot/segment deletes it
const CLOSE_RADIUS = 12    // px: click within this of the first vertex closes the shape
const DEDUPE_EPS = 0.0015  // normalized: drop a vertex this close to the previous one
const SCALE_COLOR = "#0D9488" // teal — the calibration segment

export type ViewerMode = "count" | "linear" | "area" | "scale"

export interface ViewerMark {
  id: string
  x: number
  y: number
  color: string
  code: string
}

export interface ViewerMeasuredMark {
  id: string
  kind: "linear" | "area"
  points: [number, number][]
  color: string
  label: string
}

export interface ViewerScaleSeg {
  x1: number; y1: number; x2: number; y2: number
}

type Down = { x: number; y: number; id: number }

export default function CountViewer({
  baseUrl, sheetKey, title, page, mode, marks, measuredMarks, scaleSeg,
  draftColor, canPlace, canMeasure, canScale, erasing,
  onPlace, onDelete, onDeleteMany, onCommitMeasure, onScaleDrawn, onPagesLoaded,
}: {
  baseUrl: string
  /** Stable sheet ref (drawing_sheets id) — remounts the viewer + filters overlay. */
  sheetKey: string
  title?: string | null
  /** 0-indexed page currently shown (forwarded to the viewer as pageNumber+1). */
  page: number
  mode: ViewerMode
  marks: ViewerMark[]
  measuredMarks: ViewerMeasuredMark[]
  /** Saved calibration segment for this page (rendered while in scale mode). */
  scaleSeg: ViewerScaleSeg | null
  /** Color of the in-progress measure draft (the active tag). */
  draftColor: string
  canPlace: boolean
  canMeasure: boolean
  canScale: boolean
  /** When true, input erases (click/marquee) instead of placing/drawing/panning. */
  erasing: boolean
  onPlace: (x: number, y: number) => void
  onDelete: (markId: string) => void
  onDeleteMany: (markIds: string[]) => void
  onCommitMeasure: (kind: "linear" | "area", points: [number, number][], rawMeasure: number) => void
  onScaleDrawn: (seg: ViewerScaleSeg, segLen: number) => void
  onPagesLoaded: (numPages: number) => void
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const clipRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const downRef = useRef<Down | null>(null)
  const marksRef = useRef<ViewerMark[]>(marks)
  marksRef.current = marks
  const measuredRef = useRef<ViewerMeasuredMark[]>(measuredMarks)
  measuredRef.current = measuredMarks

  // In-progress drawing state (transient, viewer-owned).
  const [draft, setDraft] = useState<{ kind: "linear" | "area"; points: [number, number][] } | null>(null)
  const [scaleP1, setScaleP1] = useState<[number, number] | null>(null)
  const [cursor, setCursor] = useState<[number, number] | null>(null)
  const drawing = draft !== null || scaleP1 !== null

  // Erase-mode marquee (client-coord down point + wrapper-relative box to draw).
  const eraseDownRef = useRef<Down | null>(null)
  const [marquee, setMarquee] = useState<{ left: number; top: number; width: number; height: number } | null>(null)

  const canvasOf = useCallback(() => wrapRef.current?.querySelector("canvas") ?? null, [])

  // Keep the two overlay layers glued to the live canvas/viewport geometry. Runs
  // on rAF while mounted — one rect read per frame, DOM writes only on change.
  useEffect(() => {
    let raf = 0
    let last = ""
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const wrap = wrapRef.current, clip = clipRef.current, inner = innerRef.current
      const canvas = canvasOf()
      if (!wrap || !clip || !inner || !canvas) { if (clip) clip.style.display = "none"; return }
      const viewport = canvas.parentElement
      if (!viewport) return
      const wrapR = wrap.getBoundingClientRect()
      const vpR = viewport.getBoundingClientRect()
      const cR = canvas.getBoundingClientRect()
      if (cR.width < 1 || cR.height < 1) { clip.style.display = "none"; return }
      const key = `${wrapR.left},${wrapR.top},${vpR.left},${vpR.top},${vpR.width},${vpR.height},${cR.left},${cR.top},${cR.width},${cR.height}`
      if (key === last) return
      last = key
      clip.style.display = "block"
      clip.style.left = `${vpR.left - wrapR.left}px`
      clip.style.top = `${vpR.top - wrapR.top}px`
      clip.style.width = `${vpR.width}px`
      clip.style.height = `${vpR.height}px`
      inner.style.left = `${cR.left - vpR.left}px`
      inner.style.top = `${cR.top - vpR.top}px`
      inner.style.width = `${cR.width}px`
      inner.style.height = `${cR.height}px`
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [canvasOf, sheetKey])

  // Bail out of a marquee if erase mode is toggled off mid-drag.
  useEffect(() => { if (!erasing) { eraseDownRef.current = null; setMarquee(null) } }, [erasing])

  // Abandon any in-progress drawing when the mode / sheet / page changes, or while
  // erasing (input then belongs to the erase overlay).
  useEffect(() => { setDraft(null); setScaleP1(null); setCursor(null) }, [mode, sheetKey, page, erasing])

  // ── Geometry helpers (client coords → normalized; canvas rect / aspect) ───────
  const canvasRect = useCallback(() => {
    const c = canvasOf()
    if (!c) return null
    const r = c.getBoundingClientRect()
    return r.width < 1 || r.height < 1 ? null : r
  }, [canvasOf])

  // Normalized [0,1] point from a client press, or null if off the page/viewport.
  const normFromClient = useCallback((cx: number, cy: number): [number, number] | null => {
    const canvas = canvasOf()
    if (!canvas) return null
    const viewport = canvas.parentElement
    if (!viewport) return null
    const vpR = viewport.getBoundingClientRect()
    if (cx < vpR.left || cx > vpR.right || cy < vpR.top || cy > vpR.bottom) return null
    const cR = canvas.getBoundingClientRect()
    if (cR.width < 1 || cR.height < 1) return null
    const nx = (cx - cR.left) / cR.width
    const ny = (cy - cR.top) / cR.height
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null
    return [nx, ny]
  }, [canvasOf])

  const dedupe = (pts: [number, number][]): [number, number][] => {
    const out: [number, number][] = []
    for (const p of pts) {
      const last = out[out.length - 1]
      if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < DEDUPE_EPS) continue
      out.push(p)
    }
    return out
  }

  // finishDraft runs from event handlers (click / dblclick / Enter), so `draft` is
  // current via the closure. We commit OUTSIDE any setState updater so the parent's
  // setState (onCommitMeasure) never fires inside our own state update.
  const finishDraft = useCallback(() => {
    if (draft) {
      const pts = dedupe(draft.points)
      const min = draft.kind === "area" ? 3 : 2
      if (pts.length >= min) {
        const cR = canvasRect()
        const aspect = cR ? cR.height / cR.width : 1
        onCommitMeasure(draft.kind, pts, measureRaw(draft.kind, pts, aspect))
      }
    }
    setDraft(null)
    setCursor(null)
  }, [draft, canvasRect, onCommitMeasure])

  const cancelDraft = useCallback(() => { setDraft(null); setScaleP1(null); setCursor(null) }, [])

  // Enter commits / Esc cancels the in-progress drawing (viewer owns the draft).
  useEffect(() => {
    if (!drawing) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") { e.preventDefault(); finishDraft() }
      else if (e.key === "Escape") { e.preventDefault(); cancelDraft() }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [drawing, finishDraft, cancelDraft])

  // ── Wrapper input (place / draw). Erase mode uses its own overlay below. ───────
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    downRef.current = { x: e.clientX, y: e.clientY, id: e.pointerId }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drawing) return // only track the cursor while actively drawing (rubber-band)
    const n = normFromClient(e.clientX, e.clientY)
    if (n) setCursor(n)
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const d = downRef.current
    downRef.current = null
    if (!d || d.id !== e.pointerId) return
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > MOVE_TOLERANCE) return // a pan, not a click

    if (mode === "count") return onCountClick(e.clientX, e.clientY)
    if (mode === "scale") return onScaleClick(e.clientX, e.clientY)
    return onMeasureClick(e.clientX, e.clientY) // linear | area
  }

  // Count: click an existing dot to delete it, else drop a new one.
  const onCountClick = (cx: number, cy: number) => {
    const cR = canvasRect()
    if (!cR) return
    for (const m of marksRef.current) {
      const sx = cR.left + m.x * cR.width
      const sy = cR.top + m.y * cR.height
      if (Math.hypot(cx - sx, cy - sy) <= HIT_RADIUS) { onDelete(m.id); return }
    }
    const n = normFromClient(cx, cy)
    if (!n || !canPlace) return
    onPlace(n[0], n[1])
  }

  // Linear/area: add a vertex, or close the shape when clicking near the first one.
  const onMeasureClick = (cx: number, cy: number) => {
    if (!canMeasure) return
    const n = normFromClient(cx, cy)
    if (!n) return
    const kind = mode as "linear" | "area"
    const cR = canvasRect()
    const min = kind === "area" ? 3 : 2
    if (draft && draft.points.length >= min && cR) {
      const [fx, fy] = draft.points[0]
      const sx = cR.left + fx * cR.width
      const sy = cR.top + fy * cR.height
      if (Math.hypot(cx - sx, cy - sy) <= CLOSE_RADIUS) { finishDraft(); return }
    }
    setDraft(d => (d && d.kind === kind ? { kind, points: [...d.points, n] } : { kind, points: [n] }))
  }

  // Scale: first click sets the start, second finishes the segment → module dialog.
  const onScaleClick = (cx: number, cy: number) => {
    if (!canScale) return
    const n = normFromClient(cx, cy)
    if (!n) return
    if (!scaleP1) { setScaleP1(n); setCursor(n); return }
    const seg = { x1: scaleP1[0], y1: scaleP1[1], x2: n[0], y2: n[1] }
    const cR = canvasRect()
    const aspect = cR ? cR.height / cR.width : 1
    const len = segLength(seg.x1, seg.y1, seg.x2, seg.y2, aspect)
    setScaleP1(null); setCursor(null)
    if (len > 0) onScaleDrawn(seg, len)
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    if (mode === "linear" || mode === "area") { e.preventDefault(); finishDraft() }
  }

  // ── Erase overlay: click removes the mark under it; drag marquee removes all
  //    inside. stopPropagation keeps the viewer from panning underneath. ──────────
  const measuredHit = (cx: number, cy: number, cR: DOMRect): string | null => {
    for (const mm of measuredRef.current) {
      const sp = mm.points.map(p => [cR.left + p[0] * cR.width, cR.top + p[1] * cR.height] as [number, number])
      // vertices
      for (const [sx, sy] of sp) if (Math.hypot(cx - sx, cy - sy) <= HIT_RADIUS) return mm.id
      // edges (+ the closing edge for area)
      const edges = mm.kind === "area" ? sp.length : sp.length - 1
      for (let i = 0; i < edges; i++) {
        const a = sp[i], b = sp[(i + 1) % sp.length]
        if (distToSeg(cx, cy, a[0], a[1], b[0], b[1]) <= HIT_RADIUS) return mm.id
      }
    }
    return null
  }

  const onErasePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    eraseDownRef.current = { x: e.clientX, y: e.clientY, id: e.pointerId }
    setMarquee(null)
  }
  const onErasePointerMove = (e: React.PointerEvent) => {
    const d = eraseDownRef.current
    if (!d || d.id !== e.pointerId) return
    e.stopPropagation()
    const wrapR = wrapRef.current?.getBoundingClientRect()
    if (!wrapR) return
    setMarquee({
      left: Math.min(d.x, e.clientX) - wrapR.left,
      top: Math.min(d.y, e.clientY) - wrapR.top,
      width: Math.abs(e.clientX - d.x),
      height: Math.abs(e.clientY - d.y),
    })
  }
  const onErasePointerUp = (e: React.PointerEvent) => {
    const d = eraseDownRef.current
    eraseDownRef.current = null
    setMarquee(null)
    if (!d || d.id !== e.pointerId) return
    e.stopPropagation()
    const cR = canvasRect()
    if (!cR) return

    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) <= MOVE_TOLERANCE) {
      // Click → delete the single mark under the cursor (dot first, then measured).
      for (const m of marksRef.current) {
        const sx = cR.left + m.x * cR.width
        const sy = cR.top + m.y * cR.height
        if (Math.hypot(e.clientX - sx, e.clientY - sy) <= HIT_RADIUS) { onDelete(m.id); return }
      }
      const hit = measuredHit(e.clientX, e.clientY, cR)
      if (hit) onDelete(hit)
      return
    }

    // Marquee → delete every dot inside the box + every measured mark with a vertex inside.
    const minX = Math.min(d.x, e.clientX), maxX = Math.max(d.x, e.clientX)
    const minY = Math.min(d.y, e.clientY), maxY = Math.max(d.y, e.clientY)
    const inBox = (sx: number, sy: number) => sx >= minX && sx <= maxX && sy >= minY && sy <= maxY
    const hit: string[] = []
    for (const m of marksRef.current) {
      if (inBox(cR.left + m.x * cR.width, cR.top + m.y * cR.height)) hit.push(m.id)
    }
    for (const mm of measuredRef.current) {
      if (mm.points.some(p => inBox(cR.left + p[0] * cR.width, cR.top + p[1] * cR.height))) hit.push(mm.id)
    }
    if (hit.length) onDeleteMany(hit)
  }

  const drawCursorClass = mode === "count" ? "" : "cursor-crosshair"
  const pct = (p: [number, number]) => `${p[0] * 100},${p[1] * 100}`

  return (
    <div
      ref={wrapRef}
      className={`relative h-full w-full ${erasing ? "" : drawCursorClass}`}
      onPointerDown={erasing ? undefined : onPointerDown}
      onPointerMove={erasing ? undefined : onPointerMove}
      onPointerUp={erasing ? undefined : onPointerUp}
      onDoubleClick={erasing ? undefined : onDoubleClick}
    >
      {/* The viewer owns the canvas + its pan/zoom + toolbar. key=sheetKey forces a
          clean remount when the sheet changes; pageNumber flips pages in place. */}
      <FlattenedMarkupView
        key={sheetKey}
        baseUrl={baseUrl}
        markups={NO_MARKUPS}
        title={title}
        pageNumber={page + 1}
        onPagesLoaded={onPagesLoaded}
      />

      {/* Clip layer (pinned to the viewer's viewport) → inner layer (pinned to the
          canvas box). Both pointer-events:none so the viewer still gets the input. */}
      <div ref={clipRef} className="absolute overflow-hidden pointer-events-none" style={{ display: "none" }}>
        <div ref={innerRef} className="absolute">
          {/* Vector layer — measured marks + the draft + the scale segment. viewBox
              maps 0..100 to the normalized page; preserveAspectRatio=none stretches
              it to the (non-square) canvas box, so straight edges stay straight and
              non-scaling-stroke keeps line width constant regardless of zoom. */}
          <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
            {measuredMarks.map(mm => (
              mm.kind === "area" ? (
                <polygon key={mm.id} points={mm.points.map(pct).join(" ")}
                  fill={mm.color} fillOpacity={0.12} stroke={mm.color} strokeWidth={2}
                  vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
              ) : (
                <polyline key={mm.id} points={mm.points.map(pct).join(" ")}
                  fill="none" stroke={mm.color} strokeWidth={2}
                  vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
              )
            ))}

            {/* Draft polyline/polygon + rubber-band to the cursor. */}
            {draft && (() => {
              const pts = cursor ? [...draft.points, cursor] : draft.points
              const str = pts.map(pct).join(" ")
              return draft.kind === "area" && draft.points.length >= 2 ? (
                <polygon points={str} fill={draftColor} fillOpacity={0.1} stroke={draftColor}
                  strokeWidth={2} strokeDasharray="5 4" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
              ) : (
                <polyline points={str} fill="none" stroke={draftColor} strokeWidth={2}
                  strokeDasharray="5 4" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
              )
            })()}

            {/* Saved calibration segment (shown while calibrating). */}
            {mode === "scale" && scaleSeg && (
              <polyline points={`${scaleSeg.x1 * 100},${scaleSeg.y1 * 100} ${scaleSeg.x2 * 100},${scaleSeg.y2 * 100}`}
                fill="none" stroke={SCALE_COLOR} strokeWidth={2.5} vectorEffect="non-scaling-stroke" strokeLinecap="round" />
            )}
            {/* In-progress scale segment. */}
            {scaleP1 && cursor && (
              <polyline points={`${scaleP1[0] * 100},${scaleP1[1] * 100} ${cursor[0] * 100},${cursor[1] * 100}`}
                fill="none" stroke={SCALE_COLOR} strokeWidth={2.5} strokeDasharray="5 4" vectorEffect="non-scaling-stroke" strokeLinecap="round" />
            )}
          </svg>

          {/* Count dots. */}
          {marks.map(m => (
            <div
              key={m.id}
              className="absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center"
              style={{ left: `${m.x * 100}%`, top: `${m.y * 100}%` }}
            >
              <span className="block h-3 w-3 rounded-full ring-2 ring-white shadow" style={{ backgroundColor: m.color }} />
              <span className="mt-0.5 px-1 rounded text-[9px] font-bold leading-tight text-white shadow whitespace-nowrap" style={{ backgroundColor: m.color }}>
                {m.code}
              </span>
            </div>
          ))}

          {/* Measured-mark quantity labels (anchored at first vertex / centroid). */}
          {measuredMarks.map(mm => {
            const a = anchorOf(mm.kind, mm.points)
            return (
              <span
                key={`lbl-${mm.id}`}
                className="absolute -translate-x-1/2 -translate-y-1/2 px-1 rounded text-[9px] font-bold leading-tight text-white shadow whitespace-nowrap"
                style={{ left: `${a[0] * 100}%`, top: `${a[1] * 100}%`, backgroundColor: mm.color }}
              >
                {mm.label}
              </span>
            )
          })}

          {/* Draft vertex handles (rendered as divs so they stay round under the
              non-uniform SVG stretch). */}
          {(draft?.points ?? []).map((p, i) => (
            <span
              key={`v${i}`}
              className="absolute -translate-x-1/2 -translate-y-1/2 h-2.5 w-2.5 rounded-full border-2 border-white shadow"
              style={{ left: `${p[0] * 100}%`, top: `${p[1] * 100}%`, backgroundColor: draftColor }}
            />
          ))}
          {scaleP1 && (
            <span
              className="absolute -translate-x-1/2 -translate-y-1/2 h-2.5 w-2.5 rounded-full border-2 border-white shadow"
              style={{ left: `${scaleP1[0] * 100}%`, top: `${scaleP1[1] * 100}%`, backgroundColor: SCALE_COLOR }}
            />
          )}
        </div>
      </div>

      {/* Floating hint while drawing — how to finish/cancel. */}
      {drawing && (
        <div className="absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-full bg-[#1A2840] px-3 py-1 text-[11px] font-semibold text-white shadow pointer-events-none">
          {mode === "scale"
            ? "Click the segment's end point"
            : `${draft?.points.length ?? 0} pt${(draft?.points.length ?? 0) === 1 ? "" : "s"} · double-click or ⏎ to finish · Esc cancels`}
        </div>
      )}

      {/* Erase overlay — only mounted while erasing; sits above everything and
          consumes input so the viewer can't pan/zoom during an erase gesture. */}
      {erasing && (
        <div
          className="absolute inset-0 z-10"
          style={{ cursor: "crosshair", touchAction: "none" }}
          onPointerDown={onErasePointerDown}
          onPointerMove={onErasePointerMove}
          onPointerUp={onErasePointerUp}
          onPointerCancel={onErasePointerUp}
        >
          {marquee && (
            <div
              className="absolute border border-[#DC2626] bg-[#DC2626]/10 pointer-events-none"
              style={{ left: marquee.left, top: marquee.top, width: marquee.width, height: marquee.height }}
            />
          )}
        </div>
      )}
    </div>
  )
}

// Distance from point (px,py) to segment (ax,ay)-(bx,by), in screen px.
function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(px - ax, py - ay)
  let t = ((px - ax) * dx + (py - ay) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}
