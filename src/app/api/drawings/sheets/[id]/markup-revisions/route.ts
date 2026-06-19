import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"
import { createClient } from "@/lib/supabase/server"
import { deserializeMarkups, MARKUP_DOC_VERSION, type MarkupDoc } from "@/lib/drawing-markup"

// POST /api/drawings/sheets/[id]/markup-revisions — save an in-app markup as a
// NUMBERED markup revision (ADR-005 Part 2d, "original-is-sacred" model + history).
// CAREFUL-LANE.
//
// MODEL (fork A, numbered):
//  - Each save is EXPLICIT intent: mode:"new" INSERTs a brand-new numbered markup;
//    mode:"edit" UPDATEs one specific existing markup in place. We never infer
//    insert-vs-update from whether a markup already exists.
//  - BASE for a new markup = the sheet's CURRENT clean upload (current_revision_id,
//    requiring source<>'markup'); if current is somehow a markup or null we fall
//    back to the LATEST source<>'markup' revision (created_at DESC). This makes a
//    markup ride on top of whatever upload is current, and baseRevisionId is
//    recorded in the doc so it composites over the exact base it was drawn on.
//  - NUMBERING: markups have their own per-sheet counter, independent of the
//    upload Rev-N namespace. n = (count of existing source='markup' rows) + 1.
//    Label = `Markup ${n}`. Uploaded revisions keep their own Rev labels untouched.
//  - VECTOR-ONLY: the row stores the serialized MarkupDoc in markup_doc and
//    REFERENCES the base file (storage_path/file_sha256/file_size) — no storage
//    copy, no flattened file (flatten-on-render lives in the viewer/export).
//  - A markup revision NEVER becomes current_revision_id. The clean upload stays
//    current, so every surface outside the editor keeps rendering the real drawing.
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
  // Explicit intent. Anything other than "edit" is treated as "new".
  const mode: "new" | "edit" = body?.mode === "edit" ? "edit" : "new"
  const clientMarkupRevId: string | null = typeof body?.markup_revision_id === "string" ? body.markup_revision_id : null

  // Re-validate the vector payload server-side — never trust client jsonb
  // verbatim. Drops malformed entries; must yield at least one real markup.
  const markups = deserializeMarkups(doc)
  if (markups.length === 0) return NextResponse.json({ error: "no valid markups to save" }, { status: 400 })

  // Target sheet must be RLS-visible (same company) and live.
  const { data: sheet, error: selErr } = await supabase
    .from("drawing_sheets")
    .select("id, current_revision_id, deleted_at")
    .eq("id", sheetId)
    .maybeSingle()
  if (selErr) return NextResponse.json({ error: selErr.message }, { status: 500 })
  if (!sheet) return NextResponse.json({ error: "sheet not found" }, { status: 404 })
  if (sheet.deleted_at) return NextResponse.json({ error: "cannot mark up a deleted sheet" }, { status: 409 })

  // ── mode: "edit" — UPDATE one specific markup in place ─────────────────────
  // Requires a markup_revision_id that is a source='markup' row for THIS sheet
  // (RLS already scopes to the caller's company). Invalid/missing → 400; we never
  // silently fall back to insert. We keep the row's existing label (no renumber)
  // and its recorded base — only the vector doc changes.
  if (mode === "edit") {
    if (!clientMarkupRevId) return NextResponse.json({ error: "markup_revision_id required for edit" }, { status: 400 })
    const { data: existing, error: exErr } = await supabase
      .from("drawing_revisions")
      .select("id, revision_label, markup_doc")
      .eq("id", clientMarkupRevId).eq("sheet_id", sheetId).eq("source", "markup")
      .maybeSingle()
    if (exErr) return NextResponse.json({ error: exErr.message }, { status: 500 })
    if (!existing) return NextResponse.json({ error: "markup_revision_id is not a markup for this sheet" }, { status: 400 })

    // Preserve the base this markup was drawn over (from its stored doc) — editing
    // vectors must not re-base it onto a newer current upload.
    const prior = (existing.markup_doc ?? null) as Partial<MarkupDoc> | null
    const storedDoc: MarkupDoc = {
      version: MARKUP_DOC_VERSION,
      baseRevisionId: prior?.baseRevisionId ?? null,
      baseLabel: prior?.baseLabel ?? null,
      markups,
    }
    const { error: updErr } = await supabase
      .from("drawing_revisions")
      .update({ markup_doc: storedDoc })   // label + file refs untouched (no renumber, same base)
      .eq("id", existing.id)
    if (updErr) return NextResponse.json({ error: `markup update failed: ${updErr.message}` }, { status: 500 })
    return NextResponse.json({ ok: true, mode: "update", sheet_id: sheetId, markup_revision_id: existing.id, revision_label: existing.revision_label })
  }

  // ── mode: "new" — INSERT a fresh numbered markup ───────────────────────────
  // BASE = the sheet's current clean upload, else the latest non-markup revision.
  let base: { id: string; storage_path: string | null; file_sha256: string | null; file_size: number | null; revision_label: string | null } | null = null
  if (sheet.current_revision_id) {
    const { data: cur } = await supabase
      .from("drawing_revisions")
      .select("id, storage_path, file_sha256, file_size, revision_label, source")
      .eq("id", sheet.current_revision_id).eq("sheet_id", sheetId)
      .maybeSingle()
    if (cur && cur.source !== "markup") base = cur
  }
  if (!base) {
    // Fallback: current is null or (defensively) points at a markup — use the
    // newest uploaded revision instead.
    const { data: latest, error: baseErr } = await supabase
      .from("drawing_revisions")
      .select("id, storage_path, file_sha256, file_size, revision_label")
      .eq("sheet_id", sheetId)
      .neq("source", "markup")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (baseErr) return NextResponse.json({ error: baseErr.message }, { status: 500 })
    base = latest
  }
  if (!base) return NextResponse.json({ error: "sheet has no uploaded (non-markup) revision to mark up" }, { status: 409 })

  // NUMBERING: a MONOTONIC high-water mark so a number is NEVER reused — even
  // after a markup is soft-deleted (and maybe later restored). n = (max N across
  // every "Markup N" label on this sheet, INCLUDING soft-deleted markup rows) + 1.
  // The authed client can't SELECT soft-deleted rows (RLS filters deleted_at IS
  // NULL), so we union the live markup labels with the deleted ones from
  // list_deleted_drawing_revisions() — the SAME company+sheet-scoped SECURITY
  // DEFINER fn the revisions recycle-bin already uses (no new DB object, no
  // tenant change). Uploads ("Rev 0", …) are ignored by the regex.
  const markupLabels: (string | null)[] = []
  const { data: liveMarkups, error: liveErr } = await supabase
    .from("drawing_revisions")
    .select("revision_label")
    .eq("sheet_id", sheetId).eq("source", "markup")
  if (liveErr) return NextResponse.json({ error: liveErr.message }, { status: 500 })
  for (const r of liveMarkups ?? []) markupLabels.push(r.revision_label)
  const { data: deletedRevs, error: delErr } = await supabase
    .rpc("list_deleted_drawing_revisions", { p_sheet_id: sheetId })
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 })
  for (const r of (deletedRevs ?? []) as { revision_label: string | null }[]) markupLabels.push(r.revision_label)
  let maxN = 0
  for (const lbl of markupLabels) {
    const mt = /^Markup (\d+)$/.exec(lbl ?? "")
    if (mt) { const v = parseInt(mt[1], 10); if (v > maxN) maxN = v }
  }
  const n = maxN + 1
  const label = `Markup ${n}`

  // Server-authoritative doc: provenance points at the base this markup rode on.
  const storedDoc: MarkupDoc = {
    version: MARKUP_DOC_VERSION,
    baseRevisionId: base.id,
    baseLabel: base.revision_label,
    markups,
  }
  // The markup REFERENCES the base file (vector-only — no copy, no flatten).
  const fileRefs = {
    storage_path: base.storage_path,
    file_sha256: base.file_sha256,
    file_size: base.file_size,
  }

  // INSERT a new markup row. company_id omitted → DEFAULT get_my_company_id();
  // RLS WITH CHECK enforces the tenant. current_revision_id is NOT flipped — the
  // clean upload stays current (fork A).
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
