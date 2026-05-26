// Client-side Excel export for the Submittal Log.
//
// Renders the user's *currently filtered + sorted* view (whatever rows are
// being shown on screen) as a styled .xlsx. ExcelJS is dynamic-imported so
// the ~600 KB library stays out of the main route bundle until the user
// clicks Export.

import type { SubmittalRecord, SubcontractorRow, SupplierRow } from "./types"
import { SECTION_PALETTE_HEX, SECTION_CHIP_HEX, sectionColorMap } from "./csi"

// Status badge hex (Tailwind *-100 bg / *-700 fg) — kept in sync with
// `StatusBadge` in src/app/dashboard/_shared/badges.tsx. ExcelJS expects ARGB,
// hence the FF alpha prefix. "Sent to Sub" deliberately uses the gray fallback
// to match the on-screen badge (which has no STATUS_STYLES entry).
const STATUS_FALLBACK = { bg: "FFF3F4F6", fg: "FF6B7280" }  // gray-100 / gray-500
const STATUS_FILL: Record<string, { bg: string; fg: string }> = {
  "Received":               { bg: "FFDBEAFE", fg: "FF1D4ED8" },  // blue-100 / blue-700
  "Sent to Sub":            STATUS_FALLBACK,                     // no badge entry — gray fallback
  "Under Review":           { bg: "FFFEF3C7", fg: "FFB45309" },  // amber-100 / amber-700
  "Approved":               { bg: "FFDCFCE7", fg: "FF15803D" },  // green-100 / green-700
  "Approved with Comments": { bg: "FFDBEAFE", fg: "FF1D4ED8" },
  "Rejected":               { bg: "FFFEE2E2", fg: "FFB91C1C" },  // red-100 / red-700
  "Revise and Resubmit":    { bg: "FFFEF3C7", fg: "FFB45309" },
  "Needs Review":           { bg: "FFFEF3C7", fg: "FFB45309" },
  "Transmitted":            { bg: "FFF3E8FF", fg: "FF7E22CE" },  // purple-100 / purple-700
}

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
const UI_FONT = "Inter"

// 1-based column indices into COLUMNS, so cell lookups are self-documenting.
const COL_SUBM   = 1
const COL_SPEC   = 2
const COL_TYPE   = 4
const COL_DATE_FROM = 6
const COL_DATE_TO   = 9
const COL_APPR   = 10
const COL_STATUS = 11
const COL_LATE   = 12
const COL_OPEN   = 14

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

function parseDate(d: string | null): Date | null {
  if (!d) return null
  const [y, m, day] = d.split("-").map(Number)
  if (!y || !m || !day) return null
  return new Date(y, m - 1, day)
}

function sanitizeFileName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]+/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    || "project"
}

export interface ExportSubmittalLogArgs {
  rows: SubmittalRecord[]
  projectName: string
  vendorSubs: SubcontractorRow[]
  vendorSuppliers: SupplierRow[]
  appOrigin: string
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

  // Match the on-screen palette assignment exactly: distinct csi_section codes
  // get sorted, then each is mapped to an index that cycles through 8 colors.
  const colorIdx = sectionColorMap(args.rows.map(r => r.csi_section))
  const rowBgFor   = (sec: string | null) =>
    SECTION_PALETTE_HEX[colorIdx.get(sec ?? "—") ?? 0]
  const chipBgFor  = (sec: string | null) =>
    SECTION_CHIP_HEX[colorIdx.get(sec ?? "—") ?? 0]

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
    const rowBg     = rowBgFor(s.csi_section)
    const chipBg    = chipBgFor(s.csi_section)

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

    // 1) Row-tint pass — every cell in the row gets the section pastel.
    // Later writes (Status / Late) override this on those specific cells.
    for (let c = 1; c <= COLUMNS.length; c++) {
      const cell = row.getCell(c)
      cell.fill   = { type: "pattern", pattern: "solid", fgColor: { argb: rowBg } }
      cell.border = { bottom: { style: "hair", color: { argb: "FFE2E8F0" } } }
    }

    // 2) Date columns: format as "mmm d, yyyy" — same as on-screen fmtDateOnly.
    for (let c = COL_DATE_FROM; c <= COL_DATE_TO; c++) {
      const cell = row.getCell(c)
      cell.numFmt    = "mmm d, yyyy"
      cell.alignment = { vertical: "middle", horizontal: "left" }
    }

    // 3) Spec # chip — slightly darker tint, mirrors the on-screen chip.
    const specCell = row.getCell(COL_SPEC)
    specCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: chipBg } }
    specCell.font = { size: 10, name: "Consolas", bold: true, color: { argb: "FF0F172A" } }
    specCell.alignment = { vertical: "middle", horizontal: "left" }

    // 4) Subm. # — semibold dark, left-aligned (matches the on-screen first col).
    row.getCell(COL_SUBM).font = { size: 10, name: UI_FONT, bold: true, color: { argb: "FF0F172A" } }
    row.getCell(COL_SUBM).alignment = { vertical: "middle", horizontal: "left" }

    // 5) Type column — muted text to mirror the on-screen "text-[#64748B]".
    row.getCell(COL_TYPE).font = { size: 10, name: UI_FONT, color: { argb: "FF64748B" } }

    // 6) Approval (Days) — centered, muted, tabular.
    row.getCell(COL_APPR).alignment = { vertical: "middle", horizontal: "center" }
    row.getCell(COL_APPR).font = { size: 10, name: UI_FONT, color: { argb: "FF64748B" } }

    // 7) Status badge — overrides the row tint with the stronger pill color.
    const fill = STATUS_FILL[status] ?? STATUS_FALLBACK
    const statusCell = row.getCell(COL_STATUS)
    statusCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill.bg } }
    statusCell.font = { size: 10, name: UI_FONT, bold: true, color: { argb: fill.fg } }
    statusCell.alignment = { vertical: "middle", horizontal: "center" }

    // 8) Late / On Time badge — also overrides the row tint on its column.
    if (late) {
      const lf = LATE_FILL[late]
      const lc = row.getCell(COL_LATE)
      lc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: lf.bg } }
      lc.font = { size: 10, name: UI_FONT, bold: true, color: { argb: lf.fg } }
      lc.alignment = { vertical: "middle", horizontal: "center" }
    }

    // 9) Actions → "Open" hyperlink. The /api/download/[id] route re-checks
    // auth on every request, so this URL never goes stale (unlike a presigned
    // URL with a fixed expiry). Keep the row-tint fill underneath the link.
    if (canOpen) {
      const openCell = row.getCell(COL_OPEN)
      openCell.value = {
        text: "Open",
        hyperlink: `${args.appOrigin}/api/download/${s.id}`,
        tooltip: s.file_name,
      }
      openCell.font = { size: 10, name: UI_FONT, color: { argb: "FF1D4ED8" }, underline: true }
      openCell.alignment = { vertical: "middle", horizontal: "center" }
    }
  }

  // Auto-filter so reviewers can re-filter inside Excel.
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
