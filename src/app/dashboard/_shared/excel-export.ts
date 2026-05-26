// Client-side Excel export for the Submittal Log.
//
// Renders the user's *currently filtered + sorted* view (whatever rows are
// being shown on screen) as a styled .xlsx. ExcelJS is dynamic-imported so
// the ~600 KB library stays out of the main route bundle until the user
// clicks Export.

import type { SubmittalRecord, SubcontractorRow, SupplierRow } from "./types"

// Hex equivalents of the Tailwind classes used by `StatusBadge` — kept in sync
// with src/app/dashboard/_shared/badges.tsx so the spreadsheet matches the UI.
// ExcelJS expects ARGB (alpha-prefixed). Values are tailwind v4 defaults
// (the @theme block in globals.css adds semantic tokens but does not override
// the stock blue/amber/green/red/purple/gray palette).

// The UI's body font (per globals.css). Falls back to Calibri in Excel if
// Inter isn't installed locally, which matches what the browser would do.
const UI_FONT = "Inter"

const STATUS_FILL: Record<string, { bg: string; fg: string }> = {
  "Received":               { bg: "FFDBEAFE", fg: "FF1D4ED8" },
  "Sent to Sub":            { bg: "FFDBEAFE", fg: "FF1D4ED8" },
  "Under Review":           { bg: "FFFEF3C7", fg: "FFB45309" },
  "Approved":               { bg: "FFDCFCE7", fg: "FF15803D" },
  "Approved with Comments": { bg: "FFDBEAFE", fg: "FF1D4ED8" },
  "Rejected":               { bg: "FFFEE2E2", fg: "FFB91C1C" },
  "Revise and Resubmit":    { bg: "FFFEF3C7", fg: "FFB45309" },
  "Needs Review":           { bg: "FFFEF3C7", fg: "FFB45309" },
  "Transmitted":            { bg: "FFF3E8FF", fg: "FF7E22CE" },
}
const STATUS_FALLBACK = { bg: "FFF3F4F6", fg: "FF6B7280" }

const LATE_FILL: Record<string, { bg: string; fg: string }> = {
  "Late":    { bg: "FFFEE2E2", fg: "FFB91C1C" },
  "On Time": { bg: "FFDCFCE7", fg: "FF15803D" },
}

const COLUMNS = [
  { header: "Subm. #",         width:  9 },
  { header: "Spec #",          width: 12 },
  { header: "Description",     width: 50 },
  { header: "Type of Subm.",   width: 16 },
  { header: "Vendor",          width: 28 },
  { header: "Received",        width: 13 },
  { header: "To A/E",          width: 13 },
  { header: "Returned A/E",    width: 14 },
  { header: "Returned to Sub", width: 16 },
  { header: "Approval (Days)", width: 14 },
  { header: "Status",          width: 22 },
  { header: "Late / On Time",  width: 14 },
  { header: "Source",          width: 12 },
  { header: "Actions",         width: 10 },
] as const

const HEADER_FILL = { bg: "FFF8F9FA", fg: "FF64748B" }

function vendorLabel(
  s: SubmittalRecord,
  subs: SubcontractorRow[],
  suppliers: SupplierRow[],
): string {
  if (s.vendor_subcontractor_id)
    return subs.find(v => v.id === s.vendor_subcontractor_id)?.company_name ?? ""
  if (s.vendor_supplier_id)
    return suppliers.find(v => v.id === s.vendor_supplier_id)?.company_name ?? ""
  return ""
}

function approvalDays(s: SubmittalRecord): number | null {
  if (!s.sent_to_ae_date || !s.returned_from_ae_date) return null
  const t1 = Date.parse(s.sent_to_ae_date), t2 = Date.parse(s.returned_from_ae_date)
  if (Number.isNaN(t1) || Number.isNaN(t2)) return null
  return Math.round((t2 - t1) / 86_400_000)
}

function lateStateLabel(s: SubmittalRecord): "Late" | "On Time" | "" {
  if (!s.sent_to_ae_date) return ""
  const end = s.returned_from_ae_date ?? new Date().toISOString().slice(0, 10)
  const t1 = Date.parse(s.sent_to_ae_date), t2 = Date.parse(end)
  if (Number.isNaN(t1) || Number.isNaN(t2)) return ""
  return Math.round((t2 - t1) / 86_400_000) > 14 ? "Late" : "On Time"
}

// "YYYY-MM-DD" → local Date at midnight so Excel sorts correctly.
function parseDate(d: string | null): Date | null {
  if (!d) return null
  const [y, m, day] = d.split("-").map(Number)
  if (!y || !m || !day) return null
  return new Date(y, m - 1, day)
}

// Filesystem-safe project name for the .xlsx file name.
function sanitizeFileName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]+/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    || "project"
}

export interface ExportSubmittalLogArgs {
  rows: SubmittalRecord[]              // already sorted in the order shown on screen
  projectName: string
  vendorSubs: SubcontractorRow[]
  vendorSuppliers: SupplierRow[]
  appOrigin: string                    // window.location.origin — used for Open hyperlinks
  groupedBySection: boolean
  isSearchMode: boolean
  searchQuery: string | null
}

export async function exportSubmittalLogToExcel(args: ExportSubmittalLogArgs): Promise<void> {
  const ExcelJS = (await import("exceljs")).default
  const wb = new ExcelJS.Workbook()
  wb.creator = "TuttoHQ"
  wb.created = new Date()

  const ws = wb.addWorksheet("Submittal Log", {
    views: [{ state: "frozen", ySplit: 1 }],
  })

  ws.columns = COLUMNS.map(c => ({ header: c.header, width: c.width }))

  // Header row styling
  const headerRow = ws.getRow(1)
  headerRow.height = 22
  headerRow.eachCell(cell => {
    cell.font      = { bold: true, size: 9, color: { argb: HEADER_FILL.fg }, name: UI_FONT }
    cell.alignment = { vertical: "middle", horizontal: "left" }
    cell.fill      = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL.bg } }
    cell.border    = { bottom: { style: "thin", color: { argb: "FFE2E8F0" } } }
  })

  for (const s of args.rows) {
    const vendor    = vendorLabel(s, args.vendorSubs, args.vendorSuppliers)
    const status    = s.review_status ?? "Received"
    const late      = lateStateLabel(s)
    const days      = approvalDays(s)
    const hasSource = s.source === "spec_ingestion" && !!s.spec_section_id
    const canOpen   = !!s.storage_path

    const row = ws.addRow([
      s.submittal_seq ?? "",
      s.csi_section   ?? "",
      s.file_name,
      s.submittal_type ?? "",
      vendor,
      parseDate(s.received_date),
      parseDate(s.sent_to_ae_date),
      parseDate(s.returned_from_ae_date),
      parseDate(s.returned_to_sub_date),
      days ?? "",
      status,
      late,
      hasSource ? "Spec book" : "",
      "",
    ])

    row.height = 18
    row.alignment = { vertical: "middle" }
    row.font = { size: 10, name: UI_FONT }
    row.eachCell(c => {
      c.border = { bottom: { style: "hair", color: { argb: "FFE2E8F0" } } }
    })

    // Date columns: mmm d, yyyy (matches the on-screen `fmtDateOnly`).
    for (const colIdx of [6, 7, 8, 9]) {
      const cell = row.getCell(colIdx)
      cell.numFmt = "mmm d, yyyy"
      cell.alignment = { vertical: "middle", horizontal: "left" }
    }
    // Spec # — monospace chip styling.
    row.getCell(2).font = { size: 10, name: "Consolas", bold: true, color: { argb: "FF0F172A" } }
    // Subm. # — semibold, tabular-nums.
    row.getCell(1).font = { size: 10, name: UI_FONT, bold: true, color: { argb: "FF0F172A" } }
    row.getCell(1).alignment = { vertical: "middle", horizontal: "left" }
    // Approval (Days) — centered, tabular.
    row.getCell(10).alignment = { vertical: "middle", horizontal: "center" }
    row.getCell(10).font = { size: 10, name: UI_FONT, color: { argb: "FF64748B" } }

    // Status badge: cell fill + colored bold font matches the on-screen pill.
    const fill = STATUS_FILL[status] ?? STATUS_FALLBACK
    const statusCell = row.getCell(11)
    statusCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill.bg } }
    statusCell.font = { size: 10, name: UI_FONT, bold: true, color: { argb: fill.fg } }
    statusCell.alignment = { vertical: "middle", horizontal: "center" }

    // Late / On Time badge.
    if (late) {
      const lf = LATE_FILL[late]
      const lc = row.getCell(12)
      lc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: lf.bg } }
      lc.font = { size: 10, name: UI_FONT, bold: true, color: { argb: lf.fg } }
      lc.alignment = { vertical: "middle", horizontal: "center" }
    }

    // Actions → single "Open" hyperlink pointing at the stable download route.
    // This URL re-checks auth on every request, so it never goes stale (unlike
    // a presigned URL with a fixed expiry). If the row has no file, leave empty.
    if (canOpen) {
      const openCell = row.getCell(14)
      openCell.value = {
        text: "Open",
        hyperlink: `${args.appOrigin}/api/download/${s.id}`,
        tooltip: s.file_name,
      }
      openCell.font = { size: 10, name: UI_FONT, color: { argb: "FF1D4ED8" }, underline: true }
      openCell.alignment = { vertical: "middle", horizontal: "center" }
    }
  }

  // Auto-filter on the visible columns so reviewers can re-filter in Excel.
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to:   { row: 1, column: COLUMNS.length },
  }

  // ── Metadata sheet ────────────────────────────────────────────────────────
  const meta = wb.addWorksheet("Export Info")
  meta.columns = [{ width: 22 }, { width: 60 }]
  const exportedAt = new Date()
  const rowsData: [string, string][] = [
    ["Project",         args.projectName],
    ["Exported at",     exportedAt.toLocaleString()],
    ["Row count",       String(args.rows.length)],
    ["Grouped by section", args.groupedBySection ? "Yes" : "No"],
    ["Search filter",   args.isSearchMode && args.searchQuery ? args.searchQuery : "—"],
    ["Source",          "TuttoHQ Submittal Log"],
  ]
  for (const [label, value] of rowsData) {
    const r = meta.addRow([label, value])
    r.getCell(1).font = { bold: true, size: 10, color: { argb: "FF64748B" } }
    r.getCell(2).font = { size: 10, color: { argb: "FF0F172A" } }
  }

  // ── Trigger download ──────────────────────────────────────────────────────
  const buf  = await wb.xlsx.writeBuffer()
  const date = exportedAt.toISOString().slice(0, 10)
  const name = `${sanitizeFileName(args.projectName)}_submittal_log_${date}.xlsx`
  const blob = new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement("a")
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
