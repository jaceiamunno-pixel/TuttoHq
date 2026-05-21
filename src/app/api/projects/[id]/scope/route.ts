import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

interface ScopeInput {
  spec_number: string
  spec_title: string
  division_code: string
  in_scope: boolean
}

// GET /api/projects/[id]/scope — returns the project's scope sections.
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
  return NextResponse.json({ scope: data ?? [] })
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
