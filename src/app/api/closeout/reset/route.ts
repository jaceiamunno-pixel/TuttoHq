import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { project_id } = await req.json()
  if (!project_id) return NextResponse.json({ error: "project_id required" }, { status: 400 })

  // Fetch storage paths before deleting so we can clean up uploaded files
  const { data: items } = await supabase
    .from("closeout_items")
    .select("file_url")
    .eq("project_id", project_id)
    .not("file_url", "is", null)

  const paths = (items ?? []).map(i => i.file_url).filter(Boolean) as string[]
  if (paths.length > 0) {
    await supabase.storage.from("submittals").remove(paths)
  }

  const { error } = await supabase
    .from("closeout_items")
    .delete()
    .eq("project_id", project_id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
