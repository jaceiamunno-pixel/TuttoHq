import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { forbidFieldRole } from "@/lib/field-access"

// POST /api/schedule-tasks/[id]/restore — undo a soft delete via the
// restore_schedule_task SECURITY DEFINER RPC (migration 0022), company-scoped
// internally via get_my_company_id(). Mirrors the DELETE path so every deleted_at
// write funnels through the definer functions — never a bare UPDATE. Returns the id
// on success, or no row if not found / cross-company / not deleted → 404.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })

  // ADR-020: restore targets a soft-deleted row no session read can see (the
  // deleted_at IS NULL SELECT policy), so a per-project grant check is
  // impossible here — and the restore RPC is SECURITY DEFINER. Recycle-bin
  // recovery is not a field surface; deny field outright.
  const fieldDenied = await forbidFieldRole(supabase)
  if (fieldDenied) return fieldDenied

  const { data: restoredId, error } = await supabase.rpc("restore_schedule_task", { p_id: id })
  if (error) {
    console.error("Failed to restore schedule task:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!restoredId) return NextResponse.json({ error: "Task not found or not deleted" }, { status: 404 })
  return NextResponse.json({ ok: true, id })
}
