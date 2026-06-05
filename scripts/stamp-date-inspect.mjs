// Inspect architect-stamp text on the front matter (typically page 1) of
// committed Waters submittals. Read-only — dumps the first 1500 chars
// per file so we can see what the stamp looks like in the extracted
// text and design a pattern set.

import { createClient } from "@supabase/supabase-js"
import { extractText, getDocumentProxy } from "unpdf"
import { readFileSync } from "node:fs"

const env = readFileSync(".env.local", "utf-8")
for (const line of env.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
  if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "")
}
const a = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const SAMPLES = [
  { id: "Sub 079 Ceramic Tile",       path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/7b25eb00-e55e-4c54-b743-824559af8828_0301-0509_Sub_No_079_Ceramic_Tile.pdf" },
  { id: "Sub 147 NSMF",               path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/24c39197-c9ec-4f19-85bf-08853fd31807_0301-0509_Sub_No_147_NSMF.pdf" },
  { id: "Sub 118 Wall Insulation",    path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/b84ba9a8-a916-47fe-9811-3f9fdb13d410_0301-0509_Sub_No_118_Wall_Insulation.pdf" },
  { id: "Sub 234-R3 Ceramic Tile Sample", path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/245852a2-adfd-4a0c-b011-387a1b3d12cb_0301-0509_Sub_No_234_-R3_Ceramic_Tile_Sample.pdf" },
]

for (const s of SAMPLES) {
  console.log("\n" + "═".repeat(80))
  console.log(s.id)
  console.log("═".repeat(80))
  const { data: blob, error } = await a.storage.from("submittals").download(s.path)
  if (error) { console.log("  download err:", error.message); continue }
  const buffer = Buffer.from(await blob.arrayBuffer())
  const pdf = await getDocumentProxy(new Uint8Array(buffer))
  const { text } = await extractText(pdf, { mergePages: false })
  const pages = Array.isArray(text) ? text : [text]
  console.log("Total pages:", pages.length)
  for (let i = 0; i < Math.min(pages.length, 3); i++) {
    console.log("\n── PAGE " + (i+1) + " (first 1500 chars) ──")
    console.log(pages[i].slice(0, 1500))
  }
}
