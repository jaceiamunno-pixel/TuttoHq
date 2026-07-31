import { NextRequest, NextResponse } from "next/server"
import { createClientFromRequest } from "@/lib/supabase/server"
import { divisionNameFor, divisionNumberOf } from "@/lib/spec-parser"
import { isSubmittalType, SUBMITTAL_TYPES } from "@/lib/bulk-import-detect"
import { canonicalSectionShape } from "@/lib/csi-section"
import { normalizeSubmittalTitle } from "@/lib/title-normalize"
import { allocateSectionSeqAndInsert } from "@/lib/section-seq"

// POST /api/submittals/manual-log-row — mint a hand-entered Submittal Log row.
//
// Quick-fix entry for spec sections the parser missed or mis-ingested (e.g.
// the spec book parse skipped 12 66 13 and the user needs the placeholder NOW
// to track the submittal). Unlike /api/bulk-import/create-row — which CLONES
// spec identity from a donor spec_ingestion row and exists only for sections
// the parser DID build — this route takes the section identity from the user,
// so it works precisely where no spec row exists.
//
// The row is a plain manual placeholder: source 'manual', spec_section_id
// NULL (so the log's Clear/Delete dialog treats it as a manual row —
// delete-only, no spec-slot semantics), no file/storage fields. Documents
// attach later through the existing flows.
//
// HARD RULES (same defense-in-depth as create-row):
//   1. Auth-gated; RLS-scoped client (cookie or bearer).
//   2. Caller must own the project (project.company_id == caller company).
//   3. company_id is NEVER accepted from the client — the column's DB
//      default get_my_company_id() stamps it; RLS WITH CHECK backstops.
//   4. submittal_seq / section_seq are NEVER accepted from the client —
//      submittal_seq via the race-safe next_submittal_seq counter RPC,
//      section_seq via the guarded-MAX allocator (counts soft-deleted rows;
//      a retired CM number is never reused).

interface Body {
  project_id?: unknown
  csi_section?: unknown
  section_name?: unknown
  submittal_type?: unknown
  title?: unknown
  description?: unknown
  lead_time?: unknown
  is_critical?: unknown
}

/** Optional free-text field: absent/null → null, non-string → error,
 *  string → trimmed (empty trims to null). */
function optionalText(v: unknown, field: string): { value: string | null; error?: string } {
  if (v === undefined || v === null) return { value: null }
  if (typeof v !== "string") return { value: null, error: `${field} must be a string` }
  const t = v.trim()
  return { value: t.length > 0 ? t : null }
}

export async function POST(req: NextRequest) {
  const supabase = await createClientFromRequest(req)
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = (await req.json().catch(() => null)) as Body | null
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })

  const projectId = typeof body.project_id === "string" ? body.project_id.trim() : ""
  if (!projectId) return NextResponse.json({ error: "project_id required" }, { status: 400 })

  // csi_section — validated against the same MasterFormat shape the bulk
  // importer uses; stored in the canonical spaced form ("12 66 13").
  const rawSection = typeof body.csi_section === "string" ? body.csi_section : ""
  const csiSection = canonicalSectionShape(rawSection)
  if (!csiSection) {
    return NextResponse.json(
      { error: 'csi_section must be a MasterFormat section like "12 66 13"' },
      { status: 400 },
    )
  }

  const sectionName = typeof body.section_name === "string" ? body.section_name.trim() : ""
  if (!sectionName) return NextResponse.json({ error: "section_name required" }, { status: 400 })

  // submittal_type — closed vocabulary, same guard as the log's inline type
  // edit (no DB CHECK on the column; the routes are the only guard).
  const submittalType = body.submittal_type
  if (!isSubmittalType(submittalType)) {
    return NextResponse.json(
      { error: `submittal_type must be one of: ${SUBMITTAL_TYPES.join(", ")}` },
      { status: 400 },
    )
  }

  const titleField = optionalText(body.title, "title")
  if (titleField.error) return NextResponse.json({ error: titleField.error }, { status: 400 })
  const descField = optionalText(body.description, "description")
  if (descField.error) return NextResponse.json({ error: descField.error }, { status: 400 })
  const leadField = optionalText(body.lead_time, "lead_time")
  if (leadField.error) return NextResponse.json({ error: leadField.error }, { status: 400 })

  if (body.is_critical !== undefined && body.is_critical !== null && typeof body.is_critical !== "boolean") {
    return NextResponse.json({ error: "is_critical must be a boolean" }, { status: 400 })
  }
  const isCritical = body.is_critical === true

  // Human-entered title → normalized once, then LOCKED so the normalizer /
  // spec-book re-parse / attach-title sync never re-stomp it. No title → the
  // row stays an unlocked placeholder (file_name falls back to section_name,
  // the same convention spec placeholders use for their NOT NULL file_name).
  const title = normalizeSubmittalTitle(titleField.value) || null

  const { data: companyId, error: cErr } = await supabase.rpc("get_my_company_id")
  if (cErr || !companyId) {
    return NextResponse.json({ error: "No company association" }, { status: 500 })
  }

  // Project ownership — the RLS-scoped SELECT can only see the caller's
  // company's projects; the explicit company check is defense-in-depth.
  const { data: project, error: pErr } = await supabase
    .from("projects")
    .select("id, company_id")
    .eq("id", projectId)
    .single()
  if (pErr || !project) {
    return NextResponse.json({ error: "project not found or not accessible" }, { status: 404 })
  }
  if (project.company_id !== companyId) {
    return NextResponse.json({ error: "project not in your company" }, { status: 403 })
  }

  // Fresh per-project sequence — the race-safe counter RPC (matches the
  // staged-commit and create-row seeders).
  const { data: seqBase, error: seqErr } = await supabase
    .rpc("next_submittal_seq", { p_project_id: projectId, p_count: 1 })
  if (seqErr || typeof seqBase !== "number") {
    return NextResponse.json(
      { error: `seq allocation failed: ${seqErr?.message ?? "no seq returned"}` },
      { status: 500 },
    )
  }

  // Allocate section_seq (migration 0039) + insert with retry-on-conflict.
  const { data: row, error: insErr } = await allocateSectionSeqAndInsert(
    supabase, projectId, csiSection,
    (sectionSeq) => ({
      csi_division:     divisionNumberOf(csiSection),
      division_name:    divisionNameFor(csiSection),
      csi_section:      csiSection,
      section_name:     sectionName,
      submittal_type:   submittalType,
      source:           "manual",
      spec_section_id:  null,
      status:           "active",
      review_status:    "Not Started",
      project_id:       projectId,
      // company_id deliberately omitted — DB default get_my_company_id().
      submittal_seq:    seqBase + 1,
      section_seq:      sectionSeq,
      submittal_number: null,
      revision_number:  "R0",
      title,
      title_locked:     title !== null,
      description:      descField.value,
      lead_time:        leadField.value,
      is_critical:      isCritical,
      // file_name is NOT NULL — the title when given, else the section name
      // (the spec-placeholder fallback convention; no material_name here).
      file_name:        title ?? sectionName,
      uploaded_by:      user.id,
    }),
    "*",
  )
  if (insErr || !row) {
    return NextResponse.json(
      { error: insErr ?? "insert returned no row" },
      { status: 500 },
    )
  }

  return NextResponse.json({ row }, { status: 201 })
}
