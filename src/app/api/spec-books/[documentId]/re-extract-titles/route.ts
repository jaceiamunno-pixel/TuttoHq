import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { parseSpecBook } from "@/lib/spec-parser"
import { enforceAiLimit } from "@/lib/ratelimit"

// POST /api/spec-books/[documentId]/re-extract-titles?dryRun=true
//
// Re-runs the spec-book parser against an already-uploaded PDF, updates
// spec_sections.spec_title + needs_title_review, then propagates the
// freshly-extracted title onto every spec-built submittals row whose
// `spec_section_id` points at one of the updated sections (heals the
// bulk-import-clobbered file_name values without any sibling lookup).
//
// CAREFUL LANE — bulk title write. Two modes:
//   ?dryRun=true (default)  — returns the diff WITHOUT writing.
//   ?dryRun=false            — applies the changes.
//
// Both paths are RLS-scoped via the caller's authenticated client. Only
// the document's project's company can read the spec-book PDF and only
// that company's rows are touched.
//
// Bounded: no AI, no retry loops, no recursion. PDF parse runs once;
// updates are batched into one UPDATE per affected table.

export const maxDuration = 60

interface DiffEntry {
  spec_number: string
  before_title: string | null
  after_title: string
  source: string
  needs_review: boolean
  status: "unchanged" | "changed" | "added"
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ documentId: string }> },
) {
  const { documentId } = await params
  if (!documentId) return NextResponse.json({ error: "documentId required" }, { status: 400 })

  const dryRun = new URL(req.url).searchParams.get("dryRun") !== "false"  // default true

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  // TIER 2 cost guard (company-keyed, FAIL CLOSED) — see src/lib/ratelimit.ts.
  const limited = await enforceAiLimit(supabase)
  if (limited) return limited

  // Verify the document is accessible to the caller (RLS filters).
  const { data: doc, error: dErr } = await supabase
    .from("project_documents")
    .select("id, project_id, type, file_path")
    .eq("id", documentId)
    .single()
  if (dErr || !doc) {
    return NextResponse.json({ error: "document not found or not accessible" }, { status: 404 })
  }
  if (doc.type !== "spec_book") {
    return NextResponse.json({ error: "document is not a spec book" }, { status: 400 })
  }

  // Download + parse the PDF with the current parser.
  const { data: blob, error: dlErr } = await supabase.storage
    .from("submittals")
    .download(doc.file_path)
  if (dlErr || !blob) {
    return NextResponse.json({ error: dlErr?.message ?? "could not read spec-book PDF" }, { status: 500 })
  }
  const buffer = Buffer.from(await blob.arrayBuffer())
  const parsed = await parseSpecBook(buffer)
  if (parsed.needsOcr) {
    return NextResponse.json({ error: "spec book has no extractable text layer (needs OCR)" }, { status: 422 })
  }

  // Pull current spec_sections for this project so we can diff per spec_number.
  const { data: existing, error: eErr } = await supabase
    .from("spec_sections")
    .select("id, spec_number, spec_title")
    .eq("project_id", doc.project_id)
  if (eErr) return NextResponse.json({ error: eErr.message }, { status: 500 })

  const existingBy = new Map<string, { id: string; spec_title: string }>(
    (existing ?? []).map(r => [r.spec_number, { id: r.id, spec_title: r.spec_title }]),
  )

  const diff: DiffEntry[] = []
  let changed = 0, added = 0, unchanged = 0
  for (const s of parsed.sections) {
    const cur = existingBy.get(s.specNumber)
    if (!cur) {
      added++
      diff.push({
        spec_number: s.specNumber,
        before_title: null,
        after_title: s.specTitle,
        source: s.titleSource,
        needs_review: s.needsTitleReview,
        status: "added",
      })
    } else if (cur.spec_title === s.specTitle) {
      unchanged++
      diff.push({
        spec_number: s.specNumber,
        before_title: cur.spec_title,
        after_title: s.specTitle,
        source: s.titleSource,
        needs_review: s.needsTitleReview,
        status: "unchanged",
      })
    } else {
      changed++
      diff.push({
        spec_number: s.specNumber,
        before_title: cur.spec_title,
        after_title: s.specTitle,
        source: s.titleSource,
        needs_review: s.needsTitleReview,
        status: "changed",
      })
    }
  }

  const summary = {
    project_id: doc.project_id,
    document_id: documentId,
    page_count: parsed.pageCount,
    parsed_sections: parsed.sections.length,
    existing_sections: existing?.length ?? 0,
    unchanged,
    changed,
    added,
    needs_title_review_count: parsed.sections.filter(s => s.needsTitleReview).length,
  }

  if (dryRun) {
    return NextResponse.json({ dry_run: true, summary, diff })
  }

  // ── Apply changes ───────────────────────────────────────────────────────
  // Update existing spec_sections rows whose title (or needs_title_review)
  // would change. We update in a loop because the .update() supabase-js
  // helper doesn't support per-row values in bulk; the loop is tight and
  // bounded by parsed.sections.length (typically 100-200).
  let sectionsUpdated = 0
  const sectionTitleById = new Map<string, string>()
  for (const s of parsed.sections) {
    const cur = existingBy.get(s.specNumber)
    if (!cur) continue  // adds are not auto-created here — Stage 3 / explicit re-parse
    if (cur.spec_title === s.specTitle) continue
    const { error: uErr } = await supabase
      .from("spec_sections")
      .update({ spec_title: s.specTitle, needs_title_review: s.needsTitleReview })
      .eq("id", cur.id)
    if (uErr) {
      return NextResponse.json({ error: `update spec_sections ${s.specNumber}: ${uErr.message}` }, { status: 500 })
    }
    sectionTitleById.set(cur.id, s.specTitle)
    sectionsUpdated++
  }

  // Propagate: every spec_built submittals row pointing at one of the
  // updated spec_sections gets file_name + received_file_name set to the
  // fresh title. Scoped to the document's project + source = 'spec_ingestion'
  // so we never touch manually-uploaded or gmail-intake rows.
  let submittalsUpdated = 0
  if (sectionTitleById.size > 0) {
    // Pull affected submittals first so we can return the count.
    const { data: subs, error: sErr } = await supabase
      .from("submittals")
      .select("id, spec_section_id, file_name")
      .eq("project_id", doc.project_id)
      .eq("source", "spec_ingestion")
      .neq("status", "deleted")
      .in("spec_section_id", [...sectionTitleById.keys()])
    if (sErr) return NextResponse.json({ error: sErr.message }, { status: 500 })

    for (const row of subs ?? []) {
      const newTitle = sectionTitleById.get(row.spec_section_id as string)
      if (!newTitle || newTitle === row.file_name) continue
      const { error: uErr } = await supabase
        .from("submittals")
        .update({ file_name: newTitle, received_file_name: newTitle })
        .eq("id", row.id)
        .eq("source", "spec_ingestion")
        .neq("status", "deleted")
      if (uErr) return NextResponse.json({ error: `update submittals ${row.id}: ${uErr.message}` }, { status: 500 })
      submittalsUpdated++
    }
  }

  return NextResponse.json({
    dry_run: false,
    summary: { ...summary, sections_updated: sectionsUpdated, submittals_updated: submittalsUpdated },
    diff,
  })
}
