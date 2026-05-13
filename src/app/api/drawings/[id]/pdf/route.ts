import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { PDFBuilder } from "@/lib/pdf-builder"

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
  b.twoCol("Discipline", dwg.discipline ?? "—", 40, "Scale", dwg.scale ?? "—", 60)
  b.twoColStatus("Revision", dwg.revision ?? "0", 25, "Status", dwg.status ?? "—", 75)
  b.twoCol("Revision Date", dwg.revision_date ? new Date(dwg.revision_date).toLocaleDateString("en-US") : "—", 50, " ", " ", 50)
  if (dwg.notes) {
    b.gap()
    b.textBlock("NOTES", dwg.notes)
  }

  if (history && history.length > 1) {
    b.gap()
    b.sectionHeader("REVISION HISTORY")
    const colW = [48, 90, 110, 216, 88]
    b.tableHeader(["Rev", "Date", "Status", "Sheet Title", "Note"], colW)
    for (const row of history.slice(0, 10)) {
      const note = row.is_current ? "Current" : row.superseded_at ? new Date(row.superseded_at).toLocaleDateString("en-US") : "—"
      b.tableRow([
        row.revision ?? "0",
        row.revision_date ? new Date(row.revision_date).toLocaleDateString("en-US") : "—",
        row.status ?? "—",
        (row.sheet_title ?? "—").slice(0, 34),
        note,
      ], colW, !!row.is_current)
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
