import { PDFDocument, StandardFonts, rgb } from "pdf-lib"
import type { SubmittalCoversheetProps } from "@/components/submittals/SubmittalCoversheet"

// CSS design tokens → pdf-lib rgb()
const T = {
  ink:        rgb(0.059, 0.090, 0.165),  // #0f172a
  label:      rgb(0.118, 0.161, 0.231),  // #1e293b
  fill:       rgb(0.859, 0.906, 0.953),  // #dbe7f3 steel-blue field fill
  rule:       rgb(0.796, 0.835, 0.882),  // #cbd5e1
  ruleStrong: rgb(0.278, 0.337, 0.412),  // #475569
  muted:      rgb(0.580, 0.639, 0.722),  // #94a3b8
  accent:     rgb(0.114, 0.306, 0.847),  // #1d4ed8
  white:      rgb(1, 1, 1),
}

export async function buildCoversheetPdf(
  props: SubmittalCoversheetProps,
  logoBytes: ArrayBuffer | null = null,
): Promise<Uint8Array> {
  const {
    gcName,
    projectName, projectNumber, projectLocation,
    submittalDescription, specSectionTitle, specSectionNumber,
    submittalNumber, revisionNumber, dateSubmitted, submittalDueDate,
    criticalSubmittal = false, submittalPartyRequired = false, copyTo = "",
    stamps, page = 1, totalPages = 1, version = "1.0",
  } = props

  const doc  = await PDFDocument.create()
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const reg  = await doc.embedFont(StandardFonts.Helvetica)
  const pg   = doc.addPage([612, 792])

  // Layout constants (points = 1/72 inch)
  const ML   = 43   // left/right margin (0.6in)
  const MT   = 36   // top margin (0.5in)
  const CW   = 526  // content width
  const LBL  = 112  // label column (1.55in)
  const RH   = 22   // standard field row height
  const LSZ  = 9.5  // label font size
  const VSZ  = 10.5 // value font size

  let y = 792 - MT  // cursor starts at top of content area

  // ── Helpers ────────────────────────────────────────────────────────────────

  function clip(text: string, maxPx: number, size: number, font: typeof bold) {
    let s = text
    while (s.length > 0 && font.widthOfTextAtSize(s, size) > maxPx) s = s.slice(0, -1)
    return s
  }

  // Draw one label|value field cell at absolute coordinates
  function cell(x: number, fy: number, w: number, label: string, value: string, lw = LBL) {
    const lw_ = Math.min(lw, Math.floor(w * 0.45))
    const vw  = w - lw_
    pg.drawRectangle({ x, y: fy, width: lw_, height: RH, color: T.white })
    pg.drawRectangle({ x: x + lw_, y: fy, width: vw, height: RH, color: T.fill })
    pg.drawText(clip(label, lw_ - 8, LSZ, bold), { x: x + 5, y: fy + 6, size: LSZ, font: bold, color: T.label })
    pg.drawText(clip(value || "", vw - 8, VSZ, reg), { x: x + lw_ + 5, y: fy + 6, size: VSZ, font: reg, color: T.ink })
  }

  // Full-width row with horizontal rule below
  function row(label: string, value: string) {
    y -= RH
    cell(ML, y, CW, label, value)
    pg.drawLine({ start: { x: ML, y }, end: { x: ML + CW, y }, thickness: 0.5, color: T.rule })
    pg.drawLine({ start: { x: ML + LBL, y }, end: { x: ML + LBL, y: y + RH }, thickness: 0.5, color: T.rule })
  }

  // Block outer border (call after drawing all rows so it sits on top)
  function blockBorder(topY: number) {
    const h = topY - y
    pg.drawLine({ start: { x: ML, y: topY }, end: { x: ML + CW, y: topY }, thickness: 0.75, color: T.rule })
    pg.drawLine({ start: { x: ML, y }, end: { x: ML + CW, y }, thickness: 0.75, color: T.rule })
    pg.drawLine({ start: { x: ML, y }, end: { x: ML, y: topY }, thickness: 0.75, color: T.rule })
    pg.drawLine({ start: { x: ML + CW, y }, end: { x: ML + CW, y: topY }, thickness: 0.75, color: T.rule })
    void h
  }

  // ── HEADER ─────────────────────────────────────────────────────────────────

  // Title
  pg.drawText("Submittal Coversheet", { x: ML, y: y - 12, size: 16, font: bold, color: T.ink })

  // Logo or company name (right-aligned)
  if (logoBytes) {
    try {
      let img
      try { img = await doc.embedPng(logoBytes) } catch { img = await doc.embedJpg(logoBytes) }
      const { width: iw, height: ih } = img.scale(1)
      const scale = Math.min(32 / ih, 140 / iw, 1)
      pg.drawImage(img, { x: ML + CW - iw * scale, y: y - ih * scale, width: iw * scale, height: ih * scale })
    } catch { /* skip broken logo */ }
  } else if (gcName) {
    const nw = bold.widthOfTextAtSize(gcName, 13)
    pg.drawText(gcName, { x: ML + CW - nw, y: y - 12, size: 13, font: bold, color: T.ink })
  }

  y -= 33  // header height (≈ 0.45in)
  y -= 9   // gap (≈ 0.12in)

  // ── PROJECT BLOCK ──────────────────────────────────────────────────────────

  const projTop = y
  row("Project Name",     projectName)
  row("Project Number",   projectNumber)
  row("Project Location", projectLocation)
  blockBorder(projTop)

  y -= 4  // gap between blocks

  // ── SUBMITTAL BLOCK ────────────────────────────────────────────────────────

  const subTop = y

  row("Submittal Description", submittalDescription)
  row("Spec Section Title",    specSectionTitle)

  // 3-column row: Spec Section No. | Submittal No. | Revision No.
  const col3 = Math.floor(CW / 3)
  y -= RH
  const r3y = y
  cell(ML,          r3y, col3, "Spec Section No.", specSectionNumber)
  cell(ML + col3,   r3y, col3, "Submittal No.",    submittalNumber)
  cell(ML + col3*2, r3y, CW - col3*2, "Revision No.", revisionNumber)
  pg.drawLine({ start: { x: ML, y: r3y }, end: { x: ML + CW, y: r3y }, thickness: 0.5, color: T.rule })
  pg.drawLine({ start: { x: ML + col3,   y: r3y }, end: { x: ML + col3,   y: r3y + RH }, thickness: 0.5, color: T.rule })
  pg.drawLine({ start: { x: ML + col3*2, y: r3y }, end: { x: ML + col3*2, y: r3y + RH }, thickness: 0.5, color: T.rule })

  // 2-column row: Date Submitted | Submittal Due Date
  const col2 = Math.floor(CW / 2)
  y -= RH
  const r2y = y
  cell(ML,        r2y, col2, "Date Submitted",    dateSubmitted)
  cell(ML + col2, r2y, CW - col2, "Submittal Due Date", submittalDueDate)
  pg.drawLine({ start: { x: ML, y: r2y }, end: { x: ML + CW, y: r2y }, thickness: 0.5, color: T.rule })
  pg.drawLine({ start: { x: ML + col2, y: r2y }, end: { x: ML + col2, y: r2y + RH }, thickness: 0.5, color: T.rule })

  // Checkbox row
  y -= RH
  const cby = y
  pg.drawRectangle({ x: ML, y: cby, width: CW, height: RH, color: T.white })
  const drawCheckbox = (cx: number, label: string, checked: boolean) => {
    const bx = cx + 5, by = cby + 6
    pg.drawRectangle({ x: bx, y: by, width: 10, height: 10, borderColor: T.label, borderWidth: 1, color: T.white })
    if (checked) {
      pg.drawText("✓", { x: bx + 1, y: by + 1, size: 9, font: bold, color: T.accent })
    }
    pg.drawText(label, { x: bx + 14, y: by + 1, size: LSZ, font: bold, color: T.label })
  }
  drawCheckbox(ML, "Critical Submittal", criticalSubmittal)
  drawCheckbox(ML + CW / 2, "Submittal Party Required", submittalPartyRequired)
  pg.drawLine({ start: { x: ML, y: cby }, end: { x: ML + CW, y: cby }, thickness: 0.5, color: T.rule })

  row("Copy To", copyTo)

  blockBorder(subTop)

  y -= 10  // gap before stamps

  // ── STAMPS GRID (2×2) ──────────────────────────────────────────────────────

  const resolvedStamps = stamps ?? [
    { role: "GC" as const }, { role: "Architect" as const },
    { role: "Engineer" as const }, { role: "Subcontractor" as const },
  ]

  const FOOTER_H = 32  // reserve space for footer
  const stampAreaH = y - FOOTER_H - 8
  const gap = 13       // 0.18in gap between cells
  const cellW = Math.floor((CW - gap) / 2)
  const cellH = Math.floor((stampAreaH - gap) / 2)

  const stampPositions = [
    { x: ML,            sy: y - cellH },          // top-left (GC)
    { x: ML + cellW + gap, sy: y - cellH },        // top-right (Architect)
    { x: ML,            sy: y - cellH*2 - gap },   // bottom-left (Engineer)
    { x: ML + cellW + gap, sy: y - cellH*2 - gap },// bottom-right (Subcontractor)
  ]

  resolvedStamps.forEach((stamp, i) => {
    const { x: sx, sy } = stampPositions[i]
    // Cell background
    pg.drawRectangle({ x: sx, y: sy, width: cellW, height: cellH, color: T.white, borderColor: T.ruleStrong, borderWidth: 0.75 })
    // Stamp content or placeholder
    if (stamp.content && typeof stamp.content === "string" && stamp.content.trim()) {
      pg.drawText(clip(String(stamp.content), cellW - 16, 8.5, reg), { x: sx + 8, y: sy + cellH - 20, size: 8.5, font: reg, color: T.ink })
    } else {
      // Placeholder in bottom-right
      const ph = `${stamp.role} Stamp`
      const phW = reg.widthOfTextAtSize(ph, 8)
      pg.drawText(ph, { x: sx + cellW - phW - 8, y: sy + 8, size: 8, font: reg, color: T.muted })
    }
  })

  // ── FOOTER ──────────────────────────────────────────────────────────────────

  const footerY = FOOTER_H - 4
  pg.drawLine({ start: { x: ML, y: footerY + 14 }, end: { x: ML + CW, y: footerY + 14 }, thickness: 0.5, color: T.ruleStrong })
  pg.drawText("Generated by TuttoHQ", { x: ML, y: footerY, size: 8.5, font: bold, color: T.label })
  const pageStr = `${page} / ${totalPages}`
  const pageW = bold.widthOfTextAtSize(pageStr, 8.5)
  pg.drawText(pageStr, { x: ML + (CW - pageW) / 2, y: footerY, size: 8.5, font: bold, color: T.label })
  const verStr = `v. ${version}`
  const verW = reg.widthOfTextAtSize(verStr, 8.5)
  pg.drawText(verStr, { x: ML + CW - verW, y: footerY, size: 8.5, font: reg, color: T.label, opacity: 0.6 })

  return doc.save()
}
