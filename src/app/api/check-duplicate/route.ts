import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isValidSha256 } from "@/lib/file-hash"

// POST /api/check-duplicate — same-company exact-byte dupe lookup.
//
// Body: { sha256: string, project_id?: string | null }
//
// Returns:
//   {
//     same_project_matches:  [{ submittal_id, file_name, submittal_seq, submittal_number, revision_number, received_at, project_id }],
//     cross_project_matches: [{ project_id, project_name, count }]   // counts only — informational
//   }
//
// SCOPE RULES (same-scope = WARN, other named project = informational):
//   - "same scope" means the SAME place the user is uploading to:
//       · uploading to a project  → same-scope = same project_id
//       · uploading to the Library SHELF (project_id = null) → same-scope =
//         other SHELF entries (project_id IS NULL)
//     A same-scope same-hash match → WARN ("already here"). This is what
//     catches the identical file uploaded twice to the shelf — previously
//     missed because `projectId && m.project_id === projectId` short-
//     circuited on a null projectId, so null == null never matched.
//   - same-company + DIFFERENT named project + same-hash → INFORMATIONAL
//     ONLY. Cross-project reuse of the same datasheet is legitimate.
//   - When uploading to a project, a SHELF copy (null project) is neither
//     same-scope nor a named other-project → not surfaced (low signal).
//
// SECURITY: standard authenticated server-side client. RLS on submittals
// scopes by company. We additionally filter status <> 'deleted' so
// previously-deleted dupes don't surface as false positives.
//
// This route is READ-ONLY. It never inserts or updates anything.

interface SameProjectMatch {
  submittal_id: string
  file_name: string
  submittal_seq: number | null
  section_seq: number | null
  csi_section: string | null
  submittal_number: string | null
  revision_number: string | null
  received_at: string | null
  project_id: string | null
}

interface CrossProjectMatch {
  project_id: string | null
  project_name: string | null
  count: number
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => null)
  const sha256: unknown = body?.sha256
  const projectId: string | null = typeof body?.project_id === "string" && body.project_id.trim()
    ? body.project_id.trim() : null

  if (!isValidSha256(sha256)) {
    return NextResponse.json({ error: "sha256 must be 64 lowercase hex chars" }, { status: 400 })
  }

  // Query submittals.file_sha256 directly. The migration's trigger keeps
  // this column in sync with the current attachment's hash, AND direct
  // Library uploads write it on the submittals row directly. So this one
  // table is the single source of truth across both upload paths.
  //
  // RLS scopes by caller's company; we additionally exclude soft-deleted
  // rows so a previously-deleted dupe doesn't re-surface as a "match".
  const { data: matches, error } = await supabase
    .from("submittals")
    .select("id, file_name, submittal_seq, section_seq, csi_section, submittal_number, revision_number, received_at, project_id")
    .eq("file_sha256", sha256)
    .neq("status", "deleted")

  if (error) {
    console.error("[check-duplicate] query failed", error)
    return NextResponse.json({ error: "lookup failed" }, { status: 500 })
  }

  const all = matches ?? []
  const sameProject: SameProjectMatch[] = []
  const otherProjectIds = new Set<string>()
  const otherProjectRowCounts = new Map<string, number>()

  // Same-scope handles the shelf (null project) case explicitly: null === null
  // doesn't work in the SQL/JS short-circuit form, so compare deliberately.
  const isSameScope = (rowProjectId: string | null) =>
    projectId ? rowProjectId === projectId : rowProjectId == null

  for (const m of all) {
    if (isSameScope(m.project_id)) {
      sameProject.push({
        submittal_id:     m.id,
        file_name:        m.file_name,
        submittal_seq:    m.submittal_seq,
        section_seq:      m.section_seq,
        csi_section:      m.csi_section,
        submittal_number: m.submittal_number,
        revision_number:  m.revision_number,
        received_at:      m.received_at,
        project_id:       m.project_id,
      })
    } else if (m.project_id) {
      // Different NAMED project → informational cross-project note.
      otherProjectIds.add(m.project_id)
      otherProjectRowCounts.set(m.project_id, (otherProjectRowCounts.get(m.project_id) ?? 0) + 1)
    }
    // Remaining case: uploading to a project, match is a shelf (null) copy —
    // not same-scope, not a named project → not surfaced (low signal).
  }

  // Pull project names for the cross-project rollup. Single query, one
  // round-trip; RLS scopes to caller's company so we won't see strangers'.
  let crossProject: CrossProjectMatch[] = []
  if (otherProjectIds.size > 0) {
    const { data: projectsData, error: pErr } = await supabase
      .from("projects")
      .select("id, name")
      .in("id", Array.from(otherProjectIds))
    if (pErr) {
      console.warn("[check-duplicate] project name lookup failed", pErr.message)
      // Fall through with names = null — counts are still useful.
      crossProject = Array.from(otherProjectIds).map(pid => ({
        project_id:  pid,
        project_name: null,
        count:        otherProjectRowCounts.get(pid) ?? 0,
      }))
    } else {
      const nameById = new Map<string, string>()
      for (const p of projectsData ?? []) nameById.set(p.id, p.name)
      crossProject = Array.from(otherProjectIds).map(pid => ({
        project_id:  pid,
        project_name: nameById.get(pid) ?? null,
        count:        otherProjectRowCounts.get(pid) ?? 0,
      }))
    }
  }

  return NextResponse.json({
    sha256,
    project_id: projectId,
    same_project_matches:  sameProject,
    cross_project_matches: crossProject,
  })
}
