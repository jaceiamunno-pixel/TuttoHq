// Formatting helpers lifted verbatim from dashboard/page.tsx during the module split (Step 0).

const MIME_DOT: Record<string, string> = {
  "application/pdf":                                                            "bg-red-400",
  "application/vnd.google-apps.document":                                      "bg-blue-400",
  "application/vnd.google-apps.spreadsheet":                                   "bg-emerald-400",
  "application/vnd.google-apps.presentation":                                  "bg-amber-400",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":   "bg-blue-400",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":         "bg-emerald-400",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "bg-amber-400",
}

export function getDot(mime: string | null) {
  return (mime && MIME_DOT[mime]) ?? "bg-stone-400"
}

export function fmtDate(iso: string) {
  // A date-only string ("YYYY-MM-DD") carries no time and no zone. `new Date(iso)`
  // parses it as UTC midnight, which then renders one calendar day EARLY in any
  // negative-offset zone (America/New_York → 8pm the prior day). Parse the
  // components and build a LOCAL date so the calendar day is preserved. Full
  // timestamps (they contain a "T") keep the instant-accurate `new Date` path.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(iso)
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

export function fmtDateOnly(d: string) {
  const [y, m, day] = d.split("-").map(Number)
  return new Date(y, m - 1, day).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

export function nextRevision(rev: string): string {
  const n = parseInt(rev)
  if (!isNaN(n)) return String(n + 1)
  if (/^[A-Za-z]$/.test(rev)) return String.fromCharCode(rev.toUpperCase().charCodeAt(0) + 1)
  return ""
}
