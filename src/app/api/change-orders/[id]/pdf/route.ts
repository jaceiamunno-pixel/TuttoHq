import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { PDFBuilder } from "@/lib/pdf-builder"

function formatCurrency(n: number | null): string {
  if (n == null) return "—"
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n)
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params

  const { data: co, error: coErr } = await supabase.from("change_orders").select("*").eq("id", id).single()
  if (coErr || !co) return NextResponse.json({ error: "Change order not found" }, { status: 404 })

  let project: Record<string, string | null> = {}
  if (co.project_id) {
    const { data: p } = await supabase.from("projects")
      .select("name, number, gc_name, architect, location").eq("id", co.project_id).maybeSingle()
    if (p) project = p
  }

  const { data: settings } = await supabase.from("company_settings").select("logo_path").maybeSingle()
  let logoBytes: ArrayBuffer | null = null
  if (settings?.logo_path) {
    const { data: blob } = await supabase.storage.from("company-assets").download(settings.logo_path)
    if (blob) logoBytes = await blob.arrayBuffer()
  }

  const b = await PDFBuilder.create("CHANGE ORDER", logoBytes)

  if (project.name || project.number) {
    b.sectionHeader("PROJECT INFORMATION")
    b.twoCol("Project Name", project.name ?? "—", 65, "Project No.", project.number ?? "—", 35)
    if (project.gc_name || project.architect)
      b.twoCol("General Contractor", project.gc_name ?? "—", 50, "Architect", project.architect ?? "—", 50)
    if (project.location) b.oneCol("Project Location", project.location)
    b.gap()
  }

  b.sectionHeader("CHANGE ORDER DETAILS")
  b.twoColStatus("CO Number", co.co_number ?? "—", 25, "Status", co.status ?? "Draft", 75)
  b.twoCol("Date", co.date ? new Date(co.date).toLocaleDateString("en-US") : "—", 50, "Assigned To", co.assigned_to ?? "—", 50)
  b.twoCol("Schedule Impact", co.schedule_impact ?? "TBD", 50,
           "Days Impact", co.schedule_impact_days != null ? String(co.schedule_impact_days) : "—", 50)
  if (co.submitted_by) b.oneCol("Submitted By", co.submitted_by)
  b.gap()

  b.textBlock("PROPOSAL", co.proposal ?? "")
  b.textBlock("QUALIFICATIONS / EXCLUSIONS", co.qualifications ?? "")

  b.sectionHeader("PRICING")
  b.pricingBlock(formatCurrency(co.pricing_sum), co.status === "Approved")

  if (co.file_name) {
    b.sectionHeader("ATTACHED FILE")
    b.oneCol("File Name", co.file_name)
  }

  b.signatureLines("Submitted By / Date", "Owner / Architect Approval / Date")

  const pdfBytes = await b.save()
  const pdfPath = `change-orders/${id}/co_${co.co_number?.replace(/\s+/g, "_") ?? id}.pdf`
  await supabase.storage.from("submittals").upload(pdfPath, Buffer.from(pdfBytes), { contentType: "application/pdf", upsert: true })
  await supabase.from("change_orders").update({ generated_pdf_path: pdfPath }).eq("id", id)
  const { data: signed } = await supabase.storage.from("submittals").createSignedUrl(pdfPath, 604800)
  return NextResponse.json({ ok: true, url: signed?.signedUrl ?? null })
}
