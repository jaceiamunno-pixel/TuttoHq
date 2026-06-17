import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// Per-project supplier assignment, on the unified vendors model. Storage is the
// project_vendors join (role='supplier'); the firm record is a row in the
// vendors master. RLS scopes both relations to the caller's company; the client
// never sends company_id (project_vendors.company_id defaults to
// get_my_company_id() and is locked by the INSERT WITH CHECK).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const { data, error } = await supabase
    .from("project_vendors")
    .select("vendor_id, vendors(id, company_name, specialty, contact_name, phone, email, website)")
    .eq("project_id", id)
    .eq("role", "supplier")

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const suppliers = (data ?? []).map((r: Record<string, unknown>) => r.vendors).filter(Boolean)
  return NextResponse.json(suppliers)
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const { ids } = await req.json() as { ids: string[] }

  // Replace this project's supplier assignments only — role-scoped so the
  // subcontractor assignments in the same join table are left untouched.
  await supabase.from("project_vendors").delete().eq("project_id", id).eq("role", "supplier")

  if (ids?.length) {
    const rows = ids.map(vendor_id => ({ project_id: id, vendor_id, role: "supplier" }))
    const { error } = await supabase.from("project_vendors").insert(rows)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
