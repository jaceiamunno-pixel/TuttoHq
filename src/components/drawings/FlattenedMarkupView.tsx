"use client"

import { useEffect, useRef, useState } from "react"
import type { Markup, MarkupDoc } from "@/lib/drawing-markup"
import { SpinnerIcon } from "../../app/dashboard/_shared/icons"

// Read-only flattened view of a saved markup revision (ADR-005 Phase 2, Part 2c).
// Composites the revision's vector markup onto its CLEAN ORIGINAL base — fresh,
// client-side, on every view — then RENDERS the composited PDF to a <canvas>
// with pdf.js. Reuses the 2b composite primitive (exportMarkedUpSheet); no stored
// raster, no DB write, no derivative file. The original is read-only (the
// composite builds a fresh throwaway doc). `baseUrl` MUST be the markup's clean
// base (markup_base_url), not whatever is `current`, so the markup lands over the
// sheet it was drawn on.
//
// WHY a pdf.js canvas (not a blob: URL in an <iframe>): a blob:-backed PDF does
// not reliably paint inside an <iframe> here — every other generated-PDF surface
// in the app displays via a signed URL, never blob-in-iframe. The composite is
// correct; the iframe was the failure. Rendering the composited bytes straight to
// a canvas (via unpdf — the same pdf.js path the splitter/editor already use)
// drops the blob+iframe entirely and paints the sheet, markup and all.

export default function FlattenedMarkupView({ baseUrl, markups, title }: {
  baseUrl: string
  /** The revision's serialized doc (or a bare Markup[]). */
  markups: MarkupDoc | Markup[]
  title?: string | null
}) {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading")
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let alive = true
    // Broad cleanup holders (the inferred RenderTask / PDFDocumentProxy below are
    // assignable) so the effect teardown can run without importing pdf.js types.
    let renderTask: { cancel: () => void } | null = null
    let pdfDoc: { destroy: () => Promise<void> } | null = null
    setState("loading")
    ;(async () => {
      try {
        const ab = await (await fetch(baseUrl)).arrayBuffer()
        // pdf-lib only loads when a markup view is actually opened.
        const { exportMarkedUpSheet } = await import("@/lib/drawing-markup-export")
        const bytes = await exportMarkedUpSheet(ab, markups)
        if (!alive) return

        // Render the composited bytes with pdf.js (via unpdf — the same path the
        // splitter/editor use; no new dependency). Lazy-import so it loads only
        // when this view mounts, matching the export module above.
        const { getDocumentProxy, createIsomorphicCanvasFactory } = await import("unpdf")
        const CanvasFactory = await createIsomorphicCanvasFactory()
        // new Uint8Array(bytes) copies into a fresh buffer — pdf.js may neuter it.
        const pdf = await getDocumentProxy(new Uint8Array(bytes), { CanvasFactory })
        pdfDoc = pdf
        const page = await pdf.getPage(1)
        if (!alive) return
        const canvas = canvasRef.current
        if (!canvas) return
        const ctx = canvas.getContext("2d")
        if (!ctx) throw new Error("no 2d canvas context")

        // Fit the page to the panel width; preserve aspect via CSS (w-full/h-auto
        // on the element). Back the bitmap at device pixel ratio (capped at 2 to
        // bound memory on a large sheet) so it stays crisp on HiDPI displays.
        const base = page.getViewport({ scale: 1 })
        const panelW = wrapRef.current?.clientWidth || base.width
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        const viewport = page.getViewport({ scale: (panelW / base.width) * dpr })
        canvas.width = Math.max(1, Math.floor(viewport.width))
        canvas.height = Math.max(1, Math.floor(viewport.height))

        const task = page.render({ canvas, canvasContext: ctx, viewport })
        renderTask = task
        await task.promise
        if (!alive) return
        setState("ready")
      } catch (err) {
        console.error("Markup flatten-view failed", err)
        if (alive) setState("error")
      }
    })()
    return () => {
      alive = false
      try { renderTask?.cancel() } catch { /* task already settled */ }
      try { pdfDoc?.destroy() } catch { /* doc already destroyed */ }
    }
  }, [baseUrl, markups])

  // The canvas stays mounted across states so the ref is live while rendering;
  // loading/error overlay on top, canvas revealed once the page has painted.
  return (
    <div ref={wrapRef} className="relative w-full h-full overflow-auto bg-[#F1F3F5]">
      <canvas
        ref={canvasRef}
        aria-label={title ?? "marked-up sheet"}
        className={`block mx-auto w-full h-auto ${state === "ready" ? "" : "invisible"}`}
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
  )
}
