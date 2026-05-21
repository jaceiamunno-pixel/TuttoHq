import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { SUBMITTAL_TYPES } from "@/lib/spec-classifier"

const EDITABLE = ["project_item_name", "submittal_type", "description", "is_selected"]

// PATCH /api/staged-submittals/[stagedId] — edit one staged row before commit
// (rename item, change type, edit description, toggle selection).
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ stagedId: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { stagedId } = await params
  const updates = await req.json()

  const safe: Record<string, unknown> = Object.fromEntries(
    Object.entries(updates).filter(([k]) => EDITABLE.includes(k)),
  )
  if (Object.keys(safe).length === 0) {
    return NextResponse.json({ error: "No editable fields provided" }, { status: 400 })
  }
  if ("submittal_type" in safe && !SUBMITTAL_TYPES.includes(safe.submittal_type as never)) {
    return NextResponse.json({ error: "Invalid submittal_type" }, { status: 400 })
  }

  const { error } = await supabase.from("staged_submittals").update(safe).eq("id", stagedId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

// DELETE /api/staged-submittals/[stagedId] — drop one staged row.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ stagedId: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { stagedId } = await params
  const { error } = await supabase.from("staged_submittals").delete().eq("id", stagedId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
