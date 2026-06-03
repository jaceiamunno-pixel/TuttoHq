import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// GET /api/submittals/[id]/attachments
//
// Returns every revision attached to a submittal log row, newest first.
// Used by the Library view's revision history slide-out. Read-only.
// RLS scopes by company on submittal_attachments via the denormalized
// company_id column; the route additionally verifies the parent submittal
// is accessible to the caller for a clean 404 vs. empty array.

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: submittalId } = await params
  if (!submittalId) {
    return NextResponse.json({ error: "submittal id required" }, { status: 400 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  // Confirm the parent submittal is accessible (RLS-filtered) — returns
  // 404 rather than an empty array when the row is in a different company.
  const { data: parent, error: pErr } = await supabase
    .from("submittals")
    .select("id, company_id, project_id, csi_section, submittal_type, material_name")
    .eq("id", submittalId)
    .single()
  if (pErr || !parent) {
    return NextResponse.json({ error: "submittal not found or not accessible" }, { status: 404 })
  }

  const { data, error } = await supabase
    .from("submittal_attachments")
    .select("id, storage_path, file_name, file_size, mime_type, revision_label, is_current, approval_date, review_status, submittal_number, uploaded_at, source")
    .eq("submittal_id", submittalId)
    .order("uploaded_at", { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({
    submittal: {
      id: parent.id,
      csi_section: parent.csi_section,
      submittal_type: parent.submittal_type,
      material_name: parent.material_name,
    },
    attachments: data ?? [],
  })
}
