import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { computePcoPricingSum, buildLineItemRows, type PcoSaveBody } from "@/lib/pco-save"

// POST /api/change-orders/pco — create a builder PCO (has_pco_detail = true).
//
// Pricing integrity lives HERE: pricing_sum is recomputed server-side via the
// shared computePcoTotals (computePcoPricingSum) over the SUBMITTED line items —
// the client's grand total is never forwarded. The recomputed value is then
// passed to save_pco, which trusts p_pricing_sum.
//
// Atomicity + numbering live in save_pco: it derives co_number (max numeric + 1)
// with an in-function retry on the partial-unique collision, and inserts the row
// + line items in ONE transaction. status / realized_amount / assigned_co_number
// are never written.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = (await req.json().catch(() => null)) as (PcoSaveBody & {
    project_id?: string; date?: string; title?: string; description_of_work?: string
    schedule_impact_days?: number | string; oh_p_percent?: number | null
    signer_name?: string; signer_title?: string
  }) | null
  if (!body) return NextResponse.json({ error: "Invalid request body" }, { status: 400 })

  const projectId = typeof body.project_id === "string" ? body.project_id.trim() : ""
  const title = typeof body.title === "string" ? body.title.trim() : ""
  if (!projectId) return NextResponse.json({ error: "project_id is required" }, { status: 400 })
  if (!title) return NextResponse.json({ error: "A title is required" }, { status: 400 })

  const pricing_sum = computePcoPricingSum(body)            // recomputed, never trusted
  const lineItems = buildLineItemRows(body)
  const schedDays = body.schedule_impact_days === undefined || body.schedule_impact_days === null || body.schedule_impact_days === ""
    ? 0 : parseInt(String(body.schedule_impact_days), 10)
  const ohp = body.oh_p_percent === null || body.oh_p_percent === undefined ? null : Number(body.oh_p_percent)

  // Snapshot the SAVER's signature path (SELECT-own) so a later regeneration
  // embeds this signer's signature, not the regenerating user's. Looked up
  // server-side — never trusted from the client.
  const { data: prof } = await supabase.from("user_profiles").select("signature_storage_path").maybeSingle()

  const { data, error } = await supabase.rpc("save_pco", {
    p_id:                    null,
    p_project_id:            projectId,
    p_date:                  body.date || null,
    p_title:                 title,
    p_description:           typeof body.description_of_work === "string" ? body.description_of_work.trim() || null : null,
    p_pricing_sum:           pricing_sum,
    p_schedule_days:         Number.isFinite(schedDays) ? schedDays : 0,
    p_ohp:                   ohp,
    p_signer_name:           typeof body.signer_name === "string" ? body.signer_name.trim() || null : null,
    p_signer_title:          typeof body.signer_title === "string" ? body.signer_title.trim() || null : null,
    p_signer_signature_path: prof?.signature_storage_path ?? null,
    p_line_items:            lineItems,
  })
  if (error) {
    console.error("save_pco (create) failed:", error)
    return NextResponse.json({ error: "Could not create PCO" }, { status: 500 })
  }

  const row = Array.isArray(data) ? data[0] : data
  return NextResponse.json({ id: row?.pco_id, co_number: row?.pco_co_number }, { status: 201 })
}
