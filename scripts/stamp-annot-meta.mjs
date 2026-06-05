// Extract every field on every /Stamp annotation across the first 4
// pages of all 13 committed Waters PDFs. Looking for /CreationDate
// and /M (modification date) — PDF-spec dates that often carry the
// architect's stamp-application date. Also /Subj (disposition like
// "Approved as Noted"), /T (annotator name).
//
// PDF date string format: "D:YYYYMMDDHHmmSSOHH'mm'"
//
// READ-ONLY.

import { createClient } from "@supabase/supabase-js"
import { PDFDocument, PDFDict, PDFArray } from "pdf-lib"
import { readFileSync } from "node:fs"

const env = readFileSync(".env.local", "utf-8")
for (const line of env.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
  if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "")
}
const a = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const ROWS = [
  { sub: "079",       path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/7b25eb00-e55e-4c54-b743-824559af8828_0301-0509_Sub_No_079_Ceramic_Tile.pdf" },
  { sub: "234-R3",    path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/245852a2-adfd-4a0c-b011-387a1b3d12cb_0301-0509_Sub_No_234_-R3_Ceramic_Tile_Sample.pdf" },
  { sub: "118",       path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/b84ba9a8-a916-47fe-9811-3f9fdb13d410_0301-0509_Sub_No_118_Wall_Insulation.pdf" },
  { sub: "147",       path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/24c39197-c9ec-4f19-85bf-08853fd31807_0301-0509_Sub_No_147_NSMF.pdf" },
  { sub: "030-R1",    path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/2fe7d076-60f7-49c8-8675-b990759bdd07_0301-0509_Sub_No_030-R1_Frame_and_Door_Schedule.pdf" },
  { sub: "031-R1",    path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/88281a82-fdb1-43a5-8faa-acdda1533bdd_0301-0509_Sub_No_031-R1_Hardware_Schedule.pdf" },
  { sub: "032-R1",    path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/94e5e586-ac34-4565-8a5f-8b431694ace2_0301-0509_Sub_No_032-R1_Acoustical_Tile_Ceilings.pdf" },
  { sub: "160",       path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/982de79b-1c98-43fc-b4d9-1dbf01d5163d_0301-0509_Sub_No_160_Aco._Tile_and_Grid_Sample__1_.pdf" },
  { sub: "078",       path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/32c2f92c-277a-41d6-a0db-3a639c4af76f_0301-0509_Sub_No_078_Resilient_Base_and_Access.pdf" },
  { sub: "370",       path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/3af77982-fc0e-429e-bece-d3c0ca448a34_0301-0509_Sub_No_370_Flooring_Sample_III.pdf" },
  { sub: "077",       path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/cccd4ac3-a01d-4573-9912-e8020894ff8b_0301-0509_Sub_No_077_Flooring.pdf" },
  { sub: "158",       path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/bf6823cc-c148-4231-ab74-9fecf129b475_0301-0509_Sub_No_158_Flooring_Sample.pdf" },
  { sub: "260",       path: "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/29dfa311-fb53-4b41-ad45-d159e7fcd473_0301-0509_Sub_No_260_SWP_Inst_Lockers.pdf" },
]

function parsePdfDate(raw) {
  if (!raw) return null
  // Strip "D:" prefix and parens. Format: "D:YYYYMMDDHHmmSS..."
  const s = String(raw).replace(/^\(D:|^D:|\)$/g, "").replace(/['"]/g, "")
  const m = s.match(/^(\d{4})(\d{2})(\d{2})/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}

function dictGet(dict, key) {
  return dict?.get?.(dict.context.obj(key))
}

const results = []
for (const r of ROWS) {
  const { data: blob, error } = await a.storage.from("submittals").download(r.path)
  if (error) { results.push({ ...r, err: error.message }); continue }
  const buffer = Buffer.from(await blob.arrayBuffer())
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false })
  const pages = doc.getPages()
  const stamps = []
  for (let p = 0; p < Math.min(pages.length, 4); p++) {
    const annotsRef = pages[p].node.get(doc.context.obj("Annots"))
    if (!annotsRef) continue
    const annots = doc.context.lookup(annotsRef)
    if (!(annots instanceof PDFArray)) continue
    for (let i = 0; i < annots.size(); i++) {
      const annot = doc.context.lookup(annots.get(i))
      if (!(annot instanceof PDFDict)) continue
      const subtype = annot.get(doc.context.obj("Subtype"))?.toString?.() ?? "?"
      if (subtype !== "/Stamp") continue
      const subj    = annot.get(doc.context.obj("Subj"))?.toString?.()
      const t       = annot.get(doc.context.obj("T"))?.toString?.()
      const name    = annot.get(doc.context.obj("Name"))?.toString?.()
      const createD = annot.get(doc.context.obj("CreationDate"))?.toString?.()
      const modD    = annot.get(doc.context.obj("M"))?.toString?.()
      stamps.push({ page: p + 1, subj, t, name, creationDate: parsePdfDate(createD), modDate: parsePdfDate(modD), rawCreation: createD, rawMod: modD })
    }
  }
  results.push({ ...r, stamps })
}

console.log("Sub# | page | author (/T)             | stamp name (/Name)                  | created    | modified   | subject")
console.log("-----+------+-------------------------+-------------------------------------+------------+------------+------------------")
for (const r of results) {
  if (r.err) { console.log(`${r.sub.padEnd(8)} ERROR: ${r.err}`); continue }
  if (r.stamps.length === 0) {
    console.log(`${r.sub.padEnd(7)} | (no Stamp annotations on pages 1-4)`)
    continue
  }
  for (const s of r.stamps) {
    console.log(`${r.sub.padEnd(7)} | ${String(s.page).padEnd(4)} | ${String(s.t ?? "").slice(0,23).padEnd(23)} | ${String(s.name ?? "").slice(0,35).padEnd(35)} | ${(s.creationDate ?? "-").padEnd(10)} | ${(s.modDate ?? "-").padEnd(10)} | ${String(s.subj ?? "").slice(0,40)}`)
  }
}
