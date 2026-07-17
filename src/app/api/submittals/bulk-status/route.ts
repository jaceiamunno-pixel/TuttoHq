import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isReviewStatus } from "@/lib/review-status"

// Bulk set of `review_status` for the Submittal Log's "Set status" selection
// action. Mirrors bulk-fulfilled/route.ts.
//
// Tenancy: the update runs through the RLS-scoped server client, so rows outside
// the caller's company simply won't match — we NEVER accept company_id from the
// client. The response returns the ids that ACTUALLY changed (via .select()), so
// the client reconciles against the real set rather than assuming
// request-set === updated-set.
//
// Vocabulary: `status` must be one of the canonical REVIEW_STATUSES — validated
// here so out-of-vocab input gets a clean 400 instead of the 0046 CHECK's 23514.
//
// Writes review_status ONLY. The date chain (received_date / sent_to_ae_date /
// returned_from_ae_date) is deliberately untouched — Ball-in-Court derives from
// dates, and a bulk status set must not fabricate them.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_IDS = 500

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => null)
  const ids = body?.ids
  const status = body?.status

  if (!isReviewStatus(status)) {
    return NextResponse.json({ error: "status must be a valid review status" }, { status: 400 })
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

  // Single UPDATE, RLS-scoped, active rows only (status='active' is the
  // submittals soft-delete gate — deleted_at is vestigial here, see #104).
  // Only touches review_status — dates / title / description are never sent.
  const { data, error } = await supabase
    .from("submittals")
    .update({ review_status: status })
    .in("id", ids)
    .eq("status", "active")
    .select("id")
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ updated: (data ?? []).map(r => r.id) })
}
