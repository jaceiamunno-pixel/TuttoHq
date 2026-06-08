import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// POST /api/drawings/discard-staging — Drawing Log splitter (ADR-005
// Subsystem 1). Purges a batch's staged per-sheet PDFs when the user cancels
// the import (or after a partial/abandoned session). Mirrors the spec-book /
// bulk-import staging auto-purge: scratch bytes under drawing-staging/ are
// never canonical, so removing them is safe once the user walks away.
//
// Tenant-scoped: only ever touches {companyId}/drawing-staging/{batchId}/.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => null)
  const batchId: string = typeof body?.batch_id === "string" ? body.batch_id.trim() : ""
  if (!/^[a-zA-Z0-9._-]+$/.test(batchId)) {
    return NextResponse.json({ error: "valid batch_id required" }, { status: 400 })
  }

  const { data: companyId } = await supabase.rpc("get_my_company_id")
  if (!companyId) return NextResponse.json({ error: "No company association" }, { status: 500 })

  const folder = `${companyId}/drawing-staging/${batchId}`
  const { data: listed, error: listErr } = await supabase.storage
    .from("submittals")
    .list(folder, { limit: 1000 })
  if (listErr) return NextResponse.json({ error: listErr.message }, { status: 500 })

  const paths = (listed ?? [])
    .filter(o => o.name && !o.name.endsWith("/"))
    .map(o => `${folder}/${o.name}`)
  if (paths.length === 0) return NextResponse.json({ ok: true, removed: 0 })

  const { error: rmErr } = await supabase.storage.from("submittals").remove(paths)
  if (rmErr) return NextResponse.json({ error: rmErr.message }, { status: 500 })

  return NextResponse.json({ ok: true, removed: paths.length })
}
