import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isProjectTransmittalCopy } from "@/lib/storage-paths"

// GET /api/library-search?q=…  — PLAIN (no AI) cross-project Library search.
//
// Partial, case-insensitive match across the agreed field set:
//   title (file_name) · CSI section number (csi_section) · section name
//   (section_name) · submittal type (submittal_type) · division
//   (csi_division + division_name)
//
// Same population as /api/files (the cross-project Library): active rows
// with a stored file, excluding project transmittal copies. Returns the
// same SubmittalFile shape so the client renders results with identical
// rows. Debounced filter-as-you-type lives client-side; this endpoint is
// a single ilike-OR query — no Anthropic call, no AI spend.
//
// The /api/search AI route is intentionally left untouched for the
// separate semantic-search phase.

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const raw = req.nextUrl.searchParams.get("q")?.trim() ?? ""
  if (!raw) return NextResponse.json({ files: [] })

  // Sanitize for PostgREST .or() — strip characters that would break the
  // filter grammar (comma, parens, %, *, backslash). Spaces are kept so a
  // spaced CSI section like "09 51 23" still matches.
  const q = raw.replace(/[%,()*\\]/g, " ").trim()
  if (!q) return NextResponse.json({ files: [] })
  const like = `%${q}%`

  const orFilter = [
    `file_name.ilike.${like}`,
    `csi_section.ilike.${like}`,
    `section_name.ilike.${like}`,
    `submittal_type.ilike.${like}`,
    `csi_division.ilike.${like}`,
    `division_name.ilike.${like}`,
  ].join(",")

  const { data, error } = await supabase
    .from("submittals")
    .select("id, file_name, storage_path, mime_type, file_size, created_at, csi_division, division_name, csi_section, section_name, submittal_type, source, project_id")
    .eq("status", "active")
    .is("deleted_at", null)
    .not("storage_path", "is", null)
    .or(orFilter)
    .order("file_name")
    .limit(100)

  if (error) {
    console.error("[library-search] query failed", error)
    return NextResponse.json({ error: "search failed" }, { status: 500 })
  }

  // Exclude project transmittal copies (they belong to a project's log,
  // not the cross-project Library) — same rule as /api/files.
  const rows = (data ?? []).filter(r => !isProjectTransmittalCopy(r.storage_path))

  // Sign URLs (7-day), same as /api/files.
  const paths = rows.map(r => r.storage_path).filter(Boolean) as string[]
  const signedUrls: Record<string, string> = {}
  if (paths.length > 0) {
    const { data: urlData } = await supabase.storage.from("submittals").createSignedUrls(paths, 604800)
    for (const u of urlData ?? []) {
      if (u.path && u.signedUrl) signedUrls[u.path] = u.signedUrl
    }
  }

  const files = rows.slice(0, 60).map(r => ({
    id:             r.id,
    file_name:      r.file_name,
    file_url:       r.storage_path ? (signedUrls[r.storage_path] ?? "") : "",
    mime_type:      r.mime_type,
    file_size:      r.file_size,
    created_at:     r.created_at,
    csi_division:   r.csi_division ?? undefined,
    division_name:  r.division_name ?? undefined,
    csi_section:    r.csi_section ?? undefined,
    section_name:   r.section_name ?? undefined,
    submittal_type: r.submittal_type ?? null,
    source:         r.source ?? null,
    project_id:     r.project_id ?? null,
  }))

  return NextResponse.json({ files })
}
