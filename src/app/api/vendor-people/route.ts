import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// People under a vendor firm (ADR-004 Firm→People, on the unified vendors
// model). All access is company-scoped by the vendor_people RLS
// (company_id = get_my_company_id()).

const COLS = "id, vendor_id, name, email, phone, role"

// GET /api/vendor-people            → all people in the caller's company
// GET /api/vendor-people?vendor_id= → people under one firm
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const vendorId = req.nextUrl.searchParams.get("vendor_id")?.trim()
  let query = supabase.from("vendor_people").select(COLS).order("name")
  if (vendorId) query = query.eq("vendor_id", vendorId)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ people: data ?? [] })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { vendor_id, name, email, phone, role } = await req.json().catch(() => ({}))
  if (!vendor_id) return NextResponse.json({ error: "vendor_id required" }, { status: 400 })
  if (!name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 })

  // Tenant-isolation check: the parent firm must be visible to this user. RLS
  // only returns vendors in the caller's company, so a not-found here means the
  // firm belongs to another tenant (or doesn't exist) — reject. The inserted
  // person's company_id defaults to get_my_company_id() and is enforced again by
  // the vendor_people RLS WITH CHECK.
  const { data: firm } = await supabase
    .from("vendors").select("id").eq("id", vendor_id).maybeSingle()
  if (!firm) return NextResponse.json({ error: "Firm not found" }, { status: 404 })

  const { data, error } = await supabase
    .from("vendor_people")
    .insert({
      vendor_id,
      name: name.trim(),
      email: email?.trim() || null,
      phone: phone?.trim() || null,
      role:  role?.trim()  || null,
    })
    .select(COLS)
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ person: data }, { status: 201 })
}
