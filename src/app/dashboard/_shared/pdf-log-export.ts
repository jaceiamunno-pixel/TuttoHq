// Client-side "Export to PDF" for the Submittal Log and the Change-Order log.
//
// Renders the user's *currently filtered + sorted* view (the same row array the
// table is rendering, already scoped to the active project + tenant) as a single
// table-style PDF — one row per entry, the on-screen columns — NOT a bundle of
// each item's underlying document. It reuses the shared PDF engine (PDFBuilder,
// the steel-blue "coversheet" house style) and its wrapping `logTable`, so long
// cell values wrap rather than clip and many rows page-break cleanly. The engine
// only embeds StandardFonts (no disk fonts), so it runs in the browser; callers
// dynamic-import this module so pdf-lib stays out of the main bundle.
//
// Parallels excel-export.ts (same call sites, same args) — the PDF is the
// print-friendly counterpart to the .xlsx download.

import { PDFBuilder } from "@/lib/pdf-builder"
import { computeCoTotals } from "./co-math"
import type {
  SubmittalRecord, ChangeOrder, VendorRow, VendorPersonRow,
} from "./types"

// ─── Small formatters (kept local so this module is self-contained) ──────────
const usd = (n: number | null | undefined) =>
  typeof n === "number" && Number.isFinite(n)
    ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
    : "—"

// Compact M/D/YY (dates are narrow log columns). Mirrors the on-screen "—" for
// missing values.
function fmtDateShort(d: string | null): string {
  if (!d) return "—"
  try { return new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "2-digit" }) }
  catch { return d }
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "") || "project"
}

// Trigger a browser download of the generated PDF bytes.
function downloadPdf(bytes: Uint8Array, fileName: string) {
  const blob = new Blob([bytes as BlobPart], { type: "application/pdf" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ─── Submittal-log calculated columns — replicated from LibrarySubmittalsModule
// (kept byte-for-byte so the PDF's Approval / Late columns match the screen). ──
function daysBetween(a: string, b: string): number | null {
  const t1 = Date.parse(a), t2 = Date.parse(b)
  if (Number.isNaN(t1) || Number.isNaN(t2)) return null
  return Math.round((t2 - t1) / 86_400_000)
}
function approvalDays(s: SubmittalRecord): number | null {
  if (!s.sent_to_ae_date || !s.returned_from_ae_date) return null
  return daysBetween(s.sent_to_ae_date, s.returned_from_ae_date)
}
function lateLabel(s: SubmittalRecord): string {
  if (!s.sent_to_ae_date) return "—"
  const end = s.returned_from_ae_date ?? new Date().toISOString().slice(0, 10)
  const d = daysBetween(s.sent_to_ae_date, end)
  if (d === null) return "—"
  return d > 14 ? "Late" : "On Time"
}

// Vendor label — "Firm — Person", firm only, or "" — mirrors the Excel export
// and the on-screen VendorCell.
function vendorLabel(
  s: SubmittalRecord,
  vendors: VendorRow[], people: VendorPersonRow[],
): string {
  if (!s.vendor_id) return ""
  const firm = vendors.find(v => v.id === s.vendor_id)?.company_name ?? ""
  const person = s.vendor_person_id ? people.find(p => p.id === s.vendor_person_id)?.name : null
  return firm && person ? `${firm} — ${person}` : firm
}

const pcoLabel = (n: string | null) => (n ?? "").replace(/^CO-/i, "")

// ─── Change-order log ─────────────────────────────────────────────────────────
export interface ExportChangeOrderLogPdfArgs {
  rows: ChangeOrder[]
  projectName: string
  projectNumber: string | null
  baseContractValue: number | null
}

export async function exportChangeOrderLogToPdf(args: ExportChangeOrderLogPdfArgs): Promise<void> {
  const meta = [args.projectName.trim(), args.projectNumber ? `No. ${args.projectNumber}` : null]
    .filter(Boolean).join("   ·   ")
  const doc = await PDFBuilder.create({
    documentType: "Change Order Log",
    documentNumber: meta || null,
    orientation: "landscape",
  })

  // Columns mirror the on-screen CO log (Actions dropped — not data). Widths sum
  // to the landscape content width; Proposal absorbs the remainder.
  const cw = doc.CW
  const fixed = 46 + 46 + 64 + 78 + 78 + 48 + 96
  const cols: { header: string; width: number; align?: "left" | "right" }[] = [
    { header: "PCO #", width: 46 },
    { header: "CO #", width: 46 },
    { header: "Date", width: 64 },
    { header: "Proposal", width: Math.max(140, cw - fixed) },
    { header: "Proposed", width: 78, align: "right" },
    { header: "Realized", width: 78, align: "right" },
    { header: "Sched.", width: 48 },
    { header: "Status", width: 96 },
  ]

  const rows: string[][] = args.rows.map(c => [
    pcoLabel(c.co_number) || "—",
    c.assigned_co_number || "—",
    fmtDateShort(c.date),
    c.proposal ?? "—",
    c.pricing_sum != null ? usd(c.pricing_sum) : "—",
    c.realized_amount != null ? usd(c.realized_amount) : "—",
    c.schedule_impact || "TBD",
    c.status,
  ])
  if (rows.length === 0) rows.push(["—", "", "", "No change orders", "", "", "", ""])

  doc.logTable(cols, rows)

  // Contract totals — the same figures shown above the on-screen log.
  const totals = computeCoTotals(args.rows, args.baseContractValue)
  doc.spacer(2)
  doc.paragraph(`Total Proposed:  ${usd(totals.totalProposed)}`, { align: "right", bold: true, size: 9, gap: 1 })
  doc.paragraph(`Revised Contract Value:  ${usd(totals.revisedContractValue)}`, { align: "right", bold: true, size: 9, gap: 1 })
  doc.paragraph(`Open Changes:  ${usd(totals.openChanges)}`, { align: "right", bold: true, size: 9, gap: 1 })

  const bytes = await doc.save()
  const date = new Date().toISOString().slice(0, 10)
  downloadPdf(bytes, `${sanitizeFileName(args.projectName)}_change_order_log_${date}.pdf`)
}

// ─── Submittal log ──────────────────────────────────────────────────────────
export interface ExportSubmittalLogPdfArgs {
  rows: SubmittalRecord[]
  projectName: string
  gcName: string | null
  vendors: VendorRow[]
  vendorPeople: VendorPersonRow[]
}

export async function exportSubmittalLogToPdf(args: ExportSubmittalLogPdfArgs): Promise<void> {
  const company = (args.gcName ?? "").trim() || args.projectName.trim()
  const doc = await PDFBuilder.create({
    documentType: "Submittal Log",
    documentNumber: company || null,
    orientation: "landscape",
  })

  // Columns mirror the on-screen log header set (Actions dropped). Description
  // absorbs the remaining width after the fixed columns.
  const cw = doc.CW
  const fixed = 28 + 46 + 56 + 84 + 44 + 44 + 46 + 46 + 34 + 72 + 40 + 36
  const cols: { header: string; width: number; align?: "left" | "right" }[] = [
    { header: "Subm. #", width: 28, align: "right" },
    { header: "Spec #", width: 46 },
    { header: "Description", width: Math.max(120, cw - fixed) },
    { header: "Type", width: 56 },
    { header: "Vendor", width: 84 },
    { header: "Received", width: 44 },
    { header: "To A/E", width: 44 },
    { header: "Ret. A/E", width: 46 },
    { header: "Ret. Sub", width: 46 },
    { header: "Appr. (d)", width: 34, align: "right" },
    { header: "Status", width: 72 },
    { header: "Late", width: 40 },
    { header: "Source", width: 36 },
  ]

  const rows: string[][] = args.rows.map(s => {
    const appr = approvalDays(s)
    return [
      s.submittal_seq != null ? String(s.submittal_seq) : "—",
      s.csi_section ?? "—",
      s.file_name,
      s.submittal_type ?? "—",
      vendorLabel(s, args.vendors, args.vendorPeople),
      fmtDateShort(s.received_date),
      fmtDateShort(s.sent_to_ae_date),
      fmtDateShort(s.returned_from_ae_date),
      fmtDateShort(s.returned_to_sub_date),
      appr != null ? String(appr) : "—",
      s.review_status ?? "Received",
      lateLabel(s),
      s.source === "spec_ingestion" && s.spec_section_id ? "Spec book" : "",
    ]
  })
  if (rows.length === 0) rows.push(["—", "", "No submittals", "", "", "", "", "", "", "", "", "", ""])

  doc.logTable(cols, rows)

  const bytes = await doc.save()
  const date = new Date().toISOString().slice(0, 10)
  downloadPdf(bytes, `${sanitizeFileName(args.projectName)}_submittal_log_${date}.pdf`)
}
