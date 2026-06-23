import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// ── Schedule dependency — hard-delete an edge (Phase 3, Slice 2) ─────────────
// Edges have NO soft-delete (no deleted_at column); the schedule_deps_delete RLS
// policy (company-scoped) covers the hard DELETE. .select().maybeSingle() doubles
// as the tenant/existence check: RLS limits the DELETE to this company's edges, so
// a cross-company or missing id removes 0 rows → null → 404. Removing an edge can
// only ever make the graph "more acyclic", so no cycle gate is needed here.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })

  const { data, error } = await supabase
    .from("schedule_dependencies")
    .delete()
    .eq("id", id)
    .select("id")
    .maybeSingle()

  if (error) {
    console.error("Failed to delete schedule dependency:", error)
    return NextResponse.json({ error: "Failed to delete dependency" }, { status: 500 })
  }
  if (!data) return NextResponse.json({ error: "Dependency not found" }, { status: 404 })
  return NextResponse.json({ ok: true, id })
}
