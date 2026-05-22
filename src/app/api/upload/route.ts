import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

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
  const reviewStatus  = (aiConfidence !== null && aiConfidence < 70) ? "Needs Review" : "Received"

  if (!filePath || !fileName || !divisionNum || !divisionName) {
    return NextResponse.json(
      { error: "file_path, file_name, division_num, and division_name are required" },
      { status: 400 },
    )
  }

  // Use explicit custom name if provided, otherwise build from structured fields, fall back to filename
  const nameParts   = [materialName, manufacturer, dimensions].filter(Boolean)
  const displayName = customName ?? (nameParts.length > 0 ? nameParts.join(" — ") : fileName)

  // Insert DB row
  const { data: inserted, error: dbError } = await supabase.from("submittals").insert({
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
    status:         "active",
    uploaded_by:    user.id,
  }).select("id, file_name, mime_type, file_size, created_at, csi_division, division_name, csi_section, section_name").single()

  if (dbError) {
    console.error("DB insert failed:", dbError)
    // Clean up the orphaned storage file
    await supabase.storage.from("submittals").remove([filePath])
    return NextResponse.json({ error: "Failed to save file record" }, { status: 500 })
  }

  return NextResponse.json({ ok: true, record: inserted })
}
