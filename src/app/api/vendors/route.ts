import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// GET /api/vendors?q=acme — typeahead over the unified vendors master (1,400+
// rows, so we always cap the result set). RLS scopes rows to the caller's
// company. Returns just the fields the PO vendor block needs.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const q = req.nextUrl.searchParams.get("q")?.trim() ?? ""

  let query = supabase
    .from("vendors")
    .select("id, vendor_no, company_name, street_address, city, state, zip_code, phone")
    .order("company_name", { ascending: true })
    .limit(50)
  if (q) query = query.ilike("company_name", `%${q}%`)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ vendors: data ?? [] })
}
