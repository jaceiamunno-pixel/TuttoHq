import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const pid = req.nextUrl.searchParams.get("project_id")
  // Return all records (current + superseded) so client can show revision history
  let q = supabase.from("drawing_log").select("*")
    .order("drawing_number", { ascending: true })
    .order("created_at", { ascending: false })
  if (pid) q = q.eq("project_id", pid)

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ drawings: data ?? [] })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json()
  const { drawing_number, sheet_title, discipline, revision, revision_date, status, scale, notes, project_id } = body

  if (!drawing_number?.trim()) return NextResponse.json({ error: "drawing_number is required" }, { status: 400 })
  if (!sheet_title?.trim())   return NextResponse.json({ error: "sheet_title is required" }, { status: 400 })

  // Supersede any existing current revision for this drawing number
  await supabase
    .from("drawing_log")
    .update({ is_current: false, superseded_at: new Date().toISOString() })
    .eq("drawing_number", drawing_number.trim())
    .eq("is_current", true)
    .eq("uploaded_by", user.id)

  const { error } = await supabase.from("drawing_log").insert({
    drawing_number: drawing_number.trim(),
    sheet_title: sheet_title.trim(),
    discipline: discipline?.trim() || null,
    revision: revision?.trim() || "0",
    revision_date: revision_date || null,
    status: status || "Issued for Review",
    scale: scale?.trim() || null,
    notes: notes?.trim() || null,
    project_id: project_id || null,
    is_current: true,
    uploaded_by: user.id,
  })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
