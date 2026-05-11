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
  const { id } = await params
  const supabase = await createClient()

  const { error } = await supabase
    .from("team_members")
    .delete()
    .eq("id", id)

  if (error) {
    console.error("Failed to delete team member:", error)
    return NextResponse.json({ error: "Failed to delete team member" }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
