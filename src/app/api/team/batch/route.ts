import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export const maxDuration = 30

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json()
  const members: Array<{ name: string; title: string; email: string }> = body.members

  if (!Array.isArray(members)) {
    return NextResponse.json({ error: "members must be an array" }, { status: 400 })
  }

  const inserted: unknown[] = []
  const errors: string[] = []

  for (let i = 0; i < members.length; i++) {
    const { name, title, email } = members[i]
    if (!name?.trim()) {
      errors.push(`Row ${i + 1}: Name is required`)
      continue
    }
    const { data, error } = await supabase
      .from("team_members")
      .insert({ name: name.trim(), title: title?.trim() || null, email: email?.trim() || null })
      .select("id, name, title, email, created_at")
      .single()
    if (error) {
      errors.push(`Row ${i + 1} (${name}): ${error.message}`)
    } else {
      inserted.push(data)
    }
  }

  return NextResponse.json({ members: inserted, imported: inserted.length, errors })
}
