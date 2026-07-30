import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { DAILY_0050_LIVE } from "@/lib/daily-flags"

// Explicit Submit action (4g): stamps status / submitted_at / submitted_by.
// v1 has no approval chain and no hard lock — a submitted report stays
// editable, and edits surface via the "edited after submission" banner.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!DAILY_0050_LIVE) {
    return NextResponse.json({ error: "Submit requires migration 0050" }, { status: 503 })
  }
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const { data, error } = await supabase.from("daily_reports")
    .update({
      status: "submitted",
      submitted_at: new Date().toISOString(),
      submitted_by: user.id,
    })
    .eq("id", id)
    .is("deleted_at", null)
    .select()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data?.length) return NextResponse.json({ error: "Not found" }, { status: 404 })
  return NextResponse.json({ ok: true, report: data[0] })
}
