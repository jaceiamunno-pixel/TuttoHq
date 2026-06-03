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
  /** YYYY-MM-DD architect approval date (review_status confirmation). */
  approval_date: string | null
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
    if (target.storage_path) {
      // Already has a PDF attached. Stage 2a refuses overwrite — clearing
      // an existing attachment is an explicit Stage 3 affordance.
      results.push({
        client_row_id: cid, status: "error",
        error: "target row already has a PDF attached (clear it first to re-commit)",
      })
      continue
    }

    // Derive the canonical uploads path. Keep the UUID prefix from staging
    // so storage paths stay unique per import session.
    const stagingBase = r.staging_path.slice(stagingPrefix.length)
    if (!stagingBase || stagingBase.includes("/")) {
      results.push({
        client_row_id: cid, status: "error",
        error: "staging_path must point at an object directly under staging/",
      })
      continue
    }
    const uploadsPath = `${companyId}/uploads/${stagingBase}`

    // Storage copy first — DB UPDATE after. If UPDATE fails, we try to
    // delete the copied object so it doesn't become an orphan in uploads/.
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

    // Attach the PDF + metadata. The WHERE constraints repeat the safety
    // checks above so a race between the SELECT and the UPDATE can't slip
    // an unwritable row through.
    const { data: updated, error: uErr } = await supabase
      .from("submittals")
      .update({
        storage_path: uploadsPath,
        file_name: r.file_name,
        received_file_name: r.file_name,
        file_size: r.file_size ?? null,
        mime_type: "application/pdf",
        returned_from_ae_date: r.approval_date || null,
        submittal_number: r.submittal_number?.trim() || null,
        revision_number: r.revision_number?.trim() || null,
        review_status: r.review_status || null,
        manually_overridden: true,
        overridden_by: user.id,
        received_at: nowIso,
      })
      .eq("id", r.target_row_id)
      .eq("company_id", companyId)
      .eq("project_id", projectId)
      .eq("source", "spec_ingestion")
      .neq("status", "deleted")
      .is("storage_path", null)
      .select("id")
      .single()

    if (uErr || !updated) {
      // Roll back the storage copy (best-effort).
      await supabase.storage.from("submittals").remove([uploadsPath]).catch(() => {})
      results.push({
        client_row_id: cid, status: "error",
        error: `update failed: ${uErr?.message ?? "row not updatable (race or constraint)"}`,
      })
      continue
    }

    results.push({
      client_row_id: cid,
      status: "ok",
      row_id: updated.id,
      attached_path: uploadsPath,
    })
  }

  return NextResponse.json({ project_id: projectId, results })
}
