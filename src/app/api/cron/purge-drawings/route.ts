import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"

// ─── /api/cron/purge-drawings ───────────────────────────────────────────────
// Vercel Cron entrypoint (vercel.json). The ONE place drawing data is HARD-
// deleted. Hard-deletes only sheets soft-deleted MORE than RECOVERY_DAYS ago,
// storage-first, with a per-row prefix guard so it can never become a blanket
// wipe. Mirrors the validated manual purge pattern (scripts/purge-drawing-*).
//
// Auth: matches `Authorization: Bearer ${CRON_SECRET}` that Vercel's cron
// runner injects (same as /api/cron/send-reminders). Allow-listed in
// middleware (matcher excludes api/cron) so it isn't redirected to /login.
//
// Service-role client: this is a system sweep across tenants, but EVERY
// deletion is scoped — storage paths must match the owning sheet's own
// {company_id}/drawings/{project_id}/ prefix, and the DB delete re-asserts
// deleted_at is still expired (so a row restored since enumeration survives).

export const dynamic = "force-dynamic"
export const maxDuration = 300

const RECOVERY_DAYS = 5

export async function GET(req: NextRequest) {
  const expected = process.env.CRON_SECRET
  if (!expected) {
    console.error("[cron/purge-drawings] FAIL CRON_SECRET not configured")
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 })
  }
  if ((req.headers.get("authorization") ?? "") !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const admin = createAdminClient()
  const cutoff = new Date(Date.now() - RECOVERY_DAYS * 86400_000).toISOString()

  // 1) Expired soft-deleted sheets across all tenants. Each carries its own
  //    company_id/project_id, used to guard its files below.
  const { data: expired, error: selErr } = await admin
    .from("drawing_sheets")
    .select("id, company_id, project_id, deleted_at")
    .not("deleted_at", "is", null)
    .lt("deleted_at", cutoff)
  if (selErr) {
    console.error("[cron/purge-drawings] select expired failed:", selErr.message)
    return NextResponse.json({ error: selErr.message }, { status: 500 })
  }
  if (!expired || expired.length === 0) {
    return NextResponse.json({ purged_sheets: 0, deleted_objects: 0, skipped_paths: 0 })
  }

  const sheetIds = expired.map(s => s.id)
  const byId = new Map(expired.map(s => [s.id, s]))

  // 2) Enumerate those sheets' revision storage paths.
  const { data: revs, error: revErr } = await admin
    .from("drawing_revisions")
    .select("sheet_id, storage_path")
    .in("sheet_id", sheetIds)
  if (revErr) {
    console.error("[cron/purge-drawings] enumerate revisions failed:", revErr.message)
    return NextResponse.json({ error: revErr.message }, { status: 500 })
  }

  // 3) PREFIX GUARD — a path is deletable only if it starts with its OWN
  //    sheet's {company_id}/drawings/{project_id}/ prefix. Anything else is
  //    skipped and logged, never deleted.
  const toDelete: string[] = []
  const skipped: string[] = []
  for (const r of revs ?? []) {
    const s = byId.get(r.sheet_id)
    if (!s || !r.storage_path) continue
    const guard = `${s.company_id}/drawings/${s.project_id}/`
    if (r.storage_path.startsWith(guard)) toDelete.push(r.storage_path)
    else skipped.push(r.storage_path)
  }
  if (skipped.length > 0) {
    console.error(`[cron/purge-drawings] ${skipped.length} path(s) FAILED prefix guard — NOT deleted:`, skipped.slice(0, 10))
  }

  // 4) STORAGE-FIRST. If a storage delete fails we STOP before touching the DB
  //    so files are never orphaned (the rows stay and retry next run). Chunked.
  let deletedObjects = 0
  for (let i = 0; i < toDelete.length; i += 100) {
    const chunk = toDelete.slice(i, i + 100)
    const { data: removed, error: rmErr } = await admin.storage.from("submittals").remove(chunk)
    if (rmErr) {
      console.error("[cron/purge-drawings] storage remove failed (DB untouched, will retry):", rmErr.message)
      return NextResponse.json({ error: `storage remove failed: ${rmErr.message}`, deleted_objects: deletedObjects }, { status: 500 })
    }
    deletedObjects += removed?.length ?? 0
  }

  // 5) DB delete (drawing_revisions CASCADE via sheet_id FK). Re-assert the
  //    expiry predicate so a sheet RESTORED since step 1 is NOT hard-deleted.
  const { error: delErr, count } = await admin
    .from("drawing_sheets")
    .delete({ count: "exact" })
    .in("id", sheetIds)
    .not("deleted_at", "is", null)
    .lt("deleted_at", cutoff)
  if (delErr) {
    console.error("[cron/purge-drawings] DB delete failed:", delErr.message)
    return NextResponse.json({ error: delErr.message, deleted_objects: deletedObjects }, { status: 500 })
  }

  console.log(`[cron/purge-drawings] purged ${count ?? 0} sheets, ${deletedObjects} objects, ${skipped.length} skipped`)
  return NextResponse.json({ purged_sheets: count ?? 0, deleted_objects: deletedObjects, skipped_paths: skipped.length })
}
