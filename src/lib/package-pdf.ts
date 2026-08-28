import { PDFDocument } from "pdf-lib"
import { randomUUID } from "node:crypto"
import { createClient as createServiceClient, type SupabaseClient } from "@supabase/supabase-js"
import {
  buildCoversheetPdf, buildPackageCoversheetPdf, PACKAGE_COVER_LINE_MAX,
  type CoversheetReviewer, type PackageCoverLine,
} from "./coversheet-pdf"
import type { SubmittalCoversheetProps } from "@/components/submittals/SubmittalCoversheet"
import { normalizeSubmittalTitle } from "./title-normalize"
import { formatSectionNumber, padSectionSeq } from "./section-number"
import { transmittalItemFileName, transmittalPackageBaseName } from "./package-name"

// ─── Transmittal-package PDF ────────────────────────────────────────────────
// A package is an OUTBOUND TRANSMITTAL: the PM assembles the APPROVED submittal
// documents and sends them upstream (to the CM / A/E) or to a subcontractor,
// from their own email client. It is NOT a solicitation — no spec-book pages.
//
// BOTH coversheet modes print the "Submittal Coversheet" chrome from
// ./coversheet-pdf; they differ in how many covers and how many files come out:
//   MODE 'package'  — ONE merged PDF: ONE package cover (buildPackageCoversheetPdf)
//                     whose manifest table lists every submittal — plus any
//                     manual, description-only `extraLines` — followed by all
//                     the documents in order ([cover][doc 1][doc 2] …). One
//                     package-level reviewer stamp. Manual lines print a row
//                     and contribute NO document.
//   MODE 'per_item' — N PDFs, one per submittal: that item's own stamped
//                     coversheet (buildCoversheetPdf) followed by its document.
//                     A 'per_item' generation is a SET of separate files, never
//                     a single merged PDF. Per-item covers exist ONLY here;
//                     extraLines are ignored.
// The separate "Submittal Transmittal" list cover (Sent To + ITEMS table)
// survives only at /api/transmittal/[id], the Send-via-Email record.
//
// Generations are append-only: each call to generateTransmittalPackage writes a
// fresh set of files under a new generation_id and inserts one
// submittal_package_files row per file. Nothing is ever overwritten.
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

/** Short recipient label stored on the row / shown in package UI. No longer
 *  printed on any cover — the retired list cover was its only render site. */
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
  submittalId: string
  /** Per-(project, section) submittal number. Rendered "{specNumber}-{seq:3}". */
  sectionSeq: number | null
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
  /** Resolved recipient (per-package override → project.cm_name). NO LONGER
   *  RENDERED: the retired list cover's "Sent To" field was its only print site,
   *  and the Submittal Coversheet template has no equivalent. Kept on the input
   *  because callers still resolve and persist it on the package row (the
   *  packages UI reads it) — the composer simply does not draw it. */
  sentTo?: string | null
  /** The GC's package-level reviewer stamp (submittalNo blank). Mode 'package'
   *  renders it once on the package cover. Mode 'per_item' ignores it — each
   *  item's coversheet carries its OWN stamp via ResolvedItem.reviewer. */
  reviewer: CoversheetReviewer | null
  /** Manual, description-only manifest rows appended after the items on the
   *  'package' cover. Always run through parseExtraLines first. Ignored by
   *  'per_item'. */
  extraLines?: PackageCoverLine[]
}

const EXTRA_LINES_MAX = 50

/**
 * Coerce an untrusted request-body value into manifest lines. Never trust the
 * client: submittalId is FORCED null (a manual line can never bind to a row),
 * every field is String()+trim+clamped, entries with an empty description are
 * dropped, and the list is capped. Both the preview and the create routes — and
 * the regenerate route reading cover_extra_lines back — go through here.
 */
export function parseExtraLines(input: unknown): PackageCoverLine[] {
  if (!Array.isArray(input)) return []
  const clean = (v: unknown) => String(v ?? "").trim().slice(0, PACKAGE_COVER_LINE_MAX)
  const out: PackageCoverLine[] = []
  for (const raw of input.slice(0, EXTRA_LINES_MAX)) {
    const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
    const description = clean(r.description)
    if (!description) continue
    out.push({
      submittalId: null,
      submittalNumber: "",
      specNumber: clean(r.specNumber),
      specTitle: clean(r.specTitle),
      description,
    })
  }
  return out
}

/** One emitted PDF. submittalId is null for the whole-package file (mode
 *  'package'); set to the item's id for a per-item file (mode 'per_item'). */
export interface TransmittalFile {
  submittalId: string | null
  bytes: Uint8Array
  fileName: string
}

async function appendInto(merged: PDFDocument, bytes: ArrayBuffer | Uint8Array | null) {
  if (!bytes) return
  try {
    const src = await PDFDocument.load(bytes)
    const pages = await merged.copyPages(src, src.getPageIndices())
    pages.forEach(p => merged.addPage(p))
  } catch {
    // A single unreadable document must not fail the whole package.
  }
}

/**
 * Build the transmittal-package file(s) from already-resolved inputs.
 *   'package'  → a single-element array (the merged package PDF), or [] when
 *                there are no items AND no extra lines (callers treat that as
 *                "nothing to assemble" rather than emitting a page-less PDF).
 *   'per_item' → one element per item that has a resolvable document, each
 *                with its own per-item cover (buildCoversheetPdf).
 */
export async function buildTransmittalPackageFiles(input: TransmittalPdfInput): Promise<TransmittalFile[]> {
  const generationDate = new Date(`${input.sendDate}T00:00:00`)

  if (input.coversheetMode === "package") {
    // ── MODE 'package': ONE merged PDF = ONE package cover, then every
    //    document in order: [cover] [doc 1] [doc 2] …
    //    The cover's manifest lists each item (its row is the item's record in
    //    the transmittal, INCLUDING an item whose document is missing — already
    //    warned in the compose step) plus any manual extraLines, which print a
    //    row and contribute NO document. The cover-only PREVIEW resolves with
    //    withDocuments:false, so every documentBytes is null and this yields
    //    exactly the one cover. The cover is stamped with the package's send
    //    date (generationDate) so the "Generated <date>" footer matches the
    //    package.
    const extraLines = input.extraLines ?? []
    if (input.items.length === 0 && extraLines.length === 0) return []

    const lines: PackageCoverLine[] = [
      ...input.items.map(it => ({
        submittalId: it.submittalId,
        submittalNumber: it.coversheet.submittalNumber,
        specNumber: it.coversheet.specSectionNumber,
        specTitle: it.coversheet.specSectionTitle,
        description: it.coversheet.submittalDescription,
      })),
      ...extraLines,
    ]
    // Project-level props come from the first item's coversheet; with no items
    // (extra lines only) synthesize them from the resolved project.
    const coverProps: SubmittalCoversheetProps = input.items[0]?.coversheet ?? {
      gcName: input.gcName,
      projectName: input.project.name ?? "",
      projectNumber: input.project.number ?? "",
      projectLocation: input.project.location ?? "",
      submittalDescription: "",
      specSectionTitle: "",
      specSectionNumber: "",
      submittalNumber: "",
      revisionNumber: "",
      dateSubmitted: fmtDate(input.sendDate),
      submittalDueDate: "",
    }

    const merged = await PDFDocument.create()
    const coverBytes = await buildPackageCoversheetPdf(
      coverProps, lines, input.logoBytes, input.reviewer, input.logoScalePct ?? undefined, generationDate,
    )
    await appendInto(merged, coverBytes)
    // appendInto skips null bytes and swallows an unreadable file in a
    // try/catch, so one bad document contributes nothing but never fails the
    // whole package.
    for (const it of input.items) await appendInto(merged, it.documentBytes)

    // Single-PDF name reads like the artifact it is, e.g.
    // "Submittal Transmittal - Construction Manager - 2026-07-10.pdf".
    const packageFileName = `${transmittalPackageBaseName(input.recipientType, input.sendDate, input.packageNumber)}.pdf`
    return [{ submittalId: null, bytes: await merged.save(), fileName: packageFileName }]
  }

  // ── MODE 'per_item': one SEPARATE PDF per item (cover + that item's doc). ──
  const files: TransmittalFile[] = []
  for (const it of input.items) {
    // Items with no resolvable document are skipped entirely (already warned in
    // the compose step). A lone cover with no document is not a useful artifact.
    if (!it.documentBytes) continue
    const doc = await PDFDocument.create()
    const coverBytes = await buildCoversheetPdf(
      it.coversheet, input.logoBytes, it.reviewer, input.logoScalePct ?? undefined,
    )
    await appendInto(doc, coverBytes)
    await appendInto(doc, it.documentBytes)
    files.push({
      submittalId: it.submittalId,
      bytes: await doc.save(),
      // "{csi_section}-{seq:3} {title}.pdf" — agrees with the log + coversheet.
      fileName: transmittalItemFileName(it.specNumber, it.sectionSeq, it.description),
    })
  }
  return files
}

// ─── Data gathering + storage ───────────────────────────────────────────────

const PKG_BUCKET = "submittals"

function serviceClient(): AnySupabase {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

/** Batch-sign storage paths → Map<path, signedUrl>. Missing/failed paths are
 *  simply absent from the map. */
export async function signPaths(
  supabase: AnySupabase,
  paths: string[],
  expiresIn = 3600,
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (paths.length === 0) return map
  const { data } = await supabase.storage.from(PKG_BUCKET).createSignedUrls(paths, expiresIn)
  for (const row of (data ?? []) as Array<{ path: string | null; signedUrl: string | null }>) {
    if (row?.path && row?.signedUrl) map.set(row.path, row.signedUrl)
  }
  return map
}

/** Storage key for one generation's file. Company-first so the submittals
 *  bucket's tenant RLS ((storage.foldername(name))[1] = company) permits the
 *  authed upload; generation-scoped so nothing is ever overwritten. */
function generationFilePath(companyId: string, packageId: string, generationId: string, fileName: string): string {
  return `${companyId}/submittal-packages/${packageId}/${generationId}/${fileName}`
}

export interface GenerateTransmittalArgs {
  packageId: string
  projectId: string
  companyId: string
  packageNumber: string
  recipientType: RecipientType
  sendDate: string
  coversheetMode: CoversheetMode
  /** Submittal ids to include, in the order the caller wants them emitted. */
  submittalIds: string[]
  /** auth.uid() of the generating user, recorded on each file row. */
  generatedBy: string
  /** Per-package "Sent To" override for the list cover. When null/empty, the
   *  cover uses project.cm_name, then falls back to RECIPIENT_LABEL. */
  sentTo?: string | null
  /** Manual manifest rows for the 'package' cover (already parseExtraLines'd). */
  extraLines?: PackageCoverLine[]
}

export interface GeneratedFileMeta {
  submittalId: string | null
  storagePath: string
  fileName: string
  fileSize: number
}

/** Everything the transmittal composer needs, resolved with no writes. */
export interface ResolvedPackage {
  project: { name?: string | null; number?: string | null; location?: string | null; gc_name?: string | null; architect?: string | null; cm_name?: string | null }
  gcName: string
  logoBytes: ArrayBuffer | null
  logoScalePct: number | null | undefined
  items: ResolvedItem[]
  /** The GC's package-level reviewer stamp (one identity for the whole
   *  transmittal; submittalNo blank). Drawn once on the 'package' cover;
   *  'per_item' prints the per-item stamps (ResolvedItem.reviewer) instead. */
  reviewer: CoversheetReviewer
  warnings: string[]
}

/**
 * Resolve project + branding + per-item coversheet props + the SERVER-RESOLVED
 * reviewer identity for a transmittal package. Performs NO writes and NO date
 * stamping. This is the single source the cover data flows through, so the
 * gated preview and the actual generation render from identical inputs — the
 * cover can't drift from what the CM receives.
 *
 *   withDocuments: true  — the generator: downloads each item's document so it
 *                          can be merged behind the cover.
 *   withDocuments: false — the preview: skips every document download (the
 *                          preview only renders the COVER, never the merged
 *                          product), so it is fast and touches no file bytes.
 *
 * The reviewer stamp (company + reviewedBy) is read from the CALLER'S OWN
 * session rows (companies / user_profiles) — it is never accepted from client
 * input, in either path.
 */
export async function resolvePackageItems(
  supabase: AnySupabase,
  args: { projectId: string; companyId: string; sendDate: string; submittalIds: string[]; userId: string },
  opts: { withDocuments: boolean },
): Promise<ResolvedPackage> {
  const warnings: string[] = []

  // Project + branding + reviewer identity (for the per-item coversheets).
  //
  // The user_profiles read is filtered to the CALLER'S OWN row (PK user_id =
  // auth uid) — never an unfiltered maybeSingle(). This makes the reviewer
  // identity correct BY CONSTRUCTION instead of leaning on the current
  // "select own" RLS policy: if that policy is ever widened (team-visible
  // profiles), an unfiltered read would error into an empty stamp on
  // multi-profile visibility — or worse, silently stamp a DIFFERENT user's
  // name as the reviewer where exactly one other row is visible. The stamp
  // is what a CM sees on the transmittal; it must name the generating user.
  const [projectRes, settingsRes, companyRes, profileRes] = await Promise.all([
    supabase.from("projects").select("name, number, location, gc_name, architect, cm_name").eq("id", args.projectId).maybeSingle(),
    supabase.from("company_settings").select("logo_path, logo_scale_pct").maybeSingle(),
    supabase.from("companies").select("name").eq("id", args.companyId).maybeSingle(),
    supabase.from("user_profiles").select("full_name").eq("user_id", args.userId).maybeSingle(),
  ])
  const project = (projectRes.data ?? {}) as ResolvedPackage["project"]
  const reviewedByName = (profileRes.data?.full_name as string | undefined) ?? ""
  const stampCompanyName = (companyRes.data?.name as string | undefined) ?? ""
  const logoScalePct = settingsRes.data?.logo_scale_pct ?? undefined

  let logoBytes: ArrayBuffer | null = null
  if (settingsRes.data?.logo_path) {
    const { data: logoBlob } = await supabase.storage.from("company-assets").download(settingsRes.data.logo_path)
    if (logoBlob) logoBytes = await logoBlob.arrayBuffer()
  }

  // Submittal rows for the requested ids (company-scoped by RLS, active only).
  // section_name is fetched because it is the cover's spec-title source (below).
  const { data: subRows } = await supabase
    .from("submittals")
    .select("id, submittal_seq, section_seq, csi_section, section_name, spec_section_id, file_name, submittal_type, storage_path, stripped_storage_path, mime_type, submittal_number, revision_number, due_date")
    .in("id", args.submittalIds)
    .eq("status", "active")

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (subRows ?? []) as any[]
  const byId = new Map(rows.map(r => [r.id as string, r]))
  const ordered = args.submittalIds.map(id => byId.get(id)).filter(Boolean)

  // Resolve spec-section titles for the coversheets (best-effort fallback only).
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
    const label = r.section_seq != null ? formatSectionNumber(r.csi_section, r.section_seq) : (r.csi_section || description)

    // Document selection — mirror /api/generate-cover's "stripped" branch:
    //   stripped_storage_path (clean product) → storage_path (current file).
    // Skipped entirely for a preview (opts.withDocuments = false): the preview
    // renders the cover, not the merged product, so it downloads nothing.
    let documentBytes: ArrayBuffer | null = null
    if (opts.withDocuments) {
      const documentPath = r.stripped_storage_path || r.storage_path
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
    }

    const specNumber = (r.csi_section as string | null) ?? ""
    // Stamp's Submittal No. = "{spec section}-{section_seq:3}.{revision}" (e.g.
    // "10 44 00-004.0") — PADDED to match the log and every other printed surface.
    const secSeq = r.section_seq as number | null
    const numPart = secSeq != null
      ? `${padSectionSeq(secSeq)}.${parseInt(String(r.revision_number ?? "0"), 10) || 0}`
      : ""
    const stampSubmittalNo = [specNumber.trim(), numPart].filter(Boolean).join("-")

    // Cover spec-title: the SUBMITTAL ROW is the source of truth. Prefer the
    // row's section_name (an inline cover edit writes there), and fall back to
    // the spec-book title only when the row carries no section_name.
    const rowSectionName = typeof r.section_name === "string" ? r.section_name.trim() : ""
    const specSectionTitle = rowSectionName
      || (r.spec_section_id ? (titleById.get(r.spec_section_id) ?? "") : "")

    const coversheet: SubmittalCoversheetProps = {
      gcName: project.gc_name ?? "",
      projectName: project.name ?? "",
      projectNumber: project.number ?? "",
      projectLocation: project.location ?? "",
      submittalDescription: description,
      specSectionTitle,
      specSectionNumber: specNumber,
      submittalNumber: secSeq != null ? padSectionSeq(secSeq) : "",
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
      submittalId: r.id,
      sectionSeq: r.section_seq ?? null,
      specNumber: r.csi_section ?? null,
      description,
      submittalType: r.submittal_type ?? null,
      documentBytes,
      coversheet,
      reviewer,
    })
  }

  // Package-level reviewer identity — the GC's stamp for the whole transmittal.
  // Same company + reviewer as every per-item stamp (one caller, one company);
  // submittalNo is blank (it identifies the transmittal, not one submittal).
  // Rendered once on the 'package' cover; 'per_item' uses the per-item stamps.
  const reviewer: CoversheetReviewer = {
    company: stampCompanyName,
    projectName: project.name ?? "",
    projectNumber: project.number ?? "",
    submittalNo: "",
    reviewedBy: reviewedByName,
    date: new Date(`${args.sendDate}T00:00:00`).toLocaleDateString("en-US"),
  }

  return { project, gcName: project.gc_name ?? "", logoBytes, logoScalePct, items, reviewer, warnings }
}

/**
 * Compose a transmittal package's file(s), upload each to storage, and INSERT
 * one append-only submittal_package_files row per file under a fresh
 * generation_id. Returns the generation id + file metadata + per-item warnings.
 *
 * Everything runs through the caller's AUTHED `supabase` client — reads,
 * document downloads, uploads (the submittals bucket's tenant RLS permits
 * writes under the company-first path), and the row inserts. No service-role.
 */
export async function generateTransmittalPackage(
  supabase: AnySupabase,
  args: GenerateTransmittalArgs,
): Promise<{ generationId: string; files: GeneratedFileMeta[]; warnings: string[] }> {
  const resolved = await resolvePackageItems(
    supabase,
    { projectId: args.projectId, companyId: args.companyId, sendDate: args.sendDate, submittalIds: args.submittalIds, userId: args.generatedBy },
    { withDocuments: true },
  )
  const warnings = resolved.warnings

  // "Sent To": the per-package override wins, else the project's saved cm_name,
  // else (in the composer) the recipient-type label.
  const sentTo = (args.sentTo && args.sentTo.trim()) || (resolved.project.cm_name?.trim() ?? null)

  const built = await buildTransmittalPackageFiles({
    packageNumber: args.packageNumber,
    recipientType: args.recipientType,
    sendDate: args.sendDate,
    coversheetMode: args.coversheetMode,
    project: resolved.project,
    gcName: resolved.gcName,
    logoBytes: resolved.logoBytes,
    logoScalePct: resolved.logoScalePct,
    items: resolved.items,
    sentTo,
    reviewer: resolved.reviewer,
    extraLines: args.extraLines,
  })

  if (built.length === 0) {
    throw new Error("No documents could be assembled for this package")
  }

  // One generation → new id shared by all its files. Upload every file first
  // (unique, generation-scoped paths → no overwrite), then insert the rows.
  const generationId = randomUUID()
  const metas: GeneratedFileMeta[] = []
  for (const f of built) {
    const storagePath = generationFilePath(args.companyId, args.packageId, generationId, f.fileName)
    const { error: uploadErr } = await supabase.storage
      .from(PKG_BUCKET)
      .upload(storagePath, f.bytes, { contentType: "application/pdf", upsert: false })
    if (uploadErr) throw new Error(`Failed to store package file: ${uploadErr.message}`)
    metas.push({ submittalId: f.submittalId, storagePath, fileName: f.fileName, fileSize: f.bytes.byteLength })
  }

  // Append-only history rows. company_id defaults to get_my_company_id();
  // generated_at defaults to now(). NEVER update/delete these elsewhere.
  const { error: insErr } = await supabase.from("submittal_package_files").insert(
    metas.map(m => ({
      package_id: args.packageId,
      submittal_id: m.submittalId,
      generation_id: generationId,
      coversheet_mode: args.coversheetMode,
      storage_path: m.storagePath,
      file_name: m.fileName,
      file_size: m.fileSize,
      generated_by: args.generatedBy,
    })),
  )
  if (insErr) throw new Error(`Failed to record package files: ${insErr.message}`)

  return { generationId, files: metas, warnings }
}

/**
 * Load a LEGACY solicitation package's stored PDF (submittal_packages.
 * pdf_file_path). Only the reminder runner uses this, and only for legacy
 * solicitation packages (recipient_type IS NULL) — transmittal packages never
 * write pdf_file_path and are excluded from reminders.
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
