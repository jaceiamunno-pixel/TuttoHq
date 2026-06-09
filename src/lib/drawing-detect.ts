// Pure detection for the Drawing Log splitter (ADR-005 Subsystem 1).
//
// NO I/O, NO pdf.js/unpdf import — operates on positioned text items the
// caller extracts (unpdf `getDocumentProxy` → `page.getTextContent()` + the
// page viewport transform applied to each item's transform[4],[5]). Kept pure
// so it unit-tests without a PDF and runs identically client- or server-side.
//
// Validated against the real 19-page Church of Scientology structural+arch
// addendum: 19/19 sheet numbers correct (page-1 S-001 NOT mis-read as the
// notes wall; DM-101 → prefix 'DM' not 'D'); revision "Addendum #1" captured;
// 17/19 titles via the narrowed titleblock-cell payload (2 blank → flagged for
// manual entry, never dropped).

export interface PositionedItem {
  /** Text run content (pdf.js item.str). */
  str: string
  /** Device-space coords, origin TOP-LEFT. The caller computes these by
   *  applying the pdf.js viewport.transform to item.transform[4],[5] so the
   *  region tests below are rotation-independent. */
  x: number
  y: number
}

export interface PageGeom {
  width: number
  height: number
}

/** Raw discipline-prefix → human discipline. The RAW prefix is always stored
 *  verbatim (ADR-005); the derived label is null when the prefix isn't mapped
 *  (the row then flags for confirm — faithful, never guessed). */
export const DISCIPLINE_MAP: Record<string, string> = {
  A: "Architectural", S: "Structural", M: "Mechanical", E: "Electrical",
  P: "Plumbing", C: "Civil", FP: "Fire Protection", DM: "Demolition",
  L: "Landscape", G: "General", T: "Telecom",
}

/** Standard sheet-number token: 1-3 leading letters, optional dash, 1-3
 *  digits, optional .decimal, optional trailing letter. e.g. S-001, DM-101,
 *  A2.1, S2.02, E201A. Anchored so notes fragments never match. */
const SHEET_RE = /^[A-Z]{1,3}-?\d{1,3}(?:\.\d+)?[A-Z]?$/

/** Leading alpha run = the raw discipline prefix. Taking the WHOLE run (not a
 *  greedy single letter) makes multi-char prefixes fall out for free:
 *  'DM-101' → 'DM' (never 'D'); 'FP-2' → 'FP'. */
export function prefixOf(sheetNumber: string): string | null {
  const m = sheetNumber.match(/^([A-Z]+)/)
  return m ? m[1] : null
}

export function deriveDiscipline(prefix: string | null): string | null {
  return prefix && DISCIPLINE_MAP[prefix] ? DISCIPLINE_MAP[prefix] : null
}

export interface SheetNumberResult {
  /** Raw sheet number, whitespace removed, verbatim, or null. */
  sheetNumber: string | null
  /** Raw discipline prefix verbatim (e.g. 'S','DM','A'), or null. */
  prefix: string | null
  /** Derived human discipline, or null when the prefix isn't mapped. */
  discipline: string | null
}

/**
 * Detect the sheet number from the LOWER-RIGHT titleblock region BY POSITION —
 * never "the biggest token on the page". This avoids the page-1 trap where a
 * notes-heavy sheet (S-001 GENERAL NOTES) would otherwise yield a fragment of
 * the notes; the real sheet id sits in the bottom-right titleblock cell.
 *
 * Candidates are ranked closest to the bottom-right corner (max x+y in device
 * space). Adjacent same-line runs are also concatenated so a split
 * "S-" + "001" is recovered.
 */
export function detectSheetNumber(items: PositionedItem[], geom: PageGeom): SheetNumberResult {
  const { width: W, height: H } = geom
  const corner = items.filter(i => i.x > W * 0.6 && i.y > H * 0.6)

  const cands: { sn: string; x: number; y: number }[] = []
  for (const i of corner) {
    const s = i.str.trim()
    if (SHEET_RE.test(s)) cands.push({ sn: s, x: i.x, y: i.y })
  }
  // Concatenate adjacent runs on the same line ("S-" + "001" → "S-001").
  const byLine = new Map<number, PositionedItem[]>()
  for (const i of corner) {
    const k = Math.round(i.y / 4)
    const arr = byLine.get(k) ?? []
    arr.push(i)
    byLine.set(k, arr)
  }
  for (const arr of byLine.values()) {
    const line = arr.slice().sort((a, b) => a.x - b.x)
    const joined = line.map(i => i.str.trim()).join("")
    if (SHEET_RE.test(joined)) {
      cands.push({ sn: joined, x: line[line.length - 1].x, y: line[0].y })
    }
  }

  cands.sort((a, b) => (b.x + b.y) - (a.x + a.y))
  const sheetNumber = cands.length ? cands[0].sn.replace(/\s+/g, "") : null
  const prefix = sheetNumber ? prefixOf(sheetNumber) : null
  return { sheetNumber, prefix, discipline: deriveDiscipline(prefix) }
}

export interface RevisionResult {
  label: string
  source: "titleblock" | "filename" | "fallback"
}

const REVISION_PATTERNS: RegExp[] = [
  /Addendum\s*#?\s*\d+/i,
  /\bADD\s*[-_ ]?\s*\d+\b/i,
  /\bRev(?:ision)?\.?\s*#?\s*\d+\b/i,
  /\bS\d+-\d+\b/,          // sheet-issue label like "S3-1"
  /Δ\s*\d+/,
]

/**
 * Dual-source revision label: titleblock text first, then filename, else a
 * "Rev 0" fallback. v1 captures the label for the FIRST revision only — it
 * never acts on cross-upload matching (that is subsystem 4; every upload here
 * is treated as new sheets).
 */
export function detectRevision(titleblockText: string, fileName: string): RevisionResult {
  for (const p of REVISION_PATTERNS) {
    const m = titleblockText.match(p)
    if (m) return { label: m[0].trim().replace(/\s+/g, " "), source: "titleblock" }
  }
  for (const p of REVISION_PATTERNS) {
    const m = (fileName || "").match(p)
    if (m) return { label: m[0].trim().replace(/\s+/g, " "), source: "filename" }
  }
  return { label: "Rev 0", source: "fallback" }
}

/** Titleblock furniture words that are never a sheet title. */
const TITLE_STOPWORD_RE =
  /^(SCALE|DATE|PROJECT|DRAWN|CHECK(?:ED)?|SHEET|REV(?:ISION)?|NO\.?|OF|BY|JOB|FILE|PLOT|ISSUED?|APPROV)/i

/**
 * Build the small text payload sent to the title model — the BOTTOM-RIGHT
 * titleblock CELL only (far-right column `x>0.80W`, bottom band `y>0.62H`).
 * This deliberately EXCLUDES the wide "DRAWING NOTES" callout column the
 * earlier right-strip (x>0.70W) swept in, which produced "DRAWING
 * NOTES"/null titles on 8/19 sheets. Drops the detected sheet number, pure
 * numeric tokens (scales/dates), and titleblock furniture so the model
 * receives just the descriptive name lines.
 *
 * Re-run result on the 19-page file: 17/19 correct titles (was ~7/19); the
 * 2 remaining blanks flag for manual entry (never dropped).
 */
export function titleblockPayload(
  items: PositionedItem[],
  geom: PageGeom,
  sheetNumber: string | null,
): string {
  const { width: W, height: H } = geom
  return items
    .filter(i => i.x > W * 0.80 && i.y > H * 0.62)
    .sort((a, b) => (a.y - b.y) || (a.x - b.x))
    .map(i => i.str.trim())
    .filter(s =>
      s.length > 2 &&
      s !== sheetNumber &&
      !/^[\d.\/-]+$/.test(s) &&        // pure numbers / dates / scales
      !TITLE_STOPWORD_RE.test(s),
    )
    .join(" | ")
}
