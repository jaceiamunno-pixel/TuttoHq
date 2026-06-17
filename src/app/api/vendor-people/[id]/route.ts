import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

const COLS = "id, vendor_id, name, email, phone, role"

function cleanText(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null
}

// PATCH /api/vendor-people/[id] — edit a person. RLS scopes the row to the
// caller's company; vendor_id and company_id are never reassigned here.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const body = await req.json().catch(() => ({}))

  const updates: Record<string, unknown> = {}
  if ("name" in body) {
    const name = cleanText(body.name)
    if (!name) return NextResponse.json({ error: "name cannot be empty" }, { status: 400 })
    updates.name = name
  }
  for (const f of ["email", "phone", "role"] as const) if (f in body) updates[f] = cleanText(body[f])

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 })
  }

  const { data, error } = await supabase
    .from("vendor_people")
    .update(updates)
    .eq("id", id)
    .select(COLS)
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: "Person not found" }, { status: 404 })
  return NextResponse.json({ person: data })
}

// DELETE /api/vendor-people/[id]
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const { error } = await supabase.from("vendor_people").delete().eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
