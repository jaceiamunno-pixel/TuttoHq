import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"
import { createClient } from "@/lib/supabase/server"
import { isValidSha256 } from "@/lib/file-hash"
import { hashBufferInNode } from "@/lib/file-hash-node"

// POST /api/drawings/commit — Drawing Log splitter (ADR-005 Subsystem 1),
// transactional COMMIT. CAREFUL-LANE: file integrity, tenant-isolated paths,
// server-set ownership.
//
// Per included row (each independent — one bad row errors only itself):
//   1. Validate staging_path is inside THIS company's drawing-staging/ dir.
//   2. Insert drawing_sheets (project verified in caller's company;
//      company_id via the get_my_company_id() DEFAULT — NOT from client;
//      uploaded_by = authed user). search_vector is generated.
//   3. COPY staged file → final tenant path
//      {companyId}/drawings/{projectId}/{sheetId}/{revisionId}.pdf
//   4. FILE-INTEGRITY GATE — re-download the FINAL object, recompute SHA-256
//      server-side, and compare to the client-declared hash. On mismatch:
//      delete the copied object, delete the sheet row, error the row. Nothing
//      becomes canonical unless the bytes that actually landed verify.
//   5. Insert drawing_revisions (source='uploaded', file_sha256 = the
//      SERVER-recomputed hash, file_size, uploaded_by = authed user).
//   6. Set drawing_sheets.current_revision_id.
//   7. Purge the staging object (best-effort).
//
// v1 = NEW sheets only. No cross-upload matching (subsystem 4). No AI here.
//
// Tenant safety: every query runs through the caller's authed client (RLS
// enforces company on SELECT/INSERT/UPDATE), AND project membership is
// re-asserted explicitly. company_id + uploaded_by are set server-side and
// never trusted from the request body.

export const maxDuration = 60

interface RowIn {
  client_row_id: string
  staging_path: string
  file_name: string
  file_size?: number | null
  file_sha256?: string | null
  sheet_number?: string | null
  title?: string | null
  discipline?: string | null
  discipline_prefix?: string | null
  revision_label?: string | null
}

interface CommitResult {
  client_row_id: string
  status: "ok" | "error"
  sheet_id?: string
  revision_id?: string
  storage_path?: string
  error?: string
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => null)
  const projectId: string = typeof body?.project_id === "string" ? body.project_id.trim() : ""
  const rows: RowIn[] = Array.isArray(body?.rows) ? body.rows : []

  if (!projectId) return NextResponse.json({ error: "project_id required" }, { status: 400 })
  if (rows.length === 0) return NextResponse.json({ error: "rows required" }, { status: 400 })
  if (rows.length > 300) return NextResponse.json({ error: "too many rows (max 300)" }, { status: 400 })

  const { data: companyId, error: cErr } = await supabase.rpc("get_my_company_id")
  if (cErr || !companyId) {
    return NextResponse.json({ error: "No company association" }, { status: 500 })
  }

  // Defense-in-depth: the project must belong to the caller's company.
  const { data: project, error: pErr } = await supabase
    .from("projects")
    .select("id, company_id")
    .eq("id", projectId)
    .single()
  if (pErr || !project) {
    return NextResponse.json({ error: "project not found or not accessible" }, { status: 404 })
  }
  if (project.company_id !== companyId) {
    return NextResponse.json({ error: "project not in your company" }, { status: 403 })
  }

  const stagingPrefix = `${companyId}/drawing-staging/`
  const results: CommitResult[] = []

  const sleep = (ms: number) => new Promise<void>(res => setTimeout(res, ms))
  // Bounded retry on the transient storage steps. A copy→download race can
  // momentarily return a stale/empty object and trip the sha256 gate; a short
  // retry stops a transient blip from permanently dropping an APPROVED sheet
  // (the S-303 class of failure). The integrity contract is unchanged — the
  // server-recomputed hash must still equal the client-declared hash; we just
  // allow a few attempts for the copy to settle before failing the row.
  const copyWithRetry = async (from: string, to: string): Promise<string | null> => {
    let last = "unknown error"
    for (let i = 0; i < 3; i++) {
      const { error } = await supabase.storage.from("submittals").copy(from, to)
      if (!error) return null
      last = error.message
      await sleep(150 * (i + 1))
    }
    return last
  }
  const downloadAndVerify = async (path: string, expected: string): Promise<{ buf?: Buffer; hash?: string; error?: string }> => {
    let last = "unknown error"
    for (let i = 0; i < 3; i++) {
      const { data: blob, error } = await supabase.storage.from("submittals").download(path)
      if (error || !blob) { last = error?.message ?? "no blob"; await sleep(150 * (i + 1)); continue }
      const buf = Buffer.from(await blob.arrayBuffer())
      const hash = await hashBufferInNode(buf)
      if (hash === expected) return { buf, hash }
      last = `stored bytes hash ${hash.slice(0, 12)}… ≠ declared ${expected.slice(0, 12)}… (attempt ${i + 1}/3)`
      await sleep(150 * (i + 1))
    }
    return { error: last }
  }

  for (const r of rows) {
    const cid = typeof r.client_row_id === "string" ? r.client_row_id : ""
    // Every failure is logged server-side (row id + sheet number + reason) —
    // the error must never live only in the HTTP response (S-303's actual
    // cause was lost that way and is now unrecoverable).
    const fail = (error: string) => {
      console.error(`[drawings-commit] row FAILED — client_row_id=${cid} sheet_number=${JSON.stringify(r?.sheet_number ?? null)}: ${error}`)
      results.push({ client_row_id: cid, status: "error", error })
    }

    if (!cid) { results.push({ client_row_id: "", status: "error", error: "client_row_id missing" }); continue }
    if (!r.staging_path || typeof r.staging_path !== "string") { fail("staging_path missing"); continue }
    if (!r.staging_path.startsWith(stagingPrefix)) { fail("staging_path is outside this company's drawing-staging directory"); continue }
    if (r.staging_path.slice(stagingPrefix.length).includes("..")) { fail("invalid staging_path"); continue }
    const sheetNumber = (r.sheet_number ?? "").toString().trim()
    if (!sheetNumber) { fail("sheet_number required (blank rows must be filled before commit)"); continue }
    if (!isValidSha256(r.file_sha256)) { fail("file_sha256 missing or malformed — cannot verify integrity"); continue }

    // 1) Insert the sheet. company_id := get_my_company_id() DEFAULT (server),
    //    uploaded_by := authed user (server). search_vector is generated.
    const { data: sheet, error: sErr } = await supabase
      .from("drawing_sheets")
      .insert({
        project_id: projectId,
        sheet_number: sheetNumber,
        title: (r.title ?? "")?.toString().trim() || null,
        discipline: (r.discipline ?? "")?.toString().trim() || null,
        discipline_prefix: (r.discipline_prefix ?? "")?.toString().trim() || null,
        uploaded_by: user.id,
      })
      .select("id")
      .single()
    if (sErr || !sheet) { fail(`sheet insert failed: ${sErr?.message ?? "no row"}`); continue }
    const sheetId = sheet.id as string

    // 2) Copy staged → final tenant-isolated path.
    const revisionId = randomUUID()
    const finalPath = `${companyId}/drawings/${projectId}/${sheetId}/${revisionId}.pdf`
    const copyErr = await copyWithRetry(r.staging_path, finalPath)
    if (copyErr) {
      await supabase.from("drawing_sheets").delete().eq("id", sheetId)
      fail(`storage copy failed after retries: ${copyErr}`)
      continue
    }

    // 3) FILE-INTEGRITY GATE — recompute SHA-256 on the bytes that actually
    //    landed and compare to the client-declared hash before finalizing.
    //    Bounded-retried so a copy that hasn't settled yet doesn't drop the row.
    const dl = await downloadAndVerify(finalPath, r.file_sha256 as string)
    if (dl.error || !dl.buf || !dl.hash) {
      await supabase.storage.from("submittals").remove([finalPath]).catch(() => {})
      await supabase.from("drawing_sheets").delete().eq("id", sheetId)
      fail(`integrity check failed after retries: ${dl.error ?? "no bytes"}`)
      continue
    }
    const finalBuf = dl.buf
    const serverHash = dl.hash
    const fileSize = typeof r.file_size === "number" && r.file_size > 0 ? r.file_size : finalBuf.length

    // 4) Insert the revision (server-recomputed hash is authoritative).
    const { data: revision, error: rErr } = await supabase
      .from("drawing_revisions")
      .insert({
        id: revisionId,
        sheet_id: sheetId,
        revision_label: (r.revision_label ?? "")?.toString().trim() || "Rev 0",
        storage_path: finalPath,
        file_sha256: serverHash,
        file_size: fileSize,
        source: "uploaded",
        uploaded_by: user.id,
      })
      .select("id")
      .single()
    if (rErr || !revision) {
      await supabase.storage.from("submittals").remove([finalPath]).catch(() => {})
      await supabase.from("drawing_sheets").delete().eq("id", sheetId)
      fail(`revision insert failed: ${rErr?.message ?? "no row"}`)
      continue
    }

    // 5) Point the sheet at its current revision.
    const { error: upErr } = await supabase
      .from("drawing_sheets")
      .update({ current_revision_id: revisionId })
      .eq("id", sheetId)
    if (upErr) {
      // Sheet + revision both exist and verify; only the back-ref failed.
      // Don't roll back committed, integrity-verified data — surface a warning.
      console.warn("[drawings-commit] current_revision_id update failed for sheet", sheetId, upErr.message)
    }

    // 6) Purge the staging scratch object (best-effort; the canonical bytes
    //    now live under drawings/ and are integrity-verified).
    await supabase.storage.from("submittals").remove([r.staging_path]).catch(() => {})

    results.push({ client_row_id: cid, status: "ok", sheet_id: sheetId, revision_id: revisionId, storage_path: finalPath })
  }

  return NextResponse.json({ project_id: projectId, results })
}
