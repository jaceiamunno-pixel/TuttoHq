import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const projectId = req.nextUrl.searchParams.get("project_id")
  if (!projectId) return NextResponse.json({ error: "project_id required" }, { status: 400 })

  const [itemsRes, punchRes, submittalsRes, rfisRes, cosRes, drawingsRes] = await Promise.all([
    supabase.from("closeout_items").select("*").eq("project_id", projectId).order("sort_order").order("created_at"),
    supabase.from("punch_items").select("*").eq("project_id", projectId).neq("status", "Completed").order("item_number"),
    supabase.from("submittals").select("*").eq("project_id", projectId).eq("status", "active").not("review_status", "eq", "Approved").order("created_at"),
    supabase.from("rfis").select("*").eq("project_id", projectId).not("status", "eq", "Closed").order("rfi_number"),
    supabase.from("change_orders").select("*").eq("project_id", projectId).not("status", "in", '("Approved","Void")').order("co_number"),
    supabase.from("drawing_log").select("*").eq("project_id", projectId).eq("is_current", true).not("status", "eq", "As-Built").order("drawing_number"),
  ])

  return NextResponse.json({
    items:                itemsRes.data   ?? [],
    pending_punch:        punchRes.data   ?? [],
    pending_submittals:   submittalsRes.data ?? [],
    pending_rfis:         rfisRes.data    ?? [],
    pending_cos:          cosRes.data     ?? [],
    pending_drawings:     drawingsRes.data ?? [],
  })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json()
  const { data, error } = await supabase
    .from("closeout_items")
    .insert({ ...body, uploaded_by: user.id })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ item: data })
}
