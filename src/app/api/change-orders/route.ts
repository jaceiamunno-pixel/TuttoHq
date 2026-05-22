import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const pid = req.nextUrl.searchParams.get("project_id")
  let q = supabase.from("change_orders").select("*").order("created_at", { ascending: false })
  if (pid) q = q.eq("project_id", pid)

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ changeOrders: data ?? [] })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  // The attachment (if any) was already PUT straight to storage from the
  // browser via a signed upload URL, so this route receives only JSON metadata.
  const fields: Record<string, string | null> = await req.json().catch(() => ({}))

  const { project_id, date, proposal, qualifications, pricing_sum,
          schedule_impact, schedule_impact_days, submitted_by, assigned_to, status } = fields

  if (!proposal?.trim() && !fields.co_number) {
    return NextResponse.json({ error: "proposal is required" }, { status: 400 })
  }

  // Auto-generate CO number per project
  let co_number: string
  if (project_id) {
    const { count } = await supabase.from("change_orders")
      .select("*", { count: "exact", head: true }).eq("project_id", project_id)
    co_number = fields.co_number?.trim() || `CO-${String((count ?? 0) + 1).padStart(3, "0")}`
  } else {
    const { count } = await supabase.from("change_orders").select("*", { count: "exact", head: true })
    co_number = fields.co_number?.trim() || `CO-${String((count ?? 0) + 1).padStart(3, "0")}`
  }

  const file_path = typeof fields.file_path === "string" ? fields.file_path.trim() || null : null
  const file_name = typeof fields.file_name === "string" ? fields.file_name.trim() || null : null

  const { error } = await supabase.from("change_orders").insert({
    co_number,
    project_id:           project_id || null,
    date:                 date || new Date().toISOString().slice(0, 10),
    proposal:             proposal?.trim() || null,
    qualifications:       qualifications?.trim() || null,
    pricing_sum:          pricing_sum ? parseFloat(pricing_sum) : null,
    schedule_impact:      schedule_impact || "TBD",
    schedule_impact_days: schedule_impact_days ? parseInt(schedule_impact_days) : null,
    file_path,
    file_name,
    status:               status || "Draft",
    submitted_by:         submitted_by?.trim() || null,
    assigned_to:          assigned_to?.trim() || null,
    uploaded_by:          user.id,
  })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, co_number })
}
