import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export const maxDuration = 30

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json()
  const projects: Array<{ name: string; number: string; location: string; gc_name: string; architect: string }> = body.projects

  if (!Array.isArray(projects)) {
    return NextResponse.json({ error: "projects must be an array" }, { status: 400 })
  }

  type RowResult = { data?: unknown; error?: string }
  const results: RowResult[] = await Promise.all(projects.map(async (proj, i): Promise<RowResult> => {
    const { name, number, location, gc_name, architect } = proj
    if (!name?.trim()) {
      return { error: `Row ${i + 1}: Project Name is required` }
    }
    const { data, error } = await supabase
      .from("projects")
      .insert({
        name: name.trim(),
        number: number?.trim() || null,
        location: location?.trim() || null,
        gc_name: gc_name?.trim() || null,
        architect: architect?.trim() || null,
      })
      .select("id, name, number, location, gc_name, architect, created_at")
      .single()
    if (error) return { error: `Row ${i + 1} (${name}): ${error.message}` }
    return { data }
  }))

  const inserted = results.filter(r => r.data !== undefined).map(r => r.data)
  const errors = results.flatMap(r => (r.error ? [r.error] : []))

  return NextResponse.json({ projects: inserted, imported: inserted.length, errors })
}
