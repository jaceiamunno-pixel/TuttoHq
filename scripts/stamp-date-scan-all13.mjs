// Scan all 13 committed Waters PDFs for any extractable architect-stamp
// date. For each PDF, look for stamp vocabulary AND nearby date strings,
// and report whether a recoverable stamp date exists.

import { createClient } from "@supabase/supabase-js"
import { extractText, getDocumentProxy } from "unpdf"
import { readFileSync } from "node:fs"

const env = readFileSync(".env.local", "utf-8")
for (const line of env.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
  if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "")
}
const a = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const ROWS = [
  { sub: "079",       sec: "09 31 00 PD", path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/7b25eb00-e55e-4c54-b743-824559af8828_0301-0509_Sub_No_079_Ceramic_Tile.pdf" },
  { sub: "234-R3",    sec: "09 31 00 SA", path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/245852a2-adfd-4a0c-b011-387a1b3d12cb_0301-0509_Sub_No_234_-R3_Ceramic_Tile_Sample.pdf" },
  { sub: "118",       sec: "07 21 00 PD", path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/b84ba9a8-a916-47fe-9811-3f9fdb13d410_0301-0509_Sub_No_118_Wall_Insulation.pdf" },
  { sub: "147",       sec: "09 22 16 PD", path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/24c39197-c9ec-4f19-85bf-08853fd31807_0301-0509_Sub_No_147_NSMF.pdf" },
  { sub: "030-R1",    sec: "08 11 13 PD", path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/2fe7d076-60f7-49c8-8675-b990759bdd07_0301-0509_Sub_No_030-R1_Frame_and_Door_Schedule.pdf" },
  { sub: "031-R1",    sec: "08 71 00 PD", path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/88281a82-fdb1-43a5-8faa-acdda1533bdd_0301-0509_Sub_No_031-R1_Hardware_Schedule.pdf" },
  { sub: "032-R1",    sec: "09 51 23 PD", path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/94e5e586-ac34-4565-8a5f-8b431694ace2_0301-0509_Sub_No_032-R1_Acoustical_Tile_Ceilings.pdf" },
  { sub: "160",       sec: "09 51 23 SA", path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/982de79b-1c98-43fc-b4d9-1dbf01d5163d_0301-0509_Sub_No_160_Aco._Tile_and_Grid_Sample__1_.pdf" },
  { sub: "078",       sec: "09 65 13 PD", path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/32c2f92c-277a-41d6-a0db-3a639c4af76f_0301-0509_Sub_No_078_Resilient_Base_and_Access.pdf" },
  { sub: "370",       sec: "09 65 19 SA", path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/3af77982-fc0e-429e-bece-d3c0ca448a34_0301-0509_Sub_No_370_Flooring_Sample_III.pdf" },
  { sub: "077",       sec: "09 67 23 PD", path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/cccd4ac3-a01d-4573-9912-e8020894ff8b_0301-0509_Sub_No_077_Flooring.pdf" },
  { sub: "158",       sec: "09 67 23 SA", path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/bf6823cc-c148-4231-ab74-9fecf129b475_0301-0509_Sub_No_158_Flooring_Sample.pdf" },
  { sub: "260",       sec: "10 51 13 PD", path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/29dfa311-fb53-4b41-ad45-d159e7fcd473_0301-0509_Sub_No_260_SWP_Inst_Lockers.pdf" },
]

// What we want to detect: a stamp action ("Approved", "Approved as Noted",
// "Exceptions Noted", "Returned for corrections", "Revise and Resubmit",
// "Not Approved") immediately FOLLOWED BY a date — that's an architect's
// returned-stamp signature. Submission templates have these words as
// CHECKBOX LABELS without an adjacent date — those should NOT match.
const STAMP_ACTIONS = "(?:Approved(?:\\s+as\\s+(?:Submitted|Noted))?|Exceptions\\s+Noted|Returned\\s+(?:for\\s+(?:corrections|Resubmit)|Without\\s+Review)?|Revise\\s+and\\s+Resubmit|Not\\s+Approved|Reviewed)"
const DATE_PATTERN  = "(\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}\\s+[A-Za-z]{3,9}\\s+\\d{4}|[A-Za-z]{3,9}\\s+\\d{1,2},?\\s+\\d{4})"

// Action immediately followed by a date (within ~30 chars of intervening
// punctuation/whitespace) — the architect-stamp shape.
const STAMP_DATE_RE = new RegExp(`\\b${STAMP_ACTIONS}\\b[^A-Za-z0-9]{0,30}${DATE_PATTERN}`, "gi")
// Also detect "date" preceded by stamp action label ("Returned on:", "Approved Date:", etc.)
const STAMP_LABEL_DATE_RE = new RegExp(`\\b${STAMP_ACTIONS}\\b[^A-Za-z0-9\\n]{0,5}(?:on|date)?[^A-Za-z0-9\\n]{0,10}${DATE_PATTERN}`, "gi")

console.log("Scanning 13 committed Waters PDFs for architect-stamp dates…\n")

const results = []
for (const r of ROWS) {
  const { data: blob, error } = await a.storage.from("submittals").download(r.path)
  if (error) { results.push({ ...r, stampDate: null, error: error.message }); continue }
  const buffer = Buffer.from(await blob.arrayBuffer())
  const pdf = await getDocumentProxy(new Uint8Array(buffer))
  const { text } = await extractText(pdf, { mergePages: false })
  const pages = Array.isArray(text) ? text : [text]
  const fullText = pages.join("\n")
  const m1 = [...fullText.matchAll(STAMP_DATE_RE)]
  const m2 = [...fullText.matchAll(STAMP_LABEL_DATE_RE)]
  const hits = [...m1, ...m2]
  results.push({ ...r, pageCount: pages.length, hits })
}

console.log("════════════════════════════════════════════════════════════════════════════")
console.log("PER-FILE RESULT")
console.log("════════════════════════════════════════════════════════════════════════════")
let withStamp = 0, withoutStamp = 0
for (const r of results) {
  if (r.error) { console.log(`  Sub#${r.sub.padEnd(8)} ${r.sec}  download error: ${r.error}`); continue }
  if (r.hits.length === 0) {
    withoutStamp++
    console.log(`  Sub#${r.sub.padEnd(8)} ${r.sec}  ${r.pageCount}p  →  NO STAMP DATE FOUND`)
  } else {
    withStamp++
    console.log(`  Sub#${r.sub.padEnd(8)} ${r.sec}  ${r.pageCount}p  →  STAMP HITS:`)
    for (const h of r.hits.slice(0, 3)) console.log(`     "${h[0].slice(0, 120).replace(/\s+/g, " ")}"`)
  }
}
console.log("\n────────── SUMMARY ──────────")
console.log("With recoverable stamp date:    ", withStamp, "/", results.length)
console.log("Without recoverable stamp date: ", withoutStamp, "/", results.length)
