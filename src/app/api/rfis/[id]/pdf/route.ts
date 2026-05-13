import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { PDFBuilder } from "@/lib/pdf-builder"

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params

  const { data: rfi, error: rfiErr } = await supabase.from("rfis").select("*").eq("id", id).single()
  if (rfiErr || !rfi) return NextResponse.json({ error: "RFI not found" }, { status: 404 })

  let project: Record<string, string | null> = {}
  if (rfi.project_id) {
    const { data: p } = await supabase.from("projects")
      .select("name, number, gc_name, architect, location").eq("id", rfi.project_id).maybeSingle()
    if (p) project = p
  }

  const { data: settings } = await supabase.from("company_settings").select("logo_path").eq("id", 1).maybeSingle()
  let logoBytes: ArrayBuffer | null = null
  if (settings?.logo_path) {
    const { data: blob } = await supabase.storage.from("company-assets").download(settings.logo_path)
    if (blob) logoBytes = await blob.arrayBuffer()
  }

  const b = await PDFBuilder.create("REQUEST FOR INFORMATION", logoBytes)

  if (project.name || project.number) {
    b.sectionHeader("PROJECT INFORMATION")
    b.twoCol("Project Name", project.name ?? "—", 65, "Project No.", project.number ?? "—", 35)
    if (project.gc_name || project.architect)
      b.twoCol("General Contractor", project.gc_name ?? "—", 50, "Architect", project.architect ?? "—", 50)
    if (project.location) b.oneCol("Project Location", project.location)
    b.gap()
  }

  b.sectionHeader("RFI DETAILS")
  b.twoColStatus("RFI Number", rfi.rfi_number ?? "—", 25, "Status", rfi.status ?? "Open", 75)
  b.twoCol("Date Issued", rfi.date_issued ? new Date(rfi.date_issued).toLocaleDateString("en-US") : "—", 50,
           "Due Date",   rfi.due_date    ? new Date(rfi.due_date).toLocaleDateString("en-US")    : "—", 50)
  b.twoCol("Schedule Impact", rfi.schedule_impact ?? "TBD", 50, "Cost Impact", rfi.cost_impact ?? "TBD", 50)
  b.twoCol("Spec Section", rfi.specification_section ?? "—", 50, "Location", rfi.location ?? "—", 50)
  b.twoCol("Received From", rfi.received_from ?? rfi.submitted_by ?? "—", 50, "Assigned To", rfi.assigned_to ?? "—", 50)
  b.gap()

  b.textBlock("QUESTION", rfi.description ?? "")
  b.textBlock("RESPONSE", rfi.response ?? "")

  if (rfi.file_name) {
    b.sectionHeader("ATTACHED FILE")
    b.oneCol("File Name", rfi.file_name)
  }

  b.signatureLines("Prepared By / Date", "Reviewed By / Date")

  const pdfBytes = await b.save()
  const pdfPath = `rfis/${id}/rfi_${rfi.rfi_number?.replace(/\s+/g, "_") ?? id}.pdf`
  await supabase.storage.from("submittals").upload(pdfPath, Buffer.from(pdfBytes), { contentType: "application/pdf", upsert: true })
  await supabase.from("rfis").update({ generated_pdf_path: pdfPath }).eq("id", id)
  const { data: signed } = await supabase.storage.from("submittals").createSignedUrl(pdfPath, 604800)
  return NextResponse.json({ ok: true, url: signed?.signedUrl ?? null })
}
