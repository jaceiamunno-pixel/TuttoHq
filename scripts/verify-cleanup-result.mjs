// scripts/verify-cleanup-result.mjs — READ-ONLY post-cleanup verification.
import { readFileSync } from "node:fs"
import pg from "pg"
import { createClient } from "@supabase/supabase-js"

const env = readFileSync(".env.local", "utf-8")
for (const line of env.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
  if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "")
}
const client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } })
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
await client.connect()

// 1. Dupe groups remaining (same-submittal)
const { rows: dupeGroups } = await client.query(`
  SELECT submittal_id, file_sha256, revision_label, COUNT(*) AS n
  FROM submittal_attachments
  WHERE file_sha256 IS NOT NULL
  GROUP BY submittal_id, file_sha256, revision_label
  HAVING COUNT(*) >= 2
`)
console.log(`1. Same-submittal dupe groups remaining: ${dupeGroups.length} ${dupeGroups.length === 0 ? "✓" : "✗"}`)
if (dupeGroups.length) console.log(JSON.stringify(dupeGroups, null, 2))

// 2. Every active submittal that HAS attachments has exactly one current
const { rows: currentCounts } = await client.query(`
  SELECT s.id, s.submittal_seq,
         COUNT(*) FILTER (WHERE sa.is_current) AS current_count,
         COUNT(*) AS total_attachments
  FROM submittals s
  JOIN submittal_attachments sa ON sa.submittal_id = s.id
  WHERE s.status <> 'deleted'
  GROUP BY s.id, s.submittal_seq
`)
const withAttachments = currentCounts.length
const exactlyOne = currentCounts.filter(r => Number(r.current_count) === 1).length
const bad = currentCounts.filter(r => Number(r.current_count) !== 1)
console.log(`2. Submittals with attachments: ${withAttachments}; exactly-one-current: ${exactlyOne} ${bad.length === 0 ? "✓" : "✗"}`)
if (bad.length) console.log("   OFFENDERS:", JSON.stringify(bad, null, 2))

// 3. The 13 storage objects are gone
const removed = [
  "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/613f87d7-ee0c-4f83-b446-64347920c722_0301-0509_Sub_No_078_Resilient_Base_and_Access.pdf",
  "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/2186da4c-bf3a-4e17-bace-13d519fbf87d_0301-0509_Sub_No_032-R1_Acoustical_Tile_Ceilings.pdf",
  "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/ad611bd9-9e60-48a9-b468-5426b8cc0a45_0301-0509_Sub_No_031-R1_Hardware_Schedule.pdf",
  "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/77c90a16-bb46-45cf-a902-490ae84796c3_0301-0509_Sub_No_079_Ceramic_Tile.pdf",
  "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/dbae62f6-617c-4a3d-b6a7-e5c38892c0cd_0301-0509_Sub_No_146_Metal_Lockers.pdf",
  "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/9a2d77c3-2759-469b-9b5f-bd5a7ec09d58_0301-0509_Sub_No_077_Flooring.pdf",
  "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/88c01165-7ce3-4a8d-bee6-772a0ef5c628_0301-0509_Sub_No_030-R1_Frame_and_Door_Schedule.pdf",
  "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/fa8a4f4f-728f-4763-a1dc-82462697432f_0301-0509_Sub_No_234_-R2_Ceramic_Tile_Sample.pdf",
  "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/25c286de-2d00-4a4c-b713-b6df911e58a9_0301-0509_Sub_No_118_Wall_Insulation.pdf",
  "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/4f7f3f48-b6ce-4290-9a41-4b1a6894e4cc_0301-0509_Sub_No_147_NSMF.pdf",
  "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/0c20e165-869b-4440-b3ed-742ca6e4f5b9_0301-0509_Sub_No_160_Aco._Tile_and_Grid_Sample__1_.pdf",
  "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/55732f4f-edcd-4ac4-87f6-75d4796beab9_0301-0509_Sub_No_370_Flooring_Sample_III.pdf",
  "c7c08273-8d0a-40fd-8f67-b712955eeb47/uploads/dff4dc97-fc74-4b48-8145-5a431e3acc73_0301-0509_Sub_No_158_Flooring_Sample.pdf",
]
let gone = 0, present = 0
for (const path of removed) {
  const dir = path.substring(0, path.lastIndexOf("/"))
  const name = path.substring(path.lastIndexOf("/") + 1)
  const { data, error } = await sb.storage.from("submittals").list(dir, { search: name, limit: 100 })
  const found = !error && data && data.some(o => o.name === name)
  if (found) { present++; console.log(`   STILL PRESENT: ${path}`) } else gone++
}
console.log(`3. Removed storage objects confirmed gone: ${gone}/13 ${gone === 13 ? "✓" : "✗ (" + present + " still present)"}`)

// 4. Total attachment count sanity
const { rows: [{ n: totalAtt }] } = await client.query(`SELECT COUNT(*)::int AS n FROM submittal_attachments`)
console.log(`4. Total submittal_attachments rows now: ${totalAtt} (was 47 pre-cleanup → expect 34)`)

await client.end()
