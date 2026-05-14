import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const { data, error } = await supabase
    .from("project_subcontractors")
    .select("subcontractor_id, subcontractors(id, company_name, trade, contact_name, phone, email, license_number)")
    .eq("project_id", id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const subs = (data ?? []).map((r: Record<string, unknown>) => r.subcontractors).filter(Boolean)
  return NextResponse.json(subs)
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const { ids } = await req.json() as { ids: string[] }

  await supabase.from("project_subcontractors").delete().eq("project_id", id)

  if (ids?.length) {
    const rows = ids.map(subcontractor_id => ({ project_id: id, subcontractor_id }))
    const { error } = await supabase.from("project_subcontractors").insert(rows)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
