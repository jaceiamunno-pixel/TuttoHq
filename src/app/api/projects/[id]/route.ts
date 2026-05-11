import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await createClient()
  const body = await req.json()

  const { name, number, location, gc_name, architect } = body

  if (name !== undefined && (typeof name !== "string" || !name.trim())) {
    return NextResponse.json({ error: "Name cannot be empty" }, { status: 400 })
  }

  const updates: Record<string, string | null> = {}
  if (name !== undefined) updates.name = name.trim()
  if (number !== undefined) updates.number = number?.trim() ?? null
  if (location !== undefined) updates.location = location?.trim() ?? null
  if (gc_name !== undefined) updates.gc_name = gc_name?.trim() ?? null
  if (architect !== undefined) updates.architect = architect?.trim() ?? null

  const { data, error } = await supabase
    .from("projects")
    .update(updates)
    .eq("id", id)
    .select("id, name, number, location, gc_name, architect, created_at")
    .single()

  if (error) {
    console.error("Failed to update project:", error)
    return NextResponse.json({ error: "Failed to update project" }, { status: 500 })
  }

  return NextResponse.json({ project: data })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await createClient()

  const { error } = await supabase
    .from("projects")
    .delete()
    .eq("id", id)

  if (error) {
    console.error("Failed to delete project:", error)
    return NextResponse.json({ error: "Failed to delete project" }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
