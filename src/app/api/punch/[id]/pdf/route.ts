import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { PDFBuilder, type FieldCell } from "@/lib/pdf-builder"

export const maxDuration = 60

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

  const { data: settings } = await supabase.from("company_settings").select("logo_path, logo_scale_pct").maybeSingle()
  let logoBytes: ArrayBuffer | null = null
  if (settings?.logo_path) {
    const { data: blob } = await supabase.storage.from("company-assets").download(settings.logo_path)
    if (blob) logoBytes = await blob.arrayBuffer()
  }

  const pdf = await PDFBuilder.create({
    documentType: "Punch List Item",
    documentNumber: item.item_number,
    logoBytes,
    logoScalePct: settings?.logo_scale_pct ?? undefined,
  })

  if (project.name || project.number) {
    pdf.projectBlock({
      name: project.name, number: project.number, location: project.location,
      gc_name: project.gc_name, architect: project.architect,
    })
  }

  pdf.sectionDivider("Item Details")
  const details: FieldCell[][] = [
    [{ label: "Item Number", value: item.item_number }, { label: "Status", status: item.status ?? "Open" }],
    [{ label: "Priority", status: item.priority ?? "Medium" }, { label: "Assigned To", value: item.assigned_to }],
    [{ label: "Due Date", value: item.due_date ? new Date(item.due_date).toLocaleDateString("en-US") : null },
     { label: "Created", value: new Date(item.created_at).toLocaleDateString("en-US") }],
  ]
  if (item.location) details.push([{ label: "Location", value: item.location }])
  pdf.fieldGrid(details)

  pdf.textBlock("Description", item.description)
  if (item.notes) pdf.textBlock("Notes", item.notes)

  pdf.signatureBlock("Inspected By / Date", "Corrective Action By / Date")

  const pdfBytes = await pdf.save()
  // Tenant-isolated path (new storage RLS uses (storage.foldername)[1]).
  const { data: companyId } = await supabase.rpc("get_my_company_id")
  if (!companyId) return NextResponse.json({ error: "No company association" }, { status: 500 })
  // Unique path per generation — avoids Supabase's CDN serving a stale cached copy.
  const pdfPath = `${companyId}/punch/${id}/punch_${item.item_number?.replace(/\s+/g, "_") ?? id}_${Date.now()}.pdf`
  await supabase.storage.from("submittals").upload(pdfPath, Buffer.from(pdfBytes), { contentType: "application/pdf", upsert: true })
  await supabase.from("punch_items").update({ generated_pdf_path: pdfPath }).eq("id", id)
  const { data: signed } = await supabase.storage.from("submittals").createSignedUrl(pdfPath, 604800)
  return NextResponse.json({ ok: true, url: signed?.signedUrl ?? null })
}
