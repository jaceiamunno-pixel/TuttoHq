import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { forbidFieldRole } from "@/lib/field-access"
import { parseMoney, deriveNextSubCoNumber, sumLinePrices } from "@/lib/sub-co-shared"

// Subcontractor Change Orders — downstream COs the GC issues TO a sub (vendor).
// Mirrors /api/change-orders but numbering is MAX(numeric)+1 per
// (project, vendor) — never the legacy count(*)+1, which recycles numbers
// after a delete. Soft-delete = status 'deleted'; every read filters it.

const VENDOR_EMBED =
  "vendor:vendors(id, vendor_no, company_name, street_address, city, state, zip_code, phone, email)"

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const pid = req.nextUrl.searchParams.get("project_id")
  let q = supabase
    .from("sub_change_orders")
    .select(`*, ${VENDOR_EMBED}, lines:sub_change_order_lines(description, price, sort_order)`)
    .neq("status", "deleted")
    .order("created_at", { ascending: false })
  if (pid) q = q.eq("project_id", pid)
  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Totals + first description are attached HERE (server-side) so the client
  // never sums money itself.
  const rows = (data ?? []).map(row => {
    const lines = ([...(row.lines ?? [])] as { description: string; price: number | null; sort_order: number }[])
      .sort((a, b) => a.sort_order - b.sort_order)
    const { lines: _lines, ...rest } = row
    return { ...rest, total: sumLinePrices(lines), first_description: lines[0]?.description ?? null }
  })
  return NextResponse.json({ subChangeOrders: rows })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const fieldDenied = await forbidFieldRole(supabase)
  if (fieldDenied) return fieldDenied

  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })

  const project_id = typeof body.project_id === "string" ? body.project_id : ""
  const vendor_id = typeof body.vendor_id === "string" ? body.vendor_id : ""
  if (!project_id) return NextResponse.json({ error: "project_id is required" }, { status: 400 })
  if (!vendor_id) return NextResponse.json({ error: "vendor_id is required" }, { status: 400 })

  // Server re-resolves both FKs through RLS-scoped reads — a cross-company id
  // is simply invisible and 404s. company_id comes from the column default
  // (get_my_company_id()), never from the client.
  const { data: project } = await supabase.from("projects").select("id").eq("id", project_id).maybeSingle()
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 })
  const { data: vendor } = await supabase.from("vendors").select("id").eq("id", vendor_id).maybeSingle()
  if (!vendor) return NextResponse.json({ error: "Vendor not found" }, { status: 404 })

  const parsedAmount = parseMoney(body.original_contract_amount)
  if (parsedAmount.invalid) {
    return NextResponse.json({ error: "original_contract_amount is not a valid amount" }, { status: 400 })
  }
  let original_contract_amount = parsedAmount.value ?? null

  let commitment_id: string | null = null
  if (typeof body.commitment_id === "string" && body.commitment_id) {
    // The linked subcontract must belong to the same project AND the same
    // vendor — anything else is rejected, not silently accepted.
    const { data: commitment } = await supabase
      .from("commitments")
      .select("id, contract_value")
      .eq("id", body.commitment_id)
      .eq("project_id", project_id)
      .eq("vendor_id", vendor_id)
      .maybeSingle()
    if (!commitment) {
      return NextResponse.json({ error: "Commitment not found for this project and vendor" }, { status: 404 })
    }
    commitment_id = commitment.id
    // Prefill only — the amount stays manually editable.
    if (original_contract_amount == null && commitment.contract_value != null) {
      original_contract_amount = commitment.contract_value
    }
  }

  const userCoNumber = typeof body.co_number === "string" ? body.co_number.trim() : ""
  let co_number = userCoNumber || (await deriveNextSubCoNumber(supabase, project_id, vendor_id))

  const row = {
    project_id,
    vendor_id,
    commitment_id,
    co_number,
    original_contract_no: typeof body.original_contract_no === "string" ? body.original_contract_no.trim() || null : null,
    co_date: typeof body.co_date === "string" && body.co_date ? body.co_date : new Date().toISOString().slice(0, 10),
    cost_code: typeof body.cost_code === "string" ? body.cost_code.trim() || null : null,
    original_contract_amount,
    status: "draft",
    signer_name: typeof body.signer_name === "string" ? body.signer_name.trim() || null : null,
    signer_title: typeof body.signer_title === "string" ? body.signer_title.trim() || null : null,
    uploaded_by: user.id,
  }

  let { data: inserted, error } = await supabase.from("sub_change_orders").insert(row).select("*").single()
  if (error?.code === "23505" && !userCoNumber) {
    // Two browsers derived the same default number — re-derive once and retry.
    co_number = await deriveNextSubCoNumber(supabase, project_id, vendor_id)
    const retry = await supabase.from("sub_change_orders").insert({ ...row, co_number }).select("*").single()
    inserted = retry.data
    error = retry.error
  }
  if (error) {
    if (error.code === "23505") {
      return NextResponse.json(
        { error: "Change order number already in use for this subcontractor on this project" },
        { status: 409 },
      )
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true, subChangeOrder: inserted })
}
