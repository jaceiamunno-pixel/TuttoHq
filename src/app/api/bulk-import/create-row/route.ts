import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// POST /api/bulk-import/create-row — Stage 2a "no open row of this type" path.
//
// The auto-split contract (see /api/bulk-import/commit) spawns a sibling only
// when a placeholder of the matching type is OCCUPIED. It has nothing to say
// when the section carries NO row of the incoming file's submittal_type at all
// (e.g. the section's Product Data placeholder was cleared/deleted). This route
// fills that gap: it mints a fresh, EMPTY spec-ingestion placeholder for the
// requested (section, submittal_type) by cloning the section's spec identity
// from an existing row in that section, then returns the new row id so the
// modal can route the file onto it via the ordinary commit path.
//
// This is the SAME spawn shape spawnSibling uses in the commit route — fresh
// submittal_seq via next_submittal_seq, submittal_number NULL, revision R0,
// source 'spec_ingestion', company/project stamped from the DONOR row (never
// client input; RLS WITH CHECK backstops) — except the submittal_type is the
// REQUESTED type, not the donor's.
//
// Read-then-write, single row. No AI, no loops, no recursion.
//
// HARD RULES:
//   1. Caller must own the project (project.company_id == caller company).
//   2. A donor row must exist: a non-deleted spec_ingestion row in this
//      project + section. Its csi_division / division_name / section_name /
//      material_name / spec_section_id / company_id / project_id are the spec
//      identity we clone. Without one, the section genuinely isn't in the spec
//      book → 409 (the modal offers pick/skip instead).
//   3. company_id + project_id are copied from the donor, RLS-verified as the
//      caller's on SELECT; the explicit WHERE .eq guards + RLS WITH CHECK are
//      defense-in-depth.

interface Body {
  project_id?: string
  csi_section?: string
  submittal_type?: string
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = (await req.json().catch(() => null)) as Body | null
  const projectId = typeof body?.project_id === "string" ? body.project_id.trim() : ""
  const csiSection = typeof body?.csi_section === "string" ? body.csi_section.trim() : ""
  const submittalType = typeof body?.submittal_type === "string" ? body.submittal_type.trim() : ""

  if (!projectId) return NextResponse.json({ error: "project_id required" }, { status: 400 })
  if (!csiSection) return NextResponse.json({ error: "csi_section required" }, { status: 400 })
  if (!submittalType) return NextResponse.json({ error: "submittal_type required" }, { status: 400 })

  const { data: companyId, error: cErr } = await supabase.rpc("get_my_company_id")
  if (cErr || !companyId) {
    return NextResponse.json({ error: "No company association" }, { status: 500 })
  }

  // Defense-in-depth: confirm the project is in the caller's company.
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

  // Donor row — any live spec-built row in this section supplies the spec
  // identity. Lowest submittal_seq first for a stable, deterministic pick.
  const { data: donor, error: dErr } = await supabase
    .from("submittals")
    .select("company_id, project_id, csi_division, division_name, csi_section, section_name, material_name, spec_section_id")
    .eq("company_id", companyId)
    .eq("project_id", projectId)
    .eq("source", "spec_ingestion")
    .eq("csi_section", csiSection)
    .neq("status", "deleted")
    .order("submittal_seq", { ascending: true })
    .limit(1)
    .maybeSingle()
  if (dErr) return NextResponse.json({ error: dErr.message }, { status: 500 })
  if (!donor) {
    // No spec row for this section at all — the section really isn't in the
    // spec book, so there's no identity to clone. The modal falls back to
    // pick-a-log-row / skip.
    return NextResponse.json(
      { error: `Section ${csiSection} has no spec-built rows in this project.` },
      { status: 409 },
    )
  }

  // Fresh per-project sequence — the race-safe counter RPC (matches spawnSibling).
  const { data: seqBase, error: seqErr } = await supabase
    .rpc("next_submittal_seq", { p_project_id: projectId, p_count: 1 })
  if (seqErr || typeof seqBase !== "number") {
    return NextResponse.json(
      { error: `seq allocation failed: ${seqErr?.message ?? "no seq returned"}` },
      { status: 500 },
    )
  }

  const { data: row, error: insErr } = await supabase
    .from("submittals")
    .insert({
      // Spec identity — cloned from the donor row in this section.
      csi_division:     donor.csi_division,
      division_name:    donor.division_name,
      csi_section:      donor.csi_section,
      section_name:     donor.section_name,
      material_name:    donor.material_name,
      spec_section_id:  donor.spec_section_id,
      // The REQUESTED type — this is the whole point (the type had no row).
      submittal_type:   submittalType,
      source:           "spec_ingestion",
      status:           "active",
      // Tenant stamp — from the donor (RLS-verified as caller's), never client.
      company_id:       donor.company_id,
      project_id:       donor.project_id,
      // Fresh identity for its own empty placeholder log row.
      submittal_seq:    seqBase + 1,
      submittal_number: null,
      revision_number:  "R0",
      review_status:    "Received",
      title_locked:     false,
      // Pre-attach placeholder title; the attachment sync trigger overwrites
      // file_name with the committed PDF's name once the file lands.
      file_name:        donor.material_name || donor.section_name || `${csiSection} ${submittalType}`,
      uploaded_by:      user.id,
    })
    .select("id, csi_section, submittal_type, submittal_seq, material_name, spec_section_id")
    .single()
  if (insErr || !row) {
    return NextResponse.json(
      { error: insErr?.message ?? "insert returned no row" },
      { status: 500 },
    )
  }

  return NextResponse.json({ row })
}
