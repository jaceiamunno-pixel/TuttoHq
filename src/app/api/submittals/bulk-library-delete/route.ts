import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { libraryDeleteOne, type LibraryDeleteAction } from "@/lib/library-delete-core"

// POST /api/submittals/bulk-library-delete — { ids: string[], action: "clear" | "delete" }
//
// The Submittal Log's bulk selection action. Runs the SAME per-row logic as
// POST /api/submittals/[id]/library-delete (shared libraryDeleteOne core,
// storage objects removed orphan-checked) over a bounded id list under ONE
// EXPLICIT action — the destructive verb the user confirmed travels in the
// body and is never inferred from selection shape — and reports a per-row
// outcome instead of all-or-nothing.
//
// action "clear" (spec rows only — detach the document, keep the row):
//   cleared  — spec row with a file: attachments + storage gone, row kept
//   skipped(nothing_to_clear) — spec placeholder: no file; running detach
//              would clobber review_status for no benefit
//   skipped(clear_not_valid)  — manual/gmail row: clear NEVER deletes a
//              manual row; there is no placeholder worth keeping
//
// action "delete" (ANY row kind — the 2026-07-17 reversal: spec rows,
// placeholders included, ARE deletable):
//   deleted  — soft-deleted (status='deleted'; deleted_at never written),
//              attachments + storage gone; section_seq kept so the retired
//              CM number is never reused and survivors' numbers never shift
//
// Both actions:
//   skipped(not_found)        — no such row visible to this user (RLS)
//   skipped(already_deleted)  — status='deleted' (e.g. another tab)
//   failed(not_in_company)    — explicit company mismatch
//   failed   — the row's delete/detach errored mid-flight; `reason` is the
//              error text. Rows that already succeeded are NOT rolled back —
//              their storage objects are already gone, so pretending the
//              batch didn't happen would be a lie. The client reconciles
//              against this result set, not the request set.
//
// Classification is decided SERVER-SIDE from freshly-loaded DB rows — the
// client's idea of which rows are spec/manual/placeholder is never trusted
// (its state can be stale: a file attached from another tab must not be
// cleared under a dialog that promised "skipped").
//
// Tenancy: auth + explicit company match (403-equivalent surfaces as a
// failed row with reason not_in_company) + RLS on every statement.
//
// Batch bound: MAX_IDS is 100 (not bulk-status's 500) because every row does
// real storage work — attachment deletes + orphan checks + object removal.
// The client sends chunks of 50 and shows progress between them, so a single
// request stays far under the function timeout. Rows are processed through a
// small concurrency pool; two selected rows sharing one storage object may
// then each see the other as a live reference and both keep it — that
// leftover is a reclaimable orphan, the same best-effort class as a failed
// storage removal in the per-row route.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_IDS = 100
const CONCURRENCY = 4

type RowOutcome = {
  id: string
  outcome: "cleared" | "deleted" | "skipped" | "failed"
  reason?: string
  storage_removed?: number
  storage_kept?: number
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: companyId } = await supabase.rpc("get_my_company_id")
  if (!companyId) return NextResponse.json({ error: "No company association" }, { status: 500 })

  const body = await req.json().catch(() => null)
  // Explicit action, required — same contract as the per-row route. Never
  // inferred from the rows: a spec row supports both.
  const actionRaw = body?.action as unknown
  if (actionRaw !== "clear" && actionRaw !== "delete") {
    return NextResponse.json(
      { error: 'action is required: "clear" (remove files, keep spec rows) or "delete" (soft-delete rows)' },
      { status: 400 },
    )
  }
  const action: LibraryDeleteAction = actionRaw
  const rawIds = body?.ids
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    return NextResponse.json({ error: "ids must be a non-empty array" }, { status: 400 })
  }
  if (rawIds.length > MAX_IDS) {
    return NextResponse.json({ error: `too many ids (max ${MAX_IDS})` }, { status: 400 })
  }
  if (!rawIds.every((id: unknown) => typeof id === "string" && UUID_RE.test(id))) {
    return NextResponse.json({ error: "ids must all be uuids" }, { status: 400 })
  }
  const ids = [...new Set(rawIds as string[])]

  // Fresh server-side load of every requested row — the ONLY classification
  // input. RLS already scopes this to the caller's visibility.
  const { data: rows, error: selErr } = await supabase
    .from("submittals")
    .select("id, company_id, spec_section_id, storage_path, status")
    .in("id", ids)
  if (selErr) return NextResponse.json({ error: selErr.message }, { status: 500 })

  const byId = new Map((rows ?? []).map(r => [r.id, r]))
  const results: RowOutcome[] = []
  const actionable: NonNullable<typeof rows>[number][] = []

  for (const id of ids) {
    const row = byId.get(id)
    if (!row) {
      results.push({ id, outcome: "skipped", reason: "not_found" })
    } else if (row.company_id !== companyId) {
      results.push({ id, outcome: "failed", reason: "not_in_company" })
    } else if (row.status === "deleted") {
      results.push({ id, outcome: "skipped", reason: "already_deleted" })
    } else if (action === "clear" && row.spec_section_id == null) {
      // Clear never touches a manual/gmail row — no placeholder to keep.
      results.push({ id, outcome: "skipped", reason: "clear_not_valid" })
    } else if (action === "clear" && !row.storage_path) {
      // Spec placeholder — nothing to clear. (Under "delete" the same row IS
      // actionable: placeholders are deletable since the 2026-07-17 reversal.)
      results.push({ id, outcome: "skipped", reason: "nothing_to_clear" })
    } else {
      actionable.push(row)
    }
  }

  // Small worker pool over the actionable rows. Each row is fully independent
  // (own attachment rows, own branch update, own storage cleanup), so one
  // row's failure never blocks or reverts the others.
  let next = 0
  async function worker() {
    while (next < actionable.length) {
      const row = actionable[next++]
      try {
        const r = await libraryDeleteOne(supabase, row, action)
        if (r.ok) {
          results.push({
            id: row.id,
            outcome: r.mode === "detach" ? "cleared" : "deleted",
            storage_removed: r.storage_removed,
            storage_kept: r.storage_kept,
          })
        } else {
          results.push({ id: row.id, outcome: "failed", reason: r.error })
        }
      } catch (err) {
        results.push({ id: row.id, outcome: "failed", reason: err instanceof Error ? err.message : "unexpected error" })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, actionable.length) }, () => worker()))

  const summary = { cleared: 0, deleted: 0, skipped: 0, failed: 0 }
  for (const r of results) summary[r.outcome]++

  return NextResponse.json({ results, summary })
}
