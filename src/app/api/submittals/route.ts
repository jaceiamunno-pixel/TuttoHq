import { NextRequest, NextResponse } from "next/server"
import { createClientFromRequest } from "@/lib/supabase/server"

export async function GET(req: NextRequest) {
  const supabase = await createClientFromRequest(req)
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const projectId = searchParams.get("project_id")

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query: any = supabase
    .from("submittals")
    .select("*")
    .eq("status", "active")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })

  if (projectId) query = query.eq("project_id", projectId)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ submittals: data ?? [] })
}
