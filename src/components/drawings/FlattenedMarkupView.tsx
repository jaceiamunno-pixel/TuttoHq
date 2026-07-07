"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { Markup, MarkupDoc } from "@/lib/drawing-markup"
import { SpinnerIcon } from "../../app/dashboard/_shared/icons"

// Read-only flattened view of a saved markup revision (ADR-005 Phase 2, Part 2c;
// zoom/pan added in ADR-008 Piece 1). Composites the revision's vector markup onto
// its CLEAN ORIGINAL base — fresh, client-side — via exportMarkedUpSheet, then
// RENDERS the composited PDF to a <canvas> with pdf.js (unpdf). Reuses the 2b
// composite primitive; no stored raster, no DB write, no derivative file. The
// original is read-only (the composite builds a fresh throwaway doc). `baseUrl`
// MUST be the markup's clean base (markup_base_url) so the markup lands over the
// sheet it was drawn on. The composite output is byte-identical to before — this
// piece only changes HOW/AT-WHAT-SCALE those bytes get rasterized for display.
//
// ── Zoom/pan model (Bluebeam-grade, transform-then-refine) ──────────────────
// The composite (fetch base + exportMarkedUpSheet + getDocumentProxy) runs ONCE
// per (baseUrl, markups) change; the resulting pdf.js page is kept alive in a ref.
// Zooming/panning never re-composites — it only re-rasterizes the in-memory page.
//
// `displayScale` (CSS px per PDF unit) is the source of truth. Fit-to-width is
// displayScale = panelW / pageWidth; "1:1" is displayScale = 1 (page point ⇒ CSS
// px). The toolbar % is RELATIVE to fit (fit = 100%) — that is the axis the
// memory ceiling (MAX_BITMAP_PX) is calibrated against: a full-page raster stays
// crisp (≥ 1:1 device px) up to ~400% of fit, where its on-screen CSS area nears
// ~16M px; beyond that the CSS transform handles the extra zoom (soft but safe).
//
// During a gesture we only CSS-transform the existing canvas (instant, slightly
// soft); ~120ms after it settles we re-run page.render() at the new scale*dpr
// (dpr capped at 2, clamped by the ceiling), render off-screen, then blit in one
// synchronous paint (no flash) and reset the transform. Panning never changes the
// raster resolution, so it needs no re-render — only zoom schedules a settle.

// pdf.js types aren't statically imported here (keeps this client-only + matches
// the file's existing loose-typing of the inferred proxy). These minimal shapes
// cover exactly what we touch; the proxies are cast in through `unknown`.
type Viewport = { width: number; height: number }
type RenderTask = { promise: Promise<void>; cancel: () => void }
type PdfPage = {
  getViewport: (opts: { scale: number }) => Viewport
  render: (opts: { canvas: HTMLCanvasElement; canvasContext: CanvasRenderingContext2D; viewport: Viewport }) => RenderTask
}
type PdfDoc = { getPage: (n: number) => Promise<PdfPage>; destroy: () => Promise<void>; numPages: number }

const SETTLE_MS = 120              // debounce before a crisp re-render after a gesture
const MAX_BITMAP_PX = 16_000_000   // raster ceiling (~16M px ≈ crisp through ~4× fit)
const WHEEL_ZOOM_K = 0.0015        // scroll-wheel zoom sensitivity (exp of -deltaY)
const CTRL_ZOOM_K = 0.012          // trackpad pinch (ctrlKey wheel) — coarser per delta
const ZOOM_BTN_STEP = 1.25         // −/+ button multiplier
const MIN_ZOOM_REL = 0.25          // out to 25% of fit
const MAX_ZOOM_REL = 16            // in to 1600% of fit (soft past ~4×)

const MinusIcon = () => <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeWidth={2} d="M5 12h14" /></svg>
const PlusIcon = () => <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeWidth={2} d="M12 5v14M5 12h14" /></svg>

export default function FlattenedMarkupView({ baseUrl, markups, title, pageNumber = 1, onPagesLoaded }: {
  baseUrl: string
  /** The revision's serialized doc (or a bare Markup[]). */
  markups: MarkupDoc | Markup[]
  title?: string | null
  /** 1-indexed page to display. Default 1 = the historical single-page behaviour.
   *  Honoured only when `markups` is empty (the count/takeoff use): the composite
   *  path flattens onto page 1 only, so it stays single-page as before. */
  pageNumber?: number
  /** Reports the source PDF's total page count once loaded (for a page selector). */
  onPagesLoaded?: (numPages: number) => void
}) {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading")
  const [readout, setReadout] = useState(100) // zoom %, relative to fit-to-width
  const [dragging, setDragging] = useState(false)

  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Kept-alive pdf.js handles + the page's intrinsic (scale-1) size.
  const pageRef = useRef<PdfPage | null>(null)
  const pdfDocRef = useRef<PdfDoc | null>(null)
  const baseRef = useRef<Viewport | null>(null)
  // Multi-page: the loaded doc is kept alive across page flips (flipping only
  // getPage()s + re-renders — never re-fetches/re-composites).
  const numPagesRef = useRef(1)
  const pageNumberRef = useRef(pageNumber)
  const shownPageRef = useRef(0)            // last page actually rendered (0 = none yet)
  const onPagesLoadedRef = useRef(onPagesLoaded)
  onPagesLoadedRef.current = onPagesLoaded
  // Off-screen buffer the crisp re-render paints into before the flash-free blit.
  const offscreenRef = useRef<HTMLCanvasElement | null>(null)
  const renderTaskRef = useRef<RenderTask | null>(null)
  const renderGenRef = useRef(0)              // monotonic; discards superseded renders
  const settleTimerRef = useRef<number | null>(null)

  // Viewport (held in refs so gestures update at 60fps without a React re-render;
  // the canvas geometry is driven imperatively, the toolbar % via `readout` state).
  const displayScaleRef = useRef(1)           // CSS px per PDF unit, current
  const fitScaleRef = useRef(1)               // displayScale that fills panel width
  const renderedScaleRef = useRef(1)          // displayScale the visible bitmap was rendered at
  const offsetRef = useRef({ x: 0, y: 0 })    // page top-left, in viewport CSS px
  const isFitRef = useRef(true)               // true while still at fit-to-width (drives resize)
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)

  // CSS-transform the existing canvas to the live viewport (cheap, mid-gesture
  // soft). transform-origin 0 0: the page top-left lands exactly at `offset`, and
  // the page draws at displayScale·base regardless of the rendered scale.
  const applyTransform = useCallback(() => {
    const c = canvasRef.current
    if (!c) return
    const ratio = displayScaleRef.current / renderedScaleRef.current
    c.style.transformOrigin = "0 0"
    c.style.transform = `translate(${offsetRef.current.x}px, ${offsetRef.current.y}px) scale(${ratio})`
  }, [])

  // Keep at least a margin of the page inside the viewport so it can't be lost.
  const clampOffset = useCallback((off: { x: number; y: number }, ds: number) => {
    const vp = wrapRef.current, base = baseRef.current
    if (!vp || !base) return off
    const vw = vp.clientWidth, vh = vp.clientHeight
    const pw = base.width * ds, ph = base.height * ds
    const mx = Math.min(80, pw * 0.5), my = Math.min(80, ph * 0.5)
    return {
      x: Math.min(Math.max(off.x, mx - pw), vw - mx),
      y: Math.min(Math.max(off.y, my - ph), vh - my),
    }
  }, [])

  // Re-rasterize the in-memory page at the current displayScale and swap it in
  // crisp. Renders off-screen first, then resizes + blits the visible canvas in a
  // single synchronous block (one paint ⇒ no blank flash).
  const renderCrisp = useCallback(async () => {
    const page = pageRef.current, base = baseRef.current
    if (!page || !base || !canvasRef.current) return
    const ds = displayScaleRef.current
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    // Clamp scale·dpr so the raster never exceeds the ceiling; above it the CSS
    // transform supplies the extra zoom (soft) rather than allocating a huge canvas.
    const maxScale = Math.sqrt(MAX_BITMAP_PX / (base.width * base.height))
    const renderScale = Math.min(ds * dpr, maxScale)

    const gen = ++renderGenRef.current
    // Cancel any in-flight render before starting a new one (teardown discipline).
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
    if (gen !== renderGenRef.current) return     // superseded by a newer render
    if (renderTaskRef.current === task) renderTaskRef.current = null

    const c = canvasRef.current
    if (!c) return
    c.width = bw; c.height = bh
    c.style.width = `${base.width * ds}px`
    c.style.height = `${base.height * ds}px`
    renderedScaleRef.current = ds
    const cctx = c.getContext("2d")
    if (cctx) cctx.drawImage(off, 0, 0)
    applyTransform()
  }, [applyTransform])

  const scheduleSettle = useCallback(() => {
    if (settleTimerRef.current != null) clearTimeout(settleTimerRef.current)
    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = null
      void renderCrisp()
    }, SETTLE_MS)
  }, [renderCrisp])

  // Zoom by `factor` toward viewport point (cx,cy) — keeps the page-point under
  // the cursor fixed. `immediate` re-renders now (discrete buttons); otherwise it
  // debounces (continuous wheel/pinch). No offset clamp here so the cursor anchor
  // stays exact; the focal math keeps content on-screen anyway.
  const zoomAt = useCallback((factor: number, cx: number, cy: number, immediate: boolean) => {
    const base = baseRef.current, vp = wrapRef.current
    if (!base || !vp || !pageRef.current) return
    const fit = fitScaleRef.current
    const oldDs = displayScaleRef.current
    const newDs = Math.min(Math.max(oldDs * factor, fit * MIN_ZOOM_REL), fit * MAX_ZOOM_REL)
    if (newDs === oldDs) return
    const off = offsetRef.current
    const k = newDs / oldDs
    offsetRef.current = { x: cx - (cx - off.x) * k, y: cy - (cy - off.y) * k }
    displayScaleRef.current = newDs
    isFitRef.current = false
    setReadout(Math.round(newDs / fit * 100))
    applyTransform()
    if (immediate) void renderCrisp(); else scheduleSettle()
  }, [applyTransform, renderCrisp, scheduleSettle])

  const fitToWidth = useCallback(() => {
    const base = baseRef.current, vp = wrapRef.current
    if (!base || !vp || !pageRef.current) return
    const vw = vp.clientWidth, vh = vp.clientHeight
    const ds = vw / base.width
    const ph = base.height * ds
    displayScaleRef.current = ds
    fitScaleRef.current = ds
    offsetRef.current = { x: 0, y: ph > vh ? 0 : (vh - ph) / 2 }
    isFitRef.current = true
    setReadout(100)
    applyTransform()
    void renderCrisp()
  }, [applyTransform, renderCrisp])

  const actualSize = useCallback(() => {
    const base = baseRef.current, vp = wrapRef.current
    if (!base || !vp || !pageRef.current) return
    const vw = vp.clientWidth, vh = vp.clientHeight
    displayScaleRef.current = 1
    offsetRef.current = clampOffset({ x: (vw - base.width) / 2, y: (vh - base.height) / 2 }, 1)
    isFitRef.current = false
    setReadout(Math.round(1 / fitScaleRef.current * 100))
    applyTransform()
    void renderCrisp()
  }, [applyTransform, clampOffset, renderCrisp])

  // Load a page from the already-alive doc and reset it to fit-to-width. Used for
  // both the initial render and every page flip (no re-fetch, no re-composite).
  // renderGenRef supersedes an older in-flight page-load if a newer one starts.
  const showPage = useCallback(async (n: number) => {
    const pdf = pdfDocRef.current
    if (!pdf) return
    const total = Math.max(1, numPagesRef.current)
    const clamped = Math.min(Math.max(1, Math.round(n)), total)
    const gen = ++renderGenRef.current
    let page: PdfPage
    try { page = await pdf.getPage(clamped) } catch { return }
    if (gen !== renderGenRef.current) return // superseded by a newer load
    pageRef.current = page
    const base = page.getViewport({ scale: 1 })
    baseRef.current = { width: base.width, height: base.height }
    shownPageRef.current = clamped
    fitToWidth() // fit-to-width + renderCrisp (reproduces the initial-view path)
  }, [fitToWidth])

  // ── Load ONCE per (baseUrl, markups); keep the doc alive for zoom + page flips ─
  useEffect(() => {
    let alive = true
    setState("loading")
    renderGenRef.current++ // invalidate any render still in flight from a prior doc
    ;(async () => {
      try {
        const ab = await (await fetch(baseUrl)).arrayBuffer()
        const mk = Array.isArray(markups) ? markups : markups.markups
        // WITH markups: composite onto page 1 (existing single-page behaviour —
        // exportMarkedUpSheet is page-1-only). WITHOUT markups (count/takeoff):
        // render the ORIGINAL directly so all pages survive for the page selector.
        let bytes: Uint8Array
        if ((mk?.length ?? 0) > 0) {
          const { exportMarkedUpSheet } = await import("@/lib/drawing-markup-export")
          bytes = await exportMarkedUpSheet(ab, markups)
        } else {
          bytes = new Uint8Array(ab)
        }
        if (!alive) return

        // Render the bytes with pdf.js (via unpdf — the same path the splitter/
        // editor use; no new dependency). Lazy-import so it loads only when this
        // view mounts, matching the export module above.
        const { getDocumentProxy, createIsomorphicCanvasFactory } = await import("unpdf")
        const CanvasFactory = await createIsomorphicCanvasFactory()
        // new Uint8Array(bytes) copies into a fresh buffer — pdf.js may neuter it.
        const pdf = (await getDocumentProxy(new Uint8Array(bytes), { CanvasFactory })) as unknown as PdfDoc
        if (!alive) { try { await pdf.destroy() } catch { /* noop */ } return }
        pdfDocRef.current = pdf
        numPagesRef.current = Math.max(1, pdf.numPages || 1)
        onPagesLoadedRef.current?.(numPagesRef.current)

        await showPage(pageNumberRef.current) // initial view = fit-to-width of the requested page
        if (!alive) return
        setState("ready")
      } catch (err) {
        console.error("Markup flatten-view failed", err)
        if (alive) setState("error")
      }
    })()
    return () => {
      alive = false
      renderGenRef.current++ // invalidate any in-flight settle render
      if (settleTimerRef.current != null) { clearTimeout(settleTimerRef.current); settleTimerRef.current = null }
      try { renderTaskRef.current?.cancel() } catch { /* task already settled */ }
      renderTaskRef.current = null
      try { pdfDocRef.current?.destroy() } catch { /* doc already destroyed */ }
      pdfDocRef.current = null
      pageRef.current = null
      baseRef.current = null
      shownPageRef.current = 0
    }
  }, [baseUrl, markups, showPage])

  // ── Flip to a new page on the alive doc (no re-fetch/re-composite) ───────────
  useEffect(() => {
    pageNumberRef.current = pageNumber
    if (pdfDocRef.current && shownPageRef.current !== 0 && shownPageRef.current !== pageNumber) {
      void showPage(pageNumber)
    }
  }, [pageNumber, showPage])

  // ── Wheel zoom (native, non-passive so we can preventDefault the page scroll) ─
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!pageRef.current) return
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const k = e.ctrlKey ? CTRL_ZOOM_K : WHEEL_ZOOM_K
      zoomAt(Math.exp(-e.deltaY * k), e.clientX - rect.left, e.clientY - rect.top, false)
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [zoomAt])

  // ── Re-fit on resize while still at fit; otherwise just re-clamp the pan ──────
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const base = baseRef.current
      if (!pageRef.current || !base) return
      if (isFitRef.current) {
        fitToWidth()
      } else {
        fitScaleRef.current = el.clientWidth / base.width
        offsetRef.current = clampOffset(offsetRef.current, displayScaleRef.current)
        setReadout(Math.round(displayScaleRef.current / fitScaleRef.current * 100))
        applyTransform()
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [applyTransform, clampOffset, fitToWidth])

  // ── Drag to pan (whole surface — no drawing tools here). Pan never changes the
  // raster resolution, so it needs no re-render: just translate. ───────────────
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !pageRef.current) return
    wrapRef.current?.setPointerCapture(e.pointerId)
    dragRef.current = { x: e.clientX, y: e.clientY, ox: offsetRef.current.x, oy: offsetRef.current.y }
    setDragging(true)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    offsetRef.current = clampOffset({ x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) }, displayScaleRef.current)
    isFitRef.current = false
    applyTransform()
  }
  const onPointerUp = (e: React.PointerEvent) => {
    if (!dragRef.current) return
    wrapRef.current?.releasePointerCapture?.(e.pointerId)
    dragRef.current = null
    setDragging(false)
  }

  const zoomBtn = "h-8 w-8 rounded-md border border-[#E2E8F0] text-[#475569] inline-flex items-center justify-center hover:bg-[#7B9BB5]/10 disabled:opacity-40 transition-colors"
  const presetBtn = "h-8 px-2.5 rounded-md text-[12px] font-semibold text-[#475569] border border-[#E2E8F0] hover:bg-[#7B9BB5]/10 disabled:opacity-40 transition-colors"
  const ready = state === "ready"

  return (
    <div className="flex flex-col h-full w-full bg-[#F1F3F5]">
      {/* Toolbar — matches the editor's chrome (h-8, #7B9BB5 accent, #E2E8F0). */}
      <div className="flex-shrink-0 flex items-center gap-1.5 px-3 py-2 bg-white border-b border-[#E2E8F0]">
        <button onClick={() => { const v = wrapRef.current; if (v) zoomAt(1 / ZOOM_BTN_STEP, v.clientWidth / 2, v.clientHeight / 2, true) }}
          disabled={!ready} className={zoomBtn} title="Zoom out"><MinusIcon /></button>
        <span className="text-[12px] text-[#475569] font-semibold tabular-nums w-12 text-center" aria-live="polite">{readout}%</span>
        <button onClick={() => { const v = wrapRef.current; if (v) zoomAt(ZOOM_BTN_STEP, v.clientWidth / 2, v.clientHeight / 2, true) }}
          disabled={!ready} className={zoomBtn} title="Zoom in"><PlusIcon /></button>
        <div className="w-px h-6 bg-[#E2E8F0] mx-1" />
        <button onClick={fitToWidth} disabled={!ready} className={presetBtn} title="Fit to width">Fit width</button>
        <button onClick={actualSize} disabled={!ready} className={presetBtn} title="Actual size (1:1 page pixels)">1:1</button>
        {title && <span className="ml-auto text-[12px] text-[#64748B] truncate pl-2">{title}</span>}
      </div>

      {/* Viewport — the canvas is absolutely positioned and driven imperatively
          (size/transform). It stays mounted across states so the ref is live
          during render; loading/error overlay on top, canvas shown once painted. */}
      <div
        ref={wrapRef}
        className="relative flex-1 min-h-0 overflow-hidden bg-[#F1F3F5]"
        style={{ touchAction: "none", cursor: dragging ? "grabbing" : "grab" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <canvas
          ref={canvasRef}
          aria-label={title ?? "marked-up sheet"}
          className={`absolute left-0 top-0 select-none ${ready ? "" : "invisible"}`}
          draggable={false}
        />
        {state === "loading" && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-[13px] text-[#64748B]">
            <SpinnerIcon className="h-4 w-4" /> Rendering markup…
          </div>
        )}
        {state === "error" && (
          <div className="absolute inset-0 flex items-center justify-center text-[13px] text-[#94A3B8] text-center px-6">
            Couldn’t render this markup.<br />The base sheet may have failed to load.
          </div>
        )}
      </div>
    </div>
  )
}
