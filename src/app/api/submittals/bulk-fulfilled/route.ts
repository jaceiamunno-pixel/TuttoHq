import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// Bulk toggle of `fulfilled_by_other` (migration 0043) for the Submittal Log's
// "Mark fulfilled by other submittal" selection action.
//
// Tenancy: the update runs through the RLS-scoped server client, so rows outside
// the caller's company simply won't match — we NEVER accept company_id from the
// client. The response returns the ids that ACTUALLY changed (via .select()), so
// the client reconciles against the real set rather than assuming
// request-set === updated-set.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_IDS = 500

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => null)
  const ids = body?.ids
  const value = body?.value

  if (typeof value !== "boolean") {
    return NextResponse.json({ error: "value must be a boolean" }, { status: 400 })
  }
  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: "ids must be a non-empty array" }, { status: 400 })
  }
  if (ids.length > MAX_IDS) {
    return NextResponse.json({ error: `too many ids (max ${MAX_IDS})` }, { status: 400 })
  }
  if (!ids.every((id: unknown) => typeof id === "string" && UUID_RE.test(id))) {
    return NextResponse.json({ error: "ids must all be uuids" }, { status: 400 })
  }

  // Single UPDATE, RLS-scoped. Only touches fulfilled_by_other — description /
  // title / review_status / revision are never sent.
  const { data, error } = await supabase
    .from("submittals")
    .update({ fulfilled_by_other: value })
    .in("id", ids)
    .select("id, fulfilled_by_other")
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ updated: (data ?? []).map(r => r.id) })
}
