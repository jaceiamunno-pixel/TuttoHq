import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// Columns the settings directory needs (every firm field). Used by the `all`
// mode below and shared with POST's return so the client gets a complete row.
const FULL_COLS =
  "id, vendor_no, company_name, is_subcontractor, is_supplier, trade, specialty, contact_name, phone, email, street_address, city, state, zip_code, license_number, website, notes, created_at"

// GET /api/vendors
//   ?q=acme&role=…           → typeahead over the unified vendors master (capped
//                              at 50, subset of fields). Unchanged behaviour for
//                              the PO / supplier-contract pickers.
//   ?all=1                   → full company-scoped list with every firm field,
//                              for the Vendors directory's client-side filter.
// RLS scopes every row to the caller's company on both paths.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const q = req.nextUrl.searchParams.get("q")?.trim() ?? ""
  const role = req.nextUrl.searchParams.get("role")?.trim() ?? ""
  const all = req.nextUrl.searchParams.get("all")

  if (all) {
    // The master is ~1,400 rows per tenant; load the whole company-scoped set
    // once and let the directory filter it client-side (no AI call), matching
    // the Library/log filter pattern. Paginate so the result is complete even
    // if PostgREST's max-rows caps a single response below the row count.
    const PAGE = 1000
    const out: unknown[] = []
    for (let from = 0; from < 50000; from += PAGE) {
      const { data, error } = await supabase
        .from("vendors")
        .select(FULL_COLS)
        .order("company_name", { ascending: true })
        .range(from, from + PAGE - 1)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      out.push(...(data ?? []))
      if (!data || data.length < PAGE) break
    }
    return NextResponse.json({ vendors: out })
  }

  let query = supabase
    .from("vendors")
    .select("id, vendor_no, company_name, street_address, city, state, zip_code, phone")
    .order("company_name", { ascending: true })
    .limit(50)
  if (q) query = query.ilike("company_name", `%${q}%`)
  // Role narrowing for the supplier-contract picker. Unknown role values are
  // ignored (treated as no filter) so a stray param can never widen access.
  if (role === "supplier") query = query.eq("is_supplier", true)
  else if (role === "subcontractor") query = query.eq("is_subcontractor", true)
  else if (role === "supplier_or_subcontractor") query = query.or("is_supplier.eq.true,is_subcontractor.eq.true")

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ vendors: data ?? [] })
}

// String-ish firm fields a client may set on create/update. company_id is NEVER
// among them — it is set by the column DEFAULT (get_my_company_id()) and locked
// by the vendors RLS WITH CHECK, so a client can't write into another tenant.
const TEXT_FIELDS = [
  "vendor_no", "trade", "specialty", "contact_name", "phone", "email",
  "street_address", "city", "state", "zip_code", "license_number", "website", "notes",
] as const

function cleanText(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null
}

// POST /api/vendors — create one vendor in the caller's company.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const company_name = cleanText(body.company_name)
  if (!company_name) return NextResponse.json({ error: "company_name required" }, { status: 400 })

  const row: Record<string, unknown> = {
    company_name,
    is_subcontractor: body.is_subcontractor === true,
    is_supplier: body.is_supplier === true,
    uploaded_by: user.id,
  }
  for (const f of TEXT_FIELDS) row[f] = cleanText(body[f])

  // No company_id supplied → DB default fills it; RLS WITH CHECK rejects any
  // row that wouldn't belong to the caller's company.
  const { data, error } = await supabase
    .from("vendors")
    .insert(row)
    .select(FULL_COLS)
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ vendor: data }, { status: 201 })
}
