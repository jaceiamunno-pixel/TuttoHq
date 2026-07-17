import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { divisionNameFor, divisionNumberOf } from "@/lib/spec-parser"
import { normalizeSubmittalTitle } from "@/lib/title-normalize"
import { sectionSeqStarts, assignSectionSeqBlock, isSectionSeqConflict } from "@/lib/section-seq"

export const maxDuration = 30

interface StagedRow {
  id: string
  spec_section_id: string
  spec_number: string
  project_item_name: string
  submittal_type: string
  description: string
  project_id: string
}

// POST /api/staged-submittals/commit — commits a project's not-yet-committed
// staged rows into the live `submittals` log, gated by the project's scope.
//
// Body: { project_id, mode: "consolidated" | "detailed" }
//  - detailed:     one submittal per staged row (Mode A).
//  - consolidated: one submittal per (section, type) group (Mode B).
//
// Scope gate: only rows whose section is in_scope per project_scope_sections are
// committed (joined on spec_number). A project with no scope rows commits all
// selected rows (legacy "not yet scoped" behavior). Out-of-scope rows are skipped
// and reported as skippedOutOfScope. See the gate below for the full rationale.
//
// Safeguard: a staged row whose source spec_section no longer exists (the spec
// book was re-parsed mid-review) is skipped gracefully — it does not error the
// whole batch — and reported back as skippedMissingSection.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => null)
  const projectId: unknown = body?.project_id
  const mode: "consolidated" | "detailed" = body?.mode === "detailed" ? "detailed" : "consolidated"

  if (typeof projectId !== "string" || !projectId) {
    return NextResponse.json({ error: "project_id is required" }, { status: 400 })
  }

  const { data: stagedData, error: stagedError } = await supabase
    .from("staged_submittals")
    .select("id, spec_section_id, spec_number, project_item_name, submittal_type, description, project_id")
    .eq("project_id", projectId)
    .eq("is_selected", true)
    .is("committed_at", null)
    .order("spec_number", { ascending: true })
  if (stagedError) return NextResponse.json({ error: stagedError.message }, { status: 500 })

  const allStaged = (stagedData ?? []) as StagedRow[]
  if (allStaged.length === 0) {
    return NextResponse.json({ committed: 0, skippedMissingSection: 0, skippedOutOfScope: 0 })
  }

  // ── Scope gate — project_scope_sections is the single source of truth ──────
  // Commit ONLY rows whose section the user actually scoped in. is_selected is an
  // ephemeral per-row toggle that a re-parse resets all-true, so it cannot decide
  // scope; it stays in the query above only as a manual per-row deselect. The
  // durable, company/RLS-scoped record of intent lives in project_scope_sections.
  //
  // Join on spec_number — the reparse-stable key. A re-parse deletes & recreates
  // spec_sections (new row ids) and SET NULLs scope.spec_section_id, so
  // spec_section_id does NOT survive a reparse; spec_number does. This mirrors the
  // parse route's own scope filter, which keys on spec_number too.
  //
  // LEGACY (DO NOT BREAK): a project with ZERO project_scope_sections rows is
  // "not yet scoped" — commit ALL selected rows exactly as before. Never silently
  // commit nothing for an unscoped project.
  const { data: scopeRows } = await supabase
    .from("project_scope_sections")
    .select("spec_number, in_scope")
    .eq("project_id", projectId)
  const hasScope = (scopeRows ?? []).length > 0
  const inScope = new Set(
    (scopeRows ?? []).filter(r => r.in_scope).map(r => r.spec_number as string),
  )
  const scopedStaged = hasScope
    ? allStaged.filter(s => inScope.has(s.spec_number))
    : allStaged
  const skippedOutOfScope = allStaged.length - scopedStaged.length
  if (scopedStaged.length === 0) {
    return NextResponse.json({ committed: 0, skippedMissingSection: 0, skippedOutOfScope })
  }

  // Safeguard: drop staged rows whose spec_section was deleted during a re-parse.
  const sectionIds = [...new Set(scopedStaged.map(s => s.spec_section_id))]
  const { data: sections } = await supabase
    .from("spec_sections")
    .select("id, spec_title")
    .in("id", sectionIds)
  const titleById = new Map((sections ?? []).map(s => [s.id as string, s.spec_title as string]))

  const staged = scopedStaged.filter(s => titleById.has(s.spec_section_id))
  const skippedMissingSection = scopedStaged.length - staged.length
  if (staged.length === 0) {
    return NextResponse.json({ committed: 0, skippedMissingSection, skippedOutOfScope })
  }

  const baseFields = (s: StagedRow) => ({
    csi_division:    divisionNumberOf(s.spec_number),
    division_name:   divisionNameFor(s.spec_number),
    csi_section:     s.spec_number,
    section_name:    titleById.get(s.spec_section_id) ?? s.project_item_name,
    material_name:   s.project_item_name,
    submittal_type:  s.submittal_type,
    // Spec-ingestion placeholder: no file, no dates — nothing has happened
    // yet. 'Not Started' from every seeder (unified with bulk-import/create-row).
    review_status:   "Not Started",
    project_id:      s.project_id,
    status:          "active",
    source:          "spec_ingestion",
    spec_section_id: s.spec_section_id,
    uploaded_by:     user.id,
  })

  const submittalRows: Record<string, unknown>[] = []
  const stagedIdsPerRow: string[][] = []

  if (mode === "detailed") {
    for (const s of staged) {
      submittalRows.push({ file_name: normalizeSubmittalTitle(s.description), ...baseFields(s) })
      stagedIdsPerRow.push([s.id])
    }
  } else {
    const groups = new Map<string, StagedRow[]>()
    for (const s of staged) {
      const key = `${s.spec_section_id}|${s.submittal_type}`
      const g = groups.get(key)
      if (g) g.push(s)
      else groups.set(key, [s])
    }
    for (const group of groups.values()) {
      const head = group[0]
      submittalRows.push({ file_name: normalizeSubmittalTitle(head.project_item_name), ...baseFields(head) })
      stagedIdsPerRow.push(group.map(g => g.id))
    }
  }

  // Reserve a contiguous block of per-project submittal numbers. next_submittal_seq
  // bumps the project's counter atomically (single INSERT ... ON CONFLICT
  // statement), so two simultaneous commits get disjoint ranges — no collision.
  const { data: seqBase, error: seqError } = await supabase
    .rpc("next_submittal_seq", { p_project_id: projectId, p_count: submittalRows.length })
  if (seqError || typeof seqBase !== "number") {
    return NextResponse.json(
      { error: `Could not allocate submittal numbers: ${seqError?.message ?? "unknown error"}` },
      { status: 500 },
    )
  }
  submittalRows.forEach((row, i) => { row.submittal_seq = seqBase + 1 + i })

  // Allocate section_seq (migration 0039) for the whole block in ONE pass —
  // one MAX lookup per DISTINCT section (never per row). Retry the batch on a
  // unique-index conflict, re-reading each section's MAX each attempt (a
  // concurrent commit may have taken numbers in the same section between our
  // read and this insert). The insert is atomic, so a conflict leaves nothing
  // inserted and the retry is clean.
  let inserted: { id: string }[] | null = null
  const MAX_ATTEMPTS = 5
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let starts: Map<string, number>
    try {
      starts = await sectionSeqStarts(supabase, projectId, submittalRows.map(r => (r.csi_section as string | null)))
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "section_seq lookup failed" },
        { status: 500 },
      )
    }
    assignSectionSeqBlock(submittalRows, starts)
    const { data, error: insertError } = await supabase
      .from("submittals")
      .insert(submittalRows)
      .select("id")
    if (!insertError && data && data.length === submittalRows.length) {
      inserted = data as { id: string }[]
      break
    }
    if (isSectionSeqConflict(insertError) && attempt < MAX_ATTEMPTS - 1) continue
    return NextResponse.json(
      { error: insertError?.message ?? "Failed to insert submittals" },
      { status: 500 },
    )
  }
  if (!inserted) {
    return NextResponse.json(
      { error: "Could not allocate unique section numbers after retries" },
      { status: 500 },
    )
  }

  const committedAt = new Date().toISOString()
  for (let i = 0; i < inserted.length; i++) {
    const { error: updError } = await supabase
      .from("staged_submittals")
      .update({ committed_at: committedAt, committed_submittal_id: inserted[i].id })
      .in("id", stagedIdsPerRow[i])
    if (updError) {
      return NextResponse.json(
        { error: `Submittals were created but staging update failed: ${updError.message}` },
        { status: 500 },
      )
    }
  }

  return NextResponse.json({ committed: inserted.length, skippedMissingSection, skippedOutOfScope })
}
