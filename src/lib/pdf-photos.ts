import sharp from "sharp"
import type { createClient } from "./supabase/server"
import type { PDFPhoto } from "./pdf-builder"

/** The server-side Supabase client (authed via cookies). */
type ServerSupabase = Awaited<ReturnType<typeof createClient>>

// Photos are downscaled before embedding so a report's PDF stays small and the
// generating function stays within memory limits — a 4032×3024 / 8 MB phone
// photo lands around 1600px / ~400 KB.
const MAX_DIM = 1600
const JPEG_QUALITY = 78
const CONCURRENCY = 5

interface PhotoRow {
  storage_path: string
  file_name: string | null
  created_at: string | null
}

/**
 * Load every photo attached to an entity, resized and ready for PDFPhotoGrid.
 *
 * Photos are fetched directly from the `photos` storage bucket (no signed URL
 * needed server-side), downscaled with sharp — `.rotate()` bakes in EXIF
 * orientation so portrait/landscape phone shots are upright — and re-encoded as
 * JPEG. Any source file sharp cannot decode (e.g. HEIC on a platform without
 * libheif) yields a `bytes: null` placeholder entry so PDF generation never
 * fails on one bad photo.
 */
export async function loadEntityPhotos(
  supabase: ServerSupabase,
  entityType: string,
  entityId: string,
): Promise<PDFPhoto[]> {
  const { data: rows, error } = await supabase
    .from("item_photos")
    .select("storage_path, file_name, created_at")
    .eq("entity_type", entityType)
    .eq("entity_id", entityId)
    .order("created_at")

  if (error) {
    console.error(`[loadEntityPhotos] item_photos query failed for ${entityType}/${entityId}:`, error.message)
  }

  const photoRows = (rows ?? []) as PhotoRow[]
  if (photoRows.length === 0) return []

  // Resize in bounded-concurrency batches to cap peak memory.
  const out: PDFPhoto[] = []
  for (let i = 0; i < photoRows.length; i += CONCURRENCY) {
    const batch = photoRows.slice(i, i + CONCURRENCY)
    out.push(...await Promise.all(batch.map(row => loadOne(supabase, row))))
  }
  return out
}

async function loadOne(supabase: ServerSupabase, row: PhotoRow): Promise<PDFPhoto> {
  const caption = buildCaption(row.file_name, row.created_at)
  try {
    const { data: blob } = await supabase.storage.from("photos").download(row.storage_path)
    if (!blob) return { bytes: null, caption }

    const input = Buffer.from(await blob.arrayBuffer())
    const resized = await sharp(input)
      .rotate()  // apply EXIF orientation, then drop the tag
      .resize(MAX_DIM, MAX_DIM, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer()
    return { bytes: new Uint8Array(resized), caption }
  } catch {
    return { bytes: null, caption }
  }
}

/** Build a "filename · MM/DD/YYYY" caption from the photo row. */
function buildCaption(fileName: string | null, createdAt: string | null): string {
  const name = (fileName ?? "").replace(/\.[^.]+$/, "").trim() || "Photo"
  if (!createdAt) return name
  const date = new Date(createdAt).toLocaleDateString("en-US", {
    month: "2-digit", day: "2-digit", year: "numeric",
  })
  return `${name}   ·   ${date}`
}
