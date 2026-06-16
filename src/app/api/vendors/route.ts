import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// GET /api/vendors?q=acme&role=supplier_or_subcontractor — typeahead over the
// unified vendors master (1,400+ rows, so we always cap the result set). RLS
// scopes rows to the caller's company. Returns just the fields the vendor block
// needs. The optional `role` filter narrows by the vendors master's role flags
// (default: no filter, so existing callers are unchanged).
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const q = req.nextUrl.searchParams.get("q")?.trim() ?? ""
  const role = req.nextUrl.searchParams.get("role")?.trim() ?? ""

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
