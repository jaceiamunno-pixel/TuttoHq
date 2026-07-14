import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { PDFBuilder, type FieldCell } from "@/lib/pdf-builder"

export const maxDuration = 60

function formatCurrency(n: number | null): string {
  if (n == null) return "—"
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n)
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params

  const { data: co, error: coErr } = await supabase.from("change_orders").select("*").eq("id", id).is("deleted_at", null).maybeSingle()
  if (coErr || !co) return NextResponse.json({ error: "Change order not found" }, { status: 404 })

  let project: Record<string, string | null> = {}
  if (co.project_id) {
    const { data: p } = await supabase.from("projects")
      .select("name, number, gc_name, architect, location").eq("id", co.project_id).maybeSingle()
    if (p) project = p
  }

  const { data: settings } = await supabase.from("company_settings").select("logo_path, logo_scale_pct").maybeSingle()
  let logoBytes: ArrayBuffer | null = null
  if (settings?.logo_path) {
    const { data: blob } = await supabase.storage.from("company-assets").download(settings.logo_path)
    if (blob) logoBytes = await blob.arrayBuffer()
  }

  const pdf = await PDFBuilder.create({
    documentType: "Change Order",
    documentNumber: co.co_number,
    logoBytes,
    logoScalePct: settings?.logo_scale_pct ?? undefined,
  })

  if (project.name || project.number) {
    pdf.projectBlock({
      name: project.name, number: project.number, location: project.location,
      gc_name: project.gc_name, architect: project.architect,
    })
  }

  pdf.sectionDivider("Change Order Details")
  const details: FieldCell[][] = [
    [{ label: "CO Number", value: co.co_number }, { label: "Status", status: co.status ?? "Draft" }],
    [{ label: "Date", value: co.date ? new Date(co.date).toLocaleDateString("en-US") : null },
     { label: "Assigned To", value: co.assigned_to }],
    [{ label: "Schedule Impact", value: co.schedule_impact ?? "TBD" },
     { label: "Days Impact", value: co.schedule_impact_days != null ? String(co.schedule_impact_days) : null }],
  ]
  if (co.submitted_by) details.push([{ label: "Submitted By", value: co.submitted_by }])
  pdf.fieldGrid(details)

  pdf.textBlock("Proposal", co.proposal)
  pdf.textBlock("Qualifications / Exclusions", co.qualifications)

  pdf.sectionDivider("Pricing")
  pdf.pricingBlock(formatCurrency(co.pricing_sum), co.status === "Approved")

  if (co.file_name) {
    pdf.sectionDivider("Attached File")
    pdf.fieldGrid([[{ label: "File Name", value: co.file_name }]])
  }

  pdf.signatureBlock("Submitted By / Date", "Owner / Architect Approval / Date")

  const pdfBytes = await pdf.save()
  // Tenant-isolated path (new storage RLS uses (storage.foldername)[1]).
  const { data: companyId } = await supabase.rpc("get_my_company_id")
  if (!companyId) return NextResponse.json({ error: "No company association" }, { status: 500 })
  // Unique path per generation — avoids Supabase's CDN serving a stale cached copy.
  const pdfPath = `${companyId}/change-orders/${id}/co_${co.co_number?.replace(/\s+/g, "_") ?? id}_${Date.now()}.pdf`
  await supabase.storage.from("submittals").upload(pdfPath, Buffer.from(pdfBytes), { contentType: "application/pdf", upsert: true })
  await supabase.from("change_orders").update({ generated_pdf_path: pdfPath }).eq("id", id)
  const { data: signed } = await supabase.storage.from("submittals").createSignedUrl(pdfPath, 604800)
  return NextResponse.json({ ok: true, url: signed?.signedUrl ?? null })
}
