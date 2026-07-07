import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// GET one RFQ + its recipients, enriched with vendor / contact display fields.
// Recipients are stitched to vendors + vendor_people with separate RLS-scoped
// queries (no PostgREST embedding) so this doesn't depend on FK metadata.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params

  const { data: rfq, error } = await supabase.from("rfqs").select("*").eq("id", id).maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!rfq) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const { data: recips } = await supabase
    .from("rfq_recipients")
    .select("*")
    .eq("rfq_id", id)
    .order("created_at", { ascending: true })

  const rows = recips ?? []
  const vendorIds = [...new Set(rows.map(r => r.vendor_id).filter(Boolean))]
  const personIds = [...new Set(rows.map(r => r.vendor_person_id).filter(Boolean))]

  const vendorMap = new Map<string, { company_name: string | null; email: string | null }>()
  if (vendorIds.length) {
    const { data: vendors } = await supabase
      .from("vendors").select("id, company_name, email").in("id", vendorIds)
    for (const v of vendors ?? []) vendorMap.set(v.id, { company_name: v.company_name, email: v.email })
  }
  const personMap = new Map<string, { name: string | null; email: string | null }>()
  if (personIds.length) {
    const { data: people } = await supabase
      .from("vendor_people").select("id, name, email").in("id", personIds)
    for (const p of people ?? []) personMap.set(p.id, { name: p.name, email: p.email })
  }

  const recipients = rows.map(r => ({
    ...r,
    vendor_company_name: vendorMap.get(r.vendor_id)?.company_name ?? null,
    vendor_email:        vendorMap.get(r.vendor_id)?.email ?? null,
    person_name:         r.vendor_person_id ? personMap.get(r.vendor_person_id)?.name ?? null : null,
    person_email:        r.vendor_person_id ? personMap.get(r.vendor_person_id)?.email ?? null : null,
  }))

  return NextResponse.json({ rfq, recipients })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const updates = await req.json().catch(() => ({}))

  const allowed = ["name", "scope_description", "division_code", "due_date", "status", "package_pdf_path"]
  const safe: Record<string, unknown> = Object.fromEntries(
    Object.entries(updates).filter(([k]) => allowed.includes(k))
  )

  if (Object.keys(safe).length === 0) return NextResponse.json({ error: "No valid fields" }, { status: 400 })

  const { error } = await supabase.from("rfqs").update(safe).eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const { data: row, error: selErr } = await supabase
    .from("rfqs").select("id").eq("id", id).maybeSingle()
  if (selErr) return NextResponse.json({ error: "Database error" }, { status: 500 })
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })

  // rfq_recipients cascade via FK ON DELETE CASCADE (migration 0030).
  const { error } = await supabase.from("rfqs").delete().eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
