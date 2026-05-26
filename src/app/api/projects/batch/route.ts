import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json()
  const projects: Array<{ name: string; number: string; location: string; gc_name: string; architect: string }> = body.projects

  if (!Array.isArray(projects)) {
    return NextResponse.json({ error: "projects must be an array" }, { status: 400 })
  }

  const inserted: unknown[] = []
  const errors: string[] = []

  for (let i = 0; i < projects.length; i++) {
    const { name, number, location, gc_name, architect } = projects[i]
    if (!name?.trim()) {
      errors.push(`Row ${i + 1}: Project Name is required`)
      continue
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
    if (error) {
      errors.push(`Row ${i + 1} (${name}): ${error.message}`)
    } else {
      inserted.push(data)
    }
  }

  return NextResponse.json({ projects: inserted, imported: inserted.length, errors })
}
