import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { PDFBuilder } from "@/lib/pdf-builder"

export const maxDuration = 60

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

  const { data: settings } = await supabase.from("company_settings").select("logo_path, logo_scale_pct").maybeSingle()
  let logoBytes: ArrayBuffer | null = null
  if (settings?.logo_path) {
    const { data: blob } = await supabase.storage.from("company-assets").download(settings.logo_path)
    if (blob) logoBytes = await blob.arrayBuffer()
  }

  const fmtDate = (d: string | null): string | null => d ? new Date(d).toLocaleDateString("en-US") : null

  const pdf = await PDFBuilder.create({
    documentType: "Request for Information",
    documentNumber: rfi.rfi_number,
    logoBytes,
    logoScalePct: settings?.logo_scale_pct ?? undefined,
  })

  if (project.name || project.number) {
    pdf.projectBlock({
      name: project.name, number: project.number, location: project.location,
      gc_name: project.gc_name, architect: project.architect,
    })
  }

  pdf.sectionDivider("RFI Details")
  pdf.fieldGrid([
    [{ label: "RFI Number", value: rfi.rfi_number }, { label: "Status", status: rfi.status ?? "Open" }],
    [{ label: "Date Issued", value: fmtDate(rfi.date_issued) }, { label: "Due Date", value: fmtDate(rfi.due_date) }],
    [{ label: "Schedule Impact", value: rfi.schedule_impact ?? "TBD" }, { label: "Cost Impact", value: rfi.cost_impact ?? "TBD" }],
    [{ label: "Spec Section", value: rfi.specification_section }, { label: "Location", value: rfi.location }],
    [{ label: "Received From", value: rfi.received_from ?? rfi.submitted_by }, { label: "Assigned To", value: rfi.assigned_to }],
  ])

  pdf.textBlock("Question", rfi.description)
  pdf.textBlock("Response", rfi.response)

  if (rfi.file_name) {
    pdf.sectionDivider("Attached File")
    pdf.fieldGrid([[{ label: "File Name", value: rfi.file_name }]])
  }

  pdf.signatureBlock("Prepared By / Date", "Reviewed By / Date")

  const pdfBytes = await pdf.save()
  // Tenant-isolated path (new storage RLS uses (storage.foldername)[1]).
  const { data: companyId } = await supabase.rpc("get_my_company_id")
  if (!companyId) return NextResponse.json({ error: "No company association" }, { status: 500 })
  // Unique path per generation — avoids Supabase's CDN serving a stale cached copy.
  const pdfPath = `${companyId}/rfis/${id}/rfi_${rfi.rfi_number?.replace(/\s+/g, "_") ?? id}_${Date.now()}.pdf`
  await supabase.storage.from("submittals").upload(pdfPath, Buffer.from(pdfBytes), { contentType: "application/pdf", upsert: true })
  await supabase.from("rfis").update({ generated_pdf_path: pdfPath }).eq("id", id)
  const { data: signed } = await supabase.storage.from("submittals").createSignedUrl(pdfPath, 604800)
  return NextResponse.json({ ok: true, url: signed?.signedUrl ?? null })
}
