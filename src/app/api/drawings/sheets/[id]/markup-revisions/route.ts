import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"
import { createClient } from "@/lib/supabase/server"
import { deserializeMarkups, MARKUP_DOC_VERSION, type MarkupDoc } from "@/lib/drawing-markup"

// POST /api/drawings/sheets/[id]/markup-revisions — save the sheet's in-app
// markup layer (ADR-005 Part 2a, "original-is-sacred" model). CAREFUL-LANE.
//
// MODEL (fork A):
//  - A markup is ALWAYS based off the sheet's CLEAN ORIGINAL revision (the
//    earliest source <> 'markup' revision) — never off current_revision_id and
//    never off another markup. This is what kills the compounding bug.
//  - VECTOR-ONLY: the row stores the serialized MarkupDoc in markup_doc and
//    REFERENCES the original's file (storage_path/file_sha256/file_size) — no
//    storage copy, no flattened file (flatten-on-render is Part 2b).
//  - ONE markup layer per sheet (v1): if the sheet already has a markup revision
//    we UPDATE it in place; otherwise we INSERT one. Either way the label is
//    "{original} · markup" — it can never compound.
//  - The markup revision does NOT become current_revision_id. The clean original
//    stays current, so every surface outside the editor keeps rendering the real
//    drawing.
//
// Tenant scoping mirrors a normal revision exactly: company_id is never client-
// supplied (rides the DEFAULT get_my_company_id(), enforced by the RLS WITH
// CHECK); authed RLS-scoped client throughout (never service-role).

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id: sheetId } = await params
  if (!sheetId) return NextResponse.json({ error: "id required" }, { status: 400 })

  const body = await req.json().catch(() => null)
  const doc: unknown = body?.markup_doc
  if (!doc || typeof doc !== "object") return NextResponse.json({ error: "markup_doc required" }, { status: 400 })
  const clientMarkupRevId: string | null = typeof body?.markup_revision_id === "string" ? body.markup_revision_id : null

  // Re-validate the vector payload server-side — never trust client jsonb
  // verbatim. Drops malformed entries; must yield at least one real markup.
  const markups = deserializeMarkups(doc)
  if (markups.length === 0) return NextResponse.json({ error: "no valid markups to save" }, { status: 400 })

  // Target sheet must be RLS-visible (same company) and live.
  const { data: sheet, error: selErr } = await supabase
    .from("drawing_sheets")
    .select("id, deleted_at")
    .eq("id", sheetId)
    .maybeSingle()
  if (selErr) return NextResponse.json({ error: selErr.message }, { status: 500 })
  if (!sheet) return NextResponse.json({ error: "sheet not found" }, { status: 404 })
  if (sheet.deleted_at) return NextResponse.json({ error: "cannot mark up a deleted sheet" }, { status: 409 })

  // BASE = the sheet's clean original: the EARLIEST non-markup revision. Never a
  // markup, so the base + label can never compound. RLS-scoped (same company).
  const { data: original, error: baseErr } = await supabase
    .from("drawing_revisions")
    .select("id, storage_path, file_sha256, file_size, revision_label, created_at")
    .eq("sheet_id", sheetId)
    .neq("source", "markup")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle()
  if (baseErr) return NextResponse.json({ error: baseErr.message }, { status: 500 })
  if (!original) return NextResponse.json({ error: "sheet has no original (non-markup) revision to mark up" }, { status: 409 })

  // Server-authoritative doc: provenance always points at the clean original.
  const storedDoc: MarkupDoc = {
    version: MARKUP_DOC_VERSION,
    baseRevisionId: original.id,
    baseLabel: original.revision_label,
    markups,
  }
  const label = `${original.revision_label ?? "Rev"} · markup`
  // The layer REFERENCES the original's file (vector-only — no copy, no flatten).
  const fileRefs = {
    storage_path: original.storage_path,
    file_sha256: original.file_sha256,
    file_size: original.file_size,
  }

  // SINGLE LAYER: target the existing markup revision if there is one — the
  // client's id if it's a valid markup rev for THIS sheet, else the sheet's
  // existing markup rev. Only when none exists do we INSERT. Server-enforced, so
  // a stale/missing client id can never stack a second layer.
  let targetId: string | null = null
  if (clientMarkupRevId) {
    const { data: m } = await supabase
      .from("drawing_revisions")
      .select("id")
      .eq("id", clientMarkupRevId).eq("sheet_id", sheetId).eq("source", "markup")
      .maybeSingle()
    targetId = m?.id ?? null
  }
  if (!targetId) {
    const { data: existing } = await supabase
      .from("drawing_revisions")
      .select("id")
      .eq("sheet_id", sheetId).eq("source", "markup")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle()
    targetId = existing?.id ?? null
  }

  if (targetId) {
    // UPDATE the existing layer in place — no new row, current_revision_id
    // untouched. RLS UPDATE policy enforces the tenant.
    const { error: updErr } = await supabase
      .from("drawing_revisions")
      .update({ markup_doc: storedDoc, revision_label: label, ...fileRefs })
      .eq("id", targetId)
    if (updErr) return NextResponse.json({ error: `markup update failed: ${updErr.message}` }, { status: 500 })
    return NextResponse.json({ ok: true, mode: "update", sheet_id: sheetId, markup_revision_id: targetId, revision_label: label })
  }

  // INSERT the sheet's first markup layer. company_id omitted → DEFAULT
  // get_my_company_id(); RLS WITH CHECK enforces the tenant. current_revision_id
  // is NOT flipped — the clean original stays current (fork A).
  const revisionId = randomUUID()
  const { data: revision, error: revErr } = await supabase
    .from("drawing_revisions")
    .insert({
      id: revisionId,
      sheet_id: sheetId,
      revision_label: label,
      ...fileRefs,
      source: "markup",
      uploaded_by: user.id,
      markup_doc: storedDoc,
    })
    .select("id")
    .single()
  if (revErr || !revision) {
    return NextResponse.json({ error: `markup insert failed: ${revErr?.message ?? "no row"}` }, { status: 500 })
  }
  return NextResponse.json({ ok: true, mode: "insert", sheet_id: sheetId, markup_revision_id: revisionId, revision_label: label })
}
