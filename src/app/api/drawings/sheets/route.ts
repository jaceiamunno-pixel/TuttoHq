import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// GET /api/drawings/sheets?project_id=… — Drawing Log v1 READ (ADR-005).
//
// Returns the committed drawing_sheets for a project, each joined to its
// CURRENT revision (file). This is the minimal read/display slice of
// Subsystem 2 — no edit, no history, no revision-matching here.
//
// Tenant scope: RLS on both tables restricts to the caller's company
// (company_id = get_my_company_id()); we additionally filter project_id.
// Two queries instead of a PostgREST embed because drawing_sheets and
// drawing_revisions have TWO FKs between them (revisions.sheet_id and
// sheets.current_revision_id), which makes an implicit embed ambiguous.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const pid = req.nextUrl.searchParams.get("project_id")
  if (!pid) return NextResponse.json({ sheets: [] })

  // ?deleted=true → the "Recently deleted" view: soft-deleted sheets still
  // inside the 5-day recovery window. Default → the live list (deleted_at NULL).
  const wantDeleted = req.nextUrl.searchParams.get("deleted") === "true"
  const RECOVERY_DAYS = 5
  const cutoffMs = Date.now() - RECOVERY_DAYS * 86400_000

  interface SheetRow {
    id: string; sheet_number: string | null; discipline: string | null
    discipline_prefix: string | null; title: string | null
    current_revision_id: string | null; created_at: string; deleted_at: string | null
    project_id?: string
  }
  let rows: SheetRow[]
  if (wantDeleted) {
    // The SELECT RLS policy filters deleted_at IS NULL, so the authed client
    // CANNOT read soft-deleted sheets directly — this view returned nothing after
    // that policy shipped (unnoticed only because no sheets were deleted yet).
    // list_deleted_drawing_sheets() is a SECURITY DEFINER fn, company-scoped
    // internally via get_my_company_id(), returning only this caller's deleted
    // sheets. Scope to this project + the 5-day recovery window (older rows are
    // already hard-purged by /api/cron/purge-drawings, so the cutoff mirrors that).
    const { data, error } = await supabase.rpc("list_deleted_drawing_sheets")
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    // Compare as epochs, not ISO strings: Postgres timestamptz (…+00:00, µs) and
    // JS toISOString (…Z, ms) don't sort lexicographically the same.
    rows = ((data ?? []) as SheetRow[])
      .filter(s => s.project_id === pid && !!s.deleted_at && new Date(s.deleted_at).getTime() >= cutoffMs)
    // fn already orders by deleted_at DESC
  } else {
    const { data, error } = await supabase
      .from("drawing_sheets")
      .select("id, sheet_number, discipline, discipline_prefix, title, current_revision_id, created_at, deleted_at")
      .eq("project_id", pid)
      .is("deleted_at", null)
      .order("sheet_number", { ascending: true })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    rows = (data ?? []) as SheetRow[]
  }
  const revIds = rows.map(s => s.current_revision_id).filter((v): v is string => !!v)

  const revById = new Map<string, { revision_label: string | null; storage_path: string | null }>()
  if (revIds.length > 0) {
    // RLS scopes this to the caller's company too — a sheet's current revision
    // (the clean original under fork A) only resolves if it's in the same tenant.
    const { data: revs } = await supabase
      .from("drawing_revisions")
      .select("id, revision_label, storage_path")
      .in("id", revIds)
    for (const r of revs ?? []) revById.set(r.id, { revision_label: r.revision_label, storage_path: r.storage_path })
  }

  // The sheet's MARKUP LAYER (fork A): markup revisions ride ALONGSIDE the sheet
  // — they never become current_revision_id — so surface them separately for the
  // editor to hydrate on reopen. One layer per sheet (v1): the earliest markup
  // revision. RLS-scoped (same company only).
  const markupBySheet = new Map<string, { id: string; markup_doc: unknown; storage_path: string | null }>()
  const sheetIds = rows.map(s => s.id)
  if (sheetIds.length > 0) {
    const { data: mks } = await supabase
      .from("drawing_revisions")
      .select("id, sheet_id, markup_doc, storage_path, created_at")
      .eq("source", "markup")
      .in("sheet_id", sheetIds)
      .order("created_at", { ascending: true })
    for (const m of mks ?? []) if (!markupBySheet.has(m.sheet_id)) markupBySheet.set(m.sheet_id, { id: m.id, markup_doc: m.markup_doc ?? null, storage_path: m.storage_path ?? null })
  }

  // Sign the current-revision files AND each markup layer's clean-original base
  // (fork A: a markup row references its base original's storage_path). Surfacing
  // the base lets the viewer flatten/edit over the ACTUAL base the markup was
  // drawn on, never over a newer `current`. Deduped — base often == current.
  const toSign = [...new Set([
    ...[...revById.values()].map(r => r.storage_path),
    ...[...markupBySheet.values()].map(m => m.storage_path),
  ].filter((p): p is string => !!p))]
  const urlByPath = new Map<string, string>()
  if (toSign.length > 0) {
    const signed = await Promise.all(
      toSign.map(p => supabase.storage.from("submittals").createSignedUrl(p, 3600)),
    )
    toSign.forEach((p, i) => { const u = signed[i].data?.signedUrl; if (u) urlByPath.set(p, u) })
  }

  const out = rows.map(s => {
    const rev = s.current_revision_id ? revById.get(s.current_revision_id) : undefined
    // Whole days left in the 5-day recovery window (only meaningful when deleted).
    const daysRemaining = s.deleted_at
      ? Math.max(0, Math.ceil((new Date(s.deleted_at).getTime() + RECOVERY_DAYS * 86400_000 - Date.now()) / 86400_000))
      : null
    return {
      id: s.id,
      sheet_number: s.sheet_number,
      discipline: s.discipline,
      discipline_prefix: s.discipline_prefix,
      title: s.title,
      revision_label: rev?.revision_label ?? null,
      // current = the clean original (fork A). The markup LAYER (its own revision
      // id + vector doc) is surfaced separately so the editor hydrates it on
      // reopen; both null when the sheet has no markup layer.
      revision_id: s.current_revision_id ?? null,
      markup_revision_id: markupBySheet.get(s.id)?.id ?? null,
      markup_doc: markupBySheet.get(s.id)?.markup_doc ?? null,
      // Signed URL of the clean original the markup was drawn over (its base).
      // VIEW flattens onto THIS and EDIT re-bases onto THIS — never a newer
      // `current`. null for plain sheets (no markup layer).
      markup_base_url: ((p) => p ? (urlByPath.get(p) ?? null) : null)(markupBySheet.get(s.id)?.storage_path),
      file_url: rev?.storage_path ? (urlByPath.get(rev.storage_path) ?? null) : null,
      created_at: s.created_at,
      deleted_at: s.deleted_at,
      days_remaining: daysRemaining,
    }
  })

  return NextResponse.json({ sheets: out })
}
