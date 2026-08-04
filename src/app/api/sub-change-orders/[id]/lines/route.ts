import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { forbidFieldRole } from "@/lib/field-access"
import { parseMoney } from "@/lib/sub-co-shared"

// Line grid under one sub change order. Lines are draft content beneath a
// soft-deletable parent — they hard-delete; the generated PDF is the frozen
// evidence of what was authorized.

async function loadParent(
  supabase: Awaited<ReturnType<typeof createClient>>,
  id: string,
): Promise<{ id: string } | null> {
  const { data } = await supabase
    .from("sub_change_orders")
    .select("id")
    .eq("id", id)
    .neq("status", "deleted")
    .maybeSingle()
  return data
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  if (!(await loadParent(supabase, id))) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const { data, error } = await supabase
    .from("sub_change_order_lines")
    .select("*")
    .eq("sub_change_order_id", id)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ lines: data ?? [] })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const fieldDenied = await forbidFieldRole(supabase)
  if (fieldDenied) return fieldDenied

  if (!(await loadParent(supabase, id))) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })

  const description = typeof body.description === "string" ? body.description.trim() : ""
  if (!description) return NextResponse.json({ error: "description is required" }, { status: 400 })

  const parsedPrice = parseMoney(body.price)
  if (parsedPrice.invalid) return NextResponse.json({ error: "price is not a valid amount" }, { status: 400 })

  let sort_order = Number.isInteger(body.sort_order) ? (body.sort_order as number) : null
  if (sort_order == null) {
    const { data: last } = await supabase
      .from("sub_change_order_lines")
      .select("sort_order")
      .eq("sub_change_order_id", id)
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle()
    sort_order = (last?.sort_order ?? -1) + 1
  }

  const { data: line, error } = await supabase
    .from("sub_change_order_lines")
    .insert({
      sub_change_order_id: id,
      owner_co_number: typeof body.owner_co_number === "string" ? body.owner_co_number.trim() || null : null,
      gc_co_number: typeof body.gc_co_number === "string" ? body.gc_co_number.trim() || null : null,
      description,
      cost_code: typeof body.cost_code === "string" ? body.cost_code.trim() || null : null,
      price: parsedPrice.value ?? 0,
      sort_order,
    })
    .select("*")
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, line })
}
