import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const { data, error } = await supabase.from("commitments").select("*").eq("id", id).single()
  if (error) return NextResponse.json({ error: error.message }, { status: 404 })
  return NextResponse.json({ commitment: data })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const updates = await req.json()

  const allowed = [
    "status", "executed_at", "contract_value", "notes",
    "to_subcontractor_id", "to_supplier_id", "to_company_name",
  ]
  const safe: Record<string, unknown> = Object.fromEntries(
    Object.entries(updates).filter(([k]) => allowed.includes(k))
  )

  if ("contract_value" in safe) {
    const v = safe.contract_value
    if (v === null || v === "" || v === undefined) {
      safe.contract_value = null
    } else {
      const cleaned = String(v).replace(/[$,\s]/g, "")
      const n = Number(cleaned)
      if (!Number.isFinite(n) || n < 0) {
        return NextResponse.json({ error: "contract_value must be a non-negative number" }, { status: 400 })
      }
      safe.contract_value = n
    }
  }

  const { error } = await supabase.from("commitments").update(safe).eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params

  // Fetch the file path so we can clean up storage too
  const { data: row } = await supabase
    .from("commitments")
    .select("executed_file_path")
    .eq("id", id)
    .single()

  if (row?.executed_file_path) {
    await supabase.storage.from("submittals").remove([row.executed_file_path])
  }

  const { error } = await supabase.from("commitments").delete().eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
