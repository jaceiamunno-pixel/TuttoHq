import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { runStripBackfill } from "@/lib/strip-backfill"

// POST /api/admin/strip-backfill — reconcile the caller's company: generate the
// missing stripped Library copy for submittals whose ORIGINAL embeds a
// coversheet but that never got a stripped copy (so PR #116 doesn't stack a
// second cover). Reuses the upload path's exact detector (findStripPlan).
//
// DRY-RUN BY DEFAULT. The body must carry { apply: true } AND the caller must
// be an admin for any write to happen. Without apply, it reads the originals
// and returns the full plan — no storage object, no column update.
//
// Company-scoped: the authed cookie client means RLS confines every read and
// write to the caller's own company. There is no cross-tenant path.
//
// Downloading + stripping N PDFs is slow; raise the ceiling.
export const maxDuration = 300

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: role } = await supabase.rpc("get_my_role")
  if (role !== "admin") {
    return NextResponse.json({ error: "Admin role required" }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const apply = body?.apply === true
  const limit = typeof body?.limit === "number" && body.limit > 0 ? Math.floor(body.limit) : undefined

  // The write pass is deliberately opt-in per-call: dryRun unless apply=true.
  const report = await runStripBackfill(supabase, { dryRun: !apply, limit })

  return NextResponse.json(report)
}
