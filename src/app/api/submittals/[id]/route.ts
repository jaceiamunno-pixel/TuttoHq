import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const updates = await req.json()

  const allowed = [
    "review_status", "csi_division", "division_name", "csi_section", "section_name",
    "project_id", "transmittal_sent_at", "transmittal_recipient",
    // Submittal-log tracker columns
    "received_date", "sent_to_ae_date", "returned_from_ae_date", "returned_to_sub_date",
    "vendor_subcontractor_id", "vendor_supplier_id",
    // Inline title edit. file_name updates implicitly lock the row so the
    // normalizer / spec-book re-parse never overwrites a human's choice.
    "file_name",
  ]
  const safe = Object.fromEntries(Object.entries(updates).filter(([k]) => allowed.includes(k)))

  // Auto-flag when a user manually changes the CSI classification
  if ("csi_division" in safe || "csi_section" in safe) {
    safe.manually_overridden = true
    safe.overridden_by = user.id
  }

  // Inline title edits are sticky: server-side guarantee that title_locked is
  // set whenever file_name comes through this route. Trimmed; empty rejects.
  if ("file_name" in safe) {
    const v = typeof safe.file_name === "string" ? safe.file_name.trim() : ""
    if (v.length === 0) {
      return NextResponse.json({ error: "file_name cannot be empty" }, { status: 400 })
    }
    safe.file_name = v
    safe.title_locked = true
  }

  // Assign a per-project submittal number when a submittal is attached to (or
  // moved between) projects. Library uploads start with project_id = null and
  // no number until they land in a project.
  if (typeof safe.project_id === "string" && safe.project_id) {
    const { data: existing } = await supabase
      .from("submittals")
      .select("submittal_seq, project_id")
      .eq("id", id)
      .single()
    const needsNumber =
      !!existing && (existing.submittal_seq == null || existing.project_id !== safe.project_id)
    if (needsNumber) {
      const { data: seqBase } = await supabase
        .rpc("next_submittal_seq", { p_project_id: safe.project_id, p_count: 1 })
      if (typeof seqBase === "number") safe.submittal_seq = seqBase + 1
    }
  }

  const { error } = await supabase.from("submittals").update(safe).eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params

  const { data: row, error: selErr } = await supabase
    .from("submittals").select("id").eq("id", id).maybeSingle()
  if (selErr) return NextResponse.json({ error: "Database error" }, { status: 500 })
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const { error } = await supabase
    .from("submittals")
    .update({ status: "deleted" })
    .eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
