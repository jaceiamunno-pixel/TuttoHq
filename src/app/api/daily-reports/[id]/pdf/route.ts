import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { PDFBuilder } from "@/lib/pdf-builder"

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

  const b = await PDFBuilder.create("DAILY FIELD REPORT", logoBytes)

  if (project.name || project.number) {
    b.sectionHeader("PROJECT INFORMATION")
    b.twoCol("Project Name", project.name ?? "—", 65, "Project No.", project.number ?? "—", 35)
    if (project.gc_name || project.architect)
      b.twoCol("General Contractor", project.gc_name ?? "—", 50, "Architect", project.architect ?? "—", 50)
    if (project.location) b.oneCol("Location", project.location)
    b.gap()
  }

  b.sectionHeader("REPORT SUMMARY")
  b.twoCol("Report Date", new Date(report.report_date).toLocaleDateString("en-US"), 50, "Prepared By", report.prepared_by ?? "—", 50)
  b.twoCol("Weather Conditions", report.weather_conditions ?? "—", 50, "Temperature", report.temperature ?? "—", 50)
  b.twoCol("Manpower on Site", report.manpower_count != null ? `${report.manpower_count} workers` : "—", 50, " ", " ", 50)
  b.gap()

  b.textBlock("WORK PERFORMED", report.work_performed ?? "")
  b.textBlock("EQUIPMENT ON SITE", report.equipment ?? "")
  b.textBlock("MATERIALS DELIVERED", report.materials_delivered ?? "")
  b.textBlock("VISITORS / INSPECTIONS", report.visitors ?? "")
  b.textBlock("ISSUES / DELAYS", report.issues_delays ?? "")
  b.textBlock("SAFETY NOTES", report.safety_notes ?? "")

  b.signatureLines("Prepared By / Date", "Superintendent / Date")

  const pdfBytes = await b.save()
  const pdfPath = `daily-reports/${id}/daily_${report.report_date.replace(/-/g, "")}.pdf`
  await supabase.storage.from("submittals").upload(pdfPath, Buffer.from(pdfBytes), { contentType: "application/pdf", upsert: true })
  await supabase.from("daily_reports").update({ generated_pdf_path: pdfPath }).eq("id", id)
  const { data: signed } = await supabase.storage.from("submittals").createSignedUrl(pdfPath, 604800)
  return NextResponse.json({ ok: true, url: signed?.signedUrl ?? null })
}
