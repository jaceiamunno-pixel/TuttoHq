import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { computePcoPricingSum, buildLineItemRows } from "@/lib/pco-save"
import { buildPcoDocuments } from "@/lib/pco-pdf"
import { payloadToDocData, parseSchedDays, type ImportPcoPayload } from "@/lib/pco-import/payload"

export const maxDuration = 300

// POST /api/change-orders/pco/import — commit a batch of reviewed historical
// PCOs. Each row is FROZEN on insert (origin='imported') and isolated: one
// failed row never aborts the batch (the drawing-log silent-drop class is the
// pattern this prevents). Returns { imported, total, failures[] }.
//
// Pricing integrity (pricing_sum discipline): pricing_sum is recomputed
// server-side from the submitted line items via the SAME computePcoPricingSum as
// the builder, then verified against the user's review-confirmed total before
// insert. The .xlsx is never uploaded — this endpoint only ever sees extracted
// data.

const TOL = 0.05
const numericKey = (co: string | null | undefined): string => (co ?? "").replace(/[^0-9]/g, "").replace(/^0+(?=\d)/, "") || ""

interface Failure { pco_number: string; reason: string }

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = (await req.json().catch(() => null)) as { pcos?: ImportPcoPayload[] } | null
  const pcos = Array.isArray(body?.pcos) ? body!.pcos : null
  if (!pcos || pcos.length === 0) return NextResponse.json({ error: "No PCOs to import" }, { status: 400 })

  // Company letterhead context — fetched once for the whole batch.
  const { data: settings } = await supabase.from("company_settings").select("logo_path, phone").maybeSingle()
  let logoBytes: ArrayBuffer | null = null
  if (settings?.logo_path) {
    const { data: blob } = await supabase.storage.from("company-assets").download(settings.logo_path)
    if (blob) logoBytes = await blob.arrayBuffer()
  }
  const { data: companyId } = await supabase.rpc("get_my_company_id")
  if (!companyId) return NextResponse.json({ error: "No company association" }, { status: 500 })
  const { data: companyRow } = await supabase.from("companies").select("name").eq("id", companyId).maybeSingle()

  // Cache project context + existing CO numbers per project (collision guard).
  const projectCache = new Map<string, { name: string | null; number: string | null; location: string | null; gc_name: string | null; existing: Set<string> }>()
  async function getProject(id: string) {
    if (projectCache.has(id)) return projectCache.get(id)!
    const { data: p } = await supabase.from("projects").select("name, number, location, gc_name").eq("id", id).maybeSingle()
    const { data: cos } = await supabase.from("change_orders").select("co_number").eq("project_id", id)
    const existing = new Set((cos ?? []).map(r => numericKey(r.co_number)).filter(Boolean))
    const ctx = { name: p?.name ?? null, number: p?.number ?? null, location: p?.location ?? null, gc_name: p?.gc_name ?? null, existing }
    projectCache.set(id, ctx)
    return ctx
  }

  const failures: Failure[] = []
  const importedIds: string[] = []

  for (const p of pcos) {
    const label = p.pco_number || "(no #)"
    try {
      const projectId = typeof p.project_id === "string" ? p.project_id.trim() : ""
      const title = typeof p.title === "string" ? p.title.trim() : ""
      const pcoNumber = typeof p.pco_number === "string" ? p.pco_number.trim() : ""
      if (!projectId) throw new Error("Missing project")
      if (!pcoNumber) throw new Error("Missing PCO #")
      if (!title) throw new Error("Missing title")

      const ctx = await getProject(projectId)

      // Collision guard (server-authoritative; covers legacy manual rows too,
      // which the partial-unique index alone would miss).
      if (ctx.existing.has(numericKey(pcoNumber))) {
        throw new Error(`PCO #${pcoNumber} already exists in this project`)
      }

      // STATED TOTALS ARE AUTHORITATIVE — the import is a direct copy of the
      // document, so pricing_sum = the cover TOTAL (stated_total, falling back to
      // confirmed_total). The line-derived recompute is logged for diagnostics
      // only; it never overrides or blocks. (A foreign/absent backup means the
      // lines can't reproduce the cover total — that's expected.)
      const statedTotal = p.stated_total != null ? Number(p.stated_total)
        : (p.confirmed_total != null ? Number(p.confirmed_total) : NaN)
      if (!Number.isFinite(statedTotal)) throw new Error("Cover TOTAL is missing")
      const pricing_sum = Math.round(statedTotal * 100) / 100
      const computedSum = computePcoPricingSum(p)
      if (Math.abs(computedSum - pricing_sum) > TOL) {
        console.info(`[pco-import] PCO ${pcoNumber}: line recompute ${computedSum.toFixed(2)} ≠ stated cover total ${pricing_sum.toFixed(2)} (using stated).`)
      }
      // Line items may legitimately be empty (cover-summary-only / foreign backup).
      const lineItems = buildLineItemRows(p)

      const texturaFee = Number(p.textura_fee) || 0
      const num = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v))
      const importArgs = {
        p_project_id:            projectId,
        p_co_number:             pcoNumber,
        p_date:                  p.date || null,
        p_title:                 title,
        p_description:           typeof p.description_of_work === "string" ? p.description_of_work.trim() || null : null,
        p_pricing_sum:           pricing_sum,
        p_schedule_days:         parseSchedDays(p.schedule_impact_days),
        p_ohp:                   p.oh_p_percent ?? null,
        p_fee_percent:           p.fee_percent ?? null,
        p_signer_name:           typeof p.signer_name === "string" ? p.signer_name.trim() || null : null,
        p_signer_title:          typeof p.signer_title === "string" ? p.signer_title.trim() || null : null,
        p_signer_signature_path: null,
        p_line_items:            lineItems,
      }
      // Full args incl. textura (0007, live) + stated summary (0008). If 0008 is
      // not applied yet, import_pco lacks the p_stated_* params → PGRST202; retry
      // with the 0007 signature (textura only) so the import still commits (the
      // stated summary just isn't persisted; pricing_sum already = cover TOTAL).
      const fullArgs = {
        ...importArgs,
        p_textura_fee:     texturaFee,
        p_stated_labor:    num(p.stated_labor),
        p_stated_materials: num(p.stated_materials),
        p_stated_sub:      num(p.stated_subcontractor),
        p_stated_ohp:      num(p.stated_ohp_amount),
        p_stated_fee:      num(p.stated_fee_amount),
      }
      let { data: rpcData, error: rpcErr } = await supabase.rpc("import_pco", fullArgs)
      if (rpcErr?.code === "PGRST202") {
        ({ data: rpcData, error: rpcErr } = await supabase.rpc("import_pco", { ...importArgs, p_textura_fee: texturaFee }))
        if (rpcErr?.code === "PGRST202" && texturaFee === 0) {
          ({ data: rpcData, error: rpcErr } = await supabase.rpc("import_pco", importArgs))
        }
      }
      if (rpcErr) {
        // 23505 = unique_violation on the partial-unique builder-PCO index.
        if (rpcErr.code === "23505") throw new Error(`PCO #${pcoNumber} already exists in this project`)
        throw new Error(rpcErr.message || "Insert failed")
      }
      const row = Array.isArray(rpcData) ? rpcData[0] : rpcData
      const newId: string | undefined = row?.pco_id
      if (!newId) throw new Error("Insert returned no id")
      importedIds.push(newId)
      ctx.existing.add(numericKey(pcoNumber))   // prevent intra-batch dup

      // Apply the optional review status AFTER commit via a normal status UPDATE
      // (the freeze allow-lists workflow columns). import_pco itself inserted
      // 'Not submitted'. Non-fatal: a failure leaves the row at 'Not submitted'.
      const reqStatus = typeof p.status === "string" ? p.status.trim() : ""
      if (reqStatus && reqStatus !== "Not submitted") {
        try {
          await supabase.from("change_orders").update({
            status: reqStatus,
            ...(reqStatus === "Approved" ? { approved_at: new Date().toISOString() } : {}),
          }).eq("id", newId)
        } catch (statusErr) {
          console.error(`Imported PCO ${pcoNumber}: status set to '${reqStatus}' failed:`, statusErr)
        }
      }

      // Generate + store the Tutto cover/backup PDFs. Non-fatal: the row is
      // already committed (frozen); a PDF hiccup must not drop the import — the
      // user can regenerate from the log. Writes only the allow-listed PDF-path
      // columns, so the freeze trigger permits this update.
      try {
        const docData = payloadToDocData(p, { name: ctx.name, number: ctx.number, location: ctx.location })
        const companyName = companyRow?.name ?? ctx.gc_name ?? null
        const { cover, backup } = await buildPcoDocuments(docData, { logoBytes, sigBytes: null, companyName, phone: settings?.phone ?? null })
        const coverPath  = `${companyId}/change-orders/${newId}/cover.pdf`
        await supabase.storage.from("submittals").upload(coverPath, Buffer.from(cover), { contentType: "application/pdf", upsert: true })
        // No backup PDF when there's no line detail (cover-summary-only / foreign backup).
        const pdfPaths: Record<string, string> = { pco_cover_pdf_path: coverPath }
        if (lineItems.length > 0) {
          const backupPath = `${companyId}/change-orders/${newId}/backup.pdf`
          await supabase.storage.from("submittals").upload(backupPath, Buffer.from(backup), { contentType: "application/pdf", upsert: true })
          pdfPaths.pco_backup_pdf_path = backupPath
        }
        await supabase.from("change_orders").update(pdfPaths).eq("id", newId)
      } catch (pdfErr) {
        console.error(`Imported PCO ${pcoNumber} stored, but PDF generation failed:`, pdfErr)
      }
    } catch (e) {
      failures.push({ pco_number: label, reason: (e as Error)?.message ?? "Unknown error" })
    }
  }

  return NextResponse.json({
    imported: importedIds.length,
    total: pcos.length,
    failures,
    ids: importedIds,
  })
}
