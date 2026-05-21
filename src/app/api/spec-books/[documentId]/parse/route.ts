import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import Anthropic from "@anthropic-ai/sdk"
import { parseSpecBook } from "@/lib/spec-parser"
import { classifySubmittals, mapWithConcurrency } from "@/lib/spec-classifier"

// Section split + 60-odd Haiku calls can take 30-60s — raise the function ceiling.
export const maxDuration = 300

const CLASSIFY_CONCURRENCY = 5
const PROGRESS_CHUNK = 10

// POST /api/spec-books/[documentId]/parse — runs the full pipeline synchronously:
// extract text -> split sections -> extract SUBMITTALS articles -> classify with
// Haiku -> write staged_submittals. Progress is written to project_documents so
// the UI can poll GET /api/spec-books/[documentId] for a progress bar.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ documentId: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY not set" }, { status: 500 })
  }

  const { documentId } = await params

  const { data: doc, error: docError } = await supabase
    .from("project_documents")
    .select("*")
    .eq("id", documentId)
    .single()
  if (docError || !doc) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (doc.parse_status === "parsed") {
    return NextResponse.json({ ok: true, alreadyParsed: true })
  }

  try {
    await supabase
      .from("project_documents")
      .update({ parse_status: "extracting", parse_progress: 5, parse_error: null })
      .eq("id", documentId)

    const { data: fileData, error: dlError } = await supabase.storage
      .from("submittals")
      .download(doc.file_path)
    if (dlError || !fileData) throw new Error("Could not download the spec book file from storage")

    const buffer = Buffer.from(await fileData.arrayBuffer())
    const result = await parseSpecBook(buffer)

    if (result.needsOcr) {
      await supabase
        .from("project_documents")
        .update({
          parse_status: "failed",
          parse_error: "This PDF has no extractable text layer (likely a scanned copy). Upload a digital PDF instead.",
          page_count: result.pageCount,
        })
        .eq("id", documentId)
      return NextResponse.json({ error: "needs_ocr" }, { status: 422 })
    }

    // Support re-parse after a previous failure: clear prior sections.
    // Cascades to staged_submittals. Only reachable when parse_status !== 'parsed',
    // so no committed rows can be lost here.
    await supabase.from("spec_sections").delete().eq("project_document_id", documentId)

    await supabase
      .from("project_documents")
      .update({ parse_progress: 25, page_count: result.pageCount })
      .eq("id", documentId)

    // ── Scope filter ─────────────────────────────────────────────────────────
    // A project with project_scope_sections rows restricts ingestion to its
    // in-scope sections.
    //
    // LEGACY BEHAVIOR — DO NOT BREAK: a project with ZERO project_scope_sections
    // rows is treated as "not yet scoped" and EVERY section is ingested, so
    // projects created before spec-book scoping keep working unchanged. Because
    // any single row flips the project into filtered mode (hiding every section
    // that lacks a row), never insert a marker/placeholder scope row for an
    // existing project.
    const { data: scopeRows } = await supabase
      .from("project_scope_sections")
      .select("spec_number, in_scope")
      .eq("project_id", doc.project_id)
    const hasScope = (scopeRows ?? []).length > 0
    const inScope = new Set(
      (scopeRows ?? []).filter(r => r.in_scope).map(r => r.spec_number as string),
    )
    const sectionsToIngest = hasScope
      ? result.sections.filter(s => inScope.has(s.specNumber))
      : result.sections

    const sectionRows = sectionsToIngest.map(s => ({
      project_document_id: documentId,
      project_id:          doc.project_id,
      spec_number:         s.specNumber,
      spec_title:          s.specTitle,
      start_page:          s.startPage,
      end_page:            s.endPage,
      full_text:           s.fullText,
      submittals_text:     s.submittalsText || null,
      has_submittals:      s.submittalsText.length > 0,
    }))

    let insertedSections: { id: string; spec_number: string; spec_title: string; submittals_text: string | null }[] = []
    if (sectionRows.length > 0) {
      const { data, error: secError } = await supabase
        .from("spec_sections")
        .insert(sectionRows)
        .select("id, spec_number, spec_title, submittals_text")
      if (secError) throw new Error(`Failed to save spec sections: ${secError.message}`)
      insertedSections = data ?? []
    }

    // Backfill project_scope_sections.spec_section_id for the sections just
    // created (matched by spec_number).
    if (hasScope) {
      for (const sec of insertedSections) {
        await supabase
          .from("project_scope_sections")
          .update({ spec_section_id: sec.id })
          .eq("project_id", doc.project_id)
          .eq("spec_number", sec.spec_number)
      }
    }

    await supabase
      .from("project_documents")
      .update({ parse_status: "classifying", parse_progress: 40 })
      .eq("id", documentId)

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const toClassify = insertedSections.filter(s => s.submittals_text)

    type StagedRow = {
      project_document_id: string
      spec_section_id: string
      project_id: string
      spec_number: string
      letter: string | null
      project_item_name: string
      submittal_type: string
      description: string
      sub_bullets: string[]
    }
    const staged: StagedRow[] = []
    let done = 0

    for (let i = 0; i < toClassify.length; i += PROGRESS_CHUNK) {
      const chunk = toClassify.slice(i, i + PROGRESS_CHUNK)
      const classified = await mapWithConcurrency(chunk, CLASSIFY_CONCURRENCY, async sec => {
        try {
          const items = await classifySubmittals(client, sec.spec_number, sec.spec_title, sec.submittals_text ?? "")
          return { sec, items }
        } catch {
          return { sec, items: [] }
        }
      })

      for (const { sec, items } of classified) {
        for (const it of items) {
          const detail = it.sub_bullets.length > 0
            ? ` – ${it.sub_bullets.join("; ")}`
            : it.description
              ? ` – ${it.description}`
              : ""
          staged.push({
            project_document_id: documentId,
            spec_section_id:     sec.id,
            project_id:          doc.project_id,
            spec_number:         sec.spec_number,
            letter:              it.letter || null,
            project_item_name:   sec.spec_title,
            submittal_type:      it.type,
            description:         `${sec.spec_title} (${it.heading}${detail})`,
            sub_bullets:         it.sub_bullets,
          })
        }
      }

      done += chunk.length
      const progress = 40 + Math.round((done / Math.max(toClassify.length, 1)) * 50)
      await supabase.from("project_documents").update({ parse_progress: progress }).eq("id", documentId)
    }

    if (staged.length > 0) {
      const { error: stError } = await supabase.from("staged_submittals").insert(staged)
      if (stError) throw new Error(`Failed to save staged submittals: ${stError.message}`)
    }

    // Parse telemetry — lets the UI explain a parse that produced no staged
    // rows (e.g. a multi-volume spec book missing the scoped divisions' bodies).
    //  sectionsScoped         — sections the user scoped (or all, if unscoped)
    //  sectionsFound          — scoped sections with a real body in THIS PDF
    //  sectionsWithSubmittals — of those, how many had a SUBMITTALS article
    const parseSummary = {
      sectionsScoped:         hasScope ? inScope.size : result.sections.length,
      sectionsFound:          sectionsToIngest.length,
      sectionsWithSubmittals: toClassify.length,
      staged:                 staged.length,
    }

    await supabase
      .from("project_documents")
      .update({
        parse_status:   "parsed",
        parse_progress: 100,
        parsed_at:      new Date().toISOString(),
        parse_summary:  parseSummary,
      })
      .eq("id", documentId)

    return NextResponse.json({ ok: true, ...parseSummary })
  } catch (err) {
    console.error("Spec book parse error:", err)
    await supabase
      .from("project_documents")
      .update({
        parse_status: "failed",
        parse_error: err instanceof Error ? err.message : "Parsing failed",
      })
      .eq("id", documentId)
    return NextResponse.json({ error: "parse_failed" }, { status: 500 })
  }
}
