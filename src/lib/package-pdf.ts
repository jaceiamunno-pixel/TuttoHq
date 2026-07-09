import { PDFDocument } from "pdf-lib"
import { createClient as createServiceClient, type SupabaseClient } from "@supabase/supabase-js"
import { PDFBuilder } from "./pdf-builder"
import { buildCoversheetPdf, type CoversheetReviewer } from "./coversheet-pdf"
import type { SubmittalCoversheetProps } from "@/components/submittals/SubmittalCoversheet"
import { normalizeSubmittalTitle } from "./title-normalize"

// ─── Transmittal-package PDF ────────────────────────────────────────────────
// A package is an OUTBOUND TRANSMITTAL: the PM assembles the APPROVED submittal
// documents and sends them upstream (to the CM / A/E) or to a subcontractor,
// from their own email client. It is NOT a solicitation — no spec-book pages,
// no "items the sub must produce". The PDF contains the actual current
// attachment for each selected submittal, front-matter built with PDFBuilder,
// documents merged in with pdf-lib copyPages.
//
// Two coversheet modes:
//   MODE B ("package")  — one package cover listing every item, then all the
//                         documents appended in order.
//   MODE A ("per_item") — each submittal gets its OWN coversheet page (the
//                         same coversheet /api/generate-cover produces) placed
//                         immediately before its document.
//
// Document selection mirrors /api/generate-cover exactly: the CURRENT
// attachment is the one synced onto the submittals row (submittal_attachments
// is_current → submittals.storage_path via trigger), and we prefer the
// cover-STRIPPED copy (stripped_storage_path) when present so a Tutto cover is
// never stacked on an existing coversheet. When stripped_storage_path is null
// we fall back to storage_path and note it in `warnings`.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = SupabaseClient<any, any, any>

export type RecipientType = "cm" | "ae" | "subcontractor"
export type CoversheetMode = "per_item" | "package"

/** Short recipient label printed on the package cover + stored on the row. */
export const RECIPIENT_LABEL: Record<RecipientType, string> = {
  cm: "Construction Manager",
  ae: "Architect / Engineer",
  subcontractor: "Subcontractor",
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—"
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" })
}

function stripExt(name: string): string {
  return name.replace(/\.[^./\\]+$/, "")
}

// ─── Resolved per-item shape the pure composer consumes ─────────────────────

interface ResolvedItem {
  seq: number | null
  specNumber: string | null
  description: string
  submittalType: string | null
  /** The item's document bytes (stripped copy preferred). null → skipped. */
  documentBytes: ArrayBuffer | null
  /** Mode A coversheet inputs. */
  coversheet: SubmittalCoversheetProps
  reviewer: CoversheetReviewer
}

export interface TransmittalPdfInput {
  packageNumber: string
  recipientType: RecipientType
  /** ISO date (YYYY-MM-DD) the package is sent. */
  sendDate: string
  coversheetMode: CoversheetMode
  project: { name?: string | null; number?: string | null; location?: string | null; gc_name?: string | null; architect?: string | null }
  gcName: string
  logoBytes: ArrayBuffer | null
  logoScalePct?: number | null
  items: ResolvedItem[]
}

/** Build the transmittal-package PDF from already-resolved inputs. */
export async function buildTransmittalPackagePdf(input: TransmittalPdfInput): Promise<Uint8Array> {
  const generationDate = new Date(`${input.sendDate}T00:00:00`)
  const merged = await PDFDocument.create()

  const appendDoc = async (bytes: ArrayBuffer | Uint8Array | null) => {
    if (!bytes) return
    try {
      const src = await PDFDocument.load(bytes)
      const pages = await merged.copyPages(src, src.getPageIndices())
      pages.forEach(p => merged.addPage(p))
    } catch {
      // A single unreadable document must not fail the whole package.
    }
  }

  if (input.coversheetMode === "package") {
    // ── MODE B: one package cover, then every document in order. ──────────
    const pdf = await PDFBuilder.create({
      documentType: "Submittal Transmittal",
      documentNumber: `[${input.packageNumber}]`,
      generationDate,
      logoBytes: input.logoBytes,
      logoScalePct: input.logoScalePct ?? undefined,
      brandName: input.gcName,
    })

    pdf.projectBlock({
      name: input.project.name,
      number: input.project.number,
      location: input.project.location,
      gc_name: input.project.gc_name,
      architect: input.project.architect,
    })

    pdf.sectionDivider("Transmittal")
    pdf.fieldGrid([
      [
        { label: "Sent To", value: RECIPIENT_LABEL[input.recipientType] },
        { label: "Date", value: fmtDate(input.sendDate) },
      ],
      [
        { label: "Items", value: String(input.items.length) },
        { label: "Tracking Ref", value: `[${input.packageNumber}]` },
      ],
    ])

    pdf.sectionDivider("Items")
    const listW = [46, 90, 305, 85] // = 526 (PDF.contentW)
    pdf.table(
      ["#", "Spec #", "Description", "Type"],
      input.items.map(it => [
        it.seq != null ? String(it.seq) : "—",
        it.specNumber || "—",
        it.description || "—",
        it.submittalType || "—",
      ]),
      listW,
    )

    const frontBytes = await pdf.save()
    const frontDoc = await PDFDocument.load(frontBytes)
    const frontPages = await merged.copyPages(frontDoc, frontDoc.getPageIndices())
    frontPages.forEach(p => merged.addPage(p))

    for (const it of input.items) await appendDoc(it.documentBytes)
  } else {
    // ── MODE A: per-item coversheet immediately before each document. ─────
    for (const it of input.items) {
      // Items with no resolvable document are skipped entirely (a lone cover
      // page with no document behind it is a confusing artifact).
      if (!it.documentBytes) continue
      const coverBytes = await buildCoversheetPdf(
        it.coversheet, input.logoBytes, it.reviewer, input.logoScalePct ?? undefined,
      )
      await appendDoc(coverBytes)
      await appendDoc(it.documentBytes)
    }
  }

  return merged.save()
}

// ─── Data gathering + storage ───────────────────────────────────────────────

const PKG_BUCKET = "submittals"

/** Storage path for a package's generated PDF. Tenant-prefixed so the
 *  storage RLS can scope via (storage.foldername(name))[1]. */
export function packagePdfPath(companyId: string, packageId: string): string {
  return `${companyId}/submittal-packages/${packageId}/package.pdf`
}

function serviceClient(): AnySupabase {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

export interface ComposeTransmittalArgs {
  packageId: string
  projectId: string
  companyId: string
  packageNumber: string
  recipientType: RecipientType
  sendDate: string
  coversheetMode: CoversheetMode
  /** Submittal ids to include, in the order the caller wants them appended. */
  submittalIds: string[]
}

/**
 * Gather every input for a transmittal package, build its PDF, upload it to
 * storage, and return the bytes + storage path + any per-item warnings.
 *
 * All DB reads and document downloads run through the caller's authed
 * `supabase` client (RLS-scoped to their company). Only the final upload of
 * the generated artifact uses the service-role client — same pattern the old
 * package composer and gmail-intake use for their own generated uploads.
 */
export async function composeTransmittalPackagePdf(
  supabase: AnySupabase,
  args: ComposeTransmittalArgs,
): Promise<{ bytes: Uint8Array; storagePath: string; warnings: string[] }> {
  const warnings: string[] = []

  // Project + branding + reviewer identity (for Mode A coversheet stamps).
  const [projectRes, settingsRes, companyRes, profileRes] = await Promise.all([
    supabase.from("projects").select("name, number, location, gc_name, architect").eq("id", args.projectId).maybeSingle(),
    supabase.from("company_settings").select("logo_path, logo_scale_pct").maybeSingle(),
    supabase.from("companies").select("name").eq("id", args.companyId).maybeSingle(),
    supabase.from("user_profiles").select("full_name").maybeSingle(),
  ])
  const project = (projectRes.data ?? {}) as {
    name?: string | null; number?: string | null; location?: string | null
    gc_name?: string | null; architect?: string | null
  }
  const reviewedByName = (profileRes.data?.full_name as string | undefined) ?? ""
  const stampCompanyName = (companyRes.data?.name as string | undefined) ?? ""
  const logoScalePct = settingsRes.data?.logo_scale_pct ?? undefined

  let logoBytes: ArrayBuffer | null = null
  if (settingsRes.data?.logo_path) {
    const { data: logoBlob } = await supabase.storage.from("company-assets").download(settingsRes.data.logo_path)
    if (logoBlob) logoBytes = await logoBlob.arrayBuffer()
  }

  // Submittal rows for the requested ids (company-scoped by RLS, active only).
  const { data: subRows } = await supabase
    .from("submittals")
    .select("id, submittal_seq, csi_section, spec_section_id, file_name, submittal_type, storage_path, stripped_storage_path, mime_type, submittal_number, revision_number, due_date")
    .in("id", args.submittalIds)
    .eq("status", "active")

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (subRows ?? []) as any[]
  // Preserve the caller's requested order (falls back to seq for stability).
  const byId = new Map(rows.map(r => [r.id as string, r]))
  const ordered = args.submittalIds.map(id => byId.get(id)).filter(Boolean)

  // Resolve spec-section titles for Mode A coversheets (best-effort).
  const sectionIds = [...new Set(ordered.map(r => r.spec_section_id).filter((v): v is string => !!v))]
  const titleById = new Map<string, string>()
  if (sectionIds.length > 0) {
    const { data: secs } = await supabase.from("spec_sections").select("id, spec_title").in("id", sectionIds)
    for (const s of (secs ?? []) as Array<{ id: string; spec_title: string | null }>) {
      titleById.set(s.id, s.spec_title ?? "")
    }
  }

  const items: ResolvedItem[] = []
  for (const r of ordered) {
    const description = normalizeSubmittalTitle(String(r.file_name ?? "")) || stripExt(String(r.file_name ?? "")) || "—"
    const label = r.submittal_seq != null ? `#${r.submittal_seq}` : (r.csi_section || description)

    // Document selection — mirror /api/generate-cover's "stripped" branch:
    //   stripped_storage_path (clean product) → storage_path (current file).
    const documentPath = r.stripped_storage_path || r.storage_path
    let documentBytes: ArrayBuffer | null = null
    if (r.mime_type === "application/pdf" && documentPath) {
      const { data: blob } = await supabase.storage.from(PKG_BUCKET).download(documentPath)
      if (blob) {
        documentBytes = await blob.arrayBuffer()
        if (!r.stripped_storage_path) {
          warnings.push(`${label}: no cover-stripped copy on file — used the original (any existing coversheet is retained).`)
        }
      } else {
        warnings.push(`${label}: attachment file could not be read — skipped.`)
      }
    } else {
      warnings.push(`${label}: no current PDF attachment — skipped.`)
    }

    // Mode A coversheet inputs (unused in Mode B but cheap to build).
    const specNumber = (r.csi_section as string | null) ?? ""
    const subInt = parseInt(String(r.submittal_number ?? ""), 10)
    const numPart = Number.isFinite(subInt)
      ? `${subInt}.${parseInt(String(r.revision_number ?? "0"), 10) || 0}`
      : ""
    const stampSubmittalNo = [specNumber.trim(), numPart].filter(Boolean).join("-")

    const coversheet: SubmittalCoversheetProps = {
      gcName: project.gc_name ?? "",
      projectName: project.name ?? "",
      projectNumber: project.number ?? "",
      projectLocation: project.location ?? "",
      submittalDescription: description,
      specSectionTitle: (r.spec_section_id && titleById.get(r.spec_section_id)) || "",
      specSectionNumber: specNumber,
      submittalNumber: String(Math.max(1, parseInt(String(r.submittal_number ?? "1"), 10) || 1)).padStart(2, "0"),
      revisionNumber: String(parseInt(String(r.revision_number ?? "0"), 10) || 0).padStart(2, "0"),
      dateSubmitted: fmtDate(args.sendDate),
      submittalDueDate: r.due_date ? fmtDate(r.due_date) : "",
    }
    const reviewer: CoversheetReviewer = {
      company: stampCompanyName,
      projectName: project.name ?? "",
      projectNumber: project.number ?? "",
      submittalNo: stampSubmittalNo,
      reviewedBy: reviewedByName,
      date: new Date(`${args.sendDate}T00:00:00`).toLocaleDateString("en-US"),
    }

    items.push({
      seq: r.submittal_seq ?? null,
      specNumber: r.csi_section ?? null,
      description,
      submittalType: r.submittal_type ?? null,
      documentBytes,
      coversheet,
      reviewer,
    })
  }

  const bytes = await buildTransmittalPackagePdf({
    packageNumber: args.packageNumber,
    recipientType: args.recipientType,
    sendDate: args.sendDate,
    coversheetMode: args.coversheetMode,
    project,
    gcName: project.gc_name ?? "",
    logoBytes,
    logoScalePct,
    items,
  })

  const storagePath = packagePdfPath(args.companyId, args.packageId)
  const { error: uploadErr } = await serviceClient().storage
    .from(PKG_BUCKET)
    .upload(storagePath, bytes, { contentType: "application/pdf", upsert: true })
  if (uploadErr) throw new Error(`Failed to store package PDF: ${uploadErr.message}`)

  return { bytes, storagePath, warnings }
}

/**
 * Load a package's already-composed PDF from storage. The transmittal PDF is
 * built ONCE at package create and stored at `pdf_file_path`; preview and the
 * reminder runner just re-read that stored artifact rather than recomposing
 * (recomposition would need the mode/recipient/date that aren't persisted).
 */
export async function loadStoredPackagePdf(
  supabase: AnySupabase,
  packageId: string,
): Promise<{ bytes: Uint8Array; storagePath: string }> {
  const { data: pkg } = await supabase
    .from("submittal_packages")
    .select("pdf_file_path")
    .eq("id", packageId)
    .maybeSingle()
  const path = (pkg?.pdf_file_path as string | null) ?? null
  if (!path) throw new Error("Package has no stored PDF")
  const { data: blob, error } = await serviceClient().storage.from(PKG_BUCKET).download(path)
  if (error || !blob) throw new Error("Stored package PDF not found")
  return { bytes: new Uint8Array(await blob.arrayBuffer()), storagePath: path }
}
