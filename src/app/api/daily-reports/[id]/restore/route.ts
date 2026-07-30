import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { DAILY_0050_LIVE } from "@/lib/daily-flags"

// Undo for the soft delete (4h): clears deleted_at. Only reachable from
// the 10 s undo toast; explicit verb per the two-verb discipline.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!DAILY_0050_LIVE) {
    return NextResponse.json({ error: "Restore requires migration 0050" }, { status: 503 })
  }
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const { data, error } = await supabase.from("daily_reports")
    .update({ deleted_at: null })
    .eq("id", id)
    .select("id")
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data?.length) return NextResponse.json({ error: "Not found" }, { status: 404 })
  return NextResponse.json({ ok: true })
}
