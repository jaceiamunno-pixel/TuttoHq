// Browser-only rasterization for the Drawing Log splitter's OCR fallback
// (ADR-005 Subsystem 1, Tier 2/3). Renders titleblock crops from a page so the
// vision route can read sheet-number/title/revision off TEXT-FREE drawing sets
// (CAD flattened to vector outlines → zero text layer → Tier-1 finds nothing).
//
// WHY CLIENT-SIDE: the splitter already parses the set in the browser (to dodge
// Vercel's 4.5 MB body limit + OOM on 40 MB+ sets); unpdf's pdf.js renders via
// the browser DOM canvas with no extra dependency. Big bytes never touch the
// server — only small (~40-60 KB) JPEG crops are POSTed to the OCR route.
//
// Generic, NOT tuned to one template: titleblocks live on the RIGHT or BOTTOM
// edge across firms, so we crop both strips and let the vision route reconcile.

import { renderPageAsImage } from "unpdf"

/** pdf.js document proxy (the same object DrawingImportModal already holds). */
type PdfProxy = Parameters<typeof renderPageAsImage>[0]

export interface StripCrops {
  /** base64 JPEG (no data: prefix) of the right ~18% strip, or null. */
  right: string | null
  /** base64 JPEG of the bottom ~18% strip, or null. */
  bottom: string | null
  /** Total image bytes produced (decoded JPEG length) — for observability. */
  bytes: number
}

// Full-page render width (px). The strip is downscaled from this; 2200 keeps
// titleblock text legible (smoke test read cleanly at this scale) while staying
// cheap enough to render hundreds of pages. The right strip lands ~400px wide.
const RENDER_WIDTH = 2200
// Downscale each crop so its longest side is <= this before sending (vision
// models gain nothing past ~1500px and it bounds upload bytes).
const MAX_CROP_SIDE = 1500
// Fraction of the page taken as the titleblock strip on each edge.
const STRIP_FRACTION = 0.18
const JPEG_QUALITY = 0.8

function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement | OffscreenCanvas; ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D } {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("2d context unavailable")
    return { canvas, ctx: ctx as OffscreenCanvasRenderingContext2D }
  }
  const canvas = document.createElement("canvas")
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("2d context unavailable")
  return { canvas, ctx }
}

async function canvasToJpegBase64(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<string> {
  let blob: Blob
  if (canvas instanceof OffscreenCanvas) {
    blob = await canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY })
  } else {
    blob = await new Promise<Blob>((res, rej) =>
      canvas.toBlob(b => (b ? res(b) : rej(new Error("toBlob failed"))), "image/jpeg", JPEG_QUALITY))
  }
  const buf = await blob.arrayBuffer()
  // base64 without a data: prefix (the route wraps it as an image block).
  let bin = ""
  const bytes = new Uint8Array(buf)
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

/** Load a PNG data URL into a bitmap we can drawImage-crop. */
async function loadBitmap(dataUrl: string): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap !== "undefined") {
    const blob = await (await fetch(dataUrl)).blob()
    return createImageBitmap(blob)
  }
  return new Promise<HTMLImageElement>((res, rej) => {
    const img = new Image()
    img.onload = () => res(img)
    img.onerror = () => rej(new Error("image decode failed"))
    img.src = dataUrl
  })
}

function cropDims(srcW: number, srcH: number, region: { sx: number; sy: number; sw: number; sh: number }) {
  const longest = Math.max(region.sw, region.sh)
  const scale = longest > MAX_CROP_SIDE ? MAX_CROP_SIDE / longest : 1
  return { dw: Math.max(1, Math.round(region.sw * scale)), dh: Math.max(1, Math.round(region.sh * scale)) }
}

/**
 * Render page `pageNum` of `proxy` and return the right + bottom titleblock
 * strip crops as base64 JPEGs. Renders the full page ONCE and crops both strips
 * from it. Throws on render failure — the caller isolates that (the row stays
 * blank, exactly as today). NO-OP-safe on the server (returns nulls).
 */
export async function renderStripCrops(proxy: PdfProxy, pageNum: number): Promise<StripCrops> {
  if (typeof window === "undefined") return { right: null, bottom: null, bytes: 0 }

  const dataUrl = await renderPageAsImage(proxy, pageNum, { width: RENDER_WIDTH, toDataURL: true }) as string
  const bmp = await loadBitmap(dataUrl)
  const W = "width" in bmp ? bmp.width : (bmp as HTMLImageElement).naturalWidth
  const H = "height" in bmp ? bmp.height : (bmp as HTMLImageElement).naturalHeight

  const regions = {
    right: { sx: Math.floor(W * (1 - STRIP_FRACTION)), sy: 0, sw: Math.ceil(W * STRIP_FRACTION), sh: H },
    bottom: { sx: 0, sy: Math.floor(H * (1 - STRIP_FRACTION)), sw: W, sh: Math.ceil(H * STRIP_FRACTION) },
  }

  let bytes = 0
  const crop = async (r: { sx: number; sy: number; sw: number; sh: number }): Promise<string> => {
    const { dw, dh } = cropDims(W, H, r)
    const { canvas, ctx } = makeCanvas(dw, dh)
    ;(ctx as CanvasRenderingContext2D).drawImage(bmp as CanvasImageSource, r.sx, r.sy, r.sw, r.sh, 0, 0, dw, dh)
    const b64 = await canvasToJpegBase64(canvas)
    bytes += Math.floor((b64.length * 3) / 4)
    return b64
  }

  const right = await crop(regions.right)
  const bottom = await crop(regions.bottom)
  if ("close" in bmp) (bmp as ImageBitmap).close()
  return { right, bottom, bytes }
}

/**
 * Render the FULL page (downscaled to MAX_CROP_SIDE longest side) as one base64
 * JPEG — used for Tier-3 index-page parsing, where the model reads the whole
 * DRAWING NUMBER → TITLE table. Throws on render failure (caller isolates).
 */
export async function renderFullPageImage(proxy: PdfProxy, pageNum: number): Promise<{ image: string; bytes: number } | null> {
  if (typeof window === "undefined") return null
  const dataUrl = await renderPageAsImage(proxy, pageNum, { width: RENDER_WIDTH, toDataURL: true }) as string
  const bmp = await loadBitmap(dataUrl)
  const W = "width" in bmp ? bmp.width : (bmp as HTMLImageElement).naturalWidth
  const H = "height" in bmp ? bmp.height : (bmp as HTMLImageElement).naturalHeight
  const { dw, dh } = cropDims(W, H, { sx: 0, sy: 0, sw: W, sh: H })
  const { canvas, ctx } = makeCanvas(dw, dh)
  ;(ctx as CanvasRenderingContext2D).drawImage(bmp as CanvasImageSource, 0, 0, W, H, 0, 0, dw, dh)
  const image = await canvasToJpegBase64(canvas)
  if ("close" in bmp) (bmp as ImageBitmap).close()
  return { image, bytes: Math.floor((image.length * 3) / 4) }
}

/**
 * Run `tasks` with at most `concurrency` in flight, preserving order. Used to
 * bound the per-page OCR network calls (4-6) on big sets without a dependency.
 */
export async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++
      if (i >= items.length) break
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}
