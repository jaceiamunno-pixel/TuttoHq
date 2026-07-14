import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const updates = await req.json()

  const allowed = [
    "status", "response", "assigned_to", "due_date", "subject", "description",
    "received_from", "specification_section", "location",
    "schedule_impact", "cost_impact", "generated_pdf_path",
  ]
  const safe: Record<string, unknown> = Object.fromEntries(
    Object.entries(updates).filter(([k]) => allowed.includes(k))
  )
  safe.updated_at = new Date().toISOString()

  // Guard against editing a soft-deleted RFI (deleted rows aren't surfaced in the UI).
  const { error } = await supabase.from("rfis").update(safe).eq("id", id).is("deleted_at", null)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  // Soft-delete: set deleted_at on a still-live row. A re-delete matches zero
  // rows → clean 404. (SELECT policy is company_id-only, so this UPDATE ...
  // RETURNING is safe — no 42501.)
  const { data, error } = await supabase.from("rfis")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id).is("deleted_at", null)
    .select("id")
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data || data.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 })
  return NextResponse.json({ ok: true })
}
