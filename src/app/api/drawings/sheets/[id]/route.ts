import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// PATCH /api/drawings/sheets/[id] — Drawing Log v1 (ADR-005 Subsystem 2),
// METADATA-ONLY edit. Authed server client; RLS scopes every read/write to the
// caller's company (never a privileged/direct connection). The file/storage is
// NEVER editable here, and this never adds a revision (that is Subsystem 4).
//
// Editable: sheet_number, title, discipline, discipline_prefix (on the sheet)
// and revision_label (on the sheet's CURRENT revision row). company_id,
// project_id, storage_path, sha256, and ownership are immutable here.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 })
  }

  // RLS only returns the row if it belongs to the caller's company.
  const { data: sheet, error: selErr } = await supabase
    .from("drawing_sheets")
    .select("id, current_revision_id, deleted_at")
    .eq("id", id)
    .maybeSingle()
  if (selErr) return NextResponse.json({ error: selErr.message }, { status: 500 })
  if (!sheet) return NextResponse.json({ error: "sheet not found" }, { status: 404 })

  // Build the sheet-metadata patch from an explicit allow-list only.
  const patch: Record<string, string | null> = {}
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")
  // sheet_number may be blanked → NULL (commit-with-blanks parity): a "Needs
  // info" sheet must be partially fillable (e.g. save a title before the number
  // is known) without forcing a number. Not a matching key in this subsystem,
  // so a NULL here can't bypass any dedup/FLAG rule. search_vector is a STORED
  // generated column over (sheet_number, title, discipline) — it recomputes on
  // this UPDATE automatically; no app code needed to keep search current.
  if ("sheet_number" in body)      patch.sheet_number = str(body.sheet_number) || null
  if ("title" in body)             patch.title = str(body.title) || null
  if ("discipline" in body)        patch.discipline = str(body.discipline) || null
  if ("discipline_prefix" in body) patch.discipline_prefix = str(body.discipline_prefix) || null

  if (Object.keys(patch).length > 0) {
    const { error: upErr } = await supabase.from("drawing_sheets").update(patch).eq("id", id)
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 })
  }

  // revision_label lives on the CURRENT revision row (metadata, not a new
  // version). Update it there when provided.
  if ("revision_label" in body && sheet.current_revision_id) {
    const { error: revErr } = await supabase
      .from("drawing_revisions")
      .update({ revision_label: str(body.revision_label) || null })
      .eq("id", sheet.current_revision_id)
    if (revErr) return NextResponse.json({ error: revErr.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, id })
}

// DELETE /api/drawings/sheets/[id] — SOFT delete (ADR-005 Subsystem 2). Sets
// drawing_sheets.deleted_at = now() via the authed RLS-scoped client. Does NOT
// remove the row or any storage file — the sheet drops out of the live list
// (which filters deleted_at IS NULL) and into "Recently deleted" for 5 days,
// after which the scheduled purge hard-deletes it. RLS guarantees a caller can
// only soft-delete sheets in their own company.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })

  // .select() returns the affected row only if RLS lets the caller see it, so
  // an empty result = not found / cross-tenant → 404 (no privileged escalation).
  const { data, error } = await supabase
    .from("drawing_sheets")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .is("deleted_at", null)            // idempotent: don't re-stamp an already-deleted row
    .select("id")
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data || data.length === 0) {
    return NextResponse.json({ error: "sheet not found or already deleted" }, { status: 404 })
  }
  return NextResponse.json({ ok: true, id })
}
