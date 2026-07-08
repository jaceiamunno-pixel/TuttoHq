import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { ESTIMATE_COLUMNS, recalcAndRead, snapshotDefaults, num } from "@/lib/estimate-server"

// Estimates (ADR-015 Phase A). RLS scopes every row to the caller's company via
// get_my_company_id(); project_id is a display filter, not the security boundary.
// company_id is stamped explicitly (resolved server-side) as defense-in-depth on
// top of the column DEFAULT + RLS WITH CHECK. All totals come from
// recalculate_estimate() server-side — never computed in app code (TRUST LAW).

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const pid = req.nextUrl.searchParams.get("project_id")
  let q = supabase.from("estimates").select(ESTIMATE_COLUMNS).order("created_at", { ascending: false })
  if (pid) q = q.eq("project_id", pid)

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ estimates: data ?? [] })
}

// Create a blank estimate (no scaffold). Defaults are snapshotted so the bid
// stack behaves identically to a generated estimate; the generate-from-spec
// scaffold lives in POST /api/estimate/generate.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const projectId = typeof body.project_id === "string" ? body.project_id : ""
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Untitled estimate"
  if (!projectId) return NextResponse.json({ error: "project_id is required" }, { status: 400 })

  const { data: companyId, error: cErr } = await supabase.rpc("get_my_company_id")
  if (cErr || !companyId) return NextResponse.json({ error: "No company association" }, { status: 500 })

  const snap = await snapshotDefaults(supabase)

  const { data: est, error } = await supabase
    .from("estimates")
    .insert({
      project_id: projectId,
      company_id: companyId,
      name,
      status: "draft",
      ...snap,
      permit_amount: 0,
      sqft: num(body.sqft),
      created_by: user.id,
    })
    .select("id")
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const { estimate, error: rErr } = await recalcAndRead(supabase, est.id)
  if (rErr) return NextResponse.json({ error: rErr }, { status: 500 })
  return NextResponse.json({ id: est.id, estimate })
}
