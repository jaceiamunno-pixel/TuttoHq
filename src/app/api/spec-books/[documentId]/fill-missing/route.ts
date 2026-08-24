import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import Anthropic from "@anthropic-ai/sdk"
import { parseSpecBook, extractSubmittalArticles } from "@/lib/spec-parser"
import { classifySubmittalsChunked, mapWithConcurrency } from "@/lib/spec-classifier"
import { enforceAiLimit } from "@/lib/ratelimit"

// Full-book text extraction can take 30-60s on an 800+ page volume.
export const maxDuration = 300

const CLASSIFY_CONCURRENCY = 3

// POST /api/spec-books/[documentId]/fill-missing — incremental ingestion for a
// spec book that has ALREADY been parsed.
//
// WHY THIS EXISTS: the full /parse route ingests only the sections in-scope at
// parse time (project_scope_sections, in_scope=true, matched by spec_number
// TEXT). Scoping a section IN afterwards had NO ingestion path — /parse
// early-returns {alreadyParsed:true} on a parsed doc, so the UI's "Re-parse"
// was a silent no-op and the newly-scoped section had no spec_sections row, no
// staged rows, and no way to appear anywhere. (Long Lots 12 66 13, 2026-07-20
// diagnosis.)
//
// WHAT THIS MODE DOES — additive ONLY, no deletes anywhere:
//   1. parseSpecBook on the stored PDF (same parser as the full path).
//   2. target set = sections the parser found WHERE the spec_number is
//      in-scope (or the project is legacy-unscoped: zero scope rows = all
//      in scope, same rule as /parse) AND no spec_sections row exists for
//      (this document, that spec_number). Scope membership is matched by
//      spec_number TEXT — the Linkage Law — never by spec_section_id.
//   3. For ONLY the target set: insert spec_sections, classify + stage
//      staged_submittals (same classifier as /parse), and backfill
//      project_scope_sections.spec_section_id for those spec_numbers.
//   Existing spec_sections, staged_submittals, and submittals rows — and their
//   spec_section_id links — are never touched: no delete, no SET NULL, no
//   re-stage. submittals is not written at all in this mode.
//   4. Idempotent: a second run finds an empty target set and no-ops
//      (0 inserts, 0 Haiku calls). A section can never be ingested twice.
//
// Tenancy: RLS on every statement; company_id lands via the tables' DB
// default get_my_company_id() — exactly like /parse, never from the client.
//
// parse_status / parse_progress are NEVER touched here — the doc stays
// 'parsed' throughout, so a mid-run failure cannot strand it. parse_summary
// is updated additively on success so the telemetry stays honest.

export async function POST(_req: NextRequest, { params }: { params: Promise<{ documentId: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  // Same TIER 2 cost guard as /parse (company-keyed, FAIL CLOSED).
  const limited = await enforceAiLimit(supabase)
  if (limited) return limited

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

  // This mode is only for docs the full pipeline has already ingested. An
  // unparsed/failed doc goes through /parse (which owns status transitions).
  if (doc.parse_status !== "parsed") {
    return NextResponse.json(
      { error: "This spec book hasn't been parsed yet — run Parse first." },
      { status: 409 },
    )
  }

  try {
    const { data: fileData, error: dlError } = await supabase.storage
      .from("submittals")
      .download(doc.file_path)
    if (dlError || !fileData) throw new Error("Could not download the spec book file from storage")

    const buffer = Buffer.from(await fileData.arrayBuffer())
    const result = await parseSpecBook(buffer)

    if (result.needsOcr) {
      return NextResponse.json({ error: "needs_ocr" }, { status: 422 })
    }

    // Scope membership by spec_number TEXT. Zero scope rows = legacy unscoped
    // project = everything in scope (same rule as /parse — do not break it).
    const { data: scopeRows, error: scopeErr } = await supabase
      .from("project_scope_sections")
      .select("spec_number, in_scope")
      .eq("project_id", doc.project_id)
    if (scopeErr) throw new Error(`Failed to load project scope: ${scopeErr.message}`)
    const hasScope = (scopeRows ?? []).length > 0
    const inScope = new Set(
      (scopeRows ?? []).filter(r => r.in_scope).map(r => r.spec_number as string),
    )

    // Sections this document has already ingested — the idempotency key.
    const { data: existingRows, error: exErr } = await supabase
      .from("spec_sections")
      .select("spec_number")
      .eq("project_document_id", documentId)
    if (exErr) throw new Error(`Failed to load existing sections: ${exErr.message}`)
    const existing = new Set((existingRows ?? []).map(r => r.spec_number as string))

    const target = result.sections.filter(s =>
      (!hasScope || inScope.has(s.specNumber)) && !existing.has(s.specNumber),
    )

    if (target.length === 0) {
      return NextResponse.json({ ok: true, filled: 0, staged: 0, sections: [] })
    }

    // Insert ONLY the missing sections — same row shape as /parse.
    const sectionRows = target.map(s => ({
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
    const { data: insertedSections, error: secError } = await supabase
      .from("spec_sections")
      .insert(sectionRows)
      .select("id, spec_number, spec_title, submittals_text")
    if (secError) throw new Error(`Failed to save spec sections: ${secError.message}`)
    const inserted = insertedSections ?? []

    // Backfill project_scope_sections.spec_section_id for JUST the filled
    // numbers (matched by spec_number, same as /parse's backfill).
    if (hasScope) {
      await Promise.all(inserted.map(sec =>
        supabase
          .from("project_scope_sections")
          .update({ spec_section_id: sec.id })
          .eq("project_id", doc.project_id)
          .eq("spec_number", sec.spec_number)
      ))
    }

    // Classify + stage — same classifier and staged-row shape as /parse,
    // applied ONLY to the newly inserted sections.
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const toClassify = inserted.filter(s => s.submittals_text)

    // Per-article blocks for the chunked classifier, from the in-memory parse
    // (keyed by spec_number — unique per document). Same grain as /parse.
    const articlesBySpecNumber = new Map(
      target.map(s => [s.specNumber, extractSubmittalArticles(s.fullText)]),
    )

    type StagedRow = {
      project_document_id: string
      spec_section_id: string
      project_id: string
      spec_number: string
      letter: string | null
      article: string | null
      project_item_name: string
      submittal_type: string
      description: string
      sub_bullets: string[]
      reference_only: boolean
      is_selected: boolean
    }
    const staged: StagedRow[] = []
    // Sections whose classification lost at least one chunk this run — their
    // itemization is incomplete, never "no submittals". Merged additively into
    // parse_summary.failedSections below.
    const failedSections: string[] = []

    const classified = await mapWithConcurrency(toClassify, CLASSIFY_CONCURRENCY, async sec => {
      try {
        const articles = articlesBySpecNumber.get(sec.spec_number) ?? []
        const { items, failedChunks } = await classifySubmittalsChunked(client, sec.spec_number, sec.spec_title, articles)
        return { sec, items, failedChunks }
      } catch (err) {
        console.error(`[spec-books/fill-missing] classify failed for section ${sec.spec_number}`, err)
        return { sec, items: [], failedChunks: 1 }
      }
    })

    for (const { sec, items, failedChunks } of classified) {
      if (failedChunks > 0) failedSections.push(sec.spec_number)
      for (const it of items) {
        const refOnly = it.reference_only === true
        staged.push({
          project_document_id: documentId,
          spec_section_id:     sec.id,
          project_id:          doc.project_id,
          spec_number:         sec.spec_number,
          letter:              it.letter || null,
          article:             it.article || null,
          project_item_name:   sec.spec_title,
          submittal_type:      it.type,
          description:         it.sub_bullets.length > 0
            ? it.sub_bullets.join("; ")
            : (it.description || sec.spec_title),
          sub_bullets:         it.sub_bullets,
          reference_only:      refOnly,
          is_selected:         !refOnly,
        })
      }
    }

    if (staged.length > 0) {
      const { error: stError } = await supabase.from("staged_submittals").insert(staged)
      if (stError) throw new Error(`Failed to save staged submittals: ${stError.message}`)
    }

    // Additive telemetry update — the stored summary keeps describing what has
    // been ingested in total for this doc. parse_status/progress untouched.
    // failedSections is a union: this run only ingests NEW sections, so prior
    // failures (from /parse or earlier fills) stay listed until re-ingested.
    const prev = (doc.parse_summary ?? {}) as Record<string, unknown>
    const prevNum = (k: string) => (typeof prev[k] === "number" ? (prev[k] as number) : 0)
    const prevFailed = Array.isArray(prev.failedSections)
      ? (prev.failedSections as unknown[]).filter((s): s is string => typeof s === "string")
      : []
    const allFailed = [...new Set([...prevFailed, ...failedSections])]
    await supabase
      .from("project_documents")
      .update({
        parse_summary: {
          ...prev,
          sectionsScoped:         hasScope ? inScope.size : prevNum("sectionsScoped") + inserted.length,
          sectionsFound:          prevNum("sectionsFound") + inserted.length,
          sectionsWithSubmittals: prevNum("sectionsWithSubmittals") + toClassify.length,
          staged:                 prevNum("staged") + staged.length,
          sectionsFailed:         allFailed.length,
          failedSections:         allFailed,
        },
      })
      .eq("id", documentId)

    return NextResponse.json({
      ok: true,
      filled: inserted.length,
      staged: staged.length,
      sections: target.map(s => ({
        spec_number: s.specNumber,
        spec_title:  s.specTitle,
        start_page:  s.startPage,
        end_page:    s.endPage,
        has_submittals: s.submittalsText.length > 0,
      })),
    })
  } catch (err) {
    console.error("Spec book fill-missing error:", err)
    // No status writes — the doc is still validly 'parsed'; nothing to unwind.
    return NextResponse.json({ error: "fill_missing_failed" }, { status: 500 })
  }
}
