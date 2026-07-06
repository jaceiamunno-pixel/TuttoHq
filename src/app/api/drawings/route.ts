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

  const drawings = data ?? []
  const toSign = drawings.filter(d => d.is_current && d.file_path)
  const urlMap: Record<string, string> = {}
  if (toSign.length > 0) {
    const results = await Promise.all(
      toSign.map(d => supabase.storage.from("submittals").createSignedUrl(d.file_path!, 3600))
    )
    toSign.forEach((d, i) => {
      if (results[i].data?.signedUrl) urlMap[d.id] = results[i].data.signedUrl
    })
  }
  return NextResponse.json({ drawings: drawings.map(d => ({ ...d, file_url: urlMap[d.id] ?? null })) })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  // The drawing file (if any) was already PUT straight to storage from the
  // browser via a signed upload URL, so this route receives only JSON metadata.
  const fields: Record<string, string | null> = await req.json().catch(() => ({}))

  const { drawing_number, sheet_title, discipline, revision, revision_date, status, scale, notes, project_id } = fields

  if (!drawing_number?.trim()) return NextResponse.json({ error: "drawing_number is required" }, { status: 400 })
  if (!sheet_title?.trim())   return NextResponse.json({ error: "sheet_title is required" }, { status: 400 })

  const file_path = typeof fields.file_path === "string" ? fields.file_path.trim() || null : null
  const file_name = typeof fields.file_name === "string" ? fields.file_name.trim() || null : null

  // Supersede any existing current revision for this drawing number — bounded to
  // THIS project so a new revision doesn't flip is_current on same-numbered sheets
  // in other projects. project_id is nullable (shelf drawings); PostgREST .eq()
  // never matches NULL, so use .is("project_id", null) for that case.
  const supProjectId = project_id || null
  let supersede = supabase
    .from("drawing_log")
    .update({ is_current: false, superseded_at: new Date().toISOString() })
    .eq("drawing_number", drawing_number.trim())
    .eq("is_current", true)
    .eq("uploaded_by", user.id)
  supersede = supProjectId == null
    ? supersede.is("project_id", null)
    : supersede.eq("project_id", supProjectId)
  const { error: supErr } = await supersede
  // Best-effort: don't abort the insert on a supersede failure, but surface it
  // instead of silently discarding (a failed supersede leaves two current rows).
  if (supErr) console.error("drawing_log supersede failed", supErr)

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
    file_path,
    file_name,
    uploaded_by: user.id,
  })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
