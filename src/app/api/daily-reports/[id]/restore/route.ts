import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { DAILY_0050_LIVE } from "@/lib/daily-flags"
import { forbidFieldWithoutEdit } from "@/lib/field-access"

// Undo for the soft delete (4h): clears deleted_at. Only reachable from
// the 10 s undo toast; explicit verb per the two-verb discipline.
//
// ADR-020 consistency decision: restore follows can_edit, the same gate as
// every other daily write — a field user with a daily_reports can_edit
// grant may undo their own soft-delete. Unlike the drawings restore RPCs
// there is no invisible-row problem here: daily_reports has no deleted_at
// clause in its SELECT policy, so the deleted row stays session-visible
// and the (RLS-gated) project_id lookup below works. Denying field
// outright (forbidFieldRole) would break their own undo toast.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!DAILY_0050_LIVE) {
    return NextResponse.json({ error: "Restore requires migration 0050" }, { status: 503 })
  }
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const denied = await forbidFieldWithoutEdit(supabase, user.id, "daily_reports", async () => {
    const { data } = await supabase.from("daily_reports")
      .select("project_id").eq("id", id).maybeSingle()
    return (data?.project_id as string | null) ?? null
  })
  if (denied) return denied

  const { data, error } = await supabase.from("daily_reports")
    .update({ deleted_at: null })
    .eq("id", id)
    .select("id")
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data?.length) return NextResponse.json({ error: "Not found" }, { status: 404 })
  return NextResponse.json({ ok: true })
}
