// Sanitize arbitrary user text so it can be drawn with pdf-lib's WinAnsi
// StandardFonts (Helvetica / Helvetica-Bold). Those fonts encode text as cp1252,
// and BOTH page.drawText() AND font.widthOfTextAtSize() THROW on any glyph
// cp1252 can't represent — emoji, CJK, ✓, stray C1 control bytes, etc. User text
// flows into every generated PDF (RFI descriptions, daily-report field notes —
// phone-typed, so emoji are routine — CO proposals, punch notes, photo captions
// derived from filenames), so a single un-encodable character would 500 the
// whole document with a bare error. Map the common typographic characters down
// to ASCII and drop anything still outside Latin-1.
//
// Apply this ONLY to text drawn with a StandardFont. Custom fonts embedded via
// fontkit (e.g. the Source Serif 4 subset in pdf-doc.ts) encode any codepoint —
// unsupported glyphs become .notdef and never throw — so they keep their richer
// punctuation and must NOT be sanitized.
//
// Extracted from the original local copy in drawing-markup-export.ts, with two
// corrections: newlines are PRESERVED (paragraph splitting depends on "\n"), and
// the DEL + C1 control range (\x7F–\x9F) is dropped too (WinAnsi can't encode it).

/** Common non-Latin-1 typographic characters → their ASCII equivalents. */
const SMART: Record<string, string> = {
  "‘": "'", "’": "'",   // ‘ ’  single curly quotes
  "“": '"', "”": '"',   // “ ”  double curly quotes
  "–": "-", "—": "-",   // – —  en / em dash
  "…": "...",                // …    ellipsis
  "•": "-",                  // •    bullet
}

/**
 * Make `s` safe to draw with a WinAnsi StandardFont. Newlines are PRESERVED
 * (callers split paragraphs on "\n"); every other whitespace run (tabs, nbsp,
 * and the gaps left where un-encodable glyphs are dropped) collapses to a single
 * space. Smart punctuation maps to ASCII; the DEL/C1 controls and everything
 * outside printable Latin-1 are dropped. Idempotent (the space-collapse runs
 * last, after the drops, so re-running is a no-op).
 */
export function sanitizeWinAnsi(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")                    // CRLF / lone CR → LF (kept as a newline)
    .replace(/[^\S\n]/g, " ")                   // any other whitespace (tab, nbsp, …) → space
    .replace(/[‘’“”–—…•]/g, (c) => SMART[c] ?? "") // smart punctuation → ASCII
    .replace(/[\x7F-\x9F]/g, "")                // DEL + C1 controls — WinAnsi can't encode these
    .replace(/[^\n\x20-\xFF]/g, "")             // drop anything else outside printable Latin-1
    .replace(/ +/g, " ")                        // collapse the space runs the two drops can leave
}
