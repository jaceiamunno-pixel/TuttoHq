// Front-matter stripping for the Library view.
//
// THE DESIGN: Stage 2b serves a STRIPPED view of each submittal on
// demand — never stores a second file. The original PDF (cover + stamp
// + content) is the source of truth on storage; the stripped version
// is generated when the user opens the Library row.
//
// STRIP ANCHOR: the architect's PDF /Stamp annotation. From that anchor
// we walk BOTH directions — backward and forward — over contiguous
// "cover-shaped" pages, where a page is cover-shaped when ANY of:
//
//   1. has AcroForm widget annotations (Waters submitter coversheet)
//   2. has a /Stamp annotation (architect stamp page)
//   3. is truly blank (< 10 chars of text AND zero image XObjects —
//      "blank by text alone" isn't enough; a page with image content
//      but no text is typically a drawing / schedule, NOT blank)
//   4. has cover-template keywords AND zero image XObjects
//      (Letter of Transmittal, Submittal Disposition, Submittal
//      Transmittal Form, Material Sample Transfer, Submittal Review)
//
// Stops at the first non-cover page in either direction. Strip range
// is the closed interval [firstCoverPage..lastCoverPage]; pages
// outside that range are preserved.
//
// CONSERVATIVE: if there is no /Stamp annotation in the first
// `STAMP_SCAN_PAGES` pages, OR the strip would consume the entire
// document, return the original buffer unchanged. The Library view
// then shows the full PDF. The user always has the original one
// click away regardless.
//
// HANDLES THE OUT-OF-ORDER CASE: when a GC inserts the architect's
// stamped paperwork mid-document (e.g. Sub 079 has product samples
// on page 1, Waters cover + stamp on pages 2-3, more samples on
// page 4+), backward-walk stops at page 2 — page 1's product
// content is preserved.
//
// REUSE: this logic runs for BOTH bulk-import-committed rows AND
// direct Library uploads. Direct uploads typically have no stamp
// (the contractor uploaded a raw datasheet) — those land in the
// conservative null branch and pass through unmodified.

import { PDFDocument, PDFDict, PDFArray, PDFName } from "pdf-lib"
import { extractText, getDocumentProxy } from "unpdf"
import { extractApprovalStampDate, type ApprovalStampInfo } from "./bulk-import-form"

const BLANK_PAGE_CHAR_THRESHOLD = 10
const STAMP_SCAN_PAGES = 6

const COVER_KEYWORDS = new RegExp([
  "Submittal Transmittal Form",
  "Submittal Disposition Stamp",
  "Submittal Review Completed",
  "Letter of Transmittal",
  "Material Sample Transfer",
  "Quality Control Program",
].join("|"), "i")

export interface StripPlan {
  /** 1-based first page to strip (inclusive). */
  stripStartPage: number
  /** 1-based last page to strip (inclusive). The Library view shows
   *  pages outside [stripStartPage..stripEndPage]. */
  stripEndPage: number
  /** The /Stamp annotation that anchored the strip. */
  stamp: ApprovalStampInfo
  /** Total pages in the original PDF. */
  totalPages: number
}

interface PageMeta {
  /** Char count after collapsing whitespace. */
  charCount: number
  formWidgetCount: number
  stampAnnotCount: number
  imageCount: number
}

function isCoverShaped(meta: PageMeta, text: string): boolean {
  if (meta.formWidgetCount > 0) return true
  if (meta.stampAnnotCount > 0) return true
  // Truly blank: very little text AND no image content
  if (meta.charCount < BLANK_PAGE_CHAR_THRESHOLD && meta.imageCount === 0) return true
  // Cover keywords AND no image content (a page with images + cover
  // keywords is probably product content that happens to mention a
  // transmittal — keep it)
  if (meta.imageCount === 0 && COVER_KEYWORDS.test(text)) return true
  return false
}

async function collectPageMeta(doc: PDFDocument): Promise<PageMeta[]> {
  const out: PageMeta[] = []
  const pages = doc.getPages()
  for (const page of pages) {
    let formWidgetCount = 0
    let stampAnnotCount = 0
    let imageCount = 0

    const annotsRef = page.node.get(doc.context.obj("Annots"))
    if (annotsRef) {
      const annots = doc.context.lookup(annotsRef)
      if (annots instanceof PDFArray) {
        for (let i = 0; i < annots.size(); i++) {
          const a = doc.context.lookup(annots.get(i))
          if (!(a instanceof PDFDict)) continue
          const subtype = a.get(doc.context.obj("Subtype"))?.toString?.() ?? ""
          if (subtype === "/Widget") formWidgetCount++
          else if (subtype === "/Stamp") stampAnnotCount++
        }
      }
    }

    const res = page.node.Resources()
    if (res) {
      const xoRef = res.get(doc.context.obj("XObject"))
      const xoDict = xoRef ? doc.context.lookup(xoRef) : null
      if (xoDict instanceof PDFDict) {
        for (const [, ref] of xoDict.entries()) {
          const xo = doc.context.lookup(ref)
          const subtype = (xo as { dict?: PDFDict }).dict?.get?.(doc.context.obj("Subtype")) as PDFName | undefined
          if (subtype?.toString?.() === "/Image") imageCount++
        }
      }
    }

    out.push({ formWidgetCount, stampAnnotCount, imageCount, charCount: 0 })
  }
  return out
}

/**
 * Compute the strip plan for a PDF. Returns null when:
 *   - no /Stamp annotation is found in the first STAMP_SCAN_PAGES pages
 *     (no anchor — leave the file alone)
 *   - the strip would consume the entire document (never produce an
 *     empty PDF — return the original instead)
 *
 * When non-null, the caller should generate a PDF containing pages
 * outside [stripStartPage..stripEndPage] (1-based, both inclusive).
 */
export async function findStripPlan(buffer: Buffer): Promise<StripPlan | null> {
  const stamp = await extractApprovalStampDate(buffer, STAMP_SCAN_PAGES)
  if (!stamp) return null

  const pdf = await getDocumentProxy(new Uint8Array(buffer))
  const { text } = await extractText(pdf, { mergePages: false })
  const pageTexts = (Array.isArray(text) ? text : [text]) as string[]
  const totalPages = pageTexts.length

  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true })
  const meta = await collectPageMeta(doc)
  // Populate charCount on meta from page text.
  for (let i = 0; i < meta.length; i++) {
    meta[i].charCount = (pageTexts[i] ?? "").replace(/\s+/g, "").length
  }

  // 0-indexed stamp page
  const stampIdx = stamp.page - 1

  // Walk BACKWARD from the stamp page while pages are cover-shaped.
  let firstCover = stampIdx
  while (firstCover - 1 >= 0 && isCoverShaped(meta[firstCover - 1], pageTexts[firstCover - 1] ?? "")) {
    firstCover--
  }

  // Walk FORWARD from the stamp page while pages are cover-shaped.
  let lastCover = stampIdx
  while (lastCover + 1 < totalPages && isCoverShaped(meta[lastCover + 1], pageTexts[lastCover + 1] ?? "")) {
    lastCover++
  }

  const stripStartPage = firstCover + 1
  const stripEndPage = lastCover + 1
  const remainingPageCount = totalPages - (stripEndPage - stripStartPage + 1)

  // Conservative: never serve an empty PDF.
  if (remainingPageCount <= 0) return null

  return { stripStartPage, stripEndPage, stamp, totalPages }
}

/**
 * Strip front matter from a PDF buffer. Returns:
 *   - a new PDF buffer containing only the content pages, when a
 *     strip plan was found
 *   - the ORIGINAL buffer unchanged, when no strip is appropriate
 *     (no stamp, or strip would empty the doc)
 *
 * Always returns a usable PDF. Never throws on a malformed PDF — falls
 * back to returning the original.
 */
export async function stripFrontMatter(buffer: Buffer): Promise<{ buffer: Buffer; plan: StripPlan | null }> {
  try {
    const plan = await findStripPlan(buffer)
    if (!plan) return { buffer, plan: null }

    const src = await PDFDocument.load(buffer, { ignoreEncryption: true })
    // Copy pages outside [stripStartPage..stripEndPage] (0-indexed inside).
    const indices: number[] = []
    for (let p = 0; p < plan.totalPages; p++) {
      const oneBased = p + 1
      if (oneBased >= plan.stripStartPage && oneBased <= plan.stripEndPage) continue
      indices.push(p)
    }

    const dst = await PDFDocument.create()
    const copied = await dst.copyPages(src, indices)
    for (const page of copied) dst.addPage(page)

    const out = await dst.save()
    return { buffer: Buffer.from(out), plan }
  } catch {
    // Never break the download path. Conservative fallback = original.
    return { buffer, plan: null }
  }
}
