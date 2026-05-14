import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const { data, error } = await supabase
    .from("project_cms")
    .select("cm_id, construction_managers(id, company_name, contact_name, phone, email, address)")
    .eq("project_id", id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const cms = (data ?? []).map((r: Record<string, unknown>) => r.construction_managers).filter(Boolean)
  return NextResponse.json(cms)
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const { ids } = await req.json() as { ids: string[] }

  await supabase.from("project_cms").delete().eq("project_id", id)

  if (ids?.length) {
    const rows = ids.map(cm_id => ({ project_id: id, cm_id }))
    const { error } = await supabase.from("project_cms").insert(rows)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
