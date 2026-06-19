"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { getDocumentProxy, createIsomorphicCanvasFactory } from "unpdf"
import {
  DEFAULT_STYLE, MARKUP_COLORS,
  HIGHLIGHT_OPACITY, HIGHLIGHT_DEFAULT_COLOR, CLOUD_SCALLOP_FRAC,
  boundingBox, cloudOutline, deserializeMarkups, hitTest, newMarkupId, serializeMarkups, translateMarkup,
  type Markup, type MarkupDoc, type MarkupStyle, type Point,
} from "@/lib/drawing-markup"
import { SpinnerIcon } from "../../app/dashboard/_shared/icons"

// In-app drawing markup editor (ADR-005 Phase 2, Part 1; zoom/pan added in
// ADR-008 Piece 3). Renders the sheet's first PDF page (via unpdf, the same
// client-side path the splitter uses) onto a <canvas> background, overlays an
// <svg> markup layer sized exactly to it, and produces the [0,1]-normalized
// vector array defined in @/lib/drawing-markup. `onSave` hands that array back.
//
// ── Zoom/pan (the careful part) ─────────────────────────────────────────────
// Zoom/pan is a CSS transform on the SHARED stage container that wraps BOTH the
// background canvas AND the <svg> (translate(offset) scale(zoom), origin 0 0).
// Because that one transform moves both layers together, `pxToNorm` needs NO
// zoom/pan terms: `svgRef.getBoundingClientRect()` already returns the POST-
// transform rect, so `(clientX - r.left) / r.width` stays the correct [0,1] at
// ANY zoom. The SVG keeps drawing in its own unscaled W×H space (px(n)=n*W); the
// container scale makes it (and stroke width / font size) grow with the page.
// This is deliberately the safe path — we do NOT reintroduce explicit
// (screenPx - offset) / (base*scale) arithmetic anywhere.
//
// `zoom` is RELATIVE to fit (fit-to-width = 1.0 = "100%"); "1:1" sets zoom so one
// PDF point = one CSS px. Sharpness is transform-then-refine: the existing canvas
// is CSS-scaled mid-gesture (instant, slightly soft), then ~120ms after settle
// the page is re-rendered at scale*dpr (dpr≤2, clamped to a ~16M-px ceiling),
// off-screen, and blitted in one synchronous paint. Pan never re-renders. The
// normalized model and the Export path are untouched.

type Tool = "select" | "line" | "rect" | "arrow" | "text" | "highlight" | "highlightPen" | "cloud"

// pdf.js types aren't statically imported (keeps this client-only + matches the
// inferred-proxy loose typing). Minimal shapes for exactly what we touch; the
// proxies are cast in through `unknown` (same as the read-only flatten view).
type Viewport = { width: number; height: number }
type RenderTask = { promise: Promise<void>; cancel: () => void }
type PdfPage = {
  getViewport: (opts: { scale: number }) => Viewport
  render: (opts: { canvas: HTMLCanvasElement; canvasContext: CanvasRenderingContext2D; viewport: Viewport }) => RenderTask
}
type PdfDoc = { getPage: (n: number) => Promise<PdfPage>; destroy: () => Promise<void> }

const SETTLE_MS = 120              // debounce before a crisp re-render after a zoom
const MAX_BITMAP_PX = 16_000_000   // raster ceiling (~16M px ≈ crisp through ~4× fit)
const WHEEL_ZOOM_K = 0.0015        // scroll-wheel zoom sensitivity (exp of -deltaY)
const CTRL_ZOOM_K = 0.012          // trackpad pinch (ctrlKey wheel) — coarser per delta
const ZOOM_BTN_STEP = 1.25         // −/+ button multiplier
const MIN_ZOOM_REL = 0.25          // out to 25% of fit
const MAX_ZOOM_REL = 16            // in to 1600% of fit (soft past ~4×)

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
const DownloadIcon = () => <svg className={ic} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" /></svg>
const HighlightIcon = () => <svg className={ic} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M4 20h16" /><rect x="6" y="5" width="12" height="9" rx="1" strokeWidth={1.8} /></svg>
const HighlightPenIcon = () => <svg className={ic} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M4 20h16M5 15c4-6 10 4 14-3" /></svg>
const CloudIcon = () => <svg className={ic} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M7 17a3.5 3.5 0 01-.5-6.96A4.5 4.5 0 0115 9.5a3 3 0 01.5 5.96" /></svg>
const MinusIcon = () => <svg className={ic} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeWidth={2} d="M5 12h14" /></svg>
const PlusIcon = () => <svg className={ic} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeWidth={2} d="M12 5v14M5 12h14" /></svg>

const TOOLS: { tool: Tool; label: string; Icon: () => React.ReactElement }[] = [
  { tool: "select", label: "Select", Icon: CursorIcon },
  { tool: "line", label: "Pen", Icon: PenIcon },
  { tool: "rect", label: "Box", Icon: RectIcon },
  { tool: "arrow", label: "Arrow", Icon: ArrowIcon },
  { tool: "text", label: "Text", Icon: TextIcon },
  { tool: "highlight", label: "Highlight", Icon: HighlightIcon },
  { tool: "highlightPen", label: "Highlight pen", Icon: HighlightPenIcon },
  { tool: "cloud", label: "Cloud", Icon: CloudIcon },
]

// Numeric size system (replaces S/M/L; wider range, like other markup tools).
// Stroke weight and text size are different scales, so the toolbar control swaps
// by context: shape tools edit strokeWidth, the Text tool / a selected text item
// edits fontSize. Each maps number → fraction-of-page-height via a unit.
const STROKE_SIZES = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24]
const STROKE_UNIT = 0.0008 // strokeWidth fraction per unit (default 0.0032 → "4")
const TEXT_SIZES = [10, 12, 14, 16, 18, 24, 32, 40, 48, 64]
const TEXT_UNIT = 0.001 // fontSize fraction per unit (default 0.024 → "24")
const nearestSize = (opts: number[], target: number) =>
  opts.reduce((best, o) => (Math.abs(o - target) < Math.abs(best - target) ? o : best), opts[0])

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

export default function MarkupEditor({ fileUrl, sheetNumber, initialMarkups, baseRevisionId, baseLabel, mode = "new", onSave }: {
  fileUrl: string
  /** Sheet number — names the throwaway export download (e.g. "A-101-markup.pdf"). */
  sheetNumber?: string | null
  /** Markup[] or a stored MarkupDoc — deserializeMarkups handles either. */
  initialMarkups?: Markup[] | MarkupDoc | null
  /** The revision this layer is drawn over (its base) — recorded in the doc. */
  baseRevisionId?: string | null
  baseLabel?: string | null
  /** Save intent: "new" stores a fresh numbered markup, "edit" updates the one
   *  being edited. Drives the Save button label only — the parent's onSave
   *  closure carries the actual new-vs-edit decision + target id. */
  mode?: "new" | "edit"
  /** Persist the serialized doc. The parent decides new-vs-edit + target id. */
  onSave?: (doc: MarkupDoc) => Promise<unknown> | unknown
}) {
  // ── Background page render ────────────────────────────────────────────────
  const [aspect, setAspect] = useState<number | null>(null) // width / height
  const [renderState, setRenderState] = useState<"loading" | "ready" | "error">("loading")
  const [painted, setPainted] = useState(false) // first crisp paint done (hides the spinner)
  // The FULL-RESOLUTION original PDF bytes, kept for the export (Part 2b) so the
  // download composites onto the real sheet — never the viewer raster. A copy is
  // stashed because getDocumentProxy below transfers/neuters `ab`.
  const originalBytesRef = useRef<ArrayBuffer | null>(null)

  // Kept-alive pdf.js handles + the page's intrinsic (scale-1) point size.
  const pageRef = useRef<PdfPage | null>(null)
  const pdfDocRef = useRef<PdfDoc | null>(null)
  const baseRef = useRef<Viewport | null>(null)        // page size in PDF points
  const bgCanvasRef = useRef<HTMLCanvasElement>(null)   // visible background canvas
  const offscreenRef = useRef<HTMLCanvasElement | null>(null) // flash-free render buffer
  const renderTaskRef = useRef<RenderTask | null>(null)
  const renderGenRef = useRef(0)
  const settleTimerRef = useRef<number | null>(null)

  useEffect(() => {
    let alive = true
    setRenderState("loading"); setPainted(false); setAspect(null); originalBytesRef.current = null
    renderGenRef.current++
    zoomRef.current = 1; offsetRef.current = { x: 0, y: 0 }; setReadout(100)
    ;(async () => {
      try {
        const ab = await (await fetch(fileUrl)).arrayBuffer()
        originalBytesRef.current = ab.slice(0)
        // Render to a pdf.js canvas (not a static raster) so zoom can re-render
        // the page crisp at scale — same unpdf path the read-only flatten view
        // uses. new Uint8Array(ab) is copied because pdf.js may neuter it.
        const CanvasFactory = await createIsomorphicCanvasFactory()
        const pdf = (await getDocumentProxy(new Uint8Array(ab), { CanvasFactory })) as unknown as PdfDoc
        if (!alive) { try { await pdf.destroy() } catch { /* noop */ } return }
        pdfDocRef.current = pdf
        const page = await pdf.getPage(1)
        if (!alive) return
        pageRef.current = page
        const vp = page.getViewport({ scale: 1 })
        baseRef.current = { width: vp.width, height: vp.height }
        setAspect(vp.width / vp.height)
        setRenderState("ready")
      } catch (err) {
        console.error("Markup editor render failed", err)
        if (alive) setRenderState("error")
      }
    })()
    return () => {
      alive = false
      renderGenRef.current++
      if (settleTimerRef.current != null) { clearTimeout(settleTimerRef.current); settleTimerRef.current = null }
      try { renderTaskRef.current?.cancel() } catch { /* settled */ }
      renderTaskRef.current = null
      try { pdfDocRef.current?.destroy() } catch { /* destroyed */ }
      pdfDocRef.current = null; pageRef.current = null; baseRef.current = null
    }
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
  // This is the FIT box (zoom = 1). Zoom is a separate multiplier on the stage.
  const disp = useMemo(() => {
    if (!aspect || area.w <= 0 || area.h <= 0) return { w: 0, h: 0 }
    const w = Math.min(area.w, area.h * aspect)
    return { w, h: w / aspect }
  }, [aspect, area])
  // Mirror for ref-reading callbacks (render/settle) that must see current W,H.
  const dispRef = useRef(disp)
  dispRef.current = disp

  // ── Viewport (zoom/pan) ───────────────────────────────────────────────────
  // Held in refs so gestures update the stage transform at 60fps without a React
  // re-render; the toolbar % lives in `readout`, cursor in `spaceHeld`/`panning`.
  const stageRef = useRef<HTMLDivElement>(null)
  const zoomRef = useRef(1)                       // multiplier on the fit box (1 = fit)
  const offsetRef = useRef({ x: 0, y: 0 })        // translate in CSS px
  const [readout, setReadout] = useState(100)     // zoom %, relative to fit
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [panning, setPanning] = useState(false)
  const spaceHeldRef = useRef(false)
  const panRef = useRef<{ startX: number; startY: number; offX: number; offY: number; Px: number; Py: number; A: DOMRect } | null>(null)

  const applyTransform = useCallback(() => {
    const s = stageRef.current
    if (!s) return
    s.style.transformOrigin = "0 0"
    s.style.transform = `translate(${offsetRef.current.x}px, ${offsetRef.current.y}px) scale(${zoomRef.current})`
  }, [])

  // Re-render the in-memory page into the background canvas at the current zoom,
  // crisp. Renders off-screen then resizes + blits the visible canvas in one
  // synchronous block (one paint ⇒ no blank flash). Canvas CSS size stays W×H
  // (the stage transform supplies the on-screen zoom); only the backing changes.
  const renderPage = useCallback(async () => {
    const page = pageRef.current, base = baseRef.current, canvas = bgCanvasRef.current
    const ds = dispRef.current
    if (!page || !base || !canvas || ds.w <= 0) return
    const zoom = zoomRef.current
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    // Backing should be (displayed CSS px) × dpr = W·zoom·dpr wide. Clamp the
    // scale so the bitmap stays under the ceiling; above it the stage transform
    // carries the extra zoom (soft) instead of allocating a huge canvas.
    const target = (ds.w * zoom * dpr) / base.width
    const maxScale = Math.sqrt(MAX_BITMAP_PX / (base.width * base.height))
    const renderScale = Math.min(target, maxScale)

    const gen = ++renderGenRef.current
    if (renderTaskRef.current) { try { renderTaskRef.current.cancel() } catch { /* settled */ } renderTaskRef.current = null }
    let off = offscreenRef.current
    if (!off) { off = document.createElement("canvas"); offscreenRef.current = off }
    const viewport = page.getViewport({ scale: renderScale })
    const bw = Math.max(1, Math.floor(viewport.width))
    const bh = Math.max(1, Math.floor(viewport.height))
    off.width = bw; off.height = bh
    const offCtx = off.getContext("2d")
    if (!offCtx) return
    const task = page.render({ canvas: off, canvasContext: offCtx, viewport })
    renderTaskRef.current = task
    try { await task.promise } catch { return } // cancelled or failed → drop
    if (gen !== renderGenRef.current) return     // superseded
    if (renderTaskRef.current === task) renderTaskRef.current = null
    const c = bgCanvasRef.current
    if (!c) return
    c.width = bw; c.height = bh
    const cctx = c.getContext("2d")
    if (cctx) cctx.drawImage(off, 0, 0)
    setPainted(true)
  }, [])

  const scheduleSettle = useCallback(() => {
    if (settleTimerRef.current != null) clearTimeout(settleTimerRef.current)
    settleTimerRef.current = window.setTimeout(() => { settleTimerRef.current = null; void renderPage() }, SETTLE_MS)
  }, [renderPage])

  // Zoom by `factor` toward viewport point (cx,cy in client coords) — keeps the
  // page-point under the cursor fixed. Reads the stage's POST-transform rect, so
  // the flex-centred base position cancels out (no need to track it). `immediate`
  // re-renders now (buttons); otherwise debounce (continuous wheel/pinch).
  const zoomAt = useCallback((factor: number, cx: number, cy: number, immediate: boolean) => {
    const stage = stageRef.current
    if (!stage || !pageRef.current) return
    const oldZoom = zoomRef.current
    const newZoom = clamp(oldZoom * factor, MIN_ZOOM_REL, MAX_ZOOM_REL)
    if (newZoom === oldZoom) return
    const R = stage.getBoundingClientRect()
    const f = 1 - newZoom / oldZoom
    offsetRef.current = { x: offsetRef.current.x + (cx - R.left) * f, y: offsetRef.current.y + (cy - R.top) * f }
    zoomRef.current = newZoom
    setReadout(Math.round(newZoom * 100))
    applyTransform()
    if (immediate) void renderPage(); else scheduleSettle()
  }, [applyTransform, renderPage, scheduleSettle])

  const zoomButton = (factor: number) => {
    const a = areaRef.current
    if (!a) return
    const r = a.getBoundingClientRect()
    zoomAt(factor, r.left + r.width / 2, r.top + r.height / 2, true)
  }
  const fitToWidth = () => {
    zoomRef.current = 1; offsetRef.current = { x: 0, y: 0 }
    setReadout(100); applyTransform(); void renderPage()
  }
  const actualSize = () => {
    const base = baseRef.current, ds = dispRef.current
    if (!base || ds.w <= 0) return
    const zoom = base.width / ds.w // 1 PDF point → 1 CSS px
    zoomRef.current = zoom
    // Keep the actual-size page centred (the fit box was centred by flexbox).
    offsetRef.current = { x: -ds.w * (zoom - 1) / 2, y: -ds.h * (zoom - 1) / 2 }
    setReadout(Math.round(zoom * 100)); applyTransform(); void renderPage()
  }

  // Initial paint + re-render when the fit box changes (area resize). Zoom
  // gestures don't change `disp`, so this doesn't fire on zoom (the settle timer
  // handles those) — it only (re)renders the backing for a new W and re-applies
  // the transform (which React never owns, so it survives W/H re-renders).
  useEffect(() => {
    if (renderState !== "ready" || !pageRef.current || disp.w <= 0) return
    applyTransform()
    void renderPage()
  }, [renderState, disp.w, disp.h, applyTransform, renderPage])

  // Wheel zoom (native + non-passive so we can preventDefault the page scroll).
  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!pageRef.current) return
      e.preventDefault()
      const k = e.ctrlKey ? CTRL_ZOOM_K : WHEEL_ZOOM_K
      zoomAt(Math.exp(-e.deltaY * k), e.clientX, e.clientY, false)
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [zoomAt])

  // SPACE held → pan mode (drag pans instead of draws). Ref mirror so pointer
  // handlers read it synchronously; window blur clears it so it can't stick.
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.code !== "Space") return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return
      e.preventDefault() // stop the page from scrolling
      if (!spaceHeldRef.current) { spaceHeldRef.current = true; setSpaceHeld(true) }
    }
    const onUp = (e: KeyboardEvent) => {
      if (e.code !== "Space") return
      spaceHeldRef.current = false; setSpaceHeld(false)
      if (panRef.current) { panRef.current = null; setPanning(false) }
    }
    const onBlur = () => { spaceHeldRef.current = false; setSpaceHeld(false) }
    window.addEventListener("keydown", onDown)
    window.addEventListener("keyup", onUp)
    window.addEventListener("blur", onBlur)
    return () => { window.removeEventListener("keydown", onDown); window.removeEventListener("keyup", onUp); window.removeEventListener("blur", onBlur) }
  }, [])

  // Pan (SPACE + drag) lives on the AREA so it works over the page (where the SVG
  // bails on spaceHeld and lets the event bubble here) AND over the margins. Pan
  // never changes the raster resolution — just translate, no re-render.
  const onAreaPointerDown = (e: React.PointerEvent) => {
    if (!spaceHeldRef.current || !pageRef.current) return
    const stage = stageRef.current, area = areaRef.current
    if (!stage || !area) return
    e.preventDefault()
    area.setPointerCapture(e.pointerId)
    const R = stage.getBoundingClientRect()
    // Px,Py = the stage's flex-centred top-left with offset removed (constant);
    // lets us clamp the pan without tracking the layout origin separately.
    panRef.current = {
      startX: e.clientX, startY: e.clientY,
      offX: offsetRef.current.x, offY: offsetRef.current.y,
      Px: R.left - offsetRef.current.x, Py: R.top - offsetRef.current.y,
      A: area.getBoundingClientRect(),
    }
    setPanning(true)
  }
  const onAreaPointerMove = (e: React.PointerEvent) => {
    const p = panRef.current
    if (!p) return
    const ds = dispRef.current, zoom = zoomRef.current, m = 40
    const pw = ds.w * zoom, ph = ds.h * zoom
    let nx = p.offX + (e.clientX - p.startX)
    let ny = p.offY + (e.clientY - p.startY)
    // Keep ≥ m px of the page inside the area (skip the axis if the page is
    // smaller than the area minus margins — then any position keeps it visible).
    const loX = p.A.left + m - p.Px - pw, hiX = p.A.right - m - p.Px
    const loY = p.A.top + m - p.Py - ph, hiY = p.A.bottom - m - p.Py
    if (loX <= hiX) nx = clamp(nx, loX, hiX)
    if (loY <= hiY) ny = clamp(ny, loY, hiY)
    offsetRef.current = { x: nx, y: ny }
    applyTransform()
  }
  const onAreaPointerUp = (e: React.PointerEvent) => {
    if (!panRef.current) return
    areaRef.current?.releasePointerCapture?.(e.pointerId)
    panRef.current = null; setPanning(false)
  }

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
  const [exporting, setExporting] = useState(false)

  const svgRef = useRef<SVGSVGElement>(null)
  // Screen px → normalized [0,1]. The shared-container transform means the SVG's
  // rect is already POST-transform, so this rect-relative math needs NO zoom/pan
  // terms — it is correct at any zoom. (Do not add (px-offset)/(base*scale) here.)
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

  // Pick a tool. Highlight tools carry translucency (+ a default amber the first
  // time you enter highlight); leaving highlight drops opacity so the other tools
  // stay opaque. The colour / stroke swatches still patch the active style.
  function selectTool(t: Tool) {
    setTool(t)
    if (t !== "select") setSelectedId(null)
    const isHl = t === "highlight" || t === "highlightPen"
    setStyle(s => isHl
      ? { ...s, opacity: HIGHLIGHT_OPACITY, color: s.opacity == null ? HIGHLIGHT_DEFAULT_COLOR : s.color }
      : (s.opacity == null ? s : { ...s, opacity: undefined }))
  }

  // ── Pointer interaction ───────────────────────────────────────────────────
  // Snap `end` so start→end lands on the nearest 0/45/90°, measured in CURRENT
  // displayed px (fit box × zoom). Uniform zoom scales dxp,dyp and the back-
  // projection equally, so it cancels — but reading the px the user actually
  // sees keeps this correct regardless of zoom.
  function snapToAngle(start: Point, end: Point): Point {
    const z = zoomRef.current
    const dw = disp.w * z, dh = disp.h * z
    const dxp = (end.x - start.x) * dw, dyp = (end.y - start.y) * dh
    const dist = Math.hypot(dxp, dyp)
    if (dist === 0) return end
    const ang = Math.round(Math.atan2(dyp, dxp) / (Math.PI / 4)) * (Math.PI / 4)
    return {
      x: dw ? start.x + (Math.cos(ang) * dist) / dw : start.x,
      y: dh ? start.y + (Math.sin(ang) * dist) / dh : start.y,
    }
  }

  function onPointerDown(e: React.PointerEvent) {
    if (editing) return // let the text input own the click
    if (spaceHeldRef.current) return // space-drag pans (handled on the area)
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
    else if (tool === "highlight") setDraft({ ...base, type: "highlight", shape: "rect", x: p.x, y: p.y, w: 0, h: 0 })
    else if (tool === "highlightPen") setDraft({ ...base, type: "highlight", shape: "free", points: [p] })
    else if (tool === "cloud") setDraft({ ...base, type: "cloud", x: p.x, y: p.y, w: 0, h: 0 })
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
    // Shift held → constrain (decided per-move off the live shiftKey, so we don't
    // fight a stroke mid-way). Freehand tools become a straight 2-point segment
    // anchored at the stroke start; the arrow snaps its end to 0/45/90°.
    const shift = e.shiftKey
    switch (draft.type) {
      case "line":
        // Shift → a straight segment LOCKED to the nearest 0/45/90° axis (the
        // endpoint snaps onto that line; it can't sit off-axis). Else freehand.
        setDraft(shift
          ? { ...draft, points: [draft.points[0], snapToAngle(draft.points[0], p)] }
          : { ...draft, points: [...draft.points, p] })
        break
      case "highlight":
        if (draft.shape === "free") {
          setDraft(shift
            ? { ...draft, points: [draft.points[0], snapToAngle(draft.points[0], p)] }
            : { ...draft, points: [...draft.points, p] })
        } else {
          setDraft({ ...draft, w: p.x - draft.x, h: p.y - draft.y })
        }
        break
      case "rect":
      case "cloud":
        setDraft({ ...draft, w: p.x - draft.x, h: p.y - draft.y })
        break
      case "arrow": {
        const end = shift ? snapToAngle({ x: draft.x1, y: draft.y1 }, p) : p
        setDraft({ ...draft, x2: end.x, y2: end.y })
        break
      }
    }
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
    if (d.type === "highlight" && d.shape === "free") return d.points.length >= 2 ? d : null
    if (d.type === "rect" || d.type === "cloud" || (d.type === "highlight" && d.shape === "rect")) {
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

  // Hand the full serialized doc (with base provenance) to the parent's save.
  // The parent owns the persistence intent: in "new" mode each save stores a
  // fresh numbered markup; in "edit" mode it updates the specific markup it
  // opened. The editor no longer captures/reuses a returned id — a new markup is
  // its own revision, never folded back into the same row.
  async function save() {
    if (!onSave || present.length === 0) return
    setSaving(true)
    try {
      await onSave(serializeMarkups(present, { revisionId: baseRevisionId ?? null, label: baseLabel ?? null }))
    } finally { setSaving(false) }
  }

  // Export (Part 2b): flatten the CURRENT markup onto the full-res original sheet
  // and download a single-page PDF — purely client-side. Writes NO revision, no
  // DB, no storage; the original is read-only. pdf-lib (+ this composite module)
  // is dynamically imported so it only loads when a user actually exports.
  async function exportPdf() {
    if (present.length === 0) return
    setExporting(true)
    try {
      const bytes = originalBytesRef.current ?? await (await fetch(fileUrl)).arrayBuffer()
      const { exportMarkedUpSheet, markupExportFilename } = await import("@/lib/drawing-markup-export")
      const out = await exportMarkedUpSheet(bytes, present)
      // Copy into a plain ArrayBuffer — pdf-lib's Uint8Array<ArrayBufferLike>
      // isn't directly assignable to BlobPart under TS's strict typed-array types.
      const ab = new ArrayBuffer(out.byteLength)
      new Uint8Array(ab).set(out)
      const blob = new Blob([ab], { type: "application/pdf" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = markupExportFilename(sheetNumber)
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error("Markup export failed", err)
      alert("Couldn’t export this markup as a PDF. Please try again.")
    } finally { setExporting(false) }
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

  // ── Render helpers (normalized → displayed px, in the SVG's own W×H space) ──
  // px/py stay in the UNSCALED fit box; the stage's CSS transform applies zoom to
  // both the canvas and this SVG together, so stroke width / font size scale with
  // the page automatically (no zoom term here).
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
      case "highlight": {
        const op = m.style.opacity ?? 1
        if (m.shape === "rect") {
          const b = boundingBox(m)
          return (
            <rect key={m.id} x={px(b.x)} y={py(b.y)} width={px(b.w)} height={py(b.h)}
              fill={m.style.color} fillOpacity={op} stroke="none"
              style={{ cursor: tool === "select" ? "move" : "default" }} />
          )
        }
        return (
          <polyline key={m.id} points={m.points.map(p => `${px(p.x)},${py(p.y)}`).join(" ")}
            fill="none" stroke={m.style.color} strokeOpacity={op}
            strokeWidth={Math.max(strokePx(m) * 2.5, H * 0.01)}
            strokeLinecap="round" strokeLinejoin="round"
            style={{ cursor: tool === "select" ? "move" : "default" }} />
        )
      }
      case "cloud": {
        const b = boundingBox(m)
        const corners = [
          { x: px(b.x), y: py(b.y) }, { x: px(b.x + b.w), y: py(b.y) },
          { x: px(b.x + b.w), y: py(b.y + b.h) }, { x: px(b.x), y: py(b.y + b.h) },
        ]
        const pts = cloudOutline(corners, Math.max(6, H * CLOUD_SCALLOP_FRAC))
        const d = pts.length ? "M " + pts.map(p => `${p.x} ${p.y}`).join(" L ") + " Z" : ""
        return (
          <path key={m.id} d={d} fill="none" stroke={m.style.color} strokeWidth={strokePx(m)}
            strokeLinecap="round" strokeLinejoin="round"
            style={{ cursor: tool === "select" ? "move" : "default" }} />
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
  const toolCursor = tool === "select" ? "default" : tool === "text" ? "text" : "crosshair"
  // SPACE pan overrides the tool cursor (grab / grabbing) over the whole surface.
  const viewCursor = spaceHeld ? (panning ? "grabbing" : "grab") : null

  // Size control context: the Text tool / a selected text item edits fontSize;
  // everything else edits strokeWidth. Drives the numeric Size dropdown below.
  const selectedType = present.find(m => m.id === selectedId)?.type
  const sizeIsText = tool === "text" || selectedType === "text"
  const sizeOptions = sizeIsText ? TEXT_SIZES : STROKE_SIZES
  const sizeUnit = sizeIsText ? TEXT_UNIT : STROKE_UNIT
  const sizeValue = nearestSize(sizeOptions, (sizeIsText ? style.fontSize : style.strokeWidth) / sizeUnit)

  // ── UI ────────────────────────────────────────────────────────────────────
  const toolBtn = (active: boolean) =>
    `h-8 px-2.5 rounded-md text-[12px] font-semibold inline-flex items-center gap-1.5 transition-colors ${
      active ? "bg-[#7B9BB5] text-white" : "text-[#475569] border border-[#E2E8F0] hover:bg-[#7B9BB5]/10"}`
  const iconBtn = "h-8 w-8 rounded-md border border-[#E2E8F0] text-[#475569] inline-flex items-center justify-center hover:bg-[#7B9BB5]/10 disabled:opacity-40 transition-colors"
  const presetBtn = "h-8 px-2.5 rounded-md text-[12px] font-semibold text-[#475569] border border-[#E2E8F0] hover:bg-[#7B9BB5]/10 disabled:opacity-40 transition-colors"
  const notReady = renderState !== "ready"

  return (
    <div className="flex flex-col h-full w-full bg-[#F1F3F5]">
      {/* Toolbar */}
      <div className="flex-shrink-0 flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 bg-white border-b border-[#E2E8F0]">
        <div className="flex items-center gap-1">
          {TOOLS.map(({ tool: t, label, Icon }) => (
            <button key={t} onClick={() => selectTool(t)}
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

        {/* Size — numeric weight (or text size when the Text tool / a text item is active) */}
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-[#64748B]">{sizeIsText ? "Text" : "Size"}</span>
          <select value={sizeValue}
            onChange={e => applyStyle(sizeIsText ? { fontSize: Number(e.target.value) * sizeUnit } : { strokeWidth: Number(e.target.value) * sizeUnit })}
            className="h-8 rounded-md border border-[#E2E8F0] bg-white text-[12px] text-[#475569] px-1.5 outline-none focus:border-[#7B9BB5]">
            {sizeOptions.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>

        <div className="w-px h-6 bg-[#E2E8F0]" />

        {/* Zoom — readout is RELATIVE to fit (fit = 100%); "1:1" = actual page px.
            Space-drag pans. Same chrome + convention as the read-only view. */}
        <div className="flex items-center gap-1">
          <button onClick={() => zoomButton(1 / ZOOM_BTN_STEP)} disabled={notReady} className={iconBtn} title="Zoom out"><MinusIcon /></button>
          <span className="text-[12px] text-[#475569] font-semibold tabular-nums w-11 text-center" aria-live="polite">{readout}%</span>
          <button onClick={() => zoomButton(ZOOM_BTN_STEP)} disabled={notReady} className={iconBtn} title="Zoom in"><PlusIcon /></button>
          <button onClick={fitToWidth} disabled={notReady} className={`${presetBtn} ml-1`} title="Fit to width">Fit</button>
          <button onClick={actualSize} disabled={notReady} className={presetBtn} title="Actual size (1:1 page pixels)">1:1</button>
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <button onClick={undo} disabled={past.length === 0} className="h-8 w-8 rounded-md border border-[#E2E8F0] text-[#475569] inline-flex items-center justify-center hover:bg-[#7B9BB5]/10 disabled:opacity-40" title="Undo (Ctrl+Z)"><UndoIcon /></button>
          <button onClick={redo} disabled={future.length === 0} className="h-8 w-8 rounded-md border border-[#E2E8F0] text-[#475569] inline-flex items-center justify-center hover:bg-[#7B9BB5]/10 disabled:opacity-40" title="Redo (Ctrl+Shift+Z)"><RedoIcon /></button>
          <button onClick={deleteSelected} disabled={!selectedId} className="h-8 w-8 rounded-md border border-[#E2E8F0] text-[#475569] inline-flex items-center justify-center hover:bg-red-50 hover:text-red-500 hover:border-red-200 disabled:opacity-40" title="Delete selected (Del)"><TrashIcon /></button>
          <span className="text-[11px] text-[#94A3B8] tabular-nums px-1">{present.length} markup{present.length === 1 ? "" : "s"}</span>
          <button onClick={exportPdf} disabled={exporting || present.length === 0}
            className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[#475569] text-[12px] font-semibold hover:bg-[#7B9BB5]/10 transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
            title="Download a flattened PDF of this sheet with the markups">
            {exporting ? <SpinnerIcon className="h-3 w-3" /> : <DownloadIcon />}
            {exporting ? "Exporting…" : "Export PDF"}
          </button>
          <button onClick={save} disabled={saving || present.length === 0}
            className="h-8 px-3.5 rounded-md bg-[#7B9BB5] text-white text-[12px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 inline-flex items-center gap-1.5">
            {saving && <SpinnerIcon className="h-3 w-3" />}
            {saving ? "Saving…" : mode === "edit" ? "Save changes" : "Save as new revision"}
          </button>
        </div>
      </div>

      {/* Canvas area — wheel zooms; SPACE+drag pans. overflow-hidden clips the
          zoomed/panned stage; the stage carries the shared zoom/pan transform. */}
      <div ref={areaRef} className="relative flex-1 min-h-0 flex items-center justify-center p-3 overflow-hidden"
        style={{ touchAction: "none", cursor: viewCursor ?? undefined }}
        onPointerDown={onAreaPointerDown} onPointerMove={onAreaPointerMove}
        onPointerUp={onAreaPointerUp} onPointerCancel={onAreaPointerUp}>
        {renderState === "error" && (
          <div className="absolute inset-0 flex items-center justify-center text-[13px] text-[#94A3B8] text-center px-6">Couldn’t render this sheet for markup.<br />The file may not be a PDF, or it failed to load.</div>
        )}
        {(renderState === "loading" || (renderState === "ready" && !painted)) && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-[13px] text-[#64748B]"><SpinnerIcon className="h-4 w-4" /> Rendering sheet…</div>
        )}
        {renderState === "ready" && W > 0 && (
          // The SHARED stage: zoom/pan transform applied imperatively (kept out of
          // JSX so it survives W/H re-renders). Background canvas + SVG move as one.
          <div ref={stageRef} className="relative shadow-lg" style={{ width: W, height: H }}>
            <canvas ref={bgCanvasRef} aria-hidden className={`block w-full h-full select-none ${painted ? "" : "invisible"}`} />
            <svg
              ref={svgRef}
              className="absolute inset-0"
              width={W} height={H}
              style={{ touchAction: "none", cursor: viewCursor ?? toolCursor }}
              // While placing text, swallow the mousedown default: clicking the
              // (non-focusable) SVG would otherwise move focus to <body> right
              // after the input mounts, blurring it before a key is pressed.
              onMouseDown={e => { if (tool === "text" && !spaceHeldRef.current) e.preventDefault() }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            >
              {ordered.map(m => renderMarkup(m))}
              {draft && renderMarkup(draft)}
              {tool === "select" && renderSelection()}
            </svg>

            {/* Inline text editor overlay — positioned in the SVG's W×H space, so
                it rides the shared transform and lands correctly at any zoom. */}
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
