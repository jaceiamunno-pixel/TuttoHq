import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// POST /api/bulk-import/commit — Stage 2a write path. Attach each Bulk
// Import row to its user-confirmed spec-built submittals row. Model A:
// matches into existing rows; NEVER creates a row.
//
// HARD WRITE RULES:
//   1. Caller must own the project (project.company_id == caller company).
//   2. Each target row must belong to: caller's company, the specified
//      project, source = 'spec_ingestion', and have NO existing PDF
//      attached (storage_path IS NULL). Re-commit is refused — the
//      operator must explicitly clear the old attachment first.
//   3. Each staging_path must be inside the caller's own
//      `{company}/bulk-import-staging/` directory.
//   4. Each row commit is independent: a single bad row produces a per-row
//      error in the response, not an envelope failure. The other rows in
//      the batch commit normally.
//   5. Storage transactionality: COPY (not move) from staging to uploads.
//      The DB UPDATE runs after the copy succeeds. On UPDATE failure we
//      attempt to delete the freshly-copied uploads object so it doesn't
//      become an orphan. The staging copy stays — Stage 2b's auto-purge
//      will sweep it (or a row whose UPDATE fails can be retried since
//      staging still holds the bytes).
//   6. NO AI in the commit path. No retry loops. No background recursion.
//
// Cross-tenant safety: every SELECT / UPDATE goes through the caller's
// authenticated client (RLS enforces company), AND the WHERE clauses on
// .eq("company_id") / .eq("project_id") explicitly re-filter. Either one
// alone is sufficient; both together is defense-in-depth.

interface RowIn {
  /** Modal-local id; echoed back so the client can map result → row. */
  client_row_id: string
  /** The spec-built submittals row the user confirmed (auto-matched OR
   *  user-picked in the ambiguous / no-match flows). */
  target_row_id: string
  /** {company}/bulk-import-staging/{uuid}_filename.pdf — where the
   *  analyzed PDF lives now. The route copies it to uploads/. */
  staging_path: string
  /** Clean original filename (no UUID prefix). */
  file_name: string
  file_size: number
  /** YYYY-MM-DD architect approval date (from the PDF /Stamp annotation
   *  /CreationDate). Empty/null when no stamp was found — the operator
   *  must enter it before commit. NEVER the GC's submission date. */
  approval_date: string | null
  /** YYYY-MM-DD GC submission date (Waters Text4 "Date Submitted").
   *  Stored separately from approval_date so the two are never confused.
   *  Propagates via the trigger to submittals.sent_to_ae_date. */
  submitted_date: string | null
  /** GC-side submittal number (Waters Text5, e.g. "080"). Stored in
   *  submittal_number for visibility; NOT a join key. */
  submittal_number: string | null
  revision_number: string | null
  /** "Approved" / "Approved with Comments" / "Rejected" / "Revise and Resubmit". */
  review_status: string
}

interface CommitResult {
  client_row_id: string
  status: "ok" | "error"
  row_id?: string
  attached_path?: string
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
  if (rows.length > 100) return NextResponse.json({ error: "too many rows (max 100)" }, { status: 400 })

  const { data: companyId, error: cErr } = await supabase.rpc("get_my_company_id")
  if (cErr || !companyId) {
    return NextResponse.json({ error: "No company association" }, { status: 500 })
  }

  // Defense-in-depth: confirm the project is in the caller's company.
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

  const results: CommitResult[] = []
  const nowIso = new Date().toISOString()

  for (const r of rows) {
    const cid = typeof r.client_row_id === "string" ? r.client_row_id : ""
    if (!cid) {
      results.push({ client_row_id: "", status: "error", error: "client_row_id missing" })
      continue
    }
    if (!r.target_row_id || typeof r.target_row_id !== "string") {
      results.push({ client_row_id: cid, status: "error", error: "target_row_id missing" })
      continue
    }
    if (!r.staging_path || typeof r.staging_path !== "string") {
      results.push({ client_row_id: cid, status: "error", error: "staging_path missing" })
      continue
    }
    if (!r.file_name || typeof r.file_name !== "string") {
      results.push({ client_row_id: cid, status: "error", error: "file_name missing" })
      continue
    }

    // Staging path must live inside the caller's own staging dir.
    const stagingPrefix = `${companyId}/bulk-import-staging/`
    if (!r.staging_path.startsWith(stagingPrefix)) {
      results.push({
        client_row_id: cid, status: "error",
        error: "staging_path is outside this company's staging directory",
      })
      continue
    }

    // Verify the target row is a writable spec-built placeholder in this
    // project. RLS already scopes by company on SELECT; we additionally
    // assert company_id and project_id explicitly.
    const { data: target, error: tErr } = await supabase
      .from("submittals")
      .select("id, company_id, project_id, source, status, storage_path")
      .eq("id", r.target_row_id)
      .single()
    if (tErr || !target) {
      results.push({ client_row_id: cid, status: "error", error: "target row not found" })
      continue
    }
    if (target.company_id !== companyId) {
      results.push({ client_row_id: cid, status: "error", error: "target row not in your company" })
      continue
    }
    if (target.project_id !== projectId) {
      results.push({ client_row_id: cid, status: "error", error: "target row is in a different project" })
      continue
    }
    if (target.source !== "spec_ingestion") {
      results.push({
        client_row_id: cid, status: "error",
        error: "target row is not a spec-built placeholder (re-commit not supported)",
      })
      continue
    }
    if (target.status === "deleted") {
      results.push({ client_row_id: cid, status: "error", error: "target row is deleted" })
      continue
    }
    // No more storage_path-non-null refuse. Stage 2a-v2 allows multiple
    // attachments per submittal — each commit adds a new attachment under
    // the same parent row, and the RPC decides whether it becomes current
    // based on revision number (newest wins) rather than insertion order.

    // Derive the canonical uploads path. Keep the UUID prefix from staging
    // so storage paths stay unique per attachment.
    const stagingBase = r.staging_path.slice(stagingPrefix.length)
    if (!stagingBase || stagingBase.includes("/")) {
      results.push({
        client_row_id: cid, status: "error",
        error: "staging_path must point at an object directly under staging/",
      })
      continue
    }
    const uploadsPath = `${companyId}/uploads/${stagingBase}`

    // Parse the revision label from the filename. The form's submittal-#
    // field lies on revisions (verified in the date diagnosis — Sub 234-R3's
    // form was byte-identical to R2 because the GC never updated the
    // coversheet). The filename is the reliable revision signal.
    //
    //   "0301-0509 Sub No 234 -R2 Ceramic Tile Sample.pdf"  →  "R2"
    //   "0301-0509 Sub No 030-R1 Frame and Door Schedule.pdf" → "R1"
    //   "0301-0509 Sub No 075 Masonry Package.pdf"          →  "R0"
    //   "20251014_08000006_R1_Acrovyn_Doors.pdf" (older BAM) →  "R1"
    const watersMatch = r.file_name.match(/[ _-]Sub[ _-]+No[ _-]+\d+[ _-]+R(\d+)/i)
    const bamMatch    = r.file_name.match(/\d{8}[ _-]+R(\d+)/i)
    const revisionLabel =
      (watersMatch && watersMatch[1] && `R${watersMatch[1]}`) ??
      (bamMatch    && bamMatch[1]    && `R${bamMatch[1]}`)    ??
      "R0"

    // Storage copy first — RPC call after. If the RPC fails, delete the
    // copied object so it doesn't become an orphan in uploads/.
    const { error: copyErr } = await supabase.storage
      .from("submittals")
      .copy(r.staging_path, uploadsPath)
    if (copyErr) {
      results.push({
        client_row_id: cid, status: "error",
        error: `storage copy failed: ${copyErr.message}`,
      })
      continue
    }

    // Attach via the add_submittal_attachment RPC — atomic newest-wins
    // (unset prev current + insert new + trigger syncs submittals row).
    // The RPC enforces tenant scope via get_my_company_id() and refuses
    // to write if the submittal isn't accessible to the caller.
    const { data: attachment, error: rpcErr } = await supabase.rpc("add_submittal_attachment", {
      p_submittal_id:     r.target_row_id,
      p_storage_path:     uploadsPath,
      p_file_name:        r.file_name,
      p_file_size:        r.file_size ?? null,
      p_revision_label:   revisionLabel,
      p_approval_date:    r.approval_date || null,
      p_review_status:    r.review_status || null,
      p_submittal_number: r.submittal_number?.trim() || null,
      p_source:           "bulk_import",
      p_submitted_date:   r.submitted_date || null,
    }).single()

    if (rpcErr || !attachment) {
      // Roll back the storage copy (best-effort).
      await supabase.storage.from("submittals").remove([uploadsPath]).catch(() => {})
      results.push({
        client_row_id: cid, status: "error",
        error: `attach failed: ${rpcErr?.message ?? "RPC returned no row"}`,
      })
      continue
    }

    results.push({
      client_row_id: cid,
      status: "ok",
      row_id: r.target_row_id,
      attached_path: uploadsPath,
    })
  }

  return NextResponse.json({ project_id: projectId, results })
}
