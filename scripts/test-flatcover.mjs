// scripts/test-flatcover.mjs — READ-ONLY.
// Replicates the UNIFIED findStripPlan (leading-cover-run) across recent
// uploads + the Metal Lockers /Stamp file, reporting per-file:
//   strip range, anchor, first KEPT page text (must be product).
// Checks: C-S datasheet → NO-STRIP; Shepley 4-pg → 1-4 keep p5;
// Metal Lockers stamp → still strips; image covers → untouched.

import { readFileSync } from "node:fs"
import pg from "pg"
import { createClient } from "@supabase/supabase-js"
import { PDFDocument, PDFDict, PDFArray, PDFName } from "pdf-lib"
import { extractText, getDocumentProxy } from "unpdf"

const env = readFileSync(".env.local", "utf-8")
for (const line of env.split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "") }
const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } })
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
await c.connect()

const BLANK = 10, STAMP_TEXT_MAX = 600, MAX_COVER = 6
const COVER_VOCAB = new RegExp([
  "letter of transmittal","submittal transmittal","transmittal (?:form|sheet|cover|no\\.?|#)","we are (?:sending|transmitting|forwarding)",
  "submittal review stamp","for your (?:approval|review)\\b","reviewed (?:for|by)\\b","no exceptions taken","revise and resubmit","make corrections noted","(?:approved|rejected) as noted",
  "\\b(?:design and construction|building company|construction (?:company|managers?|group|co\\.|corp|llc|inc)|builders|general contractor)\\b",
  "submittal cover\\s?sheet","submittal\\s*(?:no\\.?|number|name)\\s*[:#]",
  "response to this submittal","change in contract",
].join("|"), "i")

async function plan(buf){
  const doc=await PDFDocument.load(buf,{ignoreEncryption:true,throwOnInvalidObject:false,updateMetadata:false})
  const pages=doc.getPages()
  const pdf=await getDocumentProxy(new Uint8Array(buf));const {text}=await extractText(pdf,{mergePages:false});const pt=Array.isArray(text)?text:[text];const total=pt.length
  const meta=[]
  for(let p=0;p<total;p++){let fw=0,sa=0,img=0;const aref=pages[p].node.get(doc.context.obj('Annots'));if(aref){const an=doc.context.lookup(aref);if(an instanceof PDFArray)for(let i=0;i<an.size();i++){const a=doc.context.lookup(an.get(i));if(!(a instanceof PDFDict))continue;const s=a.get(doc.context.obj('Subtype'))?.toString?.()??'';if(s==='/Widget')fw++;else if(s==='/Stamp')sa++}}const res=pages[p].node.Resources?.();if(res){const xr=res.get(doc.context.obj('XObject'));const xo=xr?doc.context.lookup(xr):null;if(xo instanceof PDFDict)for(const[,ref]of xo.entries()){const o=doc.context.lookup(ref);const st=o?.dict?.get?.(doc.context.obj('Subtype'));if(st instanceof PDFName&&st.toString()==='/Image')img++}}meta.push({fw,sa,img,cc:(pt[p]??'').replace(/\s+/g,'').length})}
  const isCover=(i)=>{const m=meta[i];if(m.fw>0)return true;if(m.cc<BLANK&&m.img===0)return true;if(m.sa>0&&m.cc<STAMP_TEXT_MAX)return true;return COVER_VOCAB.test(pt[i]??'')}
  if(!isCover(0))return{res:null,pt}
  let last=0;while(last+1<total&&last+1<MAX_COVER&&isCover(last+1))last++
  const e=last+1;if(total-e<1)return{res:null,pt}
  const anchor=meta.slice(0,e).some(m=>m.sa>0&&m.cc<STAMP_TEXT_MAX)?'stamp':(meta.slice(0,e).some(m=>m.fw>0)?'form':'flat')
  return{res:{s:1,e,anchor},pt}
}

const { rows } = await c.query(`SELECT id, left(file_name,36) nm, storage_path FROM submittals WHERE status<>'deleted' AND mime_type='application/pdf' AND storage_path IS NOT NULL AND created_at>='2026-06-05T17:00:00Z' ORDER BY created_at`)
let strip=0,no=0,err=0
for(const r of rows){
  let buf;try{const{data:blob,error}=await sb.storage.from('submittals').download(r.storage_path);if(error||!blob){err++;continue}buf=Buffer.from(await blob.arrayBuffer())}catch{err++;continue}
  let out;try{out=await plan(buf)}catch(e){err++;console.log('ERR '+r.nm+' '+e.message);continue}
  const {res,pt}=out
  if(!res){no++;console.log('NO-STRIP                       | '+r.nm);continue}
  strip++
  const k=res.s===1?res.e:0
  console.log('STRIP '+res.s+'-'+res.e+' ['+res.anchor.padEnd(5)+'] keepP'+(k+1)+' | '+r.nm+' → '+(pt[k]??'').replace(/\s+/g,' ').trim().slice(0,42))
}
console.log('\\n'+strip+' stripped, '+no+' no-strip, '+err+' err (of '+rows.length+')')
await c.end()
