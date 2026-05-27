import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { PDFDocument } from "pdf-lib"
import { PDFBuilder, type FieldCell } from "@/lib/pdf-builder"

export const maxDuration = 60

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

  // ── Cover ─────────────────────────────────────────────────────────────────
  const pdf = await PDFBuilder.create({
    documentType: "Submittal Transmittal",
    documentNumber: sub.submittal_number,
    logoBytes,
  })

  if (project) {
    pdf.projectBlock({
      name: project.name,
      number: project.number,
      location: project.location,
      gc_name: project.gc_name,
      architect: project.architect,
    })
  }

  if (sub.transmitted_by || sub.transmitted_by_company) {
    pdf.sectionDivider("Transmitted By")
    pdf.fieldGrid([[
      { label: "Name", value: sub.transmitted_by },
      { label: "Company", value: sub.transmitted_by_company },
    ]])
  }

  if (sub.send_to_type) {
    const typeLabel = sub.send_to_type === "cm" ? "Construction Manager"
      : sub.send_to_type === "subcontractor" ? "Subcontractor" : "Supplier"
    pdf.sectionDivider("Transmitted To")
    const rows: FieldCell[][] = [[
      { label: "Company", value: sub.send_to_company },
      { label: "Type", value: typeLabel },
    ]]
    if (sub.send_to_contact || sub.send_to_email) {
      rows.push([
        { label: "Contact", value: sub.send_to_contact },
        { label: "Email", value: sub.send_to_email },
      ])
    }
    if (sub.send_to_phone) rows.push([{ label: "Phone", value: sub.send_to_phone }])
    if (sub.send_to_address) rows.push([{ label: "Address", value: sub.send_to_address }])
    pdf.fieldGrid(rows)
  }

  pdf.sectionDivider("Submittal Information")
  pdf.fieldGrid([
    [{ label: "Spec Section No.", value: sub.csi_section },
     { label: "Spec Section Title", value: sub.section_name }],
    [{ label: "Submittal Description", value: sub.file_name.replace(/\.[^.]+$/, "") }],
    [{ label: "Date Submitted", value: new Date().toLocaleDateString("en-US") },
     { label: "Submittal No.", value: sub.submittal_number }],
  ])

  pdf.sectionDivider("Review / Certification")
  pdf.fieldGrid([[
    { label: "Reviewed By", value: "" },
    { label: "Certified by CQM", value: "" },
  ]])

  pdf.signatureBlock("Reviewed By / Date", "Approved By / Date")

  const coverBytes = await pdf.save()

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
