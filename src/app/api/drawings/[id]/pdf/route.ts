import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { PDFDocument, StandardFonts, rgb } from "pdf-lib"

const NAVY  = rgb(0.10, 0.18, 0.35)
const LBLUE = rgb(0.91, 0.94, 0.98)
const GRAY  = rgb(0.50, 0.50, 0.50)
const DARK  = rgb(0.13, 0.13, 0.13)
const WHITE = rgb(1, 1, 1)
const LGRAY = rgb(0.87, 0.87, 0.87)

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params

  const { data: dwg, error } = await supabase.from("drawing_log").select("*").eq("id", id).single()
  if (error || !dwg) return NextResponse.json({ error: "Drawing not found" }, { status: 404 })

  // Fetch revision history for this drawing number
  const { data: history } = await supabase.from("drawing_log")
    .select("*").eq("drawing_number", dwg.drawing_number)
    .order("created_at", { ascending: false })

  let project: Record<string, string | null> = {}
  if (dwg.project_id) {
    const { data: p } = await supabase.from("projects")
      .select("name, number, gc_name, architect, location").eq("id", dwg.project_id).maybeSingle()
    if (p) project = p
  }

  const { data: settings } = await supabase.from("company_settings").select("logo_path").eq("id", 1).maybeSingle()
  let logoBytes: ArrayBuffer | null = null
  if (settings?.logo_path) {
    const { data: blob } = await supabase.storage.from("company-assets").download(settings.logo_path)
    if (blob) logoBytes = await blob.arrayBuffer()
  }

  const doc  = await PDFDocument.create()
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const reg  = await doc.embedFont(StandardFonts.Helvetica)
  const W = 612, H = 792, M = 40, CW = W - M * 2
  const page = doc.addPage([W, H])

  // Header
  const headerH = 68
  page.drawRectangle({ x: 0, y: H - headerH, width: W, height: headerH, color: NAVY })
  if (logoBytes) {
    try {
      const img = await (async () => { try { return await doc.embedPng(logoBytes!) } catch { return await doc.embedJpg(logoBytes!) } })()
      const { width: iw, height: ih } = img.scale(1)
      const scale = Math.min(42 / ih, 110 / iw, 1)
      page.drawImage(img, { x: W - M - iw * scale, y: H - headerH + (headerH - ih * scale) / 2, width: iw * scale, height: ih * scale })
    } catch { /* skip */ }
  }
  page.drawText("DRAWING TRANSMITTAL", { x: M, y: H - headerH + (headerH - 18) / 2, size: 18, font: bold, color: WHITE })

  let y = H - headerH - 20
  const rowH = 28, lblSz = 7, valSz = 10

  function sectionHeader(label: string) {
    page.drawRectangle({ x: M, y: y - 19, width: CW, height: 19, color: LBLUE })
    page.drawRectangle({ x: M, y: y - 19, width: 3, height: 19, color: NAVY })
    page.drawText(label, { x: M + 10, y: y - 13, size: 8.5, font: bold, color: NAVY })
    y -= 21
  }

  function field(label: string, value: string, x: number, fy: number, w: number) {
    page.drawText(label.toUpperCase(), { x: x + 5, y: fy + rowH - lblSz - 6, size: lblSz, font: reg, color: GRAY })
    const max = Math.floor(w / (valSz * 0.54))
    page.drawText((value || "—").slice(0, max), { x: x + 5, y: fy + 8, size: valSz, font: bold, color: DARK })
  }

  function twoCol(l1: string, v1: string, f1: number, l2: string, v2: string, f2: number) {
    const w1 = Math.round(CW * f1 / (f1 + f2))
    const fy = y - rowH
    field(l1, v1, M, fy, w1)
    field(l2, v2, M + w1, fy, CW - w1)
    page.drawLine({ start: { x: M, y: fy }, end: { x: M + CW, y: fy }, thickness: 0.4, color: LGRAY })
    y -= rowH
  }

  function oneCol(label: string, value: string) {
    const fy = y - rowH
    field(label, value, M, fy, CW)
    page.drawLine({ start: { x: M, y: fy }, end: { x: M + CW, y: fy }, thickness: 0.4, color: LGRAY })
    y -= rowH
  }

  y -= 4

  if (project.name || project.number) {
    sectionHeader("PROJECT INFORMATION")
    twoCol("Project Name", project.name ?? "—", 65, "Project No.", project.number ?? "—", 35)
    if (project.gc_name || project.architect) twoCol("General Contractor", project.gc_name ?? "—", 50, "Architect", project.architect ?? "—", 50)
    if (project.location) oneCol("Location", project.location)
    y -= 6
  }

  sectionHeader("DRAWING INFORMATION")
  twoCol("Drawing Number", dwg.drawing_number ?? "—", 40, "Sheet Title", dwg.sheet_title ?? "—", 60)
  twoCol("Discipline", dwg.discipline ?? "—", 40, "Status", dwg.status ?? "—", 60)
  twoCol("Revision", dwg.revision ?? "0", 30, "Revision Date", dwg.revision_date ? new Date(dwg.revision_date).toLocaleDateString("en-US") : "—", 70)
  if (dwg.scale) oneCol("Scale", dwg.scale)
  if (dwg.notes) {
    y -= 6
    sectionHeader("NOTES")
    const noteLines = dwg.notes.split(/\n/).flatMap((line: string) => {
      const words = line.split(/\s+/)
      const out: string[] = []
      let cur = ""
      const max = Math.floor(CW / (8.5 * 0.52))
      for (const w of words) {
        if ((cur + (cur ? " " : "") + w).length <= max) cur += (cur ? " " : "") + w
        else { if (cur) out.push(cur); cur = w }
      }
      if (cur) out.push(cur)
      return out.length ? out : [""]
    })
    const blockH = Math.max(rowH, noteLines.length * 14 + 18)
    noteLines.forEach((line: string, i: number) => page.drawText(line, { x: M + 10, y: y - 13 - i * 14, size: 8.5, font: reg, color: DARK }))
    page.drawLine({ start: { x: M, y: y - blockH }, end: { x: M + CW, y: y - blockH }, thickness: 0.4, color: LGRAY })
    y -= blockH + 6
  }

  // Revision history table
  if (history && history.length > 1) {
    y -= 6
    sectionHeader("REVISION HISTORY")
    const colW = [50, 90, 110, 200, 82]
    const cols = ["Rev", "Date", "Status", "Sheet Title", "Superseded"]
    const tableX = M
    const tableRowH = 18

    // Header row
    page.drawRectangle({ x: tableX, y: y - tableRowH, width: CW, height: tableRowH, color: rgb(0.96, 0.96, 0.96) })
    let cx = tableX
    cols.forEach((c, i) => {
      page.drawText(c.toUpperCase(), { x: cx + 4, y: y - 13, size: 6.5, font: bold, color: GRAY })
      cx += colW[i]
    })
    page.drawLine({ start: { x: tableX, y: y - tableRowH }, end: { x: tableX + CW, y: y - tableRowH }, thickness: 0.4, color: LGRAY })
    y -= tableRowH

    for (const row of history.slice(0, 8)) {
      const vals = [
        row.revision ?? "0",
        row.revision_date ? new Date(row.revision_date).toLocaleDateString("en-US") : "—",
        row.status ?? "—",
        (row.sheet_title ?? "—").slice(0, 30),
        row.superseded_at ? new Date(row.superseded_at).toLocaleDateString("en-US") : (row.is_current ? "Current" : "—"),
      ]
      cx = tableX
      const isCurrent = row.is_current
      vals.forEach((v, i) => {
        page.drawText(v, { x: cx + 4, y: y - 12, size: 7.5, font: isCurrent ? bold : reg, color: isCurrent ? NAVY : DARK })
        cx += colW[i]
      })
      page.drawLine({ start: { x: tableX, y: y - tableRowH }, end: { x: tableX + CW, y: y - tableRowH }, thickness: 0.4, color: LGRAY })
      y -= tableRowH
    }
    y -= 4
  }

  // Signature lines
  y -= 8
  const sigY = Math.max(y, 90)
  page.drawLine({ start: { x: M, y: sigY }, end: { x: M + 190, y: sigY }, thickness: 0.5, color: LGRAY })
  page.drawText("Issued By / Date", { x: M, y: sigY - 13, size: 7, font: reg, color: GRAY })
  page.drawLine({ start: { x: M + 230, y: sigY }, end: { x: M + CW, y: sigY }, thickness: 0.5, color: LGRAY })
  page.drawText("Reviewed By / Date", { x: M + 230, y: sigY - 13, size: 7, font: reg, color: GRAY })

  // Footer
  const today = new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" })
  page.drawLine({ start: { x: M, y: 26 }, end: { x: M + CW, y: 26 }, thickness: 0.4, color: LGRAY })
  page.drawText("Generated by TuttoHQ", { x: M, y: 14, size: 7, font: reg, color: rgb(0.6, 0.6, 0.6) })
  page.drawText(today, { x: M + CW - 48, y: 14, size: 7, font: reg, color: rgb(0.6, 0.6, 0.6) })

  const pdfBytes = await doc.save()
  const safeDwg = dwg.drawing_number?.replace(/[^a-zA-Z0-9._-]/g, "_") ?? id
  const pdfPath = `drawings/${id}/drawing_${safeDwg}_rev${dwg.revision ?? "0"}.pdf`
  await supabase.storage.from("submittals").upload(pdfPath, Buffer.from(pdfBytes), { contentType: "application/pdf", upsert: true })
  await supabase.from("drawing_log").update({ generated_pdf_path: pdfPath }).eq("id", id)
  const { data: signed } = await supabase.storage.from("submittals").createSignedUrl(pdfPath, 604800)
  return NextResponse.json({ ok: true, url: signed?.signedUrl ?? null })
}
