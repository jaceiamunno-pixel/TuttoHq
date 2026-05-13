import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function POST(req: NextRequest) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const formData     = await req.formData()
  const file         = formData.get("file") as File | null
  const divisionNum  = formData.get("division_num") as string | null
  const divisionName = formData.get("division_name") as string | null
  const sectionCode  = (formData.get("section_code") as string | null)?.trim() || null
  const sectionName  = (formData.get("section_name") as string | null)?.trim() || null
  const materialName  = (formData.get("material_name")  as string | null)?.trim() || null
  const manufacturer  = (formData.get("manufacturer")   as string | null)?.trim() || null
  const dimensions    = (formData.get("dimensions")     as string | null)?.trim() || null
  const aiConfidence  = formData.get("ai_confidence")   ? parseInt(formData.get("ai_confidence") as string) : null
  const aiReasoning   = (formData.get("ai_reasoning")  as string | null)?.trim() || null
  const projectId     = (formData.get("project_id")    as string | null)?.trim() || null
  const customName    = (formData.get("display_name")  as string | null)?.trim() || null
  const reviewStatus  = (aiConfidence !== null && aiConfidence < 70) ? "Needs Review" : "Received"

  if (!file || !divisionNum || !divisionName) {
    return NextResponse.json(
      { error: "file, division_num, and division_name are required" },
      { status: 400 },
    )
  }

  // Use explicit custom name if provided, otherwise build from structured fields, fall back to filename
  const nameParts   = [materialName, manufacturer, dimensions].filter(Boolean)
  const displayName = customName ?? (nameParts.length > 0 ? nameParts.join(" — ") : file.name)

  // Build a clean storage path: division/section/timestamp_filename
  const safeName    = file.name.replace(/[^a-zA-Z0-9._-]/g, "_")
  const ts          = Date.now()
  const sectionSlug = sectionCode ? sectionCode.replace(/\s+/g, "") : "general"
  const storagePath = `${divisionNum}/${sectionSlug}/${ts}_${safeName}`

  // Upload bytes to storage
  const bytes = await file.arrayBuffer()
  const { error: storageError } = await supabase.storage
    .from("submittals")
    .upload(storagePath, bytes, {
      contentType: file.type || "application/octet-stream",
      upsert: false,
    })

  if (storageError) {
    console.error("Storage upload failed:", storageError)
    return NextResponse.json({ error: "Storage upload failed" }, { status: 500 })
  }

  // Insert DB row
  const { error: dbError } = await supabase.from("submittals").insert({
    file_name:     displayName,
    storage_path:  storagePath,
    mime_type:     file.type || null,
    file_size:     file.size,
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
  })

  if (dbError) {
    console.error("DB insert failed:", dbError)
    // Clean up the orphaned storage file
    await supabase.storage.from("submittals").remove([storagePath])
    return NextResponse.json({ error: "Failed to save file record" }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
