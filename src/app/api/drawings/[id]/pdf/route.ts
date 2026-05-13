import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { PDFBuilder, C } from "@/lib/pdf-builder"

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params

  const { data: dwg, error } = await supabase.from("drawing_log").select("*").eq("id", id).single()
  if (error || !dwg) return NextResponse.json({ error: "Drawing not found" }, { status: 404 })

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

  const b = await PDFBuilder.create("DRAWING TRANSMITTAL", logoBytes)

  if (project.name || project.number) {
    b.sectionHeader("PROJECT INFORMATION")
    b.twoCol("Project Name", project.name ?? "—", 65, "Project No.", project.number ?? "—", 35)
    if (project.gc_name || project.architect)
      b.twoCol("General Contractor", project.gc_name ?? "—", 50, "Architect", project.architect ?? "—", 50)
    if (project.location) b.oneCol("Location", project.location)
    b.gap()
  }

  b.sectionHeader("DRAWING INFORMATION")
  b.twoCol("Drawing Number", dwg.drawing_number ?? "—", 35, "Sheet Title", dwg.sheet_title ?? "—", 65)
  b.twoCol("Discipline", dwg.discipline ?? "—", 40, "Status", dwg.status ?? "—", 60)
  b.twoCol("Revision", dwg.revision ?? "0", 25, "Revision Date", dwg.revision_date ? new Date(dwg.revision_date).toLocaleDateString("en-US") : "—", 75)
  if (dwg.scale) b.oneCol("Scale", dwg.scale)
  if (dwg.notes) {
    b.gap()
    b.textBlock("NOTES", dwg.notes)
  }

  // Revision history table
  if (history && history.length > 1) {
    b.gap()
    b.sectionHeader("REVISION HISTORY")
    const colW = [50, 95, 110, 200, 77]
    const headers = ["Rev", "Date", "Status", "Sheet Title", "Note"]
    const tableRowH = 20
    const { rgb } = await import("pdf-lib")

    // Header row
    b.page.drawRectangle({ x: b.M, y: b.y - tableRowH, width: b.CW, height: tableRowH, color: rgb(0.94, 0.95, 0.97) })
    let cx = b.M
    headers.forEach((h, i) => {
      b.page.drawText(h.toUpperCase(), { x: cx + 5, y: b.y - 14, size: 6.5, font: b.bold, color: C.label })
      cx += colW[i]
    })
    b.page.drawLine({ start: { x: b.M, y: b.y - tableRowH }, end: { x: b.M + b.CW, y: b.y - tableRowH }, thickness: 0.5, color: C.border })
    b.y -= tableRowH

    for (const row of (history ?? []).slice(0, 9)) {
      const note = row.is_current ? "Current" : row.superseded_at ? new Date(row.superseded_at).toLocaleDateString("en-US") : "—"
      const vals = [
        row.revision ?? "0",
        row.revision_date ? new Date(row.revision_date).toLocaleDateString("en-US") : "—",
        row.status ?? "—",
        (row.sheet_title ?? "—").slice(0, 32),
        note,
      ]
      cx = b.M
      vals.forEach((v, i) => {
        b.page.drawText(v, { x: cx + 5, y: b.y - 14, size: 8, font: row.is_current ? b.bold : b.reg, color: row.is_current ? C.navy : C.dark })
        cx += colW[i]
      })
      b.page.drawLine({ start: { x: b.M, y: b.y - tableRowH }, end: { x: b.M + b.CW, y: b.y - tableRowH }, thickness: 0.5, color: C.border })
      b.y -= tableRowH
    }
    b.gap(6)
  }

  b.signatureLines("Issued By / Date", "Reviewed By / Date")

  const pdfBytes = await b.save()
  const safeDwg = dwg.drawing_number?.replace(/[^a-zA-Z0-9._-]/g, "_") ?? id
  const pdfPath = `drawings/${id}/drawing_${safeDwg}_rev${dwg.revision ?? "0"}.pdf`
  await supabase.storage.from("submittals").upload(pdfPath, Buffer.from(pdfBytes), { contentType: "application/pdf", upsert: true })
  await supabase.from("drawing_log").update({ generated_pdf_path: pdfPath }).eq("id", id)
  const { data: signed } = await supabase.storage.from("submittals").createSignedUrl(pdfPath, 604800)
  return NextResponse.json({ ok: true, url: signed?.signedUrl ?? null })
}
