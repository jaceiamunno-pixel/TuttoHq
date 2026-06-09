import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// POST /api/drawings/sheets/[id]/restore — undo a soft delete (ADR-005
// Subsystem 2). Clears drawing_sheets.deleted_at via the authed RLS-scoped
// client, returning the sheet to the live list. Only works while the row still
// exists — once the scheduled purge has hard-deleted an expired row, there is
// nothing to restore. RLS scopes the update to the caller's company.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })

  const { data, error } = await supabase
    .from("drawing_sheets")
    .update({ deleted_at: null })
    .eq("id", id)
    .not("deleted_at", "is", null)     // only act on a currently-deleted row
    .select("id")
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data || data.length === 0) {
    return NextResponse.json({ error: "sheet not found or not deleted" }, { status: 404 })
  }
  return NextResponse.json({ ok: true, id })
}
