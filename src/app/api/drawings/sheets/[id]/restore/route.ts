import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// POST /api/drawings/sheets/[id]/restore — undo a soft delete (ADR-005
// Subsystem 2) via the restore_drawing_sheet SECURITY DEFINER function (migration
// 0020), company-scoped via get_my_company_id(). Keeps every deleted_at write on
// drawings funneled through the definer functions (the soft-delete path requires
// one; restore rides it for symmetry, so no bare deleted_at UPDATE remains). Only
// works while the row still exists — once the scheduled purge has hard-deleted an
// expired row, there is nothing to restore. Returns the id on success, or no row if
// not found / cross-company / not currently deleted.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })

  const { data: restoredId, error } = await supabase.rpc("restore_drawing_sheet", { p_id: id })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!restoredId) {
    return NextResponse.json({ error: "sheet not found or not deleted" }, { status: 404 })
  }
  return NextResponse.json({ ok: true, id })
}
