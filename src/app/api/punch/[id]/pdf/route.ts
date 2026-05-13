import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { PDFBuilder, C } from "@/lib/pdf-builder"

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

  const { data: settings } = await supabase.from("company_settings").select("logo_path").eq("id", 1).maybeSingle()
  let logoBytes: ArrayBuffer | null = null
  if (settings?.logo_path) {
    const { data: blob } = await supabase.storage.from("company-assets").download(settings.logo_path)
    if (blob) logoBytes = await blob.arrayBuffer()
  }

  const b = await PDFBuilder.create("PUNCH LIST ITEM", logoBytes)

  if (project.name || project.number) {
    b.sectionHeader("PROJECT INFORMATION")
    b.twoCol("Project Name", project.name ?? "—", 65, "Project No.", project.number ?? "—", 35)
    if (project.gc_name || project.architect)
      b.twoCol("General Contractor", project.gc_name ?? "—", 50, "Architect", project.architect ?? "—", 50)
    if (project.location) b.oneCol("Location", project.location)
    b.gap()
  }

  b.sectionHeader("ITEM DETAILS")
  b.twoCol("Item Number", item.item_number ?? "—", 30, "Status", item.status ?? "Open", 70)
  b.twoCol("Priority", item.priority ?? "Medium", 30, "Assigned To", item.assigned_to ?? "—", 70)
  b.twoCol("Due Date", item.due_date ? new Date(item.due_date).toLocaleDateString("en-US") : "—", 50,
           "Created",  new Date(item.created_at).toLocaleDateString("en-US"), 50)
  if (item.location) b.oneCol("Location", item.location)
  b.gap()

  b.textBlock("DESCRIPTION", item.description ?? "")
  if (item.notes) b.textBlock("NOTES", item.notes)

  // Priority badge
  const priColors: Record<string, [number,number,number]> = {
    High: [0.76, 0.13, 0.13], Medium: [0.68, 0.42, 0.04], Low: [0.08, 0.50, 0.22],
  }
  const [r, g, bv] = priColors[item.priority] ?? [0.42, 0.46, 0.56]
  const { rgb } = await import("pdf-lib")
  const priColor = rgb(r, g, bv)
  const badgeW = 100
  b.page.drawRectangle({ x: b.M, y: b.y - 22, width: badgeW, height: 18, color: priColor })
  b.page.drawText(`${(item.priority ?? "MEDIUM").toUpperCase()} PRIORITY`, { x: b.M + 8, y: b.y - 16, size: 8, font: b.bold, color: C.white })
  b.y -= 32

  b.signatureLines("Inspected By / Date", "Corrective Action By / Date")

  const pdfBytes = await b.save()
  const pdfPath = `punch/${id}/punch_${item.item_number?.replace(/\s+/g, "_") ?? id}.pdf`
  await supabase.storage.from("submittals").upload(pdfPath, Buffer.from(pdfBytes), { contentType: "application/pdf", upsert: true })
  await supabase.from("punch_items").update({ generated_pdf_path: pdfPath }).eq("id", id)
  const { data: signed } = await supabase.storage.from("submittals").createSignedUrl(pdfPath, 604800)
  return NextResponse.json({ ok: true, url: signed?.signedUrl ?? null })
}
