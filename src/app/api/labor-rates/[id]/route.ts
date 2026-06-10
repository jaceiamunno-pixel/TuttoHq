import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { parseRate } from "@/lib/labor-rates"

// PATCH / DELETE a single labor rate. Admin-only (writes to the company rate
// book). RLS scopes the row to the caller's company, so a cross-tenant id is a
// silent no-op rather than a leak.

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: role } = await supabase.rpc("get_my_role")
  if (role !== "admin") return NextResponse.json({ error: "Admin role required" }, { status: 403 })

  const { id } = await params
  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: "Invalid request body" }, { status: 400 })

  const updates: Record<string, string | number | boolean | null> = {}

  if (body.role_name !== undefined) {
    if (typeof body.role_name !== "string" || !body.role_name.trim()) {
      return NextResponse.json({ error: "role_name cannot be empty" }, { status: 400 })
    }
    updates.role_name = body.role_name.trim()
  }

  for (const key of ["reg_rate", "ot_rate", "dt_rate"] as const) {
    if (body[key] === undefined) continue
    const parsed = parseRate(body[key])
    if (parsed === undefined) {
      return NextResponse.json({ error: `${key} must be a non-negative number` }, { status: 400 })
    }
    updates[key] = parsed
  }

  if (body.sort_order !== undefined) {
    updates.sort_order = Number.isFinite(Number(body.sort_order)) ? Number(body.sort_order) : null
  }
  if (body.active !== undefined) updates.active = !!body.active

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 })
  }
  updates.updated_at = new Date().toISOString()

  const { data, error } = await supabase
    .from("labor_rates")
    .update(updates)
    .eq("id", id)
    .select("id, role_name, reg_rate, ot_rate, dt_rate, sort_order, active, created_at, updated_at")
    .single()

  if (error) {
    console.error("Failed to update labor rate:", error)
    return NextResponse.json({ error: "Failed to update labor rate" }, { status: 500 })
  }
  return NextResponse.json({ rate: data })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: role } = await supabase.rpc("get_my_role")
  if (role !== "admin") return NextResponse.json({ error: "Admin role required" }, { status: 403 })

  const { id } = await params
  const { error } = await supabase.from("labor_rates").delete().eq("id", id)
  if (error) {
    console.error("Failed to delete labor rate:", error)
    return NextResponse.json({ error: "Failed to delete labor rate" }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
