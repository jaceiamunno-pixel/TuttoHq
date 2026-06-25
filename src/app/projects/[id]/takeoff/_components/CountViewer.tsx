"use client"

import { useCallback, useEffect, useRef } from "react"
import dynamic from "next/dynamic"

// Reuse the existing read-only pdf.js sheet viewer BY IMPORT (no fork, no shared-
// state mutation). We render a clean sheet (markups=[]) and lay our own count dots
// OVER it. Anchoring trick: FlattenedMarkupView applies its zoom/pan transform
// directly to the <canvas>, so the canvas's live getBoundingClientRect() *is* the
// on-screen page rectangle. We read that rect each frame (read-only) and size two
// stacked layers — a clip layer pinned to the viewer's viewport (so dots never
// spill over the toolbar/margins) and an inner layer pinned to the canvas box —
// then position each dot at its normalized (x,y) as a percentage inside the inner
// layer. The dots layer is pointer-events:none, so the viewer keeps full pan
// (drag) + wheel-zoom; we detect a "count click" as a near-zero-movement pointer
// press that bubbles up to our wrapper.
const FlattenedMarkupView = dynamic(() => import("@/components/drawings/FlattenedMarkupView"), { ssr: false })

// Stable empty-markups reference — a fresh [] each render would re-trigger the
// viewer's composite effect (it deps on `markups`). One module constant avoids that.
const NO_MARKUPS: never[] = []

const MOVE_TOLERANCE = 5   // px between down/up still counts as a click (not a pan)
const HIT_RADIUS = 11      // px: click within this of a dot deletes it

export interface ViewerMark {
  id: string
  x: number
  y: number
  color: string
  code: string
}

export default function CountViewer({
  baseUrl, sheetKey, title, marks, canPlace, onPlace, onDelete,
}: {
  baseUrl: string
  /** Stable sheet ref (drawing_log id) — remounts the viewer + filters dots. */
  sheetKey: string
  title?: string | null
  marks: ViewerMark[]
  canPlace: boolean
  onPlace: (x: number, y: number) => void
  onDelete: (markId: string) => void
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const clipRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const downRef = useRef<{ x: number; y: number; id: number } | null>(null)
  const marksRef = useRef<ViewerMark[]>(marks)
  marksRef.current = marks

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

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    downRef.current = { x: e.clientX, y: e.clientY, id: e.pointerId }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const d = downRef.current
    downRef.current = null
    if (!d || d.id !== e.pointerId) return
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > MOVE_TOLERANCE) return // a pan, not a click

    const canvas = canvasOf()
    if (!canvas) return
    const viewport = canvas.parentElement
    if (!viewport) return
    const vpR = viewport.getBoundingClientRect()
    // Ignore presses outside the sheet viewport (e.g. on the viewer toolbar).
    if (e.clientX < vpR.left || e.clientX > vpR.right || e.clientY < vpR.top || e.clientY > vpR.bottom) return

    const cR = canvas.getBoundingClientRect()
    if (cR.width < 1 || cR.height < 1) return

    // Delete first: a click landing on an existing dot removes it.
    for (const m of marksRef.current) {
      const sx = cR.left + m.x * cR.width
      const sy = cR.top + m.y * cR.height
      if (Math.hypot(e.clientX - sx, e.clientY - sy) <= HIT_RADIUS) { onDelete(m.id); return }
    }

    const nx = (e.clientX - cR.left) / cR.width
    const ny = (e.clientY - cR.top) / cR.height
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return // clicked the gray margin
    if (!canPlace) return
    onPlace(nx, ny)
  }

  return (
    <div
      ref={wrapRef}
      className="relative h-full w-full"
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
    >
      {/* The viewer owns the canvas + its pan/zoom + toolbar. key=sheetKey forces a
          clean remount when the sheet changes. */}
      <FlattenedMarkupView key={sheetKey} baseUrl={baseUrl} markups={NO_MARKUPS} title={title} />

      {/* Clip layer (pinned to the viewer's viewport) → inner layer (pinned to the
          canvas box). Both pointer-events:none so the viewer still gets the input. */}
      <div ref={clipRef} className="absolute overflow-hidden pointer-events-none" style={{ display: "none" }}>
        <div ref={innerRef} className="absolute">
          {marks.map(m => (
            <div
              key={m.id}
              className="absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center"
              style={{ left: `${m.x * 100}%`, top: `${m.y * 100}%` }}
            >
              <span
                className="block h-3 w-3 rounded-full ring-2 ring-white shadow"
                style={{ backgroundColor: m.color }}
              />
              <span
                className="mt-0.5 px-1 rounded text-[9px] font-bold leading-tight text-white shadow whitespace-nowrap"
                style={{ backgroundColor: m.color }}
              >
                {m.code}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
