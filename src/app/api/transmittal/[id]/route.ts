import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { PDFDocument } from "pdf-lib"
import { PDFBuilder } from "@/lib/pdf-builder"

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params

  const [subRes, settingsRes] = await Promise.all([
    supabase.from("submittals").select("*").eq("id", id).maybeSingle(),
    supabase.from("company_settings").select("logo_path").maybeSingle(),
  ])

  const sub = subRes.data
  if (!sub) return NextResponse.json({ error: "Not found" }, { status: 404 })

  // Reuse existing PDF if already generated
  if (sub.generated_pdf_path) {
    const { data: existing } = await supabase.storage
      .from("submittals")
      .createSignedUrl(sub.generated_pdf_path, 3600)
    if (existing?.signedUrl) return NextResponse.json({ url: existing.signedUrl })
  }

  let logoBytes: ArrayBuffer | null = null
  if (settingsRes.data?.logo_path) {
    const { data: logoBlob } = await supabase.storage.from("company-assets").download(settingsRes.data.logo_path)
    if (logoBlob) logoBytes = await logoBlob.arrayBuffer()
  }

  let project: { name: string; number: string | null; location: string | null; gc_name: string | null; architect: string | null } | null = null
  if (sub.project_id) {
    const { data } = await supabase.from("projects").select("name,number,location,gc_name,architect").eq("id", sub.project_id).maybeSingle()
    project = data
  }

  // Build cover sheet
  const b = await PDFBuilder.create("SUBMITTAL TRANSMITTAL", logoBytes)

  if (project) {
    b.sectionHeader("PROJECT INFORMATION")
    b.twoCol("Project Name", project.name, 65, "Project No.", project.number ?? "—", 35)
    if (project.location) b.oneCol("Project Location", project.location)
    if (project.gc_name || project.architect)
      b.twoCol("General Contractor", project.gc_name ?? "—", 50, "Architect", project.architect ?? "—", 50)
    b.gap()
  }

  if (sub.transmitted_by || sub.transmitted_by_company) {
    b.sectionHeader("TRANSMITTED BY")
    b.twoCol("Name", sub.transmitted_by ?? "—", 50, "Company", sub.transmitted_by_company ?? "—", 50)
    b.gap()
  }

  if (sub.send_to_type) {
    const typeLabel = sub.send_to_type === "cm" ? "Construction Manager"
      : sub.send_to_type === "subcontractor" ? "Subcontractor" : "Supplier"
    b.sectionHeader("TRANSMITTED TO")
    b.twoCol("Company", sub.send_to_company ?? "—", 60, "Type", typeLabel, 40)
    if (sub.send_to_contact || sub.send_to_email)
      b.twoCol("Contact", sub.send_to_contact ?? "—", 50, "Email", sub.send_to_email ?? "—", 50)
    if (sub.send_to_phone) b.oneCol("Phone", sub.send_to_phone)
    if (sub.send_to_address) b.oneCol("Address", sub.send_to_address)
    b.gap()
  }

  b.sectionHeader("SUBMITTAL INFORMATION")
  b.twoCol("Spec Section No.", sub.csi_section ?? "—", 30, "Spec Section Title", sub.section_name ?? "—", 70)
  b.oneCol("Submittal Description", sub.file_name.replace(/\.[^.]+$/, ""))
  const today = new Date().toLocaleDateString("en-US")
  b.twoCol("Date Submitted", today, 50, "Submittal No.", sub.submittal_number ?? "—", 50)
  b.gap()

  b.sectionHeader("REVIEW / CERTIFICATION")
  b.twoCol("Reviewed By", "—", 50, "Certified by CQM", "—", 50)
  b.gap()
  b.signatureLines("Reviewed By / Date", "Approved By / Date")

  const coverBytes = await b.save()

  // Merge cover with original PDF
  const mergedDoc = await PDFDocument.create()
  const coverDoc = await PDFDocument.load(coverBytes)
  const coverPages = await mergedDoc.copyPages(coverDoc, coverDoc.getPageIndices())
  coverPages.forEach(p => mergedDoc.addPage(p))

  if (sub.storage_path && sub.mime_type === "application/pdf") {
    try {
      const { data: blob } = await supabase.storage.from("submittals").download(sub.storage_path)
      if (blob) {
        const origDoc = await PDFDocument.load(await blob.arrayBuffer())
        const pages = await mergedDoc.copyPages(origDoc, origDoc.getPageIndices())
        pages.forEach(p => mergedDoc.addPage(p))
      }
    } catch { /* cover-only if merge fails */ }
  }

  const finalBytes = await mergedDoc.save()
  const storagePath = `transmittals/${id}/transmittal.pdf`

  await supabase.storage.from("submittals").upload(storagePath, finalBytes, {
    contentType: "application/pdf",
    upsert: true,
  })

  await supabase.from("submittals").update({ generated_pdf_path: storagePath }).eq("id", id)

  const { data: urlData } = await supabase.storage.from("submittals").createSignedUrl(storagePath, 3600)
  return NextResponse.json({ url: urlData?.signedUrl ?? null })
}
