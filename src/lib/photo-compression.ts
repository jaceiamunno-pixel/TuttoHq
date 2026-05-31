import type { UploadablePhoto } from "./uploadable-photo"

// ─── Capture-side compression ───────────────────────────────────────────────
// Decode → downscale → JPEG-encode. Storing 12 MP originals would blow IDB
// quota in a handful of reports, so this step is mandatory at capture time,
// before anything is written to IndexedDB.
//
// The pipeline is browser-only (createImageBitmap, Canvas/OffscreenCanvas,
// heic2any). A native shell would not call this — it'd produce an
// UploadablePhoto directly from its camera plugin's JPEG output. That's the
// porting boundary; nothing downstream of UploadablePhoto cares which
// platform produced it.

const MAX_EDGE = 1600
const JPEG_QUALITY = 0.8

const HEIC_MIME_PATTERN = /^image\/(heic|heif)$/i
const HEIC_EXT_PATTERN = /\.(heic|heif)$/i

function isHeic(file: File): boolean {
  return HEIC_MIME_PATTERN.test(file.type) || HEIC_EXT_PATTERN.test(file.name)
}

function jpegFilename(originalName: string): string {
  const trimmed = (originalName ?? "").trim()
  const base = trimmed.replace(/\.[^.]+$/, "")
  const safeBase = base || `photo_${Date.now()}`
  return `${safeBase}.jpg`
}

// heic2any pulls a hefty libheif WASM bundle. Lazy-imported so non-HEIC
// users never pay for it.
async function transcodeHeicToJpeg(file: File): Promise<Blob> {
  const mod = await import("heic2any")
  // The module exports its factory as `default` in our setup; this guard
  // keeps it working if the bundler chooses to expose it differently.
  const heic2any: (opts: { blob: Blob; toType?: string; quality?: number }) => Promise<Blob | Blob[]> =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((mod as any).default ?? mod) as never
  const out = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.92 })
  return Array.isArray(out) ? out[0] : out
}

// `imageOrientation: "from-image"` bakes EXIF rotation into the bitmap so
// portrait phone shots come out upright — without this, Android Chrome
// renders them sideways.
async function decodeToBitmap(source: Blob): Promise<ImageBitmap> {
  return createImageBitmap(source, { imageOrientation: "from-image" })
}

function computeTargetSize(width: number, height: number): { w: number; h: number } {
  const longest = Math.max(width, height)
  if (longest <= MAX_EDGE) return { w: width, h: height }
  const scale = MAX_EDGE / longest
  return { w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)) }
}

async function bitmapToJpegBlob(bitmap: ImageBitmap): Promise<Blob> {
  const { w, h } = computeTargetSize(bitmap.width, bitmap.height)

  // OffscreenCanvas is the fast path on modern Chrome/Edge/Firefox. Safari
  // 17+ supports it too, but older Safari falls back to HTMLCanvasElement.
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("Could not get OffscreenCanvas 2D context")
    ctx.drawImage(bitmap, 0, 0, w, h)
    return canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY })
  }

  const canvas = document.createElement("canvas")
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("Could not get HTMLCanvas 2D context")
  ctx.drawImage(bitmap, 0, 0, w, h)
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      blob => (blob ? resolve(blob) : reject(new Error("Canvas produced no blob"))),
      "image/jpeg",
      JPEG_QUALITY,
    )
  })
}

/**
 * Compress an arbitrary user-selected image File into an UploadablePhoto.
 * HEIC/HEIF inputs are transcoded to JPEG so the stored photo is universally
 * displayable. The returned object deliberately does not reference the
 * source File — that's the porting boundary.
 */
export async function compressFileToUploadablePhoto(file: File): Promise<UploadablePhoto> {
  const source: Blob = isHeic(file) ? await transcodeHeicToJpeg(file) : file
  const bitmap = await decodeToBitmap(source)
  try {
    const bytes = await bitmapToJpegBlob(bitmap)
    return { bytes, mime: "image/jpeg", filename: jpegFilename(file.name) }
  } finally {
    // Free the decoded bitmap immediately — these are large.
    bitmap.close?.()
  }
}
