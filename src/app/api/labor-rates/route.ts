import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// Labor rate book — company-level config consumed by the PCO builder (Phase 2),
// which snapshots a rate into each line item at create time. RLS scopes every
// row to the caller's company; company_id is filled by the column DEFAULT
// get_my_company_id() on insert, so it is never trusted from the client.
//
// Reads are open to any authenticated company member (the PCO builder needs the
// active book to prefill labor rows). Writes are admin-only — this is the
// company's canonical pricing, edited alongside the logo (also admin-only).

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data, error } = await supabase
    .from("labor_rates")
    .select("id, role_name, reg_rate, ot_rate, dt_rate, sort_order, active, created_at, updated_at")
    .order("sort_order", { ascending: true, nullsFirst: false })
    .order("role_name", { ascending: true })

  if (error) {
    console.error("Failed to list labor rates:", error)
    return NextResponse.json({ error: "Failed to load labor rates" }, { status: 500 })
  }
  return NextResponse.json({ rates: data ?? [] })
}

// Shared rate validator. A rate may be null (unset) or a non-negative number;
// anything else is rejected rather than silently coerced.
export function parseRate(v: unknown): number | null | undefined {
  if (v === undefined) return undefined
  if (v === null || v === "") return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return undefined // caller treats undefined-after-present as invalid
  return n
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: role } = await supabase.rpc("get_my_role")
  if (role !== "admin") return NextResponse.json({ error: "Admin role required" }, { status: 403 })

  const body = await req.json().catch(() => null)
  const roleName = typeof body?.role_name === "string" ? body.role_name.trim() : ""
  if (!roleName) return NextResponse.json({ error: "role_name is required" }, { status: 400 })

  // Validate the three rate fields (each optional; null clears).
  const rates: Record<string, number | null> = {}
  for (const key of ["reg_rate", "ot_rate", "dt_rate"] as const) {
    if (body?.[key] === undefined) continue
    const parsed = parseRate(body[key])
    if (parsed === undefined && body[key] !== undefined && body[key] !== null && body[key] !== "") {
      return NextResponse.json({ error: `${key} must be a non-negative number` }, { status: 400 })
    }
    rates[key] = parsed ?? null
  }

  const sortOrder = Number.isFinite(Number(body?.sort_order)) ? Number(body.sort_order) : null
  const active = body?.active === undefined ? true : !!body.active

  const { data, error } = await supabase
    .from("labor_rates")
    .insert({ role_name: roleName, ...rates, sort_order: sortOrder, active })
    .select("id, role_name, reg_rate, ot_rate, dt_rate, sort_order, active, created_at, updated_at")
    .single()

  if (error) {
    console.error("Failed to create labor rate:", error)
    return NextResponse.json({ error: "Failed to create labor rate" }, { status: 500 })
  }
  return NextResponse.json({ rate: data }, { status: 201 })
}
