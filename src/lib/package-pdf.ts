import { PDFDocument } from "pdf-lib"
import { createClient as createServiceClient, type SupabaseClient } from "@supabase/supabase-js"
import { PDFBuilder } from "./pdf-builder"

// ─── Submittal-package PDF (Session I) ──────────────────────────────────────
// Composes the outbound package a PM sends a sub: a cover + summary, the list
// of submittal items the sub must produce, an index of the spec sections in
// scope, and the actual spec-book pages for each of those sections appended at
// the end. Front matter is built with the shared PDFBuilder; spec pages are
// merged in with pdf-lib copyPages (same pattern as the transmittal route).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = SupabaseClient<any, any, any>

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—"
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" })
}

function stripExt(name: string): string {
  return name.replace(/\.[^./\\]+$/, "")
}

// ─── Pure PDF composition ───────────────────────────────────────────────────

export interface PackagePdfItem {
  submittal_seq: number | null
  spec_number: string | null
  description: string
  submittal_type: string | null
  due_date: string | null
}

export interface PackagePdfSpecExcerpt {
  spec_number: string
  spec_title: string
  /** Spec-book PDF bytes that contain this section. */
  pdfBytes: ArrayBuffer
  /** 1-based page numbers, inclusive. */
  startPage: number
  endPage: number
}

export interface PackagePdfInput {
  /** Tracking ref, already bracketed — e.g. "[TTQ-ABCD-7]". */
  trackingRef: string
  vendorName: string
  vendorEmail: string
  project: { name?: string | null; number?: string | null; location?: string | null; gc_name?: string | null; architect?: string | null }
  gcName: string
  logoBytes: ArrayBuffer | null
  /** ISO date string, or null when no package-wide due date is set. */
  dueDate: string | null
  generationDate: Date
  items: PackagePdfItem[]
  specExcerpts: PackagePdfSpecExcerpt[]
}

const INSTRUCTIONS =
  "Please review the submittal list below and prepare each required item per the project " +
  "schedule. The relevant specification section excerpts are appended to this package for " +
  "your reference. When you respond, reply to the dispatch email with your submittal documents " +
  "attached and keep the tracking reference in the subject line — our system uses it to match " +
  "your submission back to this package automatically."

/** Build the package PDF from already-resolved inputs. */
export async function buildPackagePdf(input: PackagePdfInput): Promise<Uint8Array> {
  const pdf = await PDFBuilder.create({
    documentType: `Submittal Package — ${input.vendorName}`,
    documentNumber: input.trackingRef,
    generationDate: input.generationDate,
    logoBytes: input.logoBytes,
    brandName: input.gcName,
  })

  // ── Cover: project + package summary ──────────────────────────────────────
  pdf.projectBlock({
    name: input.project.name,
    number: input.project.number,
    location: input.project.location,
    gc_name: input.project.gc_name,
    architect: input.project.architect,
  })

  pdf.sectionDivider("Package Summary")
  pdf.fieldGrid([
    [{ label: "Vendor", value: input.vendorName }, { label: "Sent To", value: input.vendorEmail }],
    [
      { label: "Items Expected", value: String(input.items.length) },
      { label: "Due Date", value: input.dueDate ? fmtDate(input.dueDate) : "Per project schedule" },
    ],
    [
      { label: "Tracking Ref", value: input.trackingRef },
      { label: "Package Date", value: fmtDate(input.generationDate.toISOString()) },
    ],
  ])

  pdf.textBlock("Instructions", INSTRUCTIONS)

  // ── Submittal list ────────────────────────────────────────────────────────
  pdf.sectionDivider("Submittal List")
  if (input.items.length === 0) {
    pdf.textBlock("", "No submittal items are attached to this package.")
  } else {
    const listW = [46, 70, 235, 95, 80] // = 526 (PDF.contentW)
    pdf.table(
      ["Subm. #", "Spec #", "Description", "Type", "Due Date"],
      input.items.map(it => [
        it.submittal_seq != null ? String(it.submittal_seq) : "—",
        it.spec_number || "—",
        it.description || "—",
        it.submittal_type || "—",
        it.due_date ? fmtDate(it.due_date) : (input.dueDate ? fmtDate(input.dueDate) : "—"),
      ]),
      listW,
    )
  }

  // ── Spec-excerpt index ────────────────────────────────────────────────────
  if (input.specExcerpts.length > 0) {
    pdf.sectionDivider("Spec Section Excerpts")
    const idxW = [80, 366, 80] // = 526
    pdf.table(
      ["Spec #", "Section Title", "Pages"],
      input.specExcerpts.map(e => [
        e.spec_number,
        e.spec_title,
        String(Math.max(0, e.endPage - e.startPage + 1)),
      ]),
      idxW,
    )
  }

  const frontBytes = await pdf.save()

  // ── Merge: front matter + spec-book pages for each section ────────────────
  const merged = await PDFDocument.create()
  const frontDoc = await PDFDocument.load(frontBytes)
  const frontPages = await merged.copyPages(frontDoc, frontDoc.getPageIndices())
  frontPages.forEach(p => merged.addPage(p))

  for (const ex of input.specExcerpts) {
    try {
      const src = await PDFDocument.load(ex.pdfBytes)
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

  return merged.save()
}

// ─── Data gathering + storage ───────────────────────────────────────────────

const PKG_BUCKET = "submittals"

/** Storage path for a package's generated PDF. Tenant-prefixed so the
 *  new storage RLS can scope via (storage.foldername(name))[1]. */
export function packagePdfPath(companyId: string, packageId: string): string {
  return `${companyId}/submittal-packages/${packageId}/package.pdf`
}

interface PackageRow {
  id: string
  project_id: string
  company_id: string
  package_number: string
  vendor_name_snapshot: string
  sent_to_email: string
  due_date: string | null
}

/**
 * Gather every input for a package, build its PDF, upload it to storage, and
 * return the bytes + storage path. Used by both the preview and dispatch
 * routes. The caller is responsible for persisting `pdf_file_path`.
 */
export async function composePackagePdf(
  supabase: AnySupabase,
  packageId: string,
): Promise<{ bytes: Uint8Array; storagePath: string }> {
  const { data: pkg, error: pkgErr } = await supabase
    .from("submittal_packages")
    .select("id, project_id, company_id, package_number, vendor_name_snapshot, sent_to_email, due_date")
    .eq("id", packageId)
    .maybeSingle()
  if (pkgErr || !pkg) throw new Error("Package not found")
  const pkgRow = pkg as PackageRow
  if (!pkgRow.company_id) throw new Error("Package has no company_id")

  // Project + company branding
  const [projectRes, settingsRes] = await Promise.all([
    supabase.from("projects").select("name, number, location, gc_name, architect").eq("id", pkgRow.project_id).maybeSingle(),
    supabase.from("company_settings").select("logo_path").maybeSingle(),
  ])
  const project = (projectRes.data ?? {}) as {
    name?: string | null; number?: string | null; location?: string | null
    gc_name?: string | null; architect?: string | null
  }

  let logoBytes: ArrayBuffer | null = null
  if (settingsRes.data?.logo_path) {
    const { data: logoBlob } = await supabase.storage.from("company-assets").download(settingsRes.data.logo_path)
    if (logoBlob) logoBytes = await logoBlob.arrayBuffer()
  }

  // Package items → submittal detail
  const { data: itemRows } = await supabase
    .from("submittal_package_items")
    .select("submittal_id, submittals(submittal_seq, csi_section, file_name, submittal_type, due_date, spec_section_id)")
    .eq("package_id", packageId)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const submittals = (itemRows ?? []).map((r: any) => r.submittals).filter(Boolean)
  submittals.sort((a: { submittal_seq: number | null }, b: { submittal_seq: number | null }) =>
    (a.submittal_seq ?? 0) - (b.submittal_seq ?? 0))

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items: PackagePdfItem[] = submittals.map((s: any) => ({
    submittal_seq: s.submittal_seq ?? null,
    spec_number: s.csi_section ?? null,
    description: stripExt(String(s.file_name ?? "")) || "—",
    submittal_type: s.submittal_type ?? null,
    due_date: s.due_date ?? null,
  }))

  // Unique spec sections referenced by the items
  const sectionIds = [...new Set(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    submittals.map((s: any) => s.spec_section_id).filter((id: string | null): id is string => !!id),
  )]

  const specExcerpts: PackagePdfSpecExcerpt[] = []
  if (sectionIds.length > 0) {
    const { data: sections } = await supabase
      .from("spec_sections")
      .select("id, spec_number, spec_title, start_page, end_page, project_document_id")
      .in("id", sectionIds)

    // Download each unique spec-book document once, then slice per section.
    const docCache = new Map<string, ArrayBuffer | null>()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sortedSections = [...(sections ?? [])].sort((a: any, b: any) =>
      String(a.spec_number).localeCompare(String(b.spec_number)))

    for (const sec of sortedSections) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const s = sec as any
      if (s.start_page == null || s.end_page == null || !s.project_document_id) continue

      if (!docCache.has(s.project_document_id)) {
        const { data: doc } = await supabase
          .from("project_documents")
          .select("file_path")
          .eq("id", s.project_document_id)
          .maybeSingle()
        let bytes: ArrayBuffer | null = null
        if (doc?.file_path) {
          const { data: blob } = await supabase.storage.from(PKG_BUCKET).download(doc.file_path)
          if (blob) bytes = await blob.arrayBuffer()
        }
        docCache.set(s.project_document_id, bytes)
      }

      const pdfBytes = docCache.get(s.project_document_id)
      if (!pdfBytes) continue
      specExcerpts.push({
        spec_number: String(s.spec_number),
        spec_title: String(s.spec_title),
        pdfBytes,
        startPage: s.start_page,
        endPage: s.end_page,
      })
    }
  }

  const bytes = await buildPackagePdf({
    trackingRef: `[${pkgRow.package_number}]`,
    vendorName: pkgRow.vendor_name_snapshot,
    vendorEmail: pkgRow.sent_to_email,
    project,
    gcName: project.gc_name ?? "",
    logoBytes,
    dueDate: pkgRow.due_date,
    generationDate: new Date(),
    items,
    specExcerpts,
  })

  const storagePath = packagePdfPath(pkgRow.company_id, packageId)
  // The package PDF is a generated artifact. Upload it with the service-role
  // client so it isn't subject to the submittals bucket's storage RLS, which
  // whitelists only specific path prefixes — same approach gmail-intake uses
  // for its own uploads. Every DB read above stays RLS-scoped to the user.
  const admin = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
  const { error: uploadErr } = await admin.storage
    .from(PKG_BUCKET)
    .upload(storagePath, bytes, { contentType: "application/pdf", upsert: true })
  if (uploadErr) throw new Error(`Failed to store package PDF: ${uploadErr.message}`)

  return { bytes, storagePath }
}
