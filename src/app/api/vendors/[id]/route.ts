import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

const FULL_COLS =
  "id, vendor_no, company_name, is_subcontractor, is_supplier, trade, specialty, contact_name, phone, email, street_address, city, state, zip_code, license_number, website, notes, created_at"

const TEXT_FIELDS = [
  "vendor_no", "trade", "specialty", "contact_name", "phone", "email",
  "street_address", "city", "state", "zip_code", "license_number", "website", "notes",
] as const

function cleanText(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null
}

// PATCH /api/vendors/[id] — update one vendor. RLS scopes the row to the
// caller's company; company_id is never accepted from the client.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const body = await req.json().catch(() => ({}))

  const updates: Record<string, unknown> = {}
  if ("company_name" in body) {
    const name = cleanText(body.company_name)
    if (!name) return NextResponse.json({ error: "company_name cannot be empty" }, { status: 400 })
    updates.company_name = name
  }
  if ("is_subcontractor" in body) updates.is_subcontractor = body.is_subcontractor === true
  if ("is_supplier" in body) updates.is_supplier = body.is_supplier === true
  for (const f of TEXT_FIELDS) if (f in body) updates[f] = cleanText(body[f])

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 })
  }

  const { data, error } = await supabase
    .from("vendors")
    .update(updates)
    .eq("id", id)
    .select(FULL_COLS)
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: "Vendor not found" }, { status: 404 })
  return NextResponse.json({ vendor: data })
}

// DELETE /api/vendors/[id] — remove a vendor. RLS DELETE policy confines this to
// the caller's company. vendor_people rows cascade via the FK.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const { error } = await supabase.from("vendors").delete().eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
