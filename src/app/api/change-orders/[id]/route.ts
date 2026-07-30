import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { forbidFieldRole } from "@/lib/field-access"

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })


  // ADR-020: locked surface for field accounts (route reaches SECURITY
  // DEFINER RPCs / service paths RLS cannot gate).
  const fieldDenied = await forbidFieldRole(supabase)
  if (fieldDenied) return fieldDenied
  const { id } = await params
  const updates = await req.json()

  // `origin` is intentionally NOT in `allowed` below — it is immutable after
  // insert (only import_pco sets it). A manual→imported write would be an
  // irreversible freeze of a legitimate row, so no PATCH/PUT path accepts it.
  //
  // `co_number` (the PCO number) is NOT in this base list — it is added below
  // only for builder PCOs (has_pco_detail = true), where the partial unique
  // index uq_change_orders_project_pco_number guards it. A non-PCO change
  // order's number stays immutable on this path.
  const allowed = [
    "assigned_co_number", "date", "proposal", "qualifications", "pricing_sum", "realized_amount",
    "schedule_impact", "schedule_impact_days", "file_path", "file_name",
    "status", "submitted_by", "assigned_to", "generated_pdf_path", "approved_at",
  ]

  // Imported PCOs freeze the DOCUMENT content but keep LOG-WORKFLOW state
  // editable so the imported log stays manageable. Reject (clean 403) any
  // requested field outside the workflow set; the DB trigger is the hard
  // backstop. DELETE is unaffected.
  const WORKFLOW_FIELDS = ["status", "assigned_co_number", "realized_amount", "assigned_to"]
  // Re-resolve the row server-side (RLS-scoped) to read has_pco_detail/origin —
  // the client never tells us either, nor which project the row belongs to.
  const { data: existing } = await supabase.from("change_orders").select("origin, has_pco_detail").eq("id", id).maybeSingle()

  // Only builder PCOs may rename their PCO number. (Imported PCOs are also
  // has_pco_detail = true, but the freeze guard below still rejects co_number
  // for them since it isn't a WORKFLOW_FIELD — co_number stays frozen there.)
  if (existing?.has_pco_detail === true) allowed.push("co_number")

  if (existing?.origin === "imported") {
    const offending = Object.keys(updates).filter(k => allowed.includes(k) && !WORKFLOW_FIELDS.includes(k))
    if (offending.length) {
      return NextResponse.json(
        { error: `Imported PCO is frozen; only status, CO #, realized amount, and reviewer are editable (rejected: ${offending.join(", ")}).` },
        { status: 403 },
      )
    }
  }

  const safe: Record<string, unknown> = Object.fromEntries(
    Object.entries(updates).filter(([k]) => allowed.includes(k))
  )

  // A blank PCO number would erase a builder PCO's identity (and two blanks in
  // one project would collide), so reject it before it reaches the DB.
  if ("co_number" in safe) {
    let v = typeof safe.co_number === "string" ? safe.co_number.trim() : ""
    if (!v) return NextResponse.json({ error: "PCO number cannot be empty" }, { status: 400 })
    // Match the auto-generated format: left-pad purely-numeric input to 3 digits
    // ("7" → "007"), matching nextPcoNumber()/the existing rows. Non-numeric
    // values (e.g. a future "7A") are stored verbatim — never coerced.
    //
    // This pad is applied BEFORE the UPDATE, so the partial unique index
    // uq_change_orders_project_pco_number compares the PADDED value: "7" and
    // "007" are the same number for collision purposes. There is no separate
    // app-level uniqueness check — the index is the sole arbiter, and it only
    // ever sees the normalized value.
    if (/^\d+$/.test(v)) v = v.padStart(3, "0")
    safe.co_number = v
  }

  if ("status" in safe && safe.status === "Approved" && !updates.approved_at) {
    safe.approved_at = new Date().toISOString()
  }
  safe.updated_at = new Date().toISOString()

  const { error } = await supabase.from("change_orders").update(safe).eq("id", id)
  if (error) {
    // Partial unique index uq_change_orders_project_pco_number → the new PCO
    // number is already taken by another builder PCO in this project. Surface a
    // clean 409 instead of letting the unique violation fall through as a 500.
    if (error.code === "23505") {
      return NextResponse.json({ error: "PCO number already in use on this project" }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Return the normalized co_number so the client reflects exactly what was
  // stored (e.g. the padded "007") without re-implementing the pad rule.
  return NextResponse.json({ ok: true, co_number: safe.co_number })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })


  // ADR-020: locked surface for field accounts (route reaches SECURITY
  // DEFINER RPCs / service paths RLS cannot gate).
  const fieldDenied = await forbidFieldRole(supabase)
  if (fieldDenied) return fieldDenied
  const { id } = await params
  const { data: row, error: selErr } = await supabase
    .from("change_orders").select("id").eq("id", id).maybeSingle()
  if (selErr) return NextResponse.json({ error: "Database error" }, { status: 500 })
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const { error } = await supabase.from("change_orders").delete().eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
