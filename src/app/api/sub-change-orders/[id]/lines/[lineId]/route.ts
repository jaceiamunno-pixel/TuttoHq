import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { forbidFieldRole } from "@/lib/field-access"
import { parseMoney } from "@/lib/sub-co-shared"

// One line row. Every query pins BOTH ids so a line can never be addressed
// through a different parent. Hard delete is intentional (draft content).

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; lineId: string }> },
) {
  const { id, lineId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const fieldDenied = await forbidFieldRole(supabase)
  if (fieldDenied) return fieldDenied

  const updates = await req.json().catch(() => null)
  if (!updates || typeof updates !== "object") {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const allowed = ["owner_co_number", "gc_co_number", "description", "cost_code", "price", "sort_order"]
  const safe: Record<string, unknown> = Object.fromEntries(
    Object.entries(updates).filter(([k]) => allowed.includes(k)),
  )
  if (Object.keys(safe).length === 0) {
    return NextResponse.json({ error: "No editable fields in body" }, { status: 400 })
  }

  if ("description" in safe) {
    const trimmed = typeof safe.description === "string" ? safe.description.trim() : ""
    if (!trimmed) return NextResponse.json({ error: "description cannot be empty" }, { status: 400 })
    safe.description = trimmed
  }
  if ("price" in safe) {
    const parsed = parseMoney(safe.price)
    if (parsed.invalid) return NextResponse.json({ error: "price is not a valid amount" }, { status: 400 })
    safe.price = parsed.value ?? 0
  }
  if ("sort_order" in safe && !Number.isInteger(safe.sort_order)) {
    return NextResponse.json({ error: "sort_order must be an integer" }, { status: 400 })
  }

  const { data: row } = await supabase
    .from("sub_change_order_lines")
    .select("id")
    .eq("id", lineId)
    .eq("sub_change_order_id", id)
    .maybeSingle()
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const { error } = await supabase
    .from("sub_change_order_lines")
    .update(safe)
    .eq("id", lineId)
    .eq("sub_change_order_id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; lineId: string }> },
) {
  const { id, lineId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const fieldDenied = await forbidFieldRole(supabase)
  if (fieldDenied) return fieldDenied

  const { data: row } = await supabase
    .from("sub_change_order_lines")
    .select("id")
    .eq("id", lineId)
    .eq("sub_change_order_id", id)
    .maybeSingle()
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const { error } = await supabase
    .from("sub_change_order_lines")
    .delete()
    .eq("id", lineId)
    .eq("sub_change_order_id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
