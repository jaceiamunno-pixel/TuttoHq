import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isValidSha256 } from "@/lib/file-hash"

// POST /api/bulk-import/commit — Stage 2a write path. Attach each Bulk
// Import row to a spec-built submittals row. Model A never fabricates spec
// identity: every attachment lands on a row whose CSI division / section /
// type came from the spec book — either the confirmed placeholder or a
// sibling spawned from it (see the auto-split contract).
//
// AUTO-SPLIT CONTRACT (the one-file-one-log-row rule):
//   Every uploaded file becomes its OWN top-level log row. A spec book
//   generates exactly ONE placeholder per (section, submittal_type), so a
//   real project with two DISTINCT submittals of the same type in one
//   section auto-matches both files to the SAME placeholder. The second
//   file must NOT silently stack onto the first as a fake revision.
//
//   Per incoming file, keyed on target_row_id (the confirmed placeholder):
//     • First file for a FREE placeholder (no attachment from a prior
//       commit AND not yet claimed earlier in this batch) → attaches to
//       the placeholder itself.
//     • Any later file whose placeholder is already claimed in this batch,
//       OR whose placeholder already carries an attachment from a prior
//       commit → SPAWNS a new sibling submittals row that clones ONLY the
//       placeholder's spec identity, and attaches there as that row's own
//       (current) revision.
//   Distinct submittals are NEVER silently merged as revisions of one
//   another. Revision-stacking is an explicit, per-row user action handled
//   elsewhere (the /submittals/[id]/attachments route) — it is never
//   inferred from a batch, and this route does not touch that path.
//
// IDEMPOTENCY (retry-safe, no double-spawn):
//   Before spawning, we re-resolve by file_sha256 within the placeholder's
//   sibling group. If this exact file already lives on the placeholder or a
//   previously-spawned sibling, we re-attach there and the RPC's same-bytes
//   guard no-ops. A re-run of the same batch therefore converges on the
//   rows the first run created instead of minting new ones. Files with no
//   sha keep the same best-effort behavior they always had — the RPC guard
//   needs a sha to fire, so a null-sha retry can still duplicate.
//
// HARD WRITE RULES:
//   1. Caller must own the project (project.company_id == caller company).
//   2. Each target row must belong to: caller's company, the specified
//      project, and source = 'spec_ingestion'. It MAY already hold a PDF —
//      an occupied placeholder drives the auto-split above, not a refusal
//      and not a stacked revision.
//   3. Each staging_path must be inside the caller's own
//      `{company}/bulk-import-staging/` directory.
//   4. Each row commit is independent: a single bad row (including a failed
//      spawn) produces a per-row error in the response, not an envelope
//      failure. The other rows in the batch commit normally.
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
// .eq("company_id") / .eq("project_id") explicitly re-filter. Spawned
// sibling rows stamp company_id + project_id copied from the placeholder
// (already RLS-verified as the caller's) — never from client input; the
// RLS WITH CHECK backstops. Either guard alone suffices; both is
// defense-in-depth.

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
  /** SHA-256 of the file bytes (lowercase hex). Computed by /analyze and
   *  passed through verbatim. Optional — a missing/invalid value is
   *  non-fatal; backfill will populate later. */
  file_sha256?: string | null
}

interface CommitResult {
  client_row_id: string
  status: "ok" | "error"
  row_id?: string
  attached_path?: string
  error?: string
  /** True when the RPC hit the same-bytes idempotency guard and returned
   *  a pre-existing attachment row instead of inserting a duplicate.
   *  The client surfaces this as "Already attached" (the row is in the
   *  intended state — just nothing new was created this run). */
  was_duplicate?: boolean
  /** True when the file did NOT land on the confirmed placeholder but on a
   *  newly-spawned sibling row (auto-split: the placeholder was already
   *  claimed this batch or held a prior attachment). row_id is the sibling. */
  spawned?: boolean
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

  // The spec-identity fields cloned onto a spawned sibling. Read off the
  // (already RLS- + company- + project-verified) placeholder row.
  type TargetRow = {
    id: string
    company_id: string
    project_id: string
    source: string | null
    status: string | null
    storage_path: string | null
    csi_division: string | null
    division_name: string | null
    csi_section: string | null
    section_name: string | null
    material_name: string | null
    spec_section_id: string | null
    submittal_type: string | null
  }

  // target_row_ids that an earlier file in THIS batch has already claimed as
  // its placeholder. A second file for the same placeholder must spawn a
  // sibling instead of stacking (see the auto-split contract in the header).
  const claimedTargets = new Set<string>()

  // Idempotency re-resolve. The placeholder and every sibling spawned from
  // it share (project_id, csi_section, submittal_type, source='spec_ingestion').
  // If this exact file (by sha) already lives on any row in that group, return
  // that row's id so the commit re-attaches there (RPC same-bytes no-op) rather
  // than spawning a duplicate on retry. Returns { id } (may be null) or { error }.
  async function findSiblingHoldingSha(
    ph: TargetRow,
    sha: string,
  ): Promise<{ id: string | null; error?: string }> {
    // 1) All rows in the placeholder's spec-identity group (includes the
    //    placeholder itself and any previously-spawned siblings).
    let q = supabase
      .from("submittals")
      .select("id")
      .eq("company_id", companyId)
      .eq("project_id", projectId)
      .eq("source", "spec_ingestion")
      .neq("status", "deleted")
      .eq("csi_section", ph.csi_section ?? "")
    q = ph.submittal_type == null
      ? q.is("submittal_type", null)
      : q.eq("submittal_type", ph.submittal_type)
    const { data: groupRows, error: groupErr } = await q
    if (groupErr) return { id: null, error: groupErr.message }
    const groupIds = (groupRows ?? []).map((g) => g.id as string)
    if (groupIds.length === 0) return { id: null }

    // 2) Is this file's sha already attached to one of them?
    const { data: att, error: attErr } = await supabase
      .from("submittal_attachments")
      .select("submittal_id")
      .eq("company_id", companyId)
      .eq("file_sha256", sha)
      .in("submittal_id", groupIds)
      .limit(1)
    if (attErr) return { id: null, error: attErr.message }
    return { id: att && att.length > 0 ? (att[0].submittal_id as string) : null }
  }

  // Spawn a new sibling submittals row that clones ONLY the placeholder's
  // spec identity. company_id + project_id are stamped from the placeholder
  // (never client input). submittal_seq is allocated via the race-safe
  // per-project counter RPC so concurrent commits get disjoint numbers.
  async function spawnSibling(
    ph: TargetRow,
    reviewStatus: string,
    fileName: string,
  ): Promise<{ id: string } | { error: string }> {
    const { data: seqBase, error: seqErr } = await supabase
      .rpc("next_submittal_seq", { p_project_id: projectId, p_count: 1 })
    if (seqErr || typeof seqBase !== "number") {
      return { error: `seq allocation failed: ${seqErr?.message ?? "no seq returned"}` }
    }
    const { data: row, error: insErr } = await supabase
      .from("submittals")
      .insert({
        // Spec identity — copied verbatim from the placeholder.
        csi_division:     ph.csi_division,
        division_name:    ph.division_name,
        csi_section:      ph.csi_section,
        section_name:     ph.section_name,
        material_name:    ph.material_name,
        spec_section_id:  ph.spec_section_id,
        submittal_type:   ph.submittal_type,
        source:           "spec_ingestion",
        status:           "active",
        // Tenant stamp — from the placeholder, RLS WITH CHECK backstops.
        company_id:       ph.company_id,
        project_id:       ph.project_id,
        // Fresh identity for its own log row.
        submittal_seq:    seqBase + 1,
        submittal_number: null,
        revision_number:  "R0",
        review_status:    reviewStatus || null,
        title_locked:     false,
        // Sensible pre-attach title; the attachment sync trigger overwrites
        // file_name with the committed PDF's name once it lands.
        file_name:        fileName,
        uploaded_by:      user!.id,
      })
      .select("id")
      .single()
    if (insErr || !row) {
      return { error: insErr?.message ?? "insert returned no row" }
    }
    return { id: row.id as string }
  }

  // Best-effort delete of a sibling we spawned but failed to attach a PDF to.
  // Scoped by company + project + spec_ingestion; the FK cascade + the fact it
  // has no attachment yet make this safe (never deletes a populated row).
  async function deleteEmptySpawnedRow(rowId: string): Promise<void> {
    const { error } = await supabase
      .from("submittals")
      .delete()
      .eq("id", rowId)
      .eq("company_id", companyId)
      .eq("project_id", projectId)
      .eq("source", "spec_ingestion")
      .is("storage_path", null)
    if (error) {
      console.warn("[bulk-import-commit] failed to clean up empty spawned row", rowId, error.message)
    }
  }

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
      .select("id, company_id, project_id, source, status, storage_path, csi_division, division_name, csi_section, section_name, material_name, spec_section_id, submittal_type")
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
    // ── Auto-split resolution ────────────────────────────────────────────
    // The placeholder (target) is only the SPEC-IDENTITY source. Decide which
    // submittals row this file's PDF actually attaches to: the placeholder
    // itself, a sibling we spawned earlier this batch/retry, or a brand-new
    // sibling. Distinct submittals never stack as revisions of one another.
    const ph = target as TargetRow
    const sha = isValidSha256(r.file_sha256) ? r.file_sha256 : null

    let effectiveRowId = r.target_row_id
    let spawnedRowId: string | null = null

    // DELIBERATE EXCEPTION to one-row-per-upload: two byte-identical files in a
    // batch resolve to the SAME row (dedup), never spawn a second. This is both
    // the retry-convergence mechanism AND the accidental-double-drag guard. The
    // result carries was_duplicate=true so the UI shows "Already attached" — the
    // dedup is surfaced to the user, never silent. Distinct-bytes files always
    // get their own row.
    //
    // 1. Idempotency re-resolve: if this exact file already lives on the
    //    placeholder or a previously-spawned sibling, re-attach there so a
    //    retried batch converges instead of double-spawning. (Needs a sha;
    //    without one we fall through to the fresh-file path, same as before.)
    let reResolved = false
    if (sha) {
      const found = await findSiblingHoldingSha(ph, sha)
      if (found.error) {
        results.push({ client_row_id: cid, status: "error", error: `idempotency check failed: ${found.error}` })
        continue
      }
      if (found.id) {
        effectiveRowId = found.id
        reResolved = true
      }
    }

    // 2/3. Fresh file: attach to the placeholder if it's FREE, else spawn a
    //      sibling. Free = no attachment from a prior commit (storage_path is
    //      null) AND not yet claimed by an earlier file in this batch.
    if (!reResolved) {
      const placeholderTaken = ph.storage_path != null || claimedTargets.has(r.target_row_id)
      if (!placeholderTaken) {
        effectiveRowId = r.target_row_id
        claimedTargets.add(r.target_row_id)
      } else {
        const spawn = await spawnSibling(ph, r.review_status, r.file_name)
        if ("error" in spawn) {
          results.push({ client_row_id: cid, status: "error", error: `spawn sibling failed: ${spawn.error}` })
          continue
        }
        effectiveRowId = spawn.id
        spawnedRowId = spawn.id
      }
    }

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
      // Delete the empty sibling we just spawned so a retry re-spawns cleanly.
      if (spawnedRowId) await deleteEmptySpawnedRow(spawnedRowId)
      results.push({
        client_row_id: cid, status: "error",
        error: `storage copy failed: ${copyErr.message}`,
      })
      continue
    }

    // Attach via the add_submittal_attachment RPC — atomic newest-wins
    // (unset prev current + insert new + trigger syncs submittals row).
    // The RPC enforces tenant scope via get_my_company_id() and refuses
    // to write if the submittal isn't accessible to the caller. For a spawned
    // sibling this is its FIRST (and only) attachment → it becomes current.
    const { data: attachment, error: rpcErr } = await supabase.rpc("add_submittal_attachment", {
      p_submittal_id:     effectiveRowId,
      p_storage_path:     uploadsPath,
      p_file_name:        r.file_name,
      p_file_size:        r.file_size ?? null,
      p_revision_label:   revisionLabel,
      p_approval_date:    r.approval_date || null,
      p_review_status:    r.review_status || null,
      p_submittal_number: r.submittal_number?.trim() || null,
      p_source:           "bulk_import",
      p_submitted_date:   r.submitted_date || null,
      p_file_sha256:      sha,
    }).single()

    if (rpcErr || !attachment) {
      // Roll back the storage copy (best-effort) and drop the empty sibling
      // (if we spawned one) so a retry re-spawns cleanly instead of orphaning.
      await supabase.storage.from("submittals").remove([uploadsPath]).catch(() => {})
      if (spawnedRowId) await deleteEmptySpawnedRow(spawnedRowId)
      results.push({
        client_row_id: cid, status: "error",
        error: `attach failed: ${rpcErr?.message ?? "RPC returned no row"}`,
      })
      continue
    }

    // Same-bytes idempotency no-op detection. The RPC's guard returns
    // the EXISTING attachment row when (submittal_id, file_sha256,
    // revision_label) already matches a stored attachment. We detect
    // that by comparing the returned storage_path against the one we
    // just promoted to. Mismatch = no-op fired:
    //   - the uploads/ copy we just made is an immediate orphan; delete it
    //   - the staging copy is no longer needed (bytes are attached via
    //     the pre-existing row); the regular purge below handles that
    //   - the result row carries was_duplicate=true so the UI shows
    //     "Already attached" instead of "Committed"
    const att = attachment as { storage_path?: string }
    const wasDuplicate = !!att.storage_path && att.storage_path !== uploadsPath
    if (wasDuplicate) {
      const { error: orphanErr } = await supabase.storage
        .from("submittals")
        .remove([uploadsPath])
      if (orphanErr) {
        console.warn("[bulk-import-commit] orphan uploads cleanup failed for", uploadsPath, orphanErr.message)
      }
    }

    // Staging auto-purge — closes the historical ~400 MB leak. Now that
    // the attachment is committed (or the bytes are accounted for via
    // an existing row in the dupe-guard case), the staging copy is no
    // longer referenced. This is an irreversible storage delete, so we
    // belt-and-suspender the check before firing:
    //   1) The COMMITTED row's storage_path does NOT equal the staging
    //      path. Proves the file is represented by a non-staging
    //      attachment row.
    //   2) The staging path lives under the caller's company staging
    //      dir (already verified above when constructing uploadsPath).
    //   3) Active-reference check: SELECT submittal_attachments where
    //      storage_path = staging_path. If ANY row still references it,
    //      DO NOT DELETE. Logs a warning and the row stays. This catches
    //      the (theoretical) case where a parallel commit somehow
    //      pointed an attachment at the same staging object — we'd
    //      rather leak the file than orphan a live reference.
    // Best-effort delete; failure does not fail the commit (the file is
    // already represented in the DB and any TTL sweep will catch the
    // orphan later).
    if (att.storage_path && att.storage_path !== r.staging_path) {
      const { data: liveRefs, error: refErr } = await supabase
        .from("submittal_attachments")
        .select("id")
        .eq("storage_path", r.staging_path)
        .limit(1)
      if (refErr) {
        console.warn("[bulk-import-commit] staging purge: live-ref check failed for", r.staging_path, refErr.message)
      } else if (liveRefs && liveRefs.length > 0) {
        console.warn("[bulk-import-commit] staging purge SKIPPED — live attachment still references", r.staging_path)
      } else {
        const { error: purgeErr } = await supabase.storage
          .from("submittals")
          .remove([r.staging_path])
        if (purgeErr) {
          console.warn("[bulk-import-commit] staging purge failed for", r.staging_path, purgeErr.message)
        }
      }
    }

    results.push({
      client_row_id: cid,
      status: "ok",
      // The row the file actually landed on — the placeholder, or the sibling
      // we spawned/re-resolved for the auto-split. NOT always target_row_id.
      row_id: effectiveRowId,
      attached_path: att.storage_path,
      was_duplicate: wasDuplicate,
      spawned: spawnedRowId != null,
    })
  }

  return NextResponse.json({ project_id: projectId, results })
}
