import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { forbidFieldRole } from "@/lib/field-access"

// POST /api/drawings/sheets/[id]/revisions/[revId]/restore — undo a revision
// soft-delete via the restore_drawing_revision SECURITY DEFINER function
// (migration 0020), company-scoped via get_my_company_id(). Every deleted_at write
// on drawings is funneled through the definer functions: a bare authed UPDATE
// clearing deleted_at would work, but the soft-delete path MUST use one (the new
// row fails the SELECT policy and PostgREST rejects it), so restore rides the same
// mechanism for symmetry — and no bare deleted_at UPDATE remains. The fn returns
// the id on success, or no row if not found / cross-company / not currently deleted.
//
// Restore does NOT touch current_revision_id — a restored revision simply
// reappears in history; whatever is current stays current.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string; revId: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id: sheetId, revId } = await params
  if (!sheetId || !revId) return NextResponse.json({ error: "id and revId required" }, { status: 400 })

  // ADR-020: recycle-bin recovery is not a field surface (the RPC is SECURITY
  // DEFINER and the deleted target is invisible to session reads).
  const fieldDenied = await forbidFieldRole(supabase)
  if (fieldDenied) return fieldDenied

  const { data: restoredId, error } = await supabase.rpc("restore_drawing_revision", { p_id: revId })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!restoredId) return NextResponse.json({ error: "revision not found or not deleted" }, { status: 404 })
  return NextResponse.json({ ok: true, id: revId })
}
