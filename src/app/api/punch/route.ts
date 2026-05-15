import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const pid = req.nextUrl.searchParams.get("project_id")
  let q = supabase.from("punch_items").select("*").order("created_at", { ascending: false })
  if (pid) q = q.eq("project_id", pid)

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ items: data ?? [] })
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
      fileBytes = await f.arrayBuffer()
      fileType = f.type || "application/octet-stream"
      origFileName = f.name
    }
  } else {
    fields = await req.json()
  }

  const { description, location, assigned_to, due_date, priority, project_id, notes } = fields
  if (!description?.trim()) return NextResponse.json({ error: "description is required" }, { status: 400 })

  const { count } = await supabase.from("punch_items").select("*", { count: "exact", head: true })
  const item_number = `P-${String((count ?? 0) + 1).padStart(3, "0")}`

  let file_path: string | null = null
  let file_name: string | null = null
  if (fileBytes && origFileName) {
    const safeName = origFileName.replace(/[^a-zA-Z0-9._-]/g, "_")
    file_path = `punch/${Date.now()}_${safeName}`
    file_name = origFileName
    await supabase.storage.from("submittals").upload(file_path, fileBytes, { contentType: fileType, upsert: false })
  }

  const { error } = await supabase.from("punch_items").insert({
    item_number,
    description: description.trim(),
    location: location?.trim() || null,
    assigned_to: assigned_to?.trim() || null,
    due_date: due_date || null,
    priority: priority || "Medium",
    status: "Open",
    notes: notes?.trim() || null,
    project_id: project_id || null,
    file_path,
    file_name,
    uploaded_by: user.id,
  })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, item_number })
}
