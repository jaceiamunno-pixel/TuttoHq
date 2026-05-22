import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { PDFBuilder } from "@/lib/pdf-builder"
import { loadEntityPhotos } from "@/lib/pdf-photos"

// Downloading + resizing a report's photos can take a while for image-heavy
// reports — raise the serverless ceiling so long renders don't get cut off.
export const maxDuration = 300

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params

  const { data: report, error } = await supabase.from("daily_reports").select("*").eq("id", id).single()
  if (error || !report) return NextResponse.json({ error: "Report not found" }, { status: 404 })

  let project: Record<string, string | null> = {}
  if (report.project_id) {
    const { data: p } = await supabase.from("projects")
      .select("name, number, gc_name, architect, location").eq("id", report.project_id).maybeSingle()
    if (p) project = p
  }

  const { data: settings } = await supabase.from("company_settings").select("logo_path").maybeSingle()
  let logoBytes: ArrayBuffer | null = null
  if (settings?.logo_path) {
    const { data: blob } = await supabase.storage.from("company-assets").download(settings.logo_path)
    if (blob) logoBytes = await blob.arrayBuffer()
  }

  const reportDate = new Date(report.report_date).toLocaleDateString("en-US")

  // ── Cover ─────────────────────────────────────────────────────────────────
  const pdf = await PDFBuilder.create({
    documentType: "Daily Field Report",
    documentNumber: reportDate,
    logoBytes,
  })

  if (project.name || project.number) {
    pdf.projectBlock({
      name: project.name,
      number: project.number,
      location: project.location,
      gc_name: project.gc_name,
      architect: project.architect,
    })
  }

  pdf.sectionDivider("Report Summary")
  pdf.fieldGrid([
    [{ label: "Report Date", value: reportDate },
     { label: "Prepared By", value: report.prepared_by }],
    [{ label: "Weather Conditions", value: report.weather_conditions },
     { label: "Temperature", value: report.temperature }],
    [{ label: "Manpower on Site",
      value: report.manpower_count != null ? `${report.manpower_count} workers` : null }],
  ])

  pdf.textBlock("Work Performed", report.work_performed)
  pdf.textBlock("Equipment on Site", report.equipment)
  pdf.textBlock("Materials Delivered", report.materials_delivered)
  pdf.textBlock("Visitors / Inspections", report.visitors)
  pdf.textBlock("Issues / Delays", report.issues_delays)
  pdf.textBlock("Safety Notes", report.safety_notes)

  pdf.signatureBlock("Prepared By / Date", "Superintendent / Date")

  // ── Site photos ───────────────────────────────────────────────────────────
  // The cover stays on page 1; photos follow on their own pages, 4 per page.
  const photos = await loadEntityPhotos(supabase, "daily_report", id)
  if (photos.length > 0) {
    pdf.pageBreak()
    pdf.sectionDivider(`Site Photos (${photos.length})`)
    await pdf.photoGrid(photos)
  }

  const pdfBytes = await pdf.save()

  // Unique path per generation: a fixed path + upsert lets Supabase's CDN keep
  // serving a stale cached copy after the storage object is overwritten.
  const pdfPath = `daily-reports/${id}/daily_${report.report_date.replace(/-/g, "")}_${Date.now()}.pdf`
  await supabase.storage.from("submittals").upload(pdfPath, Buffer.from(pdfBytes), { contentType: "application/pdf", upsert: true })
  await supabase.from("daily_reports").update({ generated_pdf_path: pdfPath }).eq("id", id)
  const { data: signed } = await supabase.storage.from("submittals").createSignedUrl(pdfPath, 604800)
  return NextResponse.json({ ok: true, url: signed?.signedUrl ?? null })
}
