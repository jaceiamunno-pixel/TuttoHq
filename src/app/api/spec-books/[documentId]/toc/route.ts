import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { parseTableOfContents } from "@/lib/spec-parser"

// TOC parse is text-extraction + regex only (no AI) — fast, but give a big PDF
// some headroom.
export const maxDuration = 120

// POST /api/spec-books/[documentId]/toc — parses the spec book's table of
// contents and returns the flat section list + divisions. No DB writes; the
// client drives the scope-selection UI from this and then POSTs the result to
// /api/projects/[id]/scope.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ documentId: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { documentId } = await params

  const { data: doc, error: docError } = await supabase
    .from("project_documents")
    .select("file_path")
    .eq("id", documentId)
    .single()
  if (docError || !doc?.file_path) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const { data: fileData, error: dlError } = await supabase.storage
    .from("submittals")
    .download(doc.file_path)
  if (dlError || !fileData) {
    return NextResponse.json({ error: "Could not download the spec book file" }, { status: 500 })
  }

  try {
    const buffer = Buffer.from(await fileData.arrayBuffer())
    const result = await parseTableOfContents(buffer)

    if (result.needsOcr) {
      return NextResponse.json({ error: "needs_ocr" }, { status: 422 })
    }

    return NextResponse.json({
      pageCount: result.pageCount,
      sections: result.sections,
      divisions: result.divisions,
    })
  } catch (err) {
    console.error("TOC parse error:", err)
    return NextResponse.json({ error: "toc_parse_failed" }, { status: 500 })
  }
}
