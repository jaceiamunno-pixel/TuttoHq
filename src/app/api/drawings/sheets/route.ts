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
  const cutoffIso = new Date(Date.now() - RECOVERY_DAYS * 86400_000).toISOString()

  let q = supabase
    .from("drawing_sheets")
    .select("id, sheet_number, discipline, discipline_prefix, title, current_revision_id, created_at, deleted_at")
    .eq("project_id", pid)
  if (wantDeleted) {
    // Within the window only — anything older is pending hard-purge.
    q = q.not("deleted_at", "is", null).gte("deleted_at", cutoffIso).order("deleted_at", { ascending: false })
  } else {
    q = q.is("deleted_at", null).order("sheet_number", { ascending: true })
  }
  const { data: sheets, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const rows = sheets ?? []
  const revIds = rows.map(s => s.current_revision_id).filter((v): v is string => !!v)

  const revById = new Map<string, { revision_label: string | null; storage_path: string | null }>()
  if (revIds.length > 0) {
    // RLS scopes this to the caller's company too — a sheet's revision can
    // only resolve if it's in the same tenant.
    const { data: revs } = await supabase
      .from("drawing_revisions")
      .select("id, revision_label, storage_path")
      .in("id", revIds)
    for (const r of revs ?? []) revById.set(r.id, { revision_label: r.revision_label, storage_path: r.storage_path })
  }

  // Sign the current-revision files (1 h) for inline open/download.
  const toSign = [...revById.values()].map(r => r.storage_path).filter((p): p is string => !!p)
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
      file_url: rev?.storage_path ? (urlByPath.get(rev.storage_path) ?? null) : null,
      created_at: s.created_at,
      deleted_at: s.deleted_at,
      days_remaining: daysRemaining,
    }
  })

  return NextResponse.json({ sheets: out })
}
