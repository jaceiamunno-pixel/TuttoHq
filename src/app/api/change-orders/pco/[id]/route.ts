import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { computePcoPricingSum, buildLineItemRows, newLaborRoleRows, type PcoSaveBody } from "@/lib/pco-save"

// GET — load a builder PCO (header + line items) for edit mode.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params

  const { data: co } = await supabase
    .from("change_orders")
    .select("id, co_number, project_id, date, proposal, description_of_work, pricing_sum, schedule_impact_days, oh_p_percent, fee_percent, has_pco_detail, submitted_by, signer_title")
    .eq("id", id).is("deleted_at", null).maybeSingle()
  if (!co) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const { data: items } = await supabase
    .from("change_order_line_items")
    .select("id, category, description, qty_reg, rate_reg, qty_ot, rate_ot, qty_dt, rate_dt, qty, unit, unit_price, note, amount, sort_order")
    .eq("change_order_id", id)
    .order("sort_order", { ascending: true })

  const rows = items ?? []
  return NextResponse.json({
    changeOrder: co,
    labor:     rows.filter(r => r.category === "labor"),
    materials: rows.filter(r => r.category === "material"),
    subs:      rows.filter(r => r.category === "subcontractor"),
  })
}

// PUT — update a builder PCO and REPLACE its line items, atomically, via
// save_pco. pricing_sum is recomputed server-side (never trusted from client).
// save_pco refuses (no_data_found) on a missing or non-builder row → 409, so a
// manual log row can't be reshaped into a PCO. co_number, status,
// realized_amount, and assigned_co_number are not written.
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const body = (await req.json().catch(() => null)) as (PcoSaveBody & {
    date?: string; title?: string; description_of_work?: string
    schedule_impact_days?: number | string; oh_p_percent?: number | null; fee_percent?: number | null
    signer_name?: string; signer_title?: string
  }) | null
  if (!body) return NextResponse.json({ error: "Invalid request body" }, { status: 400 })

  const title = typeof body.title === "string" ? body.title.trim() : ""
  if (!title) return NextResponse.json({ error: "A title is required" }, { status: 400 })

  // Imported PCOs are frozen — the builder must never re-save one. Clean 403
  // (the save_pco UPDATE would also be rejected by the DB freeze trigger).
  // A soft-deleted row reads as absent → 404 (guards against resurrecting a
  // deleted PCO through save_pco, whose UPDATE does not itself filter deleted_at).
  const { data: existing } = await supabase.from("change_orders").select("origin").eq("id", id).is("deleted_at", null).maybeSingle()
  if (!existing) return NextResponse.json({ error: "PCO not found" }, { status: 404 })
  if (existing.origin === "imported") {
    return NextResponse.json({ error: "This PCO was imported and is frozen; it cannot be edited." }, { status: 403 })
  }

  const pricing_sum = computePcoPricingSum(body)            // recomputed, never trusted
  const lineItems = buildLineItemRows(body)
  const schedDays = body.schedule_impact_days === undefined || body.schedule_impact_days === null || body.schedule_impact_days === ""
    ? 0 : parseInt(String(body.schedule_impact_days), 10)
  const ohp = body.oh_p_percent === null || body.oh_p_percent === undefined ? null : Number(body.oh_p_percent)
  const fee = body.fee_percent === null || body.fee_percent === undefined ? null : Number(body.fee_percent)

  // Re-snapshot the saver's signature on each save (the person saving signs this
  // revision). SELECT-own; never trusted from the client.
  const { data: prof } = await supabase.from("user_profiles").select("signature_storage_path").eq("user_id", user.id).maybeSingle()

  const { data, error } = await supabase.rpc("save_pco", {
    p_id:                    id,
    p_project_id:            null,                          // unused on the update path
    p_date:                  body.date || null,
    p_title:                 title,
    p_description:           typeof body.description_of_work === "string" ? body.description_of_work.trim() || null : null,
    p_pricing_sum:           pricing_sum,
    p_schedule_days:         Number.isFinite(schedDays) ? schedDays : 0,
    p_ohp:                   ohp,
    p_fee_percent:           fee,
    p_signer_name:           typeof body.signer_name === "string" ? body.signer_name.trim() || null : null,
    p_signer_title:          typeof body.signer_title === "string" ? body.signer_title.trim() || null : null,
    p_signer_signature_path: prof?.signature_storage_path ?? null,
    p_line_items:            lineItems,
  })
  if (error) {
    // no_data_found (SQLSTATE P0002) → missing or non-builder row.
    if (error.code === "P0002") {
      return NextResponse.json({ error: "PCO not found or not a builder PCO" }, { status: 409 })
    }
    console.error("save_pco (update) failed:", error)
    return NextResponse.json({ error: "Could not save PCO" }, { status: 500 })
  }

  // Persist any new labor role names to the rate book (typeahead "create"). Non-fatal.
  try {
    const { data: existingRoles } = await supabase.from("labor_rates").select("role_name")
    const newRoles = newLaborRoleRows(body, (existingRoles ?? []).map(r => r.role_name))
    if (newRoles.length) await supabase.from("labor_rates").insert(newRoles)
  } catch { /* non-fatal */ }

  const row = Array.isArray(data) ? data[0] : data
  return NextResponse.json({ id: row?.pco_id ?? id, pricing_sum })
}
