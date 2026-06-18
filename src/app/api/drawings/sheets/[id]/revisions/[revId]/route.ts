import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// DELETE /api/drawings/sheets/[id]/revisions/[revId] — SOFT delete ONE revision
// (ADR-005 Subsystem 4). CAREFUL-LANE: current_revision_id integrity.
//
// The write goes through soft_delete_drawing_revision(p_id, p_new_current), a
// SECURITY DEFINER function (migration 0020) that re-points current_revision_id
// (when asked) and stamps deleted_at ATOMICALLY, company-scoped via
// get_my_company_id(). A bare authed UPDATE can't do this: stamping deleted_at
// makes the new row fail the SELECT policy (deleted_at IS NULL) that applies to the
// authenticated role, so PostgREST rejects it ("new row violates row-level security
// policy"). The fn (run as owner, bypassing RLS) verifies p_new_current is a live,
// same-company, same-sheet, non-markup row before re-pointing, so current can never
// land on a deleted or markup revision.
//
// This route still owns the POLICY of the delete (the fn just executes it):
//  • MARKUP revision (source = 'markup'): never current_revision_id (fork-A —
//    "current = the clean original"), so p_new_current = null. No re-point, no
//    only-remaining guard.
//  • NON-MARKUP (uploaded) revision:
//      1. BLOCK (409) if it is the sheet's ONLY remaining non-deleted non-markup
//         revision — a sheet must always keep a current revision; delete the whole
//         sheet instead.
//      2. p_new_current = the newest OTHER live non-markup revision when the target
//         IS current_revision_id; null when it isn't.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; revId: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id: sheetId, revId } = await params
  if (!sheetId || !revId) return NextResponse.json({ error: "id and revId required" }, { status: 400 })

  // Target revision must be RLS-visible (same company, not already deleted) and
  // belong to THIS sheet. An already-deleted revision is hidden by the SELECT
  // policy → 404 here, so a double-delete is a safe no-op.
  const { data: rev, error: revErr } = await supabase
    .from("drawing_revisions")
    .select("id, sheet_id, source")
    .eq("id", revId)
    .eq("sheet_id", sheetId)
    .maybeSingle()
  if (revErr) return NextResponse.json({ error: revErr.message }, { status: 500 })
  if (!rev) return NextResponse.json({ error: "revision not found or already deleted" }, { status: 404 })

  // Compute the re-point target. Markup → null (markup is never current). Non-markup
  // → enforce the only-remaining guard, then re-point to the newest OTHER live
  // non-markup revision ONLY when the target is the sheet's current revision.
  let pNewCurrent: string | null = null
  if (rev.source !== "markup") {
    // All LIVE (RLS-filtered) non-markup revisions, newest first. Includes the target.
    const { data: liveNonMarkup, error: listErr } = await supabase
      .from("drawing_revisions")
      .select("id, created_at")
      .eq("sheet_id", sheetId)
      .neq("source", "markup")
      .order("created_at", { ascending: false })
    if (listErr) return NextResponse.json({ error: listErr.message }, { status: 500 })
    if (!liveNonMarkup || liveNonMarkup.length <= 1) {
      return NextResponse.json(
        { error: "Cannot delete a sheet's only remaining revision — delete the whole sheet instead." },
        { status: 409 },
      )
    }

    const { data: sheet, error: sErr } = await supabase
      .from("drawing_sheets")
      .select("id, current_revision_id")
      .eq("id", sheetId)
      .maybeSingle()
    if (sErr) return NextResponse.json({ error: sErr.message }, { status: 500 })
    if (!sheet) return NextResponse.json({ error: "sheet not found" }, { status: 404 })

    if (sheet.current_revision_id === revId) {
      const replacement = liveNonMarkup.find(r => r.id !== revId)   // newest non-target (list is desc)
      if (!replacement) {
        // Unreachable given the >1 guard above, but never delete without a target.
        return NextResponse.json({ error: "No live revision to re-point current to — delete aborted." }, { status: 409 })
      }
      pNewCurrent = replacement.id
    }
  }

  // Atomic in the fn: re-point (when pNewCurrent is set, with its own validity check)
  // then stamp deleted_at. Returns the id, or null if the target isn't found / not
  // this caller's company / already deleted.
  const { data: deletedId, error } = await supabase
    .rpc("soft_delete_drawing_revision", { p_id: revId, p_new_current: pNewCurrent })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!deletedId) return NextResponse.json({ error: "revision not found or already deleted" }, { status: 404 })

  return NextResponse.json({
    ok: true,
    id: revId,
    kind: rev.source === "markup" ? "markup" : "uploaded",
    repointed_current_to: pNewCurrent,
  })
}
