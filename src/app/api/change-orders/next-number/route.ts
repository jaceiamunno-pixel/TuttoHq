import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { nextPcoNumber } from "@/lib/pco-number"

// GET /api/change-orders/next-number?project_id=… — display-only preview of the
// next PCO number for the builder header. The AUTHORITATIVE number is re-derived
// server-side at insert time (Phase 3), so this preview can lag a concurrent
// create without consequence. RLS scopes the read to the caller's company.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const projectId = req.nextUrl.searchParams.get("project_id")
  if (!projectId) return NextResponse.json({ error: "project_id is required" }, { status: 400 })

  const { data, error } = await supabase
    .from("change_orders").select("co_number").eq("project_id", projectId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const { next, display } = nextPcoNumber((data ?? []).map(r => r.co_number))
  return NextResponse.json({ next, display })
}
