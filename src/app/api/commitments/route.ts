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

  let fields: Record<string, string | null> = {}
  let fileBytes: ArrayBuffer | null = null
  let fileType = ""
  let origFileName = ""

  const contentType = req.headers.get("content-type") ?? ""
  if (contentType.includes("multipart/form-data")) {
    const fd = await req.formData()
    for (const [k, v] of fd.entries()) {
      if (typeof v === "string") fields[k] = v || null
    }
    const f = fd.get("file") as File | null
    if (f && f.size > 0) {
      fileBytes    = await f.arrayBuffer()
      fileType     = f.type || "application/octet-stream"
      origFileName = f.name
    }
  } else {
    fields = await req.json()
  }

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

  // 1. Insert row (without file path) — get the id back
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
      uploaded_by:         user.id,
    })
    .select()
    .single()

  if (insertError || !row) {
    return NextResponse.json({ error: insertError?.message ?? "Insert failed" }, { status: 500 })
  }

  // 2. Upload the executed file (if any) and patch the row with the path
  if (fileBytes && origFileName) {
    const safeName = origFileName.replace(/[^a-zA-Z0-9._-]/g, "_")
    const filePath = `commitments/${row.id}/${Date.now()}_${safeName}`

    const { error: uploadError } = await supabase.storage
      .from("submittals")
      .upload(filePath, fileBytes, { contentType: fileType, upsert: false })

    if (uploadError) {
      await supabase.from("commitments").delete().eq("id", row.id)
      return NextResponse.json({ error: `File upload failed: ${uploadError.message}` }, { status: 500 })
    }

    const { error: updateError } = await supabase
      .from("commitments")
      .update({ executed_file_path: filePath, executed_file_name: origFileName })
      .eq("id", row.id)

    if (updateError) {
      return NextResponse.json({ error: `Failed to attach file: ${updateError.message}` }, { status: 500 })
    }

    row.executed_file_path = filePath
    row.executed_file_name = origFileName
  }

  return NextResponse.json({ commitment: row }, { status: 201 })
}
