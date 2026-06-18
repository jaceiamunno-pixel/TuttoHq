import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"
import { createClient } from "@/lib/supabase/server"
import { isValidSha256 } from "@/lib/file-hash"
import { hashBufferInNode } from "@/lib/file-hash-node"

// /api/drawings/sheets/[id]/revisions — ADD A REVISION to an existing sheet
// (ADR-005 Subsystem 4, v1). CAREFUL-LANE.
//
// MATCHING IS EXPLICIT: the target sheet is the [id] in the URL — a sheet the
// user picked in the UI — never auto-matched by content. RLS returns that
// sheet only if it belongs to the caller's company, so a revision can only
// ever attach to a sheet the caller owns and explicitly chose. No content
// heuristic, so no risk of attaching to the wrong sheet.
//
// BOTH COPIES STAY (never-overwrite guarantee):
//   - the new revision gets a FRESH randomUUID() → a DISTINCT storage path
//     {companyId}/drawings/{projectId}/{sheetId}/{revisionId}.pdf, so it can
//     never collide with or overwrite a prior revision's file;
//   - it is an INSERT of a new drawing_revisions row — prior revision rows and
//     their files are never updated or deleted;
//   - the only mutation to existing data is drawing_sheets.current_revision_id
//     (a pointer flip) — the prior revision row remains intact and visible in
//     history.
//
// Server-recomputed SHA-256 integrity gate on the new file (same contract as
// the splitter commit). Authed RLS-scoped client throughout (never privileged).

export const maxDuration = 60

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id: sheetId } = await params
  if (!sheetId) return NextResponse.json({ error: "id required" }, { status: 400 })

  const body = await req.json().catch(() => null)
  const stagingPath: string = typeof body?.staging_path === "string" ? body.staging_path.trim() : ""
  const fileSha256: unknown = body?.file_sha256
  const revisionLabel: string = typeof body?.revision_label === "string" ? body.revision_label.trim() : ""
  const fileSize: number | null = typeof body?.file_size === "number" && body.file_size > 0 ? body.file_size : null

  if (!stagingPath) return NextResponse.json({ error: "staging_path required" }, { status: 400 })
  if (!isValidSha256(fileSha256)) return NextResponse.json({ error: "file_sha256 missing or malformed" }, { status: 400 })

  const { data: companyId } = await supabase.rpc("get_my_company_id")
  if (!companyId) return NextResponse.json({ error: "No company association" }, { status: 500 })

  // Target sheet must be visible to the caller (RLS = same company) and live.
  const { data: sheet, error: selErr } = await supabase
    .from("drawing_sheets")
    .select("id, project_id, deleted_at")
    .eq("id", sheetId)
    .maybeSingle()
  if (selErr) return NextResponse.json({ error: selErr.message }, { status: 500 })
  if (!sheet) return NextResponse.json({ error: "sheet not found" }, { status: 404 })
  if (sheet.deleted_at) return NextResponse.json({ error: "cannot add a revision to a deleted sheet" }, { status: 409 })

  // Staging path must live under the caller's own drawing-staging dir.
  const stagingPrefix = `${companyId}/drawing-staging/`
  if (!stagingPath.startsWith(stagingPrefix) || stagingPath.slice(stagingPrefix.length).includes("..")) {
    return NextResponse.json({ error: "staging_path is outside this company's drawing-staging directory" }, { status: 400 })
  }

  // FRESH revisionId → DISTINCT final path. Cannot collide with a prior file.
  const revisionId = randomUUID()
  const finalPath = `${companyId}/drawings/${sheet.project_id}/${sheetId}/${revisionId}.pdf`

  // Copy staged → final (bounded retry; storage races shouldn't drop the rev).
  let copyErr: string | null = "unknown error"
  for (let i = 0; i < 3; i++) {
    const { error } = await supabase.storage.from("submittals").copy(stagingPath, finalPath)
    if (!error) { copyErr = null; break }
    copyErr = error.message
    await sleep(150 * (i + 1))
  }
  if (copyErr) return NextResponse.json({ error: `storage copy failed: ${copyErr}` }, { status: 500 })

  // Integrity gate: recompute SHA-256 on the bytes that landed; must equal the
  // client-declared hash. Bounded retry for copy-settle. On failure, delete the
  // NEW object only — the sheet and all prior revisions are untouched.
  let serverHash: string | null = null
  let finalBuf: Buffer | null = null
  let integErr = "unknown error"
  for (let i = 0; i < 3; i++) {
    const { data: blob, error } = await supabase.storage.from("submittals").download(finalPath)
    if (error || !blob) { integErr = error?.message ?? "no blob"; await sleep(150 * (i + 1)); continue }
    finalBuf = Buffer.from(await blob.arrayBuffer())
    const h = await hashBufferInNode(finalBuf)
    if (h === fileSha256) { serverHash = h; break }
    integErr = `stored bytes hash ${h.slice(0, 12)}… ≠ declared ${String(fileSha256).slice(0, 12)}… (attempt ${i + 1}/3)`
    await sleep(150 * (i + 1))
  }
  if (!serverHash || !finalBuf) {
    await supabase.storage.from("submittals").remove([finalPath]).catch(() => {})
    return NextResponse.json({ error: `integrity check failed: ${integErr}` }, { status: 422 })
  }

  // INSERT the new revision (never touches prior rows). company_id via DEFAULT.
  const { data: revision, error: revErr } = await supabase
    .from("drawing_revisions")
    .insert({
      id: revisionId,
      sheet_id: sheetId,
      revision_label: revisionLabel || "Rev",
      storage_path: finalPath,
      file_sha256: serverHash,
      file_size: fileSize ?? finalBuf.length,
      source: "uploaded",
      uploaded_by: user.id,
    })
    .select("id")
    .single()
  if (revErr || !revision) {
    await supabase.storage.from("submittals").remove([finalPath]).catch(() => {})
    return NextResponse.json({ error: `revision insert failed: ${revErr?.message ?? "no row"}` }, { status: 500 })
  }

  // Flip the sheet's current pointer to the new revision. Prior revision row
  // stays in the table (preserved). Failure here leaves the new revision
  // committed + integrity-verified; surface a warning, don't roll back data.
  const { error: upErr } = await supabase
    .from("drawing_sheets")
    .update({ current_revision_id: revisionId })
    .eq("id", sheetId)
  if (upErr) console.warn("[drawings-revisions] current_revision_id update failed for sheet", sheetId, upErr.message)

  // Purge the staging scratch (best-effort; canonical bytes are at finalPath).
  await supabase.storage.from("submittals").remove([stagingPath]).catch(() => {})

  return NextResponse.json({ ok: true, sheet_id: sheetId, revision_id: revisionId, storage_path: finalPath })
}

// GET /api/drawings/sheets/[id]/revisions — revision history for a sheet
// (proves "both copies stay"). RLS-scoped; signs each file for download.
//
// ?deleted=true → the revision recycle-bin. The SELECT RLS policy filters
// deleted_at IS NULL, so the authed client CANNOT read soft-deleted revisions;
// list_deleted_drawing_revisions(p_sheet_id) is a SECURITY DEFINER function that
// is company-scoped internally (get_my_company_id()) AND sheet-scoped, so it can
// only ever return THIS caller's own deleted revisions for THIS sheet. Unlike
// sheets there is no recovery countdown — the purge cron only hard-deletes expired
// *sheets* (cascading their revisions), never standalone revisions, so a deleted
// revision on a live sheet is recoverable indefinitely.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id: sheetId } = await params
  if (!sheetId) return NextResponse.json({ error: "id required" }, { status: 400 })

  // Sheet must be RLS-visible (same company, live) — clean 404 + ownership check.
  const { data: sheet } = await supabase
    .from("drawing_sheets")
    .select("id, current_revision_id")
    .eq("id", sheetId)
    .maybeSingle()
  if (!sheet) return NextResponse.json({ error: "sheet not found" }, { status: 404 })

  const wantDeleted = req.nextUrl.searchParams.get("deleted") === "true"

  interface RevRow { id: string; revision_label: string | null; file_size: number | null; created_at: string; storage_path: string | null }
  let rows: RevRow[]
  if (wantDeleted) {
    const { data, error } = await supabase.rpc("list_deleted_drawing_revisions", { p_sheet_id: sheetId })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    rows = (data ?? []) as RevRow[]      // SECURITY DEFINER fn already orders by deleted_at DESC
  } else {
    const { data, error } = await supabase
      .from("drawing_revisions")
      .select("id, revision_label, file_size, file_sha256, created_at, storage_path")
      .eq("sheet_id", sheetId)
      .order("created_at", { ascending: false })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    rows = (data ?? []) as RevRow[]
  }

  const signed = await Promise.all(
    rows.map(r => r.storage_path
      ? supabase.storage.from("submittals").createSignedUrl(r.storage_path, 3600)
      : Promise.resolve({ data: null })),
  )

  const out = rows.map((r, i) => ({
    id: r.id,
    revision_label: r.revision_label,
    file_size: r.file_size,
    created_at: r.created_at,
    // Deleted revisions are never current (the current_revision_id invariant), so
    // is_current is always false in the recycle-bin view.
    is_current: !wantDeleted && r.id === sheet.current_revision_id,
    file_url: (signed[i] as { data: { signedUrl?: string } | null }).data?.signedUrl ?? null,
  }))

  return NextResponse.json({ revisions: out })
}
