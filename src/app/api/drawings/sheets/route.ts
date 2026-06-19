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

  // The sheet's MARKUP REVISIONS (fork A, numbered): markups ride ALONGSIDE the
  // sheet — they never become current_revision_id — and a sheet can now have MANY
  // (Markup 1, Markup 2, …). Surface the full list per sheet, created_at ASC so
  // they read in numbered order. RLS-scoped (same company only).
  const markupsBySheet = new Map<string, Array<{ id: string; markup_doc: unknown; storage_path: string | null; revision_label: string | null; created_at: string }>>()
  const sheetIds = rows.map(s => s.id)
  if (sheetIds.length > 0) {
    const { data: mks } = await supabase
      .from("drawing_revisions")
      .select("id, sheet_id, markup_doc, storage_path, revision_label, created_at")
      .eq("source", "markup")
      .in("sheet_id", sheetIds)
      .order("created_at", { ascending: true })
    for (const m of mks ?? []) {
      const arr = markupsBySheet.get(m.sheet_id) ?? []
      arr.push({ id: m.id, markup_doc: m.markup_doc ?? null, storage_path: m.storage_path ?? null, revision_label: m.revision_label ?? null, created_at: m.created_at })
      markupsBySheet.set(m.sheet_id, arr)
    }
  }

  // Sign the current-revision files AND every markup's base (each markup row
  // references the base upload it was drawn over via storage_path). Surfacing the
  // base lets the viewer flatten/edit over the ACTUAL base the markup was drawn
  // on, never over a newer `current`. Deduped — a base often == current.
  const toSign = [...new Set([
    ...[...revById.values()].map(r => r.storage_path),
    ...[...markupsBySheet.values()].flat().map(m => m.storage_path),
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
      // current = the clean upload (fork A). Markups ride alongside as their own
      // numbered revisions (never current_revision_id); surfaced as a list so the
      // viewer can open/edit any one of them. Empty array for plain sheets.
      revision_id: s.current_revision_id ?? null,
      markups: (markupsBySheet.get(s.id) ?? []).map(m => ({
        id: m.id,
        revision_label: m.revision_label,
        markup_doc: m.markup_doc,
        // Signed URL of the base this markup was drawn over. VIEW flattens onto
        // THIS and EDIT re-bases onto THIS — never a newer `current`.
        markup_base_url: m.storage_path ? (urlByPath.get(m.storage_path) ?? null) : null,
        created_at: m.created_at,
      })),
      file_url: rev?.storage_path ? (urlByPath.get(rev.storage_path) ?? null) : null,
      created_at: s.created_at,
      deleted_at: s.deleted_at,
      days_remaining: daysRemaining,
    }
  })

  return NextResponse.json({ sheets: out })
}
