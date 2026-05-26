import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { divisionNameFor, divisionNumberOf } from "@/lib/spec-parser"

interface StagedRow {
  id: string
  spec_section_id: string
  spec_number: string
  project_item_name: string
  submittal_type: string
  description: string
  project_id: string
}

// POST /api/staged-submittals/commit — commits every selected, not-yet-committed
// staged row for a project into the live `submittals` log.
//
// Body: { project_id, mode: "consolidated" | "detailed" }
//  - detailed:     one submittal per staged row (Mode A).
//  - consolidated: one submittal per (section, type) group (Mode B).
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
  if (allStaged.length === 0) return NextResponse.json({ committed: 0, skippedMissingSection: 0 })

  // Safeguard: drop staged rows whose spec_section was deleted during a re-parse.
  const sectionIds = [...new Set(allStaged.map(s => s.spec_section_id))]
  const { data: sections } = await supabase
    .from("spec_sections")
    .select("id, spec_title")
    .in("id", sectionIds)
  const titleById = new Map((sections ?? []).map(s => [s.id as string, s.spec_title as string]))

  const staged = allStaged.filter(s => titleById.has(s.spec_section_id))
  const skippedMissingSection = allStaged.length - staged.length
  if (staged.length === 0) return NextResponse.json({ committed: 0, skippedMissingSection })

  const baseFields = (s: StagedRow) => ({
    csi_division:    divisionNumberOf(s.spec_number),
    division_name:   divisionNameFor(s.spec_number),
    csi_section:     s.spec_number,
    section_name:    titleById.get(s.spec_section_id) ?? s.project_item_name,
    material_name:   s.project_item_name,
    submittal_type:  s.submittal_type,
    review_status:   "Received",
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
      submittalRows.push({ file_name: s.description, ...baseFields(s) })
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
      submittalRows.push({ file_name: head.project_item_name, ...baseFields(head) })
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

  const { data: inserted, error: insertError } = await supabase
    .from("submittals")
    .insert(submittalRows)
    .select("id")
  if (insertError || !inserted || inserted.length !== submittalRows.length) {
    return NextResponse.json(
      { error: insertError?.message ?? "Failed to insert submittals" },
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

  return NextResponse.json({ committed: inserted.length, skippedMissingSection })
}
