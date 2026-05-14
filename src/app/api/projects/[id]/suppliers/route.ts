import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const { data, error } = await supabase
    .from("project_suppliers")
    .select("supplier_id, suppliers(id, company_name, specialty, contact_name, phone, email, website)")
    .eq("project_id", id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const suppliers = (data ?? []).map((r: Record<string, unknown>) => r.suppliers).filter(Boolean)
  return NextResponse.json(suppliers)
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const { ids } = await req.json() as { ids: string[] }

  await supabase.from("project_suppliers").delete().eq("project_id", id)

  if (ids?.length) {
    const rows = ids.map(supplier_id => ({ project_id: id, supplier_id }))
    const { error } = await supabase.from("project_suppliers").insert(rows)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
