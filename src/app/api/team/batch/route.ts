import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export const maxDuration = 30

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: role } = await supabase.rpc("get_my_role")
  if (role !== "admin") {
    return NextResponse.json({ error: "Admin role required" }, { status: 403 })
  }

  const body = await req.json()
  const members: Array<{ name: string; title: string; email: string }> = body.members

  if (!Array.isArray(members)) {
    return NextResponse.json({ error: "members must be an array" }, { status: 400 })
  }

  type RowResult = { data?: unknown; error?: string }
  const results: RowResult[] = await Promise.all(members.map(async (m, i): Promise<RowResult> => {
    const { name, title, email } = m
    if (!name?.trim()) {
      return { error: `Row ${i + 1}: Name is required` }
    }
    const { data, error } = await supabase
      .from("team_members")
      .insert({ name: name.trim(), title: title?.trim() || null, email: email?.trim() || null })
      .select("id, name, title, email, created_at")
      .single()
    if (error) return { error: `Row ${i + 1} (${name}): ${error.message}` }
    return { data }
  }))

  const inserted = results.filter(r => r.data !== undefined).map(r => r.data)
  const errors = results.flatMap(r => (r.error ? [r.error] : []))

  return NextResponse.json({ members: inserted, imported: inserted.length, errors })
}
