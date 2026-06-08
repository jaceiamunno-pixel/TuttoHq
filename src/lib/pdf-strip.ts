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
import type { CoverSplitResult } from "./bulk-import-detect"

const BLANK_PAGE_CHAR_THRESHOLD = 10
const STAMP_SCAN_PAGES = 6
// A /Stamp annotation makes a page "cover" only when the page is otherwise
// light on text (a disposition/stamp page), NOT a product page that merely
// carries a stamp/signature annotation. Above this char count we treat it
// as product even if it has a stamp.
const STAMP_PAGE_TEXT_MAX = 600
// Backstop on the leading cover run — the longest real cover stack observed
// is 4 pages (GC review-transmittal + GC address + legal disposition +
// submitter coversheet); Waters stamp stacks reach ~5 (cover + stamp pages +
// blank). 6 is a safe ceiling; stop-at-product is the real driver.
const MAX_COVER_PAGES = 6

// TEMPLATE-AGNOSTIC submittal-cover vocabulary. Every cover-page TYPE that
// precedes product content, as generic phrases that span GCs/architects (no
// vendor names): GC review-transmittal, architect review/disposition stamp
// language, GC company-name suffixes, the submitter "Submittal Coversheet",
// labeled submittal/section fields, and the legal-disposition boilerplate.
// A manufacturer DATASHEET ("…www.x.com  JOB NO.: CUSTOMER: …  part table")
// matches NONE of these → page 1 isn't cover → nothing is stripped.
const COVER_VOCAB = new RegExp([
  // GC transmittal
  "letter of transmittal",
  "submittal transmittal",
  "transmittal (?:form|sheet|cover|no\\.?|#)",
  "we are (?:sending|transmitting|forwarding)",
  // architect review / disposition stamp
  "submittal review stamp",
  "for your (?:approval|review)\\b",
  "reviewed (?:for|by)\\b",
  "no exceptions taken",
  "revise and resubmit",
  "make corrections noted",
  "(?:approved|rejected) as noted",
  // GC company-name suffixes
  "\\b(?:design and construction|building company|construction (?:company|managers?|group|co\\.|corp|llc|inc)|builders|general contractor)\\b",
  // submitter coversheet + labeled fields. (NOTE: "spec section" is NOT
  // here — manufacturer datasheets routinely print "SPEC SECTION: 10260"
  // referencing the spec they satisfy, so it's not a cover-only signal.)
  "submittal cover\\s?sheet",
  "submittal\\s*(?:no\\.?|number|name)\\s*[:#]",
  // legal disposition boilerplate
  "response to this submittal",
  "change in contract",
].join("|"), "i")

export interface StripPlan {
  /** 1-based first page to strip (inclusive). */
  stripStartPage: number
  /** 1-based last page to strip (inclusive). The Library view shows
   *  pages outside [stripStartPage..stripEndPage]. */
  stripEndPage: number
  /** What anchored the strip:
   *   "stamp"      — an architect /Stamp annotation (bidirectional walk)
   *   "coversheet" — a leading run of submitter-coversheet pages, no stamp
   *                  present (template-agnostic; catches any GC's cover). */
  anchor: "stamp" | "coversheet"
  /** The /Stamp annotation when anchor === "stamp"; null for "coversheet". */
  stamp: ApprovalStampInfo | null
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
 * Compute the strip plan for a PDF — UNIFIED leading-cover-run model
 * (template-agnostic, text-based so logo images don't defeat it).
 *
 * Strip the CONTIGUOUS run of cover pages starting at page 1. A page is a
 * "cover page" when ANY of:
 *   - it has AcroForm form widgets (a fillable coversheet)
 *   - it's blank/near-empty (no text, no image)
 *   - it has a /Stamp annotation AND little text (a disposition/stamp page;
 *     NOT a product page that merely carries a stamp/signature annotation)
 *   - its text matches submittal-cover vocabulary (COVER_VOCAB): GC
 *     transmittal, architect review/disposition stamp, GC company name,
 *     "Submittal Coversheet", labeled submittal/section fields, or legal
 *     disposition boilerplate.
 *
 * Because the run must START at page 1 and is contiguous, a stray /Stamp or
 * signature deep in a product section is NEVER reached — the run already
 * stopped at the first product page. That is the front-matter constraint,
 * automatic: a deep stamp can't drive a strip.
 *
 * Returns null (→ serve original) when:
 *   - page 1 is not a cover page (protects manufacturer datasheets and any
 *     product-first document)
 *   - the strip would leave < 1 page (never empty the doc)
 *   - the PDF can't be parsed (caught by stripFrontMatter)
 *
 * Caller generates a PDF containing pages OUTSIDE
 * [stripStartPage..stripEndPage] (1-based, both inclusive).
 */
export async function findStripPlan(buffer: Buffer): Promise<StripPlan | null> {
  // Architect-stamp date — kept for StripPlan.stamp metadata only; it no
  // longer DRIVES the strip (the leading-cover-run does).
  const stamp = await extractApprovalStampDate(buffer, STAMP_SCAN_PAGES)

  const pdf = await getDocumentProxy(new Uint8Array(buffer))
  const { text } = await extractText(pdf, { mergePages: false })
  const pageTexts = (Array.isArray(text) ? text : [text]) as string[]
  const totalPages = pageTexts.length
  if (totalPages === 0) return null

  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true })
  const meta = await collectPageMeta(doc)
  for (let i = 0; i < meta.length; i++) {
    meta[i].charCount = (pageTexts[i] ?? "").replace(/\s+/g, "").length
  }

  const isCoverPage = (i: number): boolean => {
    const m = meta[i]
    if (m.formWidgetCount > 0) return true
    if (m.charCount < BLANK_PAGE_CHAR_THRESHOLD && m.imageCount === 0) return true
    if (m.stampAnnotCount > 0 && m.charCount < STAMP_PAGE_TEXT_MAX) return true
    return COVER_VOCAB.test(pageTexts[i] ?? "")
  }

  // Page 1 must be a cover page — otherwise serve the original (datasheets,
  // product-first docs).
  if (!isCoverPage(0)) return null

  // Walk the contiguous leading cover run; stop at the first product page.
  let last = 0
  while (
    last + 1 < totalPages &&        // stay in bounds
    last + 1 < MAX_COVER_PAGES &&   // backstop cap
    isCoverPage(last + 1)
  ) {
    last++
  }
  const stripEndPage = last + 1
  if (totalPages - stripEndPage < 1) return null  // never empty the doc

  const stampInRun = stamp && stamp.page <= stripEndPage ? stamp : null
  return {
    stripStartPage: 1,
    stripEndPage,
    anchor: stampInRun ? "stamp" : "coversheet",
    stamp: stampInRun,
    totalPages,
  }
}

/**
 * Compute the bulk-import review-table cover split from the SAME detector the
 * Library strip uses (`findStripPlan` / COVER_VOCAB). The analyze route calls
 * this so the proposed split shown for human confirm matches exactly what
 * on-demand stripping will remove later. This NEVER strips — it only reports
 * the page boundary; all of findStripPlan's guards apply (stop-at-product,
 * never-strip-last-page, bail-if-page-1-has-no-cover).
 *
 *   coverSplit = findStripPlan.stripEndPage (stripStartPage is always 1), i.e.
 *   the count of leading cover pages. 0 when no leading cover run is found
 *   (manufacturer datasheet / product-first doc / strip would empty the doc) —
 *   the review row flags so the user sets the split manually.
 *
 * Never throws — a parse failure surfaces as coverSplit=0 / uncertain.
 */
export async function analyzeCoverSplit(buffer: Buffer): Promise<CoverSplitResult> {
  let plan: StripPlan | null = null
  try {
    plan = await findStripPlan(buffer)
  } catch {
    plan = null
  }
  if (!plan) {
    return {
      coverSplit: 0,
      uncertain: true,
      reason: "No coversheet detected on page 1 — set the split manually if there is front matter to strip.",
    }
  }
  const coverSplit = plan.stripEndPage
  return {
    coverSplit,
    uncertain: false,
    reason: `Coversheet ends after page ${coverSplit}; product content begins page ${coverSplit + 1}.`,
  }
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
