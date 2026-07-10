import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import type { ScopeDiagnosis } from "@/lib/scope-types"

interface ScopeInput {
  spec_number: string
  spec_title: string
  division_code: string
  in_scope: boolean
}

// GET /api/projects/[id]/scope — returns the project's scope sections, each
// annotated with a `diagnosis` (see ScopeDiagnosis) that explains an in-scope
// section which produced no submittals, plus a top-level `parsed` flag.
//
// WHY here: the submittal log is generated staged-driven — the commit route
// filters staged rows by scope membership, so scope can only ever SUBTRACT.
// Nothing iterates scope looking for content, so a scoped section with no body
// / no staged rows is invisible by construction. This endpoint is the read-only
// surface that makes that silence visible; it writes nothing.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const { data, error } = await supabase
    .from("project_scope_sections")
    .select("*")
    .eq("project_id", id)
    .order("spec_number", { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const rows = (data ?? []) as Array<Record<string, unknown> & { spec_number: string; in_scope: boolean }>

  // Gate: diagnosis is only meaningful AFTER a parse has run. Before that every
  // in-scope section is trivially "no_body" and the flag is pure noise. The
  // signal a parse completed is a project_documents row in the 'parsed' state —
  // NOT "a spec_sections row exists": a parse can legitimately finish with zero
  // body sections (a TOC-only volume), and that is exactly when the flag should
  // still fire.
  const { data: parsedDocs } = await supabase
    .from("project_documents")
    .select("id")
    .eq("project_id", id)
    .eq("parse_status", "parsed")
    .limit(1)
  const parsed = (parsedDocs ?? []).length > 0

  if (!parsed) {
    return NextResponse.json({ scope: rows.map(r => ({ ...r, diagnosis: null })), parsed: false })
  }

  // The prod predicate, joined on spec_number (the reparse-stable key — the FK
  // is nulled ON DELETE SET NULL). Two small per-project reads → membership
  // sets; no per-row queries.
  //   no_body       — in scope, no spec_sections row.
  //   body_no_items — spec_sections row exists, but no staged_submittals row
  //                   (any state — committed or not; matches count(*) = 0).
  const [{ data: specRows }, { data: stagedRows }] = await Promise.all([
    supabase.from("spec_sections").select("spec_number").eq("project_id", id),
    supabase.from("staged_submittals").select("spec_number").eq("project_id", id),
  ])
  const hasBody  = new Set((specRows ?? []).map(r => r.spec_number as string))
  const hasItems = new Set((stagedRows ?? []).map(r => r.spec_number as string))

  const scope = rows.map(r => {
    let diagnosis: ScopeDiagnosis | null = null
    if (r.in_scope) {
      if (!hasBody.has(r.spec_number)) diagnosis = "no_body"
      else if (!hasItems.has(r.spec_number)) diagnosis = "body_no_items"
    }
    return { ...r, diagnosis }
  })

  return NextResponse.json({ scope, parsed: true })
}

// POST /api/projects/[id]/scope — writes the project's scope (one row per TOC
// section). Upserts on (project_id, spec_number) so re-running the flow after a
// second spec book upload merges cleanly. Returns immediately; the caller fires
// the spec-book parse separately so this stays fast.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const body = await req.json().catch(() => null)
  const sections: unknown = body?.sections

  if (!Array.isArray(sections)) {
    return NextResponse.json({ error: "sections array is required" }, { status: 400 })
  }
  if (sections.length === 0) {
    return NextResponse.json({ ok: true, count: 0 })
  }

  const rows = (sections as ScopeInput[])
    .filter(s => s && typeof s.spec_number === "string" && s.spec_number.trim() !== "")
    .map(s => ({
      project_id:    id,
      spec_number:   s.spec_number.trim(),
      spec_title:    (s.spec_title ?? "").trim() || s.spec_number.trim(),
      division_code: (s.division_code ?? s.spec_number.slice(0, 2)).trim(),
      in_scope:      s.in_scope !== false,
    }))

  if (rows.length === 0) {
    return NextResponse.json({ error: "No valid sections provided" }, { status: 400 })
  }

  const { error } = await supabase
    .from("project_scope_sections")
    .upsert(rows, { onConflict: "project_id,spec_number" })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, count: rows.length })
}

// DELETE /api/projects/[id]/scope — removes every scope row for the project,
// returning it to the clean "not yet scoped" state (same as a fresh project:
// Spec Book Ingestion falls back to ingesting all sections). Leaves already
// ingested spec_sections / staged_submittals untouched.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const { error } = await supabase
    .from("project_scope_sections")
    .delete()
    .eq("project_id", id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
