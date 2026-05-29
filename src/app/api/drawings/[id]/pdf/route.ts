import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { PDFBuilder } from "@/lib/pdf-builder"

export const maxDuration = 60

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

  const { data: settings } = await supabase.from("company_settings").select("logo_path").maybeSingle()
  let logoBytes: ArrayBuffer | null = null
  if (settings?.logo_path) {
    const { data: blob } = await supabase.storage.from("company-assets").download(settings.logo_path)
    if (blob) logoBytes = await blob.arrayBuffer()
  }

  const pdf = await PDFBuilder.create({
    documentType: "Drawing Transmittal",
    documentNumber: dwg.drawing_number,
    logoBytes,
  })

  if (project.name || project.number) {
    pdf.projectBlock({
      name: project.name, number: project.number, location: project.location,
      gc_name: project.gc_name, architect: project.architect,
    })
  }

  pdf.sectionDivider("Drawing Information")
  pdf.fieldGrid([
    [{ label: "Drawing Number", value: dwg.drawing_number }, { label: "Sheet Title", value: dwg.sheet_title }],
    [{ label: "Discipline", value: dwg.discipline }, { label: "Scale", value: dwg.scale }],
    [{ label: "Revision", value: dwg.revision ?? "0" }, { label: "Status", status: dwg.status }],
    [{ label: "Revision Date", value: dwg.revision_date ? new Date(dwg.revision_date).toLocaleDateString("en-US") : null }],
  ])

  if (dwg.notes) pdf.textBlock("Notes", dwg.notes)

  if (history && history.length > 1) {
    pdf.sectionDivider("Revision History")
    const colW = [48, 90, 110, 216, 88]
    pdf.tableHeader(["Rev", "Date", "Status", "Sheet Title", "Note"], colW)
    for (const row of history.slice(0, 10)) {
      const note = row.is_current
        ? "Current"
        : row.superseded_at ? new Date(row.superseded_at).toLocaleDateString("en-US") : "—"
      pdf.tableRow([
        row.revision ?? "0",
        row.revision_date ? new Date(row.revision_date).toLocaleDateString("en-US") : "—",
        row.status ?? "—",
        (row.sheet_title ?? "—").slice(0, 34),
        note,
      ], colW, !!row.is_current)
    }
  }

  pdf.signatureBlock("Issued By / Date", "Reviewed By / Date")

  const pdfBytes = await pdf.save()
  const safeDwg = dwg.drawing_number?.replace(/[^a-zA-Z0-9._-]/g, "_") ?? id
  // Tenant-isolated path (new storage RLS uses (storage.foldername)[1]).
  const { data: companyId } = await supabase.rpc("get_my_company_id")
  if (!companyId) return NextResponse.json({ error: "No company association" }, { status: 500 })
  // Unique path per generation — avoids Supabase's CDN serving a stale cached copy.
  const pdfPath = `${companyId}/drawings/${id}/drawing_${safeDwg}_rev${dwg.revision ?? "0"}_${Date.now()}.pdf`
  await supabase.storage.from("submittals").upload(pdfPath, Buffer.from(pdfBytes), { contentType: "application/pdf", upsert: true })
  await supabase.from("drawing_log").update({ generated_pdf_path: pdfPath }).eq("id", id)
  const { data: signed } = await supabase.storage.from("submittals").createSignedUrl(pdfPath, 604800)
  return NextResponse.json({ ok: true, url: signed?.signedUrl ?? null })
}
