import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const updates = await req.json()

  const allowed = [
    "co_number", "assigned_co_number", "date", "proposal", "qualifications", "pricing_sum",
    "schedule_impact", "schedule_impact_days", "file_path", "file_name",
    "status", "submitted_by", "assigned_to", "generated_pdf_path", "approved_at",
  ]
  const safe: Record<string, unknown> = Object.fromEntries(
    Object.entries(updates).filter(([k]) => allowed.includes(k))
  )

  if ("status" in safe && safe.status === "Approved" && !updates.approved_at) {
    safe.approved_at = new Date().toISOString()
  }
  safe.updated_at = new Date().toISOString()

  const { error } = await supabase.from("change_orders").update(safe).eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const { data: row, error: selErr } = await supabase
    .from("change_orders").select("id").eq("id", id).maybeSingle()
  if (selErr) return NextResponse.json({ error: "Database error" }, { status: 500 })
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const { error } = await supabase.from("change_orders").delete().eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
