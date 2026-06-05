// scripts/test-strip-part2.mjs — READ-ONLY.
// Validates the Part 2 strip logic (stamp-anchored + NEW coversheet-anchored)
// faithfully replicating src/lib/pdf-strip.ts. Runs on BOTH:
//   - the 4 non-Waters batch coversheet files (no /Stamp, has widgets)
//   - the Waters /Stamp files (regression: must still strip)
// Reports per file: anchor, strip page range, and the first KEPT page's text
// so we can confirm it's real product content (not a clipped content page).

import { readFileSync } from "node:fs"
import pg from "pg"
import { createClient } from "@supabase/supabase-js"
import { PDFDocument, PDFDict, PDFArray, PDFName } from "pdf-lib"
import { extractText, getDocumentProxy } from "unpdf"

const env = readFileSync(".env.local", "utf-8")
for (const line of env.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
  if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "")
}
const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } })
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
await c.connect()

const BLANK = 10, STAMP_SCAN = 6
const COVER_KEYWORDS = /Letter of Transmittal|Submittal Transmittal|Transmittal Form|Transmittal No|For Approval|For Review|Approved as Noted|No Exceptions Taken|Revise and Resubmit|Make Corrections Noted|Rejected as Noted|Reviewed for Conformance|Shop Drawing|Date Received|Specification Section|Spec Section/i

function parsePdfDate(raw){ if(!raw)return null; const s=String(raw).replace(/^\(D:|^D:|\)$/g,'').replace(/['"]/g,''); const m=s.match(/^(\d{4})(\d{2})(\d{2})/); return m?`${m[1]}-${m[2]}-${m[3]}`:null }
function isCoverShaped(m,t){ if(m.formWidgetCount>0)return true; if(m.stampAnnotCount>0)return true; if(m.charCount<BLANK&&m.imageCount===0)return true; if(m.imageCount===0&&COVER_KEYWORDS.test(t))return true; return false }
function isStructuralCover(m){ if(m.formWidgetCount>0)return true; if(m.stampAnnotCount>0)return true; if(m.charCount<BLANK&&m.imageCount===0)return true; return false }

async function plan(buffer){
  const doc=await PDFDocument.load(buffer,{ignoreEncryption:true,throwOnInvalidObject:false,updateMetadata:false})
  const pages=doc.getPages()
  // stamp anchor
  let stamp=null
  for(let p=0;p<Math.min(pages.length,STAMP_SCAN);p++){
    const aref=pages[p].node.get(doc.context.obj('Annots')); if(!aref)continue
    const an=doc.context.lookup(aref); if(!(an instanceof PDFArray))continue
    for(let i=0;i<an.size();i++){const a=doc.context.lookup(an.get(i));if(!(a instanceof PDFDict))continue;if((a.get(doc.context.obj('Subtype'))?.toString?.()??'')!=='/Stamp')continue;const d=parsePdfDate(a.get(doc.context.obj('CreationDate'))?.toString?.());const info={page:p+1,date:d??'9999-99-99'};if(!stamp||info.date<stamp.date)stamp=info}
  }
  const pdf=await getDocumentProxy(new Uint8Array(buffer))
  const { text }=await extractText(pdf,{mergePages:false})
  const pageTexts=Array.isArray(text)?text:[text]
  const total=pages.length
  const meta=[]
  for(let p=0;p<total;p++){
    let fw=0,sa=0,img=0
    const aref=pages[p].node.get(doc.context.obj('Annots'))
    if(aref){const an=doc.context.lookup(aref);if(an instanceof PDFArray)for(let i=0;i<an.size();i++){const a=doc.context.lookup(an.get(i));if(!(a instanceof PDFDict))continue;const s=a.get(doc.context.obj('Subtype'))?.toString?.()??'';if(s==='/Widget')fw++;else if(s==='/Stamp')sa++}}
    const res=pages[p].node.Resources?.()
    if(res){const xr=res.get(doc.context.obj('XObject'));const xo=xr?doc.context.lookup(xr):null;if(xo instanceof PDFDict)for(const[,ref]of xo.entries()){const o=doc.context.lookup(ref);const st=o?.dict?.get?.(doc.context.obj('Subtype'));if(st instanceof PDFName&&st.toString()==='/Image')img++}}
    meta.push({formWidgetCount:fw,stampAnnotCount:sa,imageCount:img,charCount:(pageTexts[p]??'').replace(/\s+/g,'').length})
  }
  const FORM_SCAN=5
  let res
  if(stamp){
    const si=stamp.page-1
    let fc=si; while(fc-1>=0&&isCoverShaped(meta[fc-1],pageTexts[fc-1]??''))fc--
    let lc=si; while(lc+1<total&&isCoverShaped(meta[lc+1],pageTexts[lc+1]??''))lc++
    const start=fc+1,end=lc+1
    if(total-(end-start+1)<=0)res=null; else res={start,end,anchor:'stamp',total}
  } else {
    let formIdx=-1
    for(let p=0;p<Math.min(total,FORM_SCAN);p++){ if(meta[p].formWidgetCount>0){formIdx=p;break} }
    if(formIdx>=0){
      let lc=formIdx; while(lc+1<total&&isCoverShaped(meta[lc+1],pageTexts[lc+1]??''))lc++
      const end=lc+1; if(total-end<=0)res=null; else res={start:1,end,anchor:'coversheet(form)',total}
    } else if(isStructuralCover(meta[0])){
      let lc=0; while(lc+1<total&&isCoverShaped(meta[lc+1],pageTexts[lc+1]??''))lc++
      const end=lc+1; if(total-end<=0)res=null; else res={start:1,end,anchor:'coversheet(blank)',total}
    } else res=null
  }
  return { res, pageTexts, meta, total }
}

async function run(label, storage_path){
  console.log('\n'+'═'.repeat(76)); console.log(label)
  const { data: blob, error }=await sb.storage.from('submittals').download(storage_path)
  if(error||!blob){ console.log('  ✗ download failed (file may have been detached/deleted):', error?.message); return }
  const buffer=Buffer.from(await blob.arrayBuffer())
  const { res, pageTexts, total }=await plan(buffer)
  console.log(`  pages=${total}  size=${(buffer.length/1e6).toFixed(1)}MB`)
  if(!res){ console.log('  → NO STRIP (no anchor / content-bail / would-empty) → original served'); return }
  const remaining=total-(res.end-res.start+1)
  console.log(`  → anchor=${res.anchor}  STRIP pages ${res.start}-${res.end}  (${res.end-res.start+1} removed, ${remaining} kept)`)
  const firstKeptIdx = res.start===1 ? res.end : 0   // 0-based first kept page
  const snip=(pageTexts[firstKeptIdx]??'').replace(/\s+/g,' ').trim().slice(0,150)
  console.log(`  first KEPT page = p${firstKeptIdx+1}: ${snip||'(no extractable text — likely image/drawing page)'}`)
}

// Resolve test files. Batch 4 by id; Waters /Stamp + Metal Lockers by lookup.
const batch=['3ef32323-d156-4c8c-adbf-674087a2520e','56ad9adf-9173-4aa5-9898-ab8d5870551b','3c71cf60-3c58-487e-913f-86f7a7aa7b6a','c13e4bd0-74f5-42aa-a8f1-e118b4d35233']
console.log('################ NON-WATERS BATCH (coversheet, no /Stamp) ################')
for(const id of batch){
  const r=await c.query('SELECT left(file_name,40) nm, storage_path FROM submittals WHERE id=$1',[id])
  if(r.rows[0]?.storage_path) await run('BATCH · '+r.rows[0].nm, r.rows[0].storage_path)
  else console.log('\n'+id+' — no storage_path (detached?)')
}

console.log('\n\n################ /STAMP REGRESSION (must still strip) ################')
// Any current file carrying a /Stamp: spec attachments (Waters) + direct
// uploads like the just-uploaded Metal Lockers (lives on submittals, not
// submittal_attachments). Union both sources.
const stampCandidates = await c.query(`
  SELECT storage_path, nm FROM (
    SELECT sa.storage_path, left(s.file_name,40) nm, sa.uploaded_at AS ts
    FROM submittal_attachments sa JOIN submittals s ON s.id=sa.submittal_id AND s.status<>'deleted'
    WHERE sa.storage_path LIKE '%Sub_No_147%' OR sa.storage_path LIKE '%Sub_No_079%' OR sa.storage_path LIKE '%Sub_No_234%'
    UNION ALL
    SELECT s.storage_path, left(s.file_name,40) nm, s.created_at AS ts
    FROM submittals s
    WHERE s.status<>'deleted' AND s.storage_path IS NOT NULL
      AND (s.file_name ILIKE '%Metal Locker%' OR s.storage_path LIKE '%Metal_Lockers%' OR s.storage_path LIKE '%NSMF%' OR s.storage_path LIKE '%Ceramic_Tile%')
  ) u ORDER BY ts DESC LIMIT 10`)
if(stampCandidates.rows.length===0) console.log('  (no /Stamp files currently available — Waters spec files detached this session)')
const seen=new Set()
for(const w of stampCandidates.rows){ if(seen.has(w.storage_path))continue; seen.add(w.storage_path); await run('STAMP · '+w.nm, w.storage_path) }

await c.end()
