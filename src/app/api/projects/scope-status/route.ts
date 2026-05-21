import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// GET /api/projects/scope-status — ids of projects that have at least one
// project_scope_sections row. Used by Settings to flag projects whose scope has
// not been set (e.g. created via CSV import).
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data, error } = await supabase
    .from("project_scope_sections")
    .select("project_id")
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const scoped = [...new Set((data ?? []).map(r => r.project_id as string))]
  return NextResponse.json({ scoped })
}
