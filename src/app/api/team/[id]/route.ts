import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await createClient()
  const body = await req.json()

  const { name, title, email } = body

  if (name !== undefined && (typeof name !== "string" || !name.trim())) {
    return NextResponse.json({ error: "Name cannot be empty" }, { status: 400 })
  }

  const updates: Record<string, string | null> = {}
  if (name !== undefined) updates.name = name.trim()
  if (title !== undefined) updates.title = title?.trim() ?? null
  if (email !== undefined) updates.email = email?.trim() ?? null

  const { data, error } = await supabase
    .from("team_members")
    .update(updates)
    .eq("id", id)
    .select("id, name, title, email, created_at")
    .single()

  if (error) {
    console.error("Failed to update team member:", error)
    return NextResponse.json({ error: "Failed to update team member" }, { status: 500 })
  }

  return NextResponse.json({ member: data })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const { data: row, error: selErr } = await supabase
    .from("team_members").select("id").eq("id", id).maybeSingle()
  if (selErr) return NextResponse.json({ error: "Database error" }, { status: 500 })
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const { error } = await supabase.from("team_members").delete().eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
