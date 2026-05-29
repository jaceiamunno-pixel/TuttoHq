import { createClient as createServiceClient, type SupabaseClient } from "@supabase/supabase-js"
import { PDFBuilder } from "./pdf-builder"

// ─── Closeout-package PDF (Session K1) ──────────────────────────────────────
// Outbound dispatch document a PM sends a sub: a cover + summary, instructions,
// and a list of closeout items the sub must return (warranties, O&M manuals,
// certifications, etc.). Built with the shared PDFBuilder.
//
// Unlike submittal packages, this PDF does NOT append source documents — the
// dispatch is the *request* to the sub. The sub replies with their actual
// closeout documents attached; those are handled by gmail-intake's match-back
// into closeout_package_inbound.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = SupabaseClient<any, any, any>

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—"
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" })
}

const CATEGORY_LABEL: Record<string, string> = {
  documents: "Documents",
  inspections: "Inspections",
  warranties: "Warranties",
  handover: "Handover",
  training: "Training",
  subcontractors: "Subcontractor",
  suppliers: "Supplier",
}

function fmtStatus(s: string | null | undefined): string {
  if (s === "complete") return "Complete"
  if (s === "in_progress") return "In Progress"
  return "Incomplete"
}

// ─── Pure PDF composition ───────────────────────────────────────────────────

export interface CloseoutPackagePdfItem {
  title: string
  category: string | null
  item_type: string | null
  folder_name: string | null
  status: string | null
  assigned_to: string | null
  due_date: string | null
}

export interface CloseoutPackagePdfInput {
  /** Tracking ref, already bracketed — e.g. "[TTQ-CO-ABCD-7]". */
  trackingRef: string
  vendorName: string
  vendorEmail: string
  project: { name?: string | null; number?: string | null; location?: string | null; gc_name?: string | null; architect?: string | null }
  gcName: string
  logoBytes: ArrayBuffer | null
  dueDate: string | null
  generationDate: Date
  items: CloseoutPackagePdfItem[]
}

const INSTRUCTIONS =
  "Please review the closeout item list below and return each required document " +
  "(warranties, O&M manuals, certifications, contact information, etc.) per the " +
  "project closeout schedule. When you respond, reply to the dispatch email with " +
  "your documents attached and keep the tracking reference in the subject line — " +
  "our system uses it to route your submission back to this package for review."

/** Build the closeout package PDF from already-resolved inputs. */
export async function buildCloseoutPackagePdf(input: CloseoutPackagePdfInput): Promise<Uint8Array> {
  const pdf = await PDFBuilder.create({
    documentType: `Closeout Package — ${input.vendorName}`,
    documentNumber: input.trackingRef,
    generationDate: input.generationDate,
    logoBytes: input.logoBytes,
    brandName: input.gcName,
  })

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
      { label: "Due Date", value: input.dueDate ? fmtDate(input.dueDate) : "Per closeout schedule" },
    ],
    [
      { label: "Tracking Ref", value: input.trackingRef },
      { label: "Package Date", value: fmtDate(input.generationDate.toISOString()) },
    ],
  ])

  pdf.textBlock("Instructions", INSTRUCTIONS)

  pdf.sectionDivider("Closeout Items")
  if (input.items.length === 0) {
    pdf.textBlock("", "No closeout items are attached to this package.")
  } else {
    const colW = [186, 96, 96, 80, 68] // = 526 (PDF.contentW)
    pdf.table(
      ["Item", "Category", "Assigned", "Status", "Due"],
      input.items.map(it => [
        it.title || "—",
        it.folder_name
          ? `${CATEGORY_LABEL[it.category ?? ""] ?? it.category ?? "—"} · ${it.folder_name}`
          : (CATEGORY_LABEL[it.category ?? ""] ?? it.category ?? "—"),
        it.assigned_to || "—",
        fmtStatus(it.status),
        it.due_date ? fmtDate(it.due_date) : (input.dueDate ? fmtDate(input.dueDate) : "—"),
      ]),
      colW,
    )
  }

  return pdf.save()
}

// ─── Data gathering + storage ───────────────────────────────────────────────

const PKG_BUCKET = "submittals"

/** Storage path for a closeout package's generated PDF. Tenant-prefixed
 *  so the new storage RLS can scope via (storage.foldername(name))[1]. */
export function closeoutPackagePdfPath(companyId: string, packageId: string): string {
  return `${companyId}/closeout-packages/${packageId}/package.pdf`
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
 * Gather every input for a closeout package, build its PDF, upload to storage,
 * and return the bytes + storage path. Used by both the preview and dispatch
 * routes. Caller is responsible for persisting pdf_file_path.
 */
export async function composeCloseoutPackagePdf(
  supabase: AnySupabase,
  packageId: string,
): Promise<{ bytes: Uint8Array; storagePath: string }> {
  const { data: pkg, error: pkgErr } = await supabase
    .from("closeout_packages")
    .select("id, project_id, company_id, package_number, vendor_name_snapshot, sent_to_email, due_date")
    .eq("id", packageId)
    .maybeSingle()
  if (pkgErr || !pkg) throw new Error("Package not found")
  const pkgRow = pkg as PackageRow
  if (!pkgRow.company_id) throw new Error("Package has no company_id")

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

  const { data: itemRows } = await supabase
    .from("closeout_package_items")
    .select("closeout_item_id, closeout_items(title, category, item_type, folder_name, status, assigned_to, due_date, sort_order)")
    .eq("package_id", packageId)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const closeoutItems = (itemRows ?? []).map((r: any) => r.closeout_items).filter(Boolean)
  closeoutItems.sort((a: { sort_order: number | null }, b: { sort_order: number | null }) =>
    (a.sort_order ?? 0) - (b.sort_order ?? 0))

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items: CloseoutPackagePdfItem[] = closeoutItems.map((c: any) => ({
    title: c.title ?? "—",
    category: c.category ?? null,
    item_type: c.item_type ?? null,
    folder_name: c.folder_name ?? null,
    status: c.status ?? null,
    assigned_to: c.assigned_to ?? null,
    due_date: c.due_date ?? null,
  }))

  const bytes = await buildCloseoutPackagePdf({
    trackingRef: `[${pkgRow.package_number}]`,
    vendorName: pkgRow.vendor_name_snapshot,
    vendorEmail: pkgRow.sent_to_email,
    project,
    gcName: project.gc_name ?? "",
    logoBytes,
    dueDate: pkgRow.due_date,
    generationDate: new Date(),
    items,
  })

  const storagePath = closeoutPackagePdfPath(pkgRow.company_id, packageId)
  // Generated artifact — upload with service-role to bypass storage RLS, which
  // whitelists only specific path prefixes. Mirrors composePackagePdf.
  const admin = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
  const { error: uploadErr } = await admin.storage
    .from(PKG_BUCKET)
    .upload(storagePath, bytes, { contentType: "application/pdf", upsert: true })
  if (uploadErr) throw new Error(`Failed to store closeout package PDF: ${uploadErr.message}`)

  return { bytes, storagePath }
}
