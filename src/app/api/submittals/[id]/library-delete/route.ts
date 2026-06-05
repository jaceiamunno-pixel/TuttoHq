import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// POST /api/submittals/[id]/library-delete
//
// Deletes a Library entry. A Library entry is a submittals row WITH a file
// attached — the SAME row the project Submittal Log reads. So "delete" must
// branch on whether the row carries spec-book log identity:
//
//   spec_ingestion (spec_section_id NOT NULL) → DETACH. Remove the
//     attachment rows + their storage objects, clear the parent's
//     file-derived fields back to the parser's placeholder defaults, and
//     KEEP the row. The Submittal Log entry survives intact (section,
//     title, type, seq, project, spec_section_id untouched) — it simply
//     shows "no file attached", ready for re-import. NEVER delete a
//     spec-built log row.
//
//   manual / gmail (spec_section_id NULL) → DELETE. The row exists only as
//     a Library item, so soft-delete it (status='deleted', matching the
//     existing DELETE /api/submittals/[id] pattern) AND remove its
//     attachment rows + storage objects.
//
// The branch is decided SERVER-SIDE from the DB row — never trusted from
// the client. spec_section_id IS NOT NULL ⟺ source = 'spec_ingestion'
// (verified: 726/726 spec rows linked, 0 manual/gmail rows linked).
//
// Tenant-scoped: auth + explicit company match + RLS on every statement.
//
// Storage objects are removed only after an orphan check — no remaining
// attachment row and no OTHER live submittal references the path. Best-
// effort: a failed storage removal does not fail the delete (the DB is
// already consistent; a leftover object is a reclaimable orphan).

// DETACH field reset. These are the file-derived / trigger-managed columns;
// resetting them returns the row to a fresh spec-ingestion placeholder.
// review_status + revision_number use the parser's TRUE creation defaults
// (staged-submittals/commit sets review_status:"Received"; the DB default
// for revision_number is '00') so a detached row is indistinguishable from
// a never-attached one.
const DETACH_RESET = {
  storage_path:          null,
  file_size:             null,
  mime_type:             null,
  file_sha256:           null,
  received_file_name:    null,
  returned_from_ae_date: null,
  sent_to_ae_date:       null,
  received_at:           null,
  submittal_number:      null,
  review_status:         "Received",
  revision_number:       "00",
} as const

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: companyId } = await supabase.rpc("get_my_company_id")
  if (!companyId) return NextResponse.json({ error: "No company association" }, { status: 500 })

  // Load the row + decide the branch server-side.
  const { data: row, error: selErr } = await supabase
    .from("submittals")
    .select("id, company_id, source, spec_section_id, storage_path, status")
    .eq("id", id)
    .single()
  if (selErr || !row) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (row.company_id !== companyId) return NextResponse.json({ error: "Not in your company" }, { status: 403 })
  if (row.status === "deleted") return NextResponse.json({ error: "Already deleted" }, { status: 400 })

  const isSpec = row.spec_section_id != null  // ⟺ source === 'spec_ingestion'

  // Gather every storage object this row references (each attachment's path
  // plus the parent's denormalized path — deduped; they usually coincide).
  const { data: atts } = await supabase
    .from("submittal_attachments")
    .select("id, storage_path")
    .eq("submittal_id", id)
  const candidatePaths = new Set<string>()
  for (const a of atts ?? []) if (a.storage_path) candidatePaths.add(a.storage_path)
  if (row.storage_path) candidatePaths.add(row.storage_path)

  // 1. Hard-delete attachment rows (no soft-delete column on this table —
  //    same as the dedup cleanup).
  const { error: delAttErr } = await supabase
    .from("submittal_attachments")
    .delete()
    .eq("submittal_id", id)
  if (delAttErr) {
    return NextResponse.json({ error: `attachment delete failed: ${delAttErr.message}` }, { status: 500 })
  }

  // 2. Branch the parent row.
  if (isSpec) {
    const { error: updErr } = await supabase.from("submittals").update(DETACH_RESET).eq("id", id)
    if (updErr) return NextResponse.json({ error: `detach update failed: ${updErr.message}` }, { status: 500 })
  } else {
    // Soft-delete + null the file pointer so the deleted row carries no
    // dangling storage_path once its object is removed.
    const { error: updErr } = await supabase
      .from("submittals")
      .update({ status: "deleted", storage_path: null, file_sha256: null })
      .eq("id", id)
    if (updErr) return NextResponse.json({ error: `delete update failed: ${updErr.message}` }, { status: 500 })
  }

  // 3. Storage cleanup — orphan-checked, best-effort. A path is removed only
  //    when no attachment row references it AND no OTHER live submittal does.
  let storageRemoved = 0, storageKept = 0
  for (const path of candidatePaths) {
    const { count: attRefs } = await supabase
      .from("submittal_attachments")
      .select("id", { count: "exact", head: true })
      .eq("storage_path", path)
    const { count: subRefs } = await supabase
      .from("submittals")
      .select("id", { count: "exact", head: true })
      .eq("storage_path", path)
      .neq("status", "deleted")
      .neq("id", id)
    if ((attRefs ?? 0) === 0 && (subRefs ?? 0) === 0) {
      const { error: rmErr } = await supabase.storage.from("submittals").remove([path])
      if (rmErr) { storageKept++; console.warn("[library-delete] storage remove failed", path, rmErr.message) }
      else storageRemoved++
    } else {
      storageKept++
    }
  }

  return NextResponse.json({
    ok: true,
    mode: isSpec ? "detach" : "delete",
    storage_removed: storageRemoved,
    storage_kept: storageKept,
  })
}
