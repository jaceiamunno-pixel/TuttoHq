import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { PDFDocument, StandardFonts, rgb } from "pdf-lib"

const NAVY  = rgb(0.10, 0.18, 0.35)
const LBLUE = rgb(0.91, 0.94, 0.98)
const GRAY  = rgb(0.50, 0.50, 0.50)
const DARK  = rgb(0.13, 0.13, 0.13)
const WHITE = rgb(1, 1, 1)
const LGRAY = rgb(0.87, 0.87, 0.87)

const PRIORITY_COLORS: Record<string, [number, number, number]> = {
  High:   [0.80, 0.15, 0.15],
  Medium: [0.75, 0.50, 0.05],
  Low:    [0.15, 0.55, 0.20],
}

function wrapText(text: string, maxChars: number): string[] {
  const words = (text ?? "").split(/\s+/)
  const lines: string[] = []
  let cur = ""
  for (const w of words) {
    if ((cur + (cur ? " " : "") + w).length <= maxChars) cur += (cur ? " " : "") + w
    else { if (cur) lines.push(cur); cur = w }
  }
  if (cur) lines.push(cur)
  return lines.length ? lines : [""]
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params

  const { data: item, error } = await supabase.from("punch_items").select("*").eq("id", id).single()
  if (error || !item) return NextResponse.json({ error: "Item not found" }, { status: 404 })

  let project: Record<string, string | null> = {}
  if (item.project_id) {
    const { data: p } = await supabase.from("projects")
      .select("name, number, gc_name, architect, location").eq("id", item.project_id).maybeSingle()
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
  page.drawText("PUNCH LIST ITEM", { x: M, y: H - headerH + (headerH - 18) / 2, size: 18, font: bold, color: WHITE })

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

  function textBlock(label: string, text: string) {
    if (!text?.trim()) return
    const lines = wrapText(text, Math.floor(CW / (8.5 * 0.52)))
    const blockH = Math.max(rowH, lines.length * 14 + 18)
    sectionHeader(label)
    lines.forEach((line, i) => page.drawText(line, { x: M + 10, y: y - 13 - i * 14, size: 8.5, font: reg, color: DARK }))
    page.drawLine({ start: { x: M, y: y - blockH }, end: { x: M + CW, y: y - blockH }, thickness: 0.4, color: LGRAY })
    y -= blockH + 6
  }

  y -= 4

  if (project.name || project.number) {
    sectionHeader("PROJECT INFORMATION")
    twoCol("Project Name", project.name ?? "—", 65, "Project No.", project.number ?? "—", 35)
    if (project.gc_name || project.architect) twoCol("General Contractor", project.gc_name ?? "—", 50, "Architect", project.architect ?? "—", 50)
    if (project.location) oneCol("Location", project.location)
    y -= 6
  }

  sectionHeader("ITEM DETAILS")
  twoCol("Item Number", item.item_number ?? "—", 30, "Status", item.status ?? "Open", 70)
  twoCol("Priority", item.priority ?? "Medium", 30, "Assigned To", item.assigned_to ?? "—", 70)
  twoCol("Due Date", item.due_date ? new Date(item.due_date).toLocaleDateString("en-US") : "—", 50,
         "Created", new Date(item.created_at).toLocaleDateString("en-US"), 50)
  if (item.location) oneCol("Location", item.location)

  y -= 6
  textBlock("DESCRIPTION", item.description ?? "")
  if (item.notes) textBlock("NOTES", item.notes)

  // Priority badge
  const priBgRgb = PRIORITY_COLORS[item.priority] ?? [0.47, 0.47, 0.47]
  const priBg = rgb(priBgRgb[0], priBgRgb[1], priBgRgb[2])
  page.drawRectangle({ x: M, y: y - 28, width: 80, height: 20, color: priBg })
  page.drawText(`PRIORITY: ${(item.priority ?? "MEDIUM").toUpperCase()}`, { x: M + 8, y: y - 21, size: 7.5, font: bold, color: WHITE })
  y -= 36

  // Signature lines
  y -= 8
  const sigY = Math.max(y, 90)
  page.drawLine({ start: { x: M, y: sigY }, end: { x: M + 190, y: sigY }, thickness: 0.5, color: LGRAY })
  page.drawText("Inspected By / Date", { x: M, y: sigY - 13, size: 7, font: reg, color: GRAY })
  page.drawLine({ start: { x: M + 230, y: sigY }, end: { x: M + CW, y: sigY }, thickness: 0.5, color: LGRAY })
  page.drawText("Corrective Action By / Date", { x: M + 230, y: sigY - 13, size: 7, font: reg, color: GRAY })

  // Footer
  const today = new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" })
  page.drawLine({ start: { x: M, y: 26 }, end: { x: M + CW, y: 26 }, thickness: 0.4, color: LGRAY })
  page.drawText("Generated by TuttoHQ", { x: M, y: 14, size: 7, font: reg, color: rgb(0.6, 0.6, 0.6) })
  page.drawText(today, { x: M + CW - 48, y: 14, size: 7, font: reg, color: rgb(0.6, 0.6, 0.6) })

  const pdfBytes = await doc.save()
  const pdfPath = `punch/${id}/punch_${item.item_number?.replace(/\s+/g, "_") ?? id}.pdf`
  await supabase.storage.from("submittals").upload(pdfPath, Buffer.from(pdfBytes), { contentType: "application/pdf", upsert: true })
  await supabase.from("punch_items").update({ generated_pdf_path: pdfPath }).eq("id", id)
  const { data: signed } = await supabase.storage.from("submittals").createSignedUrl(pdfPath, 604800)
  return NextResponse.json({ ok: true, url: signed?.signedUrl ?? null })
}
