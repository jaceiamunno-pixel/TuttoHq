import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { forbidFieldRole } from "@/lib/field-access"
import { parseMoney } from "@/lib/sub-co-shared"

// Single Subcontractor Change Order. DELETE is soft-only (status = 'deleted');
// the row and its number survive forever — the partial unique index excludes
// deleted rows so the number is retired, never recycled.

const VENDOR_EMBED =
  "vendor:vendors(id, vendor_no, company_name, street_address, city, state, zip_code, phone, email)"

// 'deleted' is deliberately absent — PATCH can never soft-delete; only the
// DELETE handler transitions to 'deleted'.
const PATCHABLE_STATUSES = ["draft", "sent", "accepted"]

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data, error } = await supabase
    .from("sub_change_orders")
    .select(`*, ${VENDOR_EMBED}, lines:sub_change_order_lines(*)`)
    .eq("id", id)
    .neq("status", "deleted")
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 })
  data.lines = ([...(data.lines ?? [])] as { sort_order: number; created_at: string }[])
    .sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at))
  return NextResponse.json({ subChangeOrder: data })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const fieldDenied = await forbidFieldRole(supabase)
  if (fieldDenied) return fieldDenied

  const updates = await req.json().catch(() => null)
  if (!updates || typeof updates !== "object") {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const { data: existing } = await supabase
    .from("sub_change_orders")
    .select("id, project_id, vendor_id, status")
    .eq("id", id)
    .neq("status", "deleted")
    .maybeSingle()
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const allowed = [
    "co_number", "original_contract_no", "co_date", "cost_code",
    "original_contract_amount", "status", "commitment_id", "vendor_id",
    "signer_name", "signer_title",
  ]
  const safe: Record<string, unknown> = Object.fromEntries(
    Object.entries(updates).filter(([k]) => allowed.includes(k)),
  )
  if (Object.keys(safe).length === 0) {
    return NextResponse.json({ error: "No editable fields in body" }, { status: 400 })
  }

  if ("co_number" in safe) {
    const trimmed = typeof safe.co_number === "string" ? safe.co_number.trim() : ""
    if (!trimmed) return NextResponse.json({ error: "co_number cannot be empty" }, { status: 400 })
    safe.co_number = trimmed
  }

  if ("status" in safe) {
    if (typeof safe.status !== "string" || !PATCHABLE_STATUSES.includes(safe.status)) {
      return NextResponse.json(
        { error: `status must be one of: ${PATCHABLE_STATUSES.join(", ")}` },
        { status: 400 },
      )
    }
    // Mirror change_orders approved_at: stamp on the transition into accepted.
    if (safe.status === "accepted" && existing.status !== "accepted") {
      safe.accepted_at = new Date().toISOString()
    }
  }

  if ("original_contract_amount" in safe) {
    const parsed = parseMoney(safe.original_contract_amount)
    if (parsed.invalid) {
      return NextResponse.json({ error: "original_contract_amount is not a valid amount" }, { status: 400 })
    }
    safe.original_contract_amount = parsed.value ?? null
  }

  // Re-resolve FK edits through RLS-scoped reads (cross-company ids 404).
  const effectiveVendor = typeof safe.vendor_id === "string" ? safe.vendor_id : existing.vendor_id
  if ("vendor_id" in safe) {
    if (typeof safe.vendor_id !== "string" || !safe.vendor_id) {
      return NextResponse.json({ error: "vendor_id cannot be empty" }, { status: 400 })
    }
    const { data: vendor } = await supabase.from("vendors").select("id").eq("id", safe.vendor_id).maybeSingle()
    if (!vendor) return NextResponse.json({ error: "Vendor not found" }, { status: 404 })
  }
  if ("commitment_id" in safe && safe.commitment_id != null) {
    if (typeof safe.commitment_id !== "string") {
      return NextResponse.json({ error: "commitment_id must be a string or null" }, { status: 400 })
    }
    const { data: commitment } = await supabase
      .from("commitments")
      .select("id")
      .eq("id", safe.commitment_id)
      .eq("project_id", existing.project_id)
      .eq("vendor_id", effectiveVendor)
      .maybeSingle()
    if (!commitment) {
      return NextResponse.json({ error: "Commitment not found for this project and vendor" }, { status: 404 })
    }
  }

  safe.updated_at = new Date().toISOString()

  const { error } = await supabase.from("sub_change_orders").update(safe).eq("id", id)
  if (error) {
    if (error.code === "23505") {
      return NextResponse.json(
        { error: "Change order number already in use for this subcontractor on this project" },
        { status: 409 },
      )
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const fieldDenied = await forbidFieldRole(supabase)
  if (fieldDenied) return fieldDenied

  const { data: row } = await supabase
    .from("sub_change_orders")
    .select("id")
    .eq("id", id)
    .neq("status", "deleted")
    .maybeSingle()
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const { error } = await supabase
    .from("sub_change_orders")
    .update({ status: "deleted", updated_at: new Date().toISOString() })
    .eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
