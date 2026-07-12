// One-shot reconcile for Library submittals that never got a stripped copy.
//
// WHY: since PR #116, package-mode transmittals put a fresh stamped Tutto
// coversheet in front of every item's document (documentBytes =
// stripped_storage_path || storage_path). For a submittal whose ORIGINAL pdf
// already embeds a coversheet AND has no stripped copy, the CM then receives
// TWO covers — the new stamped Tutto cover, then the old embedded one. This
// tool generates the missing stripped copy for exactly those rows so only the
// stamped cover remains.
//
// HEURISTIC: reuses the SAME detector the upload path uses — findStripPlan /
// stripFrontMatter from ./pdf-strip. NOTHING here re-implements or tweaks the
// cover-detection; a change to the heuristic belongs in pdf-strip.ts, not here.
//
// SCOPE: active PDF submittals with storage_path set and
// stripped_storage_path NULL. RLS on the passed authed client confines every
// read/write to the caller's own company — no cross-tenant access. Only rows
// whose page 1 is a cover produce a write; raw datasheets (no cover on p1) are
// left with a NULL column and serve their original unchanged (correct: they
// have no embedded cover to double up).
//
// SAFETY: dryRun is the default at the route. In dryRun this performs reads
// only and writes NOTHING — no storage object, no column update. The path
// convention + bucket exactly match strip-and-store.ts so a real pass produces
// the same artifacts the upload path would have.

import { PDFDocument } from "pdf-lib"
import { findStripPlan, stripFrontMatter } from "./pdf-strip"
import type { SupabaseClient } from "@supabase/supabase-js"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = SupabaseClient<any, any, any>

const BUCKET = "submittals"

export type StripBackfillStatus =
  | "would-strip"        // dry-run: a cover was found; a real pass would write
  | "wrote"              // real pass: stripped copy written, column set
  | "no-strip"           // page 1 isn't a cover — original serves, column left NULL
  | "download-failed"
  | "plan-error"
  | "upload-failed"
  | "update-failed"

export interface StripBackfillItem {
  submittalId: string
  fileName: string
  projectId: string | null
  pagesBefore: number | null
  /** Count of leading cover pages the plan would remove (0 = no strip). */
  pagesStripped: number
  pagesKept: number | null
  anchor: "stamp" | "coversheet" | null
  /** The stripped object path — set only on a real 'wrote'. */
  wrotePath: string | null
  status: StripBackfillStatus
  /** Heuristic "look here" flag: a long cover run or a near-total strip. */
  flagged: boolean
}

export interface StripBackfillReport {
  dryRun: boolean
  companyId: string
  scanned: number
  /** wouldStrip in dry-run; wrote count in a real pass. */
  covers: number
  noStrip: number
  failed: number
  items: StripBackfillItem[]
}

/** Filesystem-safe base name — identical to strip-and-store.ts:safeBase. */
function safeBase(name: string): string {
  const base = name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80)
  return base || "submittal"
}

/** A doc worth a human glance before a real write: a long leading cover run
 *  (detector may have over-matched into product) or a strip that keeps ≤ 1
 *  page. Neither blocks — it only surfaces the row in the report. */
function isFlagged(stripEnd: number, total: number): boolean {
  return stripEnd >= 4 || total - stripEnd <= 1
}

/**
 * Reconcile the caller's company. Pass an AUTHED supabase client (RLS scopes
 * to the company). dryRun defaults true at the route; only an explicit,
 * admin-gated apply flips it.
 */
export async function runStripBackfill(
  sb: AnySupabase,
  opts: { dryRun: boolean; limit?: number },
): Promise<StripBackfillReport> {
  const { data: companyId } = await sb.rpc("get_my_company_id")
  if (!companyId) {
    return { dryRun: opts.dryRun, companyId: "", scanned: 0, covers: 0, noStrip: 0, failed: 0, items: [] }
  }

  let q = sb
    .from("submittals")
    .select("id, project_id, file_name, storage_path")
    .neq("status", "deleted")
    .eq("mime_type", "application/pdf")
    .not("storage_path", "is", null)
    .is("stripped_storage_path", null)
    .order("project_id")
  if (opts.limit && opts.limit > 0) q = q.limit(opts.limit)
  const { data: rows, error } = await q
  if (error) throw new Error(`scope query failed: ${error.message}`)

  const items: StripBackfillItem[] = []
  let covers = 0, noStrip = 0, failed = 0

  for (const r of (rows ?? []) as Array<{ id: string; project_id: string | null; file_name: string | null; storage_path: string }>) {
    const fileName = String(r.file_name ?? "")
    const base: Omit<StripBackfillItem, "status" | "flagged"> = {
      submittalId: r.id, fileName, projectId: r.project_id,
      pagesBefore: null, pagesStripped: 0, pagesKept: null, anchor: null, wrotePath: null,
    }

    // 1. Download the original (RLS-scoped read).
    let buf: Buffer
    try {
      const { data: blob, error: dlErr } = await sb.storage.from(BUCKET).download(r.storage_path)
      if (dlErr || !blob) { failed++; items.push({ ...base, status: "download-failed", flagged: false }); continue }
      buf = Buffer.from(await blob.arrayBuffer())
    } catch { failed++; items.push({ ...base, status: "download-failed", flagged: false }); continue }

    // 2. Plan via the REAL detector.
    let plan
    try { plan = await findStripPlan(buf) } catch { failed++; items.push({ ...base, status: "plan-error", flagged: false }); continue }

    if (!plan) {
      // Page 1 isn't a cover (raw datasheet) — leave the column NULL; the
      // original serves and has no embedded cover to double up.
      noStrip++
      items.push({ ...base, pagesBefore: null, status: "no-strip", flagged: false })
      continue
    }

    const flagged = isFlagged(plan.stripEndPage, plan.totalPages)
    const common = {
      ...base,
      pagesBefore: plan.totalPages,
      pagesStripped: plan.stripEndPage,
      pagesKept: plan.totalPages - plan.stripEndPage,
      anchor: plan.anchor,
    }

    if (opts.dryRun) {
      covers++
      items.push({ ...common, status: "would-strip", wrotePath: null, flagged })
      continue
    }

    // 3. Real pass — produce the stripped bytes, upload, set the column. Path
    //    convention matches strip-and-store.ts exactly.
    let strippedBuffer: Buffer
    try {
      const { buffer, plan: p2 } = await stripFrontMatter(buf)
      if (!p2) { noStrip++; items.push({ ...base, status: "no-strip", flagged: false }); continue }
      strippedBuffer = buffer
    } catch { failed++; items.push({ ...common, status: "plan-error", flagged }); continue }

    const strippedPath = `${companyId}/library-stripped/${crypto.randomUUID()}_${safeBase(fileName)}.pdf`
    const { error: upErr } = await sb.storage
      .from(BUCKET)
      .upload(strippedPath, strippedBuffer, { contentType: "application/pdf", upsert: false })
    if (upErr) { failed++; items.push({ ...common, status: "upload-failed", flagged }); continue }

    const { error: updErr } = await sb
      .from("submittals")
      .update({ stripped_storage_path: strippedPath })
      .eq("id", r.id)
      .eq("company_id", companyId)
    if (updErr) {
      await sb.storage.from(BUCKET).remove([strippedPath]).catch(() => {})
      failed++; items.push({ ...common, status: "update-failed", flagged }); continue
    }

    // Sanity: record the actual output page count.
    let keptActual: number | null = null
    try { const d = await PDFDocument.load(strippedBuffer); keptActual = d.getPageCount() } catch { /* non-fatal */ }
    covers++
    items.push({ ...common, pagesKept: keptActual ?? common.pagesKept, status: "wrote", wrotePath: strippedPath, flagged })
  }

  return { dryRun: opts.dryRun, companyId: String(companyId), scanned: (rows ?? []).length, covers, noStrip, failed, items }
}
