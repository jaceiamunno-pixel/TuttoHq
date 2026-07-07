import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// Update / remove one recipient row. Both operations scope by (id = rid AND
// rfq_id = the route's rfq id); RLS additionally scopes to the caller's company,
// so a recipient can only ever be mutated by its owning tenant.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string; rid: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id: rfqId, rid } = await params
  const updates = await req.json().catch(() => ({}))

  const allowed = ["state", "quoted_amount", "quote_file_path", "vendor_person_id", "linked_estimate_line_id"]
  const safe: Record<string, unknown> = Object.fromEntries(
    Object.entries(updates).filter(([k]) => allowed.includes(k))
  )

  // Coerce a typed amount; empty string clears it.
  if ("quoted_amount" in safe) {
    const n = Number(safe.quoted_amount)
    safe.quoted_amount = safe.quoted_amount === "" || safe.quoted_amount == null || Number.isNaN(n) ? null : n
  }
  // Attaching a quote file advances the state unless the caller set one explicitly.
  if (typeof safe.quote_file_path === "string" && safe.quote_file_path && safe.state === undefined) {
    safe.state = "quote_received"
  }

  if (Object.keys(safe).length === 0) return NextResponse.json({ error: "No valid fields" }, { status: 400 })

  const { data: row } = await supabase
    .from("rfq_recipients").select("id").eq("id", rid).eq("rfq_id", rfqId).maybeSingle()
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const { error } = await supabase.from("rfq_recipients").update(safe).eq("id", rid).eq("rfq_id", rfqId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; rid: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id: rfqId, rid } = await params
  const { data: row } = await supabase
    .from("rfq_recipients").select("id").eq("id", rid).eq("rfq_id", rfqId).maybeSingle()
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const { error } = await supabase.from("rfq_recipients").delete().eq("id", rid).eq("rfq_id", rfqId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
