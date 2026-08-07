import { NextRequest, NextResponse } from "next/server"
import { createClientFromRequest } from "@/lib/supabase/server"

// GET /api/submittals/export-attachments?project_id=…
//
// Read-only data source for the submittal-log Excel export's attachment
// links. Returns every non-soft-deleted submittal in the project with its
// submittal_attachments revisions, plus long-lived signed URLs for every
// storage path — all through the caller's RLS-scoped client (never
// service-role), so a user can only sign paths their company rows reference.
//
// Soft-delete needs BOTH gates: prod has rows where status='deleted' with
// deleted_at NULL and rows where status='active' with deleted_at set — a row
// is excluded if EITHER flag says deleted.

// 10 years. The exported log is an offline archival record; links must
// outlive the default 7-day TTL used for in-app viewing.
const TEN_YEARS_SECONDS = 315360000

export async function GET(req: NextRequest) {
  const supabase = await createClientFromRequest(req)
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const projectId = searchParams.get("project_id")
  if (!projectId) {
    return NextResponse.json({ error: "project_id required" }, { status: 400 })
  }

  // Embedded select keeps this to one round-trip and lets RLS scope both
  // tables; an .in(submittal_id, […hundreds of uuids]) would blow past URL
  // length limits on large projects.
  const { data: rows, error } = await supabase
    .from("submittals")
    .select("id, storage_path, file_name, created_at, submittal_attachments(id, storage_path, file_name, revision_label, is_current, approval_date, uploaded_at)")
    .eq("project_id", projectId)
    .neq("status", "deleted")
    .is("deleted_at", null)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const submittals = rows ?? []

  // Sign every unique path referenced by the RLS-scoped rows — and ONLY
  // those (the client never supplies paths). One batched call per export.
  const paths = new Set<string>()
  for (const s of submittals) {
    if (s.storage_path) paths.add(s.storage_path)
    for (const a of s.submittal_attachments ?? []) {
      if (a.storage_path) paths.add(a.storage_path)
    }
  }

  const urls: Record<string, string> = {}
  if (paths.size > 0) {
    const { data: signed, error: signErr } = await supabase.storage
      .from("submittals")
      .createSignedUrls([...paths], TEN_YEARS_SECONDS)
    // A failed batch (or failed individual path) just leaves the map entry
    // missing — the exporter renders "file unavailable" for that cell and
    // the export itself always succeeds.
    if (!signErr && signed) {
      for (const s of signed) {
        if (!s.error && s.path && s.signedUrl) urls[s.path] = s.signedUrl
      }
    }
  }

  return NextResponse.json({ submittals, urls })
}
