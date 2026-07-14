import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { nextPlainCoNumber } from "@/lib/co-number"

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const pid = req.nextUrl.searchParams.get("project_id")
  // Soft-deleted change orders (deleted_at set) are hidden from the log. Filter
  // in-query, never in the RLS SELECT policy (the 42501 UPDATE...RETURNING trap).
  let q = supabase.from("change_orders").select("*").is("deleted_at", null).order("created_at", { ascending: false })
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
          schedule_impact, schedule_impact_days, submitted_by, assigned_to, status,
          assigned_co_number, realized_amount } = fields

  // Realized is only meaningful once a C.O.# is assigned; otherwise force null.
  const hasCoNum = typeof assigned_co_number === "string" && assigned_co_number.trim() !== ""
  const realizedRaw = typeof realized_amount === "string" ? realized_amount.trim() : ""
  const realizedVal = hasCoNum && realizedRaw !== "" ? parseFloat(realizedRaw) : null

  if (!proposal?.trim() && !fields.co_number) {
    return NextResponse.json({ error: "proposal is required" }, { status: 400 })
  }

  const userCoNumber = typeof fields.co_number === "string" ? fields.co_number.trim() : ""

  const file_path = typeof fields.file_path === "string" ? fields.file_path.trim() || null : null
  const file_name = typeof fields.file_name === "string" ? fields.file_name.trim() || null : null

  // Shared row payload; co_number is assigned by the numbering scheme below.
  const baseRow = {
    project_id:           project_id || null,
    date:                 date || new Date().toISOString().slice(0, 10),
    proposal:             proposal?.trim() || null,
    qualifications:       qualifications?.trim() || null,
    pricing_sum:          pricing_sum ? parseFloat(pricing_sum) : null,
    schedule_impact:      schedule_impact || "TBD",
    schedule_impact_days: schedule_impact_days ? parseInt(schedule_impact_days) : null,
    file_path,
    file_name,
    status:               status || "Not submitted",
    assigned_co_number:   assigned_co_number?.trim() || null,
    realized_amount:      realizedVal,
    submitted_by:         submitted_by?.trim() || null,
    assigned_to:          assigned_to?.trim() || null,
    uploaded_by:          user.id,
  }

  // Global (null-project) fallback: unchanged legacy count-based scheme. A
  // user-typed number still wins; no partial unique index covers null project_id.
  if (!project_id) {
    const { count } = await supabase.from("change_orders").select("*", { count: "exact", head: true })
    const co_number = userCoNumber || `CO-${String((count ?? 0) + 1).padStart(3, "0")}`
    const { error } = await supabase.from("change_orders").insert({ ...baseRow, co_number })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, co_number })
  }

  // User-typed number wins and is NEVER renumbered. A collision with a live plain
  // CO in this project (uq_change_orders_project_plain_number, 0046) → clean 409.
  if (userCoNumber) {
    const { error } = await supabase.from("change_orders").insert({ ...baseRow, co_number: userCoNumber })
    if (error) {
      if (error.code === "23505") {
        return NextResponse.json({ error: `CO number ${userCoNumber} already exists on this project` }, { status: 409 })
      }
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ ok: true, co_number: userCoNumber })
  }

  // Blank → auto number = MAX(numeric tail of "CO-NNN") + 1 over ALL PLAIN rows
  // (has_pco_detail IS NOT TRUE) in the project, including soft-deleted → never
  // recycled. On a concurrent collision (23505) re-derive from the committed MAX
  // and retry, bounded — mirrors save_pco (0002_pco_phase3.sql). Builder PCOs
  // (pure-digit co_number) are excluded, so plain and builder sequences stay
  // independent.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { data: rows } = await supabase.from("change_orders")
      .select("co_number, has_pco_detail").eq("project_id", project_id)
    const plain = (rows ?? []).filter(r => r.has_pco_detail !== true).map(r => r.co_number)
    const { display: co_number } = nextPlainCoNumber(plain)
    const { error } = await supabase.from("change_orders").insert({ ...baseRow, co_number })
    if (!error) return NextResponse.json({ ok: true, co_number })
    if (error.code === "23505" && attempt < 3) continue
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ error: "Could not assign a CO number" }, { status: 500 })
}
