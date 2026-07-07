import { PDFDocument } from "pdf-lib"
import { type SupabaseClient } from "@supabase/supabase-js"
import { PDFBuilder } from "./pdf-builder"

// ─── RFQ (Bid Request) package PDF — ADR-016 v1a ────────────────────────────
// Composes the outbound bid package a GC sends a sub/supplier: a cover (project +
// scope + due date + GC contact) + an index of what's included, then the actual
// spec-section pages and drawing sheets appended. Front matter is built with the
// shared PDFBuilder; source pages are merged with pdf-lib copyPages (same pattern
// as the submittal-package + transmittal routes).
//
// LINKAGE LAW: spec scope is resolved by (project_id, spec_number) TEXT — never
// by spec_section_id — so a spec-book re-parse never breaks a package.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = SupabaseClient<any, any, any>

const RFQ_BUCKET = "submittals"

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—"
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" })
}

/** Storage path for an RFQ's generated package PDF. Tenant-prefixed so the
 *  submittals-bucket RLS scopes it via (storage.foldername(name))[1] = company. */
export function rfqPackagePath(companyId: string, rfqId: string, stamp: number): string {
  return `${companyId}/rfq/${rfqId}/package_${stamp}.pdf`
}

export interface RfqPackageSelection {
  specNumbers: string[]
  sheetIds: string[]
}

/**
 * Gather every input for an RFQ package, build its PDF, upload it to storage,
 * and return the storage path. The caller persists `rfqs.package_pdf_path` and
 * mints the signed URL. All DB reads are RLS-scoped through the passed client.
 */
export async function composeRfqPackagePdf(
  supabase: AnySupabase,
  rfqId: string,
  selection: RfqPackageSelection,
  stamp: number,
): Promise<{ storagePath: string }> {
  const { data: rfq, error: rfqErr } = await supabase
    .from("rfqs")
    .select("id, project_id, company_id, name, scope_description, csi_division, due_date")
    .eq("id", rfqId)
    .maybeSingle()
  if (rfqErr || !rfq) throw new Error("RFQ not found")
  if (!rfq.company_id) throw new Error("RFQ has no company_id")

  // Project + company branding/contact.
  const [projectRes, settingsRes] = await Promise.all([
    supabase.from("projects").select("name, number, location, gc_name, architect").eq("id", rfq.project_id).maybeSingle(),
    supabase.from("company_settings").select("display_name, address_line1, address_line2, phone, logo_path, logo_scale_pct").maybeSingle(),
  ])
  const project = (projectRes.data ?? {}) as {
    name?: string | null; number?: string | null; location?: string | null
    gc_name?: string | null; architect?: string | null
  }
  const settings = (settingsRes.data ?? {}) as {
    display_name?: string | null; address_line1?: string | null; address_line2?: string | null
    phone?: string | null; logo_path?: string | null; logo_scale_pct?: number | null
  }

  let logoBytes: ArrayBuffer | null = null
  if (settings.logo_path) {
    const { data: logoBlob } = await supabase.storage.from("company-assets").download(settings.logo_path)
    if (logoBlob) logoBytes = await logoBlob.arrayBuffer()
  }

  // ── Resolve spec sections by spec_number (LINKAGE LAW), de-duplicated. ──────
  const specNumbers = [...new Set(selection.specNumbers.map(s => s.trim()).filter(Boolean))]
  const specExcerpts: { spec_number: string; spec_title: string; pdfBytes: ArrayBuffer; startPage: number; endPage: number }[] = []
  if (specNumbers.length) {
    const { data: sections } = await supabase
      .from("spec_sections")
      .select("spec_number, spec_title, start_page, end_page, project_document_id")
      .eq("project_id", rfq.project_id)
      .in("spec_number", specNumbers)

    const docCache = new Map<string, ArrayBuffer | null>()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sorted = [...(sections ?? [])].sort((a: any, b: any) => String(a.spec_number).localeCompare(String(b.spec_number)))
    for (const sec of sorted) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const s = sec as any
      if (s.start_page == null || s.end_page == null || !s.project_document_id) continue
      if (!docCache.has(s.project_document_id)) {
        const { data: doc } = await supabase.from("project_documents").select("file_path").eq("id", s.project_document_id).maybeSingle()
        let bytes: ArrayBuffer | null = null
        if (doc?.file_path) {
          const { data: blob } = await supabase.storage.from(RFQ_BUCKET).download(doc.file_path)
          if (blob) bytes = await blob.arrayBuffer()
        }
        docCache.set(s.project_document_id, bytes)
      }
      const pdfBytes = docCache.get(s.project_document_id)
      if (!pdfBytes) continue
      specExcerpts.push({
        spec_number: String(s.spec_number),
        spec_title: String(s.spec_title ?? ""),
        pdfBytes,
        startPage: s.start_page,
        endPage: s.end_page,
      })
    }
  }

  // ── Resolve drawing sheets → their current revision PDF. ────────────────────
  const sheetIds = [...new Set(selection.sheetIds.filter(Boolean))]
  const drawings: { sheet_number: string; title: string; storage_path: string }[] = []
  if (sheetIds.length) {
    const { data: sheets } = await supabase
      .from("drawing_sheets")
      .select("id, sheet_number, title, current_revision_id")
      .eq("project_id", rfq.project_id)
      .in("id", sheetIds)
      .is("deleted_at", null)
    const revIds = [...new Set((sheets ?? []).map(s => s.current_revision_id).filter(Boolean))]
    const revMap = new Map<string, string>()
    if (revIds.length) {
      const { data: revs } = await supabase.from("drawing_revisions").select("id, storage_path").in("id", revIds)
      for (const r of revs ?? []) if (r.storage_path) revMap.set(r.id, r.storage_path)
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sortedSheets = [...(sheets ?? [])].sort((a: any, b: any) => String(a.sheet_number ?? "").localeCompare(String(b.sheet_number ?? "")))
    for (const sh of sortedSheets) {
      const path = sh.current_revision_id ? revMap.get(sh.current_revision_id) : null
      if (!path) continue
      drawings.push({ sheet_number: String(sh.sheet_number ?? "—"), title: String(sh.title ?? ""), storage_path: path })
    }
  }

  // ── Cover / front matter ────────────────────────────────────────────────────
  const pdf = await PDFBuilder.create({
    documentType: "Bid Request",
    documentNumber: rfq.name,
    logoBytes,
    logoScalePct: settings.logo_scale_pct ?? undefined,
    brandName: settings.display_name ?? project.gc_name ?? null,
  })

  if (project.name || project.number) {
    pdf.projectBlock({
      name: project.name, number: project.number, location: project.location,
      gc_name: project.gc_name, architect: project.architect,
    })
  }

  pdf.sectionDivider("Bid Request")
  pdf.fieldGrid([
    [{ label: "Scope", value: rfq.name }],
    [
      { label: "CSI Division", value: rfq.csi_division || "—" },
      { label: "Quote Due", value: rfq.due_date ? fmtDate(rfq.due_date) : "—" },
    ],
  ])
  if (rfq.scope_description) pdf.textBlock("Scope Description", rfq.scope_description)

  // GC contact (from company_settings) — who the sub replies to.
  const addr = [settings.address_line1, settings.address_line2].filter(Boolean).join(", ")
  pdf.sectionDivider("General Contractor")
  pdf.fieldGrid([
    [{ label: "Company", value: settings.display_name || project.gc_name || "—" }],
    [
      { label: "Phone", value: settings.phone || "—" },
      { label: "Address", value: addr || "—" },
    ],
  ])

  // Index of everything appended.
  if (specExcerpts.length) {
    pdf.sectionDivider("Specification Sections")
    pdf.table(
      ["Spec #", "Section Title", "Pages"],
      specExcerpts.map(e => [e.spec_number, e.spec_title || "—", String(Math.max(0, e.endPage - e.startPage + 1))]),
      [80, 366, 80], // = 526
    )
  }
  if (drawings.length) {
    pdf.sectionDivider("Drawing Sheets")
    pdf.table(
      ["Sheet", "Title"],
      drawings.map(d => [d.sheet_number, d.title || "—"]),
      [120, 406], // = 526
    )
  }

  const frontBytes = await pdf.save()

  // ── Merge: front matter + spec pages + drawing pages ────────────────────────
  const merged = await PDFDocument.create()
  const frontDoc = await PDFDocument.load(frontBytes)
  const frontPages = await merged.copyPages(frontDoc, frontDoc.getPageIndices())
  frontPages.forEach(p => merged.addPage(p))

  for (const ex of specExcerpts) {
    try {
      const src = await PDFDocument.load(ex.pdfBytes, { ignoreEncryption: true })
      const total = src.getPageCount()
      const start = Math.max(1, Math.floor(ex.startPage))
      const end = Math.min(total, Math.floor(ex.endPage))
      if (end < start) continue
      const indices: number[] = []
      for (let i = start - 1; i <= end - 1; i++) indices.push(i)
      const pages = await merged.copyPages(src, indices)
      pages.forEach(p => merged.addPage(p))
    } catch {
      // Skip an unreadable excerpt rather than failing the whole package.
    }
  }

  for (const dwg of drawings) {
    try {
      const { data: blob } = await supabase.storage.from(RFQ_BUCKET).download(dwg.storage_path)
      if (!blob) continue
      const src = await PDFDocument.load(await blob.arrayBuffer(), { ignoreEncryption: true })
      const pages = await merged.copyPages(src, src.getPageIndices()) // preserves /Rotate + CropBox
      pages.forEach(p => merged.addPage(p))
    } catch {
      // Skip an unreadable sheet rather than failing the whole package.
    }
  }

  const bytes = await merged.save()

  // Upload with the RLS-scoped client — the path's first segment is the caller's
  // company_id, which satisfies the submittals-bucket tenant insert policy.
  const storagePath = rfqPackagePath(rfq.company_id, rfqId, stamp)
  const { error: uploadErr } = await supabase.storage
    .from(RFQ_BUCKET)
    .upload(storagePath, Buffer.from(bytes), { contentType: "application/pdf", upsert: true })
  if (uploadErr) throw new Error(`Failed to store package PDF: ${uploadErr.message}`)

  return { storagePath }
}
