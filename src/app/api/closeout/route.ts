import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const projectId = req.nextUrl.searchParams.get("project_id")
  if (!projectId) return NextResponse.json({ error: "project_id required" }, { status: 400 })

  const [
    itemsRes, punchRes, subsRes, rfisRes, cosRes, drawingsRes,
    allSubsRes, allRFIsRes, allCOsRes, allDrawingsRes, teamRes,
  ] = await Promise.all([
    supabase.from("closeout_items").select("*").eq("project_id", projectId).order("sort_order").order("created_at"),
    supabase.from("punch_items").select("*").eq("project_id", projectId).order("item_number"),
    supabase.from("submittals").select("id,file_name,csi_section,csi_division,division_name,section_name,review_status,created_at").eq("project_id", projectId).eq("status", "active").order("csi_section"),
    supabase.from("rfis").select("id,rfi_number,subject,status,created_at").eq("project_id", projectId).is("deleted_at", null).order("rfi_number"),
    supabase.from("change_orders").select("id,co_number,proposal,status,pricing_sum").eq("project_id", projectId).is("deleted_at", null).order("co_number"),
    supabase.from("drawing_log").select("id,drawing_number,sheet_title,discipline,status,revision").eq("project_id", projectId).eq("is_current", true).order("drawing_number"),
    // pending aliases for backward compat
    supabase.from("submittals").select("id,file_name,review_status").eq("project_id", projectId).eq("status", "active").not("review_status", "eq", "Approved"),
    supabase.from("rfis").select("id,rfi_number,subject,status").eq("project_id", projectId).is("deleted_at", null).not("status", "eq", "Closed"),
    supabase.from("change_orders").select("id,co_number,proposal,status").eq("project_id", projectId).is("deleted_at", null).not("status", "in", '("Approved","Void")'),
    supabase.from("drawing_log").select("id,drawing_number,sheet_title,status").eq("project_id", projectId).eq("is_current", true).not("status", "eq", "As-Built"),
    supabase.from("team_members").select("id,name,title").order("name"),
  ])

  return NextResponse.json({
    items:              itemsRes.data    ?? [],
    all_punch:          punchRes.data    ?? [],
    all_submittals:     subsRes.data     ?? [],
    all_rfis:           rfisRes.data     ?? [],
    all_cos:            cosRes.data      ?? [],
    all_drawings:       drawingsRes.data ?? [],
    pending_submittals: allSubsRes.data  ?? [],
    pending_rfis:       allRFIsRes.data  ?? [],
    pending_cos:        allCOsRes.data   ?? [],
    pending_drawings:   allDrawingsRes.data ?? [],
    team_members:       teamRes.data     ?? [],
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
