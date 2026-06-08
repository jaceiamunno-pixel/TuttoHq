import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// People under a subcontractor firm (ADR-004 Firm→People). All access is
// company-scoped by the subcontractor_people RLS (company_id = get_my_company_id()).

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data, error } = await supabase
    .from("subcontractor_people")
    .select("id, subcontractor_id, name, email, phone, role")
    .order("name")

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data ?? [])
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { subcontractor_id, name, email, phone, role } = await req.json()
  if (!subcontractor_id) return NextResponse.json({ error: "subcontractor_id required" }, { status: 400 })
  if (!name?.trim())     return NextResponse.json({ error: "name required" }, { status: 400 })

  // Tenant-isolation check: the parent firm must be visible to this user. RLS
  // only returns subcontractors in the caller's company, so a not-found here
  // means the firm belongs to another tenant (or doesn't exist) — reject. The
  // inserted person's company_id defaults to get_my_company_id() and is
  // enforced again by the subcontractor_people RLS WITH CHECK.
  const { data: firm } = await supabase
    .from("subcontractors").select("id").eq("id", subcontractor_id).maybeSingle()
  if (!firm) return NextResponse.json({ error: "Firm not found" }, { status: 404 })

  const { data, error } = await supabase
    .from("subcontractor_people")
    .insert({
      subcontractor_id,
      name: name.trim(),
      email: email?.trim() || null,
      phone: phone?.trim() || null,
      role:  role?.trim()  || null,
    })
    .select("id, subcontractor_id, name, email, phone, role")
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data, { status: 201 })
}
