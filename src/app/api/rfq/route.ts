import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// RFQ (Bid Requests) — ADR-016 v1a. Every query below is RLS-scoped to the
// caller's company via get_my_company_id(); project_id is a display filter, not
// the security boundary. The insert also stamps company_id explicitly (resolved
// server-side) as defense-in-depth on top of the column DEFAULT + RLS WITH CHECK.

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const pid = req.nextUrl.searchParams.get("project_id")
  let q = supabase.from("rfqs").select("*").order("created_at", { ascending: false })
  if (pid) q = q.eq("project_id", pid)

  const { data: rfqs, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Attach per-RFQ recipient aggregates for the status-log at-a-glance view.
  const ids = (rfqs ?? []).map(r => r.id)
  const counts = new Map<string, { total: number; quotes: number }>()
  if (ids.length) {
    const { data: recips } = await supabase
      .from("rfq_recipients")
      .select("rfq_id, state")
      .in("rfq_id", ids)
    for (const r of recips ?? []) {
      const c = counts.get(r.rfq_id) ?? { total: 0, quotes: 0 }
      c.total += 1
      if (r.state === "quote_received") c.quotes += 1
      counts.set(r.rfq_id, c)
    }
  }

  const withCounts = (rfqs ?? []).map(r => ({
    ...r,
    recipient_count: counts.get(r.id)?.total ?? 0,
    quote_received_count: counts.get(r.id)?.quotes ?? 0,
  }))

  return NextResponse.json({ rfqs: withCounts })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body: Record<string, string | null> = await req.json().catch(() => ({}))
  const { name, scope_description, csi_division, due_date, project_id } = body

  if (!name?.trim()) return NextResponse.json({ error: "name is required" }, { status: 400 })
  if (!project_id) return NextResponse.json({ error: "project_id is required" }, { status: 400 })

  // Resolve the caller's company so the row is explicitly tenant-stamped.
  const { data: companyId, error: cErr } = await supabase.rpc("get_my_company_id")
  if (cErr || !companyId) return NextResponse.json({ error: "No company association" }, { status: 500 })

  const { data, error } = await supabase.from("rfqs").insert({
    project_id,
    company_id:        companyId,
    name:              name.trim(),
    scope_description: scope_description?.trim() || null,
    csi_division:      csi_division?.trim() || null,
    due_date:          due_date || null,
    status:            "draft",
    uploaded_by:       user.id,
  }).select("id").single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, id: data.id })
}
