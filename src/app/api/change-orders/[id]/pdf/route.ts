import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { PDFDocument, StandardFonts, rgb } from "pdf-lib"

const NAVY  = rgb(0.13, 0.22, 0.40)
const LBLUE = rgb(0.87, 0.91, 0.96)
const GRAY  = rgb(0.47, 0.47, 0.47)
const DARK  = rgb(0.22, 0.22, 0.22)
const WHITE = rgb(1, 1, 1)
const LGRAY = rgb(0.80, 0.80, 0.80)
const GREEN = rgb(0.13, 0.55, 0.13)

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

function formatCurrency(n: number | null): string {
  if (n == null) return "—"
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n)
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params

  const { data: co, error: coErr } = await supabase
    .from("change_orders").select("*").eq("id", id).single()
  if (coErr || !co) return NextResponse.json({ error: "Change order not found" }, { status: 404 })

  let project: Record<string, string | null> = {}
  if (co.project_id) {
    const { data: p } = await supabase.from("projects")
      .select("name, number, gc_name, architect, location").eq("id", co.project_id).maybeSingle()
    if (p) project = p
  }

  const { data: settings } = await supabase.from("company_settings")
    .select("logo_path").eq("id", 1).maybeSingle()

  let logoBytes: ArrayBuffer | null = null
  if (settings?.logo_path) {
    const { data: blob } = await supabase.storage.from("company-assets").download(settings.logo_path)
    if (blob) logoBytes = await blob.arrayBuffer()
  }

  const doc  = await PDFDocument.create()
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const reg  = await doc.embedFont(StandardFonts.Helvetica)
  const W = 612, H = 792, M = 36, CW = W - M * 2
  const page = doc.addPage([W, H])

  // Header
  const headerH = 72
  page.drawRectangle({ x: 0, y: H - headerH, width: W, height: headerH, color: NAVY })

  if (logoBytes) {
    try {
      const img = await (async () => {
        try { return await doc.embedPng(logoBytes!) } catch { return await doc.embedJpg(logoBytes!) }
      })()
      const { width: iw, height: ih } = img.scale(1)
      const scale = Math.min(44 / ih, 120 / iw, 1)
      page.drawImage(img, { x: W - M - iw * scale, y: H - headerH + (headerH - ih * scale) / 2, width: iw * scale, height: ih * scale })
    } catch { /* skip */ }
  }

  page.drawText("CHANGE ORDER", { x: M, y: H - headerH + (headerH - 18) / 2, size: 18, font: bold, color: WHITE })

  let y = H - headerH - 16
  const rowH = 26
  const lblSz = 6.5, valSz = 9.5

  function sectionHeader(label: string) {
    page.drawRectangle({ x: M, y: y - 18, width: CW, height: 18, color: LBLUE })
    page.drawText(label, { x: M + 6, y: y - 13, size: 8, font: bold, color: NAVY })
    y -= 20
  }

  function field(label: string, value: string, x: number, fy: number, w: number) {
    page.drawText(label.toUpperCase(), { x: x + 4, y: fy + rowH - lblSz - 5, size: lblSz, font: reg, color: GRAY })
    const max = Math.floor(w / (valSz * 0.52))
    page.drawText((value || "—").slice(0, max), { x: x + 4, y: fy + 7, size: valSz, font: bold, color: DARK })
  }

  function twoCol(l1: string, v1: string, f1: number, l2: string, v2: string, f2: number) {
    const w1 = Math.round(CW * f1 / (f1 + f2))
    const fy = y - rowH
    field(l1, v1, M, fy, w1)
    field(l2, v2, M + w1, fy, CW - w1)
    page.drawLine({ start: { x: M, y: fy }, end: { x: M + CW, y: fy }, thickness: 0.5, color: LGRAY })
    y -= rowH
  }

  function oneCol(label: string, value: string) {
    const fy = y - rowH
    field(label, value, M, fy, CW)
    page.drawLine({ start: { x: M, y: fy }, end: { x: M + CW, y: fy }, thickness: 0.5, color: LGRAY })
    y -= rowH
  }

  function textBlock(label: string, text: string) {
    const lines = wrapText(text || "", Math.floor(CW / (8.5 * 0.52)))
    const blockH = Math.max(rowH, lines.length * 14 + 16)
    sectionHeader(label)
    lines.forEach((line, i) => {
      page.drawText(line, { x: M + 6, y: y - 12 - i * 14, size: 8.5, font: reg, color: DARK })
    })
    page.drawLine({ start: { x: M, y: y - blockH }, end: { x: M + CW, y: y - blockH }, thickness: 0.5, color: LGRAY })
    y -= blockH + 4
  }

  y -= 4

  sectionHeader("PROJECT INFORMATION")
  twoCol("Project Name", project.name ?? "—", 65, "Project No.", project.number ?? "—", 35)
  twoCol("General Contractor", project.gc_name ?? "—", 50, "Architect", project.architect ?? "—", 50)
  oneCol("Project Location", project.location ?? "—")

  y -= 6

  sectionHeader("CHANGE ORDER DETAILS")
  twoCol("CO Number", co.co_number ?? "—", 25, "Date", co.date ? new Date(co.date).toLocaleDateString("en-US") : "—", 75)
  twoCol("Status", co.status ?? "Draft", 50, "Assigned To", co.assigned_to ?? "—", 50)
  twoCol("Schedule Impact", co.schedule_impact ?? "TBD", 50,
         "Days Impact", co.schedule_impact_days != null ? String(co.schedule_impact_days) : "—", 50)

  y -= 6
  textBlock("PROPOSAL", co.proposal ?? "")
  textBlock("QUALIFICATIONS / EXCLUSIONS", co.qualifications ?? "")

  // Pricing — large display
  y -= 4
  sectionHeader("PRICING")
  page.drawRectangle({ x: M, y: y - 48, width: CW, height: 48, color: rgb(0.97, 0.97, 0.97) })
  page.drawText("TOTAL CHANGE ORDER AMOUNT", { x: M + 12, y: y - 18, size: 8, font: reg, color: GRAY })
  page.drawText(formatCurrency(co.pricing_sum), { x: M + 12, y: y - 38, size: 20, font: bold, color: co.status === "Approved" ? GREEN : DARK })
  page.drawLine({ start: { x: M, y: y - 48 }, end: { x: M + CW, y: y - 48 }, thickness: 0.5, color: LGRAY })
  y -= 52

  if (co.file_name) {
    y -= 4
    sectionHeader("ATTACHED FILE")
    page.drawText(co.file_name, { x: M + 6, y: y - 14, size: 8.5, font: reg, color: DARK })
    y -= rowH
  }

  // Signature lines
  y -= 16
  const sigY = Math.max(y, 90)
  page.drawLine({ start: { x: M, y: sigY }, end: { x: M + 180, y: sigY }, thickness: 0.5, color: LGRAY })
  page.drawText("Submitted By / Date", { x: M, y: sigY - 12, size: 7, font: reg, color: GRAY })
  if (co.submitted_by) page.drawText(co.submitted_by, { x: M, y: sigY + 4, size: 8.5, font: bold, color: DARK })

  page.drawLine({ start: { x: M + 220, y: sigY }, end: { x: M + CW, y: sigY }, thickness: 0.5, color: LGRAY })
  page.drawText("Owner / Architect Approval / Date", { x: M + 220, y: sigY - 12, size: 7, font: reg, color: GRAY })

  // Footer
  const today = new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" })
  page.drawLine({ start: { x: M, y: 24 }, end: { x: M + CW, y: 24 }, thickness: 0.5, color: LGRAY })
  page.drawText("Generated by TuttoHQ", { x: M, y: 14, size: 7, font: reg, color: rgb(0.6, 0.6, 0.6) })
  page.drawText(today, { x: M + CW - 45, y: 14, size: 7, font: reg, color: rgb(0.6, 0.6, 0.6) })

  const pdfBytes = await doc.save()

  const pdfPath = `change-orders/${id}/co_${co.co_number?.replace(/\s+/g, "_") ?? id}.pdf`
  await supabase.storage.from("submittals").upload(pdfPath, Buffer.from(pdfBytes), {
    contentType: "application/pdf", upsert: true,
  })
  await supabase.from("change_orders").update({ generated_pdf_path: pdfPath }).eq("id", id)

  const { data: signed } = await supabase.storage.from("submittals").createSignedUrl(pdfPath, 604800)
  return NextResponse.json({ ok: true, url: signed?.signedUrl ?? null })
}
