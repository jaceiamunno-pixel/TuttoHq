import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const pid = req.nextUrl.searchParams.get("project_id")
  let q = supabase.from("commitments").select("*").order("executed_at", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false })
  if (pid) q = q.eq("project_id", pid)

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ commitments: data ?? [] })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  // The executed-contract file (if any) was already PUT straight to storage from
  // the browser via a signed upload URL, so this route receives only JSON.
  const fields: Record<string, string | null> = await req.json().catch(() => ({}))
  const filePath = typeof fields.file_path === "string" ? fields.file_path.trim() || null : null
  const fileName = typeof fields.file_name === "string" ? fields.file_name.trim() || null : null

  const {
    project_id,
    type,
    to_subcontractor_id,
    to_supplier_id,
    to_company_name,
    executed_at,
    contract_value,
    notes,
  } = fields

  if (!project_id) return NextResponse.json({ error: "project_id is required" }, { status: 400 })
  if (type !== "subcontract" && type !== "purchase_order") {
    return NextResponse.json({ error: "type must be 'subcontract' or 'purchase_order'" }, { status: 400 })
  }
  if (type === "subcontract" && !to_subcontractor_id) {
    return NextResponse.json({ error: "to_subcontractor_id is required for subcontract" }, { status: 400 })
  }
  if (type === "purchase_order" && !to_supplier_id) {
    return NextResponse.json({ error: "to_supplier_id is required for purchase_order" }, { status: 400 })
  }
  if (!to_company_name?.trim()) {
    return NextResponse.json({ error: "to_company_name is required" }, { status: 400 })
  }

  let parsedValue: number | null = null
  if (contract_value && contract_value.trim() !== "") {
    const cleaned = contract_value.replace(/[$,\s]/g, "")
    const n = Number(cleaned)
    if (!Number.isFinite(n) || n < 0) {
      return NextResponse.json({ error: "contract_value must be a non-negative number" }, { status: 400 })
    }
    parsedValue = n
  }

  const { data: row, error: insertError } = await supabase
    .from("commitments")
    .insert({
      project_id,
      type,
      to_subcontractor_id: type === "subcontract"    ? to_subcontractor_id : null,
      to_supplier_id:      type === "purchase_order" ? to_supplier_id      : null,
      to_company_name:     to_company_name.trim(),
      status:              "executed",
      executed_at:         executed_at || null,
      contract_value:      parsedValue,
      notes:               notes?.trim() || null,
      executed_file_path:  filePath,
      executed_file_name:  fileName,
      uploaded_by:         user.id,
    })
    .select()
    .single()

  if (insertError || !row) {
    return NextResponse.json({ error: insertError?.message ?? "Insert failed" }, { status: 500 })
  }

  return NextResponse.json({ commitment: row }, { status: 201 })
}
