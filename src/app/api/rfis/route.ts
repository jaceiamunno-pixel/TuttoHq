import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { nextRfiNumber } from "@/lib/rfi-number"

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const pid = req.nextUrl.searchParams.get("project_id")
  // Soft-deleted RFIs (deleted_at set) are hidden from the log. Filter in-query,
  // never in the RLS SELECT policy (the 42501 UPDATE...RETURNING trap).
  let q = supabase.from("rfis").select("*").is("deleted_at", null).order("created_at", { ascending: false })
  if (pid) q = q.eq("project_id", pid)

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ rfis: data ?? [] })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  // The attachment (if any) was already PUT straight to storage from the
  // browser via a signed upload URL, so this route receives only JSON metadata.
  const fields: Record<string, string | null> = await req.json().catch(() => ({}))

  const { subject, description, question, received_from, submitted_by,
          specification_section, location, schedule_impact, cost_impact,
          assigned_to, date_issued, due_date, project_id } = fields

  if (!subject?.trim()) return NextResponse.json({ error: "subject is required" }, { status: 400 })

  const file_path = typeof fields.file_path === "string" ? fields.file_path.trim() || null : null
  const file_name = typeof fields.file_name === "string" ? fields.file_name.trim() || null : null

  // Shared row payload; rfi_number is assigned by the numbering scheme below.
  const baseRow = {
    subject:               subject.trim(),
    description:           (question ?? description)?.trim() || null,
    received_from:         received_from?.trim() || null,
    submitted_by:          (received_from ?? submitted_by)?.trim() || null,
    specification_section: specification_section?.trim() || null,
    location:              location?.trim() || null,
    schedule_impact:       schedule_impact || "TBD",
    cost_impact:           cost_impact || "TBD",
    assigned_to:           assigned_to?.trim() || null,
    date_issued:           date_issued || null,
    due_date:              due_date || null,
    project_id:            project_id || null,
    file_path,
    file_name,
    status:                "Open",
    uploaded_by:           user.id,
  }

  // Global (null-project) fallback: unchanged legacy count-based scheme. Left as
  // dead-in-practice — no partial unique index covers null project_id (Postgres
  // treats NULLs as distinct), and everything is project-scoped in practice.
  if (!project_id) {
    const { count } = await supabase.from("rfis").select("*", { count: "exact", head: true })
    const rfi_number = `RFI-${String((count ?? 0) + 1).padStart(3, "0")}`
    const { error } = await supabase.from("rfis").insert({ ...baseRow, rfi_number })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, rfi_number })
  }

  // Per-project: next = MAX(numeric tail of rfi_number) + 1 over ALL rows in the
  // project (including soft-deleted, so numbers are never recycled). The partial
  // unique index uq_rfis_project_number (live rows) is the arbiter; on a
  // concurrent collision (23505) re-derive from the now-committed MAX and retry,
  // bounded — mirrors save_pco (0002_pco_phase3.sql).
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { data: rows } = await supabase.from("rfis").select("rfi_number").eq("project_id", project_id)
    const { display: rfi_number } = nextRfiNumber((rows ?? []).map(r => r.rfi_number))
    const { error } = await supabase.from("rfis").insert({ ...baseRow, rfi_number })
    if (!error) return NextResponse.json({ ok: true, rfi_number })
    if (error.code === "23505" && attempt < 3) continue
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ error: "Could not assign an RFI number" }, { status: 500 })
}
