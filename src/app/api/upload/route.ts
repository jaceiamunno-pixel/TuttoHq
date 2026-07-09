import { NextRequest, NextResponse } from "next/server"
import { after } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { normalizeSubmittalTitle } from "@/lib/title-normalize"
import { isValidSha256 } from "@/lib/file-hash"
import { stripAndStore } from "@/lib/strip-and-store"
import { allocateSectionSeqAndInsert } from "@/lib/section-seq"

// Give after() room to download + strip + store a Library copy post-response.
export const maxDuration = 60

// POST /api/upload — records a manually uploaded submittal.
//
// The file itself is PUT straight to Supabase Storage from the browser via a
// signed upload URL (see /api/storage/presigned-url), so this route only
// receives JSON metadata: `file_path` already points at the stored object.
export async function POST(req: NextRequest) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // DEMO COST GATE. /api/upload is the one compute-only PDF-parse surface that
  // sits OUTSIDE the enforceAiLimit() chokepoint, so the read-only demo tenant
  // (role='demo') is blocked here directly. Uses the authed client already built
  // above. Fail-open in try/catch — a failed is_demo_user() lookup must never
  // 403 a real paying user (worst case the DB write-block / definer guards still
  // hold, so there's no data-integrity hole, only degraded cost protection).
  try {
    const { data: isDemo } = await supabase.rpc("is_demo_user")
    if (isDemo === true) {
      return NextResponse.json(
        { error: "This action isn't available on the demo account." },
        { status: 403 },
      )
    }
  } catch {
    // is_demo_user() lookup failed — treat as NOT demo and fall through.
  }

  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: "Invalid request body" }, { status: 400 })

  const filePath      = typeof body.file_path === "string" ? body.file_path.trim() : ""
  const fileName      = typeof body.file_name === "string" ? body.file_name.trim() : ""
  const fileSize      = typeof body.file_size === "number" ? body.file_size : null
  const mimeType      = typeof body.mime_type === "string" ? body.mime_type : null
  const divisionNum   = typeof body.division_num  === "string" ? body.division_num  : null
  const divisionName  = typeof body.division_name === "string" ? body.division_name : null
  const sectionCode   = (typeof body.section_code === "string" ? body.section_code : "").trim() || null
  const sectionName   = (typeof body.section_name === "string" ? body.section_name : "").trim() || null
  const materialName  = (typeof body.material_name === "string" ? body.material_name : "").trim() || null
  const manufacturer  = (typeof body.manufacturer  === "string" ? body.manufacturer  : "").trim() || null
  const dimensions    = (typeof body.dimensions    === "string" ? body.dimensions    : "").trim() || null
  const aiConfidence  = typeof body.ai_confidence === "number" ? body.ai_confidence : null
  const aiReasoning   = (typeof body.ai_reasoning === "string" ? body.ai_reasoning : "").trim() || null
  const projectId     = (typeof body.project_id   === "string" ? body.project_id   : "").trim() || null
  const customName    = (typeof body.display_name === "string" ? body.display_name : "").trim() || null
  // Client-computed SHA-256 of the file bytes (Web Crypto). Used by the
  // dupe-check API and stored for future backfill consistency. Optional —
  // a missing/invalid hash is a non-fatal "we don't have it yet" state,
  // not an upload failure; the backfill script will fill it in later.
  const fileSha256    = isValidSha256(body.file_sha256) ? body.file_sha256 : null
  const reviewStatus  = (aiConfidence !== null && aiConfidence < 70) ? "Needs Review" : "Received"

  if (!filePath || !fileName || !divisionNum || !divisionName) {
    return NextResponse.json(
      { error: "file_path, file_name, division_num, and division_name are required" },
      { status: 400 },
    )
  }

  // Defense-in-depth on top of the storage RLS: validate that the client-
  // supplied file_path starts with the caller's company_id. The storage RLS
  // would reject any cross-tenant signed-URL fetch anyway, but failing fast
  // here keeps us from inserting an orphan submittals row pointing at an
  // inaccessible path.
  const { data: companyId } = await supabase.rpc("get_my_company_id")
  if (!companyId) {
    return NextResponse.json({ error: "No company association" }, { status: 500 })
  }
  if (!filePath.startsWith(`${companyId}/`)) {
    return NextResponse.json({ error: "Invalid file_path" }, { status: 400 })
  }

  // Use explicit custom name if provided, otherwise build from structured fields, fall back to filename
  const nameParts   = [materialName, manufacturer, dimensions].filter(Boolean)
  const rawName     = customName ?? (nameParts.length > 0 ? nameParts.join(" — ") : fileName)
  const displayName = normalizeSubmittalTitle(rawName) || fileName

  // Insert DB row. Allocate section_seq (migration 0039) with retry-on-conflict
  // when this upload lands in a project + section; a Library shelf upload
  // (project_id null) or an unclassified file (no section) inserts unnumbered.
  const { data: inserted, error: dbError } = await allocateSectionSeqAndInsert<{
    id: string; file_name: string; mime_type: string | null; file_size: number | null;
    created_at: string; csi_division: string | null; division_name: string | null;
    csi_section: string | null; section_name: string | null;
  }>(
    supabase, projectId, sectionCode,
    (sectionSeq) => ({
      file_name:     displayName,
      storage_path:  filePath,
      mime_type:     mimeType,
      file_size:     fileSize,
      csi_division:  divisionNum,
      division_name: divisionName,
      csi_section:   sectionCode,
      section_name:  sectionName,
      material_name:  materialName,
      manufacturer:   manufacturer,
      dimensions:     dimensions,
      review_status:  reviewStatus,
      ai_confidence:  aiConfidence,
      ai_reasoning:   aiReasoning,
      project_id:     projectId,
      section_seq:    sectionSeq,
      status:         "active",
      uploaded_by:    user.id,
      file_sha256:    fileSha256,
    }),
    "id, file_name, mime_type, file_size, created_at, csi_division, division_name, csi_section, section_name",
  )

  if (dbError || !inserted) {
    console.error("DB insert failed:", dbError)
    // Clean up the orphaned storage file
    await supabase.storage.from("submittals").remove([filePath])
    return NextResponse.json({ error: "Failed to save file record" }, { status: 500 })
  }

  // Strip-at-upload — generate + store the stripped Library copy ONCE, AFTER
  // the response is sent. ISOLATED BY DESIGN: after() runs post-response, so
  // even a process-level strip failure (unpdf OOM / pdf.js worker crash) can
  // never block or fail this upload — the row + original are already saved
  // and the 200 is already returned. On any failure stripped_storage_path
  // stays NULL and the view serves the original. Only PDFs are worth
  // stripping; skip others to avoid needless work.
  if (mimeType === "application/pdf" && inserted?.id) {
    after(async () => {
      await stripAndStore({
        submittalId: inserted.id,
        storagePath: filePath,
        fileName,
        companyId: String(companyId),
      })
    })
  }

  return NextResponse.json({ ok: true, record: inserted })
}
