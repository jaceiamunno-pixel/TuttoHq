import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { PDFDocument, StandardFonts, rgb } from "pdf-lib"

export async function POST(req: NextRequest) {
  const supabase = await createClient()

  const body = await req.json()
  const {
    submittalId,
    projectName,
    projectNumber,
    projectLocation,
    gcName,
    architect,
    specSectionNo,
    specSectionTitle,
    description,
    dateSubmitted,
    submittalNo,
    reviewedBy,
    certifiedBy,
    notes,
  } = body

  const { data: settings } = await supabase
    .from("company_settings")
    .select("logo_path")
    .eq("id", 1)
    .maybeSingle()

  let logoBytes: ArrayBuffer | null = null
  if (settings?.logo_path) {
    const { data: logoBlob } = await supabase.storage
      .from("company-assets")
      .download(settings.logo_path)
    if (logoBlob) {
      logoBytes = await logoBlob.arrayBuffer()
    }
  }

  const coverDoc = await PDFDocument.create()
  const boldFont = await coverDoc.embedFont(StandardFonts.HelveticaBold)
  const regFont  = await coverDoc.embedFont(StandardFonts.Helvetica)

  const pageW = 612
  const pageH = 792
  const margin = 36
  const contentW = pageW - margin * 2

  const page = coverDoc.addPage([pageW, pageH])

  const navyR = 0.13
  const navyG = 0.22
  const navyB = 0.40

  const lightBlueR = 0.87
  const lightBlueG = 0.91
  const lightBlueB = 0.96

  const headerH = 72

  page.drawRectangle({
    x: 0,
    y: pageH - headerH,
    width: pageW,
    height: headerH,
    color: rgb(navyR, navyG, navyB),
  })

  let logoEmbedded = false
  if (logoBytes) {
    try {
      const img = await coverDoc.embedPng(logoBytes)
      const dims = img.scale(1)
      const maxH = 44
      const maxW = 120
      const scale = Math.min(maxH / dims.height, maxW / dims.width, 1)
      const imgW = dims.width * scale
      const imgH = dims.height * scale
      page.drawImage(img, {
        x: margin,
        y: pageH - headerH + (headerH - imgH) / 2,
        width: imgW,
        height: imgH,
      })
      logoEmbedded = true
    } catch {
      try {
        const img = await coverDoc.embedJpg(logoBytes)
        const dims = img.scale(1)
        const maxH = 44
        const maxW = 120
        const scale = Math.min(maxH / dims.height, maxW / dims.width, 1)
        const imgW = dims.width * scale
        const imgH = dims.height * scale
        page.drawImage(img, {
          x: margin,
          y: pageH - headerH + (headerH - imgH) / 2,
          width: imgW,
          height: imgH,
        })
        logoEmbedded = true
      } catch {
        logoEmbedded = false
      }
    }
  }

  const titleX = logoEmbedded ? margin + 130 : margin
  page.drawText("SUBMITTAL TRANSMITTAL", {
    x: titleX,
    y: pageH - headerH + (headerH - 18) / 2,
    size: 18,
    font: boldFont,
    color: rgb(1, 1, 1),
  })

  let cursorY = pageH - headerH - 16

  function drawSectionHeader(label: string) {
    const sectionHeaderH = 18
    page.drawRectangle({
      x: margin,
      y: cursorY - sectionHeaderH,
      width: contentW,
      height: sectionHeaderH,
      color: rgb(lightBlueR, lightBlueG, lightBlueB),
    })
    page.drawText(label, {
      x: margin + 6,
      y: cursorY - sectionHeaderH + 5,
      size: 8,
      font: boldFont,
      color: rgb(navyR, navyG, navyB),
    })
    cursorY -= sectionHeaderH + 2
  }

  function drawRowDivider() {
    page.drawLine({
      start: { x: margin, y: cursorY },
      end:   { x: margin + contentW, y: cursorY },
      thickness: 0.5,
      color: rgb(0.80, 0.80, 0.80),
    })
  }

  const rowH = 28
  const labelSize = 6.5
  const valueSize = 9.5
  const labelColor = rgb(0.47, 0.47, 0.47)
  const valueColor = rgb(0.22, 0.22, 0.22)

  function drawField(label: string, value: string, x: number, y: number, w: number) {
    page.drawText(label.toUpperCase(), {
      x: x + 4,
      y: y + rowH - labelSize - 5,
      size: labelSize,
      font: regFont,
      color: labelColor,
    })
    const maxChars = Math.floor(w / (valueSize * 0.52))
    const displayVal = value.length > maxChars ? value.slice(0, maxChars - 1) + "…" : value
    page.drawText(displayVal || "—", {
      x: x + 4,
      y: y + 7,
      size: valueSize,
      font: boldFont,
      color: valueColor,
    })
  }

  function drawTwoColRow(
    label1: string, val1: string, flex1: number,
    label2: string, val2: string, flex2: number,
  ) {
    const total = flex1 + flex2
    const w1 = Math.round((contentW * flex1) / total)
    const w2 = contentW - w1
    const rowY = cursorY - rowH
    drawField(label1, val1, margin,      rowY, w1)
    drawField(label2, val2, margin + w1, rowY, w2)
    drawRowDivider()
    cursorY -= rowH
  }

  function drawOneColRow(label: string, value: string) {
    const rowY = cursorY - rowH
    drawField(label, value, margin, rowY, contentW)
    drawRowDivider()
    cursorY -= rowH
  }

  cursorY -= 4

  drawSectionHeader("PROJECT INFORMATION")

  drawTwoColRow("Project Name", projectName ?? "", 65, "Project No.", projectNumber ?? "", 35)
  drawOneColRow("Project Location", projectLocation ?? "")
  drawTwoColRow("General Contractor", gcName ?? "", 50, "Architect", architect ?? "", 50)

  cursorY -= 8

  drawSectionHeader("SUBMITTAL INFORMATION")

  drawTwoColRow("Spec Section No.", specSectionNo ?? "", 30, "Spec Section Title", specSectionTitle ?? "", 70)
  drawOneColRow("Submittal Description", description ?? "")
  drawTwoColRow("Date Submitted", dateSubmitted ?? "", 50, "Submittal No.", submittalNo ?? "", 50)

  cursorY -= 8

  drawSectionHeader("REVIEW / CERTIFICATION")

  drawTwoColRow("Reviewed By", reviewedBy ?? "", 50, "Certified by CQM", certifiedBy ?? "", 50)

  cursorY -= 8

  drawSectionHeader("NOTES")

  const notesText = (notes ?? "").trim()
  if (notesText) {
    const notesFontSize = 9
    const lineHeight = 14
    const maxLineW = contentW - 10
    const avgCharW = notesFontSize * 0.52
    const charsPerLine = Math.floor(maxLineW / avgCharW)

    const words = notesText.split(/\s+/)
    const lines: string[] = []
    let current = ""
    for (const word of words) {
      if ((current + (current ? " " : "") + word).length <= charsPerLine) {
        current += (current ? " " : "") + word
      } else {
        if (current) lines.push(current)
        current = word
      }
    }
    if (current) lines.push(current)

    const notesBlockH = Math.max(rowH, lines.length * lineHeight + 12)
    const notesY = cursorY - notesBlockH
    lines.forEach((line, i) => {
      page.drawText(line, {
        x: margin + 4,
        y: notesY + notesBlockH - 10 - i * lineHeight,
        size: notesFontSize,
        font: regFont,
        color: valueColor,
      })
    })
    drawRowDivider()
    cursorY -= notesBlockH
  } else {
    cursorY -= rowH
    drawRowDivider()
  }

  const footerY = 20
  const todayStr = new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" })

  page.drawLine({
    start: { x: margin, y: footerY + 10 },
    end:   { x: margin + contentW, y: footerY + 10 },
    thickness: 0.5,
    color: rgb(0.80, 0.80, 0.80),
  })
  page.drawText("Generated by SubmittalHub", {
    x: margin,
    y: footerY,
    size: 7,
    font: regFont,
    color: rgb(0.60, 0.60, 0.60),
  })
  page.drawText(todayStr, {
    x: margin + contentW - 50,
    y: footerY,
    size: 7,
    font: regFont,
    color: rgb(0.60, 0.60, 0.60),
  })

  const mergedDoc = await PDFDocument.create()
  const coverPages = await mergedDoc.copyPages(coverDoc, coverDoc.getPageIndices())
  coverPages.forEach(p => mergedDoc.addPage(p))

  if (submittalId) {
    const { data: submittalRow } = await supabase
      .from("submittals")
      .select("file_name, storage_path, mime_type")
      .eq("id", submittalId)
      .maybeSingle()

    if (submittalRow?.storage_path && submittalRow.mime_type === "application/pdf") {
      const { data: submittalBlob } = await supabase.storage
        .from("submittals")
        .download(submittalRow.storage_path)

      if (submittalBlob) {
        const submittalBytes = await submittalBlob.arrayBuffer()
        const submittalDoc   = await PDFDocument.load(submittalBytes)
        const submittalPages = await mergedDoc.copyPages(submittalDoc, submittalDoc.getPageIndices())
        submittalPages.forEach(p => mergedDoc.addPage(p))
      }
    }
  }

  const finalBytes = await mergedDoc.save()
  const filename   = submittalId ? "submittal_transmittal.pdf" : "cover_sheet.pdf"

  return new NextResponse(Buffer.from(finalBytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  })
}
