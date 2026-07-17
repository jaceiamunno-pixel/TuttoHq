import type { createClient } from "@/lib/supabase/server"

// The operational core of "library delete" — moved VERBATIM from
// /api/submittals/[id]/library-delete (#136) so the bulk selection action can
// run the exact same per-row logic without duplicating it. The caller decides
// WHETHER a row is actionable (auth, company match, active status, and — for
// the bulk route — skipping spec placeholders); this function only performs
// the delete/detach, branched server-side on the row the CALLER loaded from
// the DB (never on client input):
//
//   spec_ingestion (spec_section_id NOT NULL) → DETACH. Remove the
//     attachment rows + their storage objects, clear the parent's
//     file-derived fields back to the parser's placeholder defaults, and
//     KEEP the row. NEVER delete a spec-built log row.
//
//   manual / gmail (spec_section_id NULL) → DELETE. Soft-delete the row
//     (status='deleted') AND remove its attachment rows + storage objects.
//
// Storage objects are removed only after an orphan check — no remaining
// attachment row and no OTHER live submittal references the path. Best-
// effort: a failed storage removal does not fail the delete (the DB is
// already consistent; a leftover object is a reclaimable orphan).

type ServerSupabase = Awaited<ReturnType<typeof createClient>>

// DETACH field reset. These are the file-derived / trigger-managed columns;
// resetting them returns the row to an empty spec-ingestion placeholder.
// review_status stays "Received" DELIBERATELY — it matches what the
// remove_submittal_attachment RPC's placeholder-reset branch writes
// (sql/migrations/0035), so both clear paths agree. A FRESH placeholder
// seeds "Not Started" (staged-submittals/commit); aligning cleared rows to
// "Not Started" too needs a 0035-RPC follow-up migration — do both then.
// revision_number's DB default is '00'.
export const DETACH_RESET = {
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

export type LibraryDeleteRow = {
  id: string
  spec_section_id: string | null
  storage_path: string | null
}

export type LibraryDeleteResult =
  | { ok: true; mode: "detach" | "delete"; storage_removed: number; storage_kept: number }
  | { ok: false; error: string }

export async function libraryDeleteOne(
  supabase: ServerSupabase,
  row: LibraryDeleteRow,
): Promise<LibraryDeleteResult> {
  const id = row.id
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
    return { ok: false, error: `attachment delete failed: ${delAttErr.message}` }
  }

  // 2. Branch the parent row.
  if (isSpec) {
    const { error: updErr } = await supabase.from("submittals").update(DETACH_RESET).eq("id", id)
    if (updErr) return { ok: false, error: `detach update failed: ${updErr.message}` }
  } else {
    // Soft-delete + null the file pointer so the deleted row carries no
    // dangling storage_path once its object is removed.
    const { error: updErr } = await supabase
      .from("submittals")
      .update({ status: "deleted", storage_path: null, file_sha256: null })
      .eq("id", id)
    if (updErr) return { ok: false, error: `delete update failed: ${updErr.message}` }
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

  return { ok: true, mode: isSpec ? "detach" : "delete", storage_removed: storageRemoved, storage_kept: storageKept }
}
