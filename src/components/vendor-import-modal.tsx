"use client"

import { useMemo, useRef, useState } from "react"
import Papa from "papaparse"

// Dedup key: case-insensitive, trimmed company name (matches the server route).
const normalizeName = (s: string) => s.trim().toLowerCase()

// Self-serve spreadsheet import for vendors. Flow: upload (CSV/XLSX) → map
// spreadsheet columns to vendor fields → preview (with the dedup skip-count and
// skipped names shown BEFORE commit) → confirm → server insert → summary.
//
// Dedup is SKIP-duplicates, keyed on the case-insensitive trimmed company_name.
// The preview computes it client-side against the already-loaded directory; the
// /api/vendors/import route re-runs it authoritatively (and owns tenant scope),
// so the committed counts are always the source of truth.

type ImportSummary = { inserted: number; skipped: number; invalid?: number }

// Vendor fields a column can map to. company_name is the only required mapping;
// is_subcontractor / is_supplier are intentionally absent — imports land Untyped.
const FIELDS: { key: string; label: string; required?: boolean; aliases: string[] }[] = [
  { key: "company_name",   label: "Company Name", required: true, aliases: ["company", "companyname", "name", "vendor", "vendorname", "firm", "business"] },
  { key: "vendor_no",      label: "Vendor No.",   aliases: ["vendorno", "vendornumber", "vendorid", "no", "number", "acct", "account"] },
  { key: "trade",          label: "Trade",        aliases: ["trade", "discipline"] },
  { key: "specialty",      label: "Specialty",    aliases: ["specialty", "material", "materials", "category"] },
  { key: "contact_name",   label: "Contact Name", aliases: ["contact", "contactname", "attn", "rep"] },
  { key: "phone",          label: "Phone",        aliases: ["phone", "tel", "telephone", "phonenumber", "mobile", "cell"] },
  { key: "email",          label: "Email",        aliases: ["email", "emailaddress", "mail"] },
  { key: "street_address", label: "Street",       aliases: ["street", "streetaddress", "address", "address1", "addr"] },
  { key: "city",           label: "City",         aliases: ["city", "town"] },
  { key: "state",          label: "State",        aliases: ["state", "province", "region"] },
  { key: "zip_code",       label: "ZIP",          aliases: ["zip", "zipcode", "postal", "postalcode", "postcode"] },
  { key: "license_number", label: "License No.",  aliases: ["license", "licensenumber", "licenseno", "lic"] },
  { key: "website",        label: "Website",      aliases: ["website", "web", "url", "site"] },
  { key: "notes",          label: "Notes",        aliases: ["notes", "note", "comment", "comments", "remarks"] },
]

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "")

function autoMap(headers: string[]): Record<string, string> {
  const map: Record<string, string> = {}
  const used = new Set<string>()
  for (const f of FIELDS) {
    const hit = headers.find(h => !used.has(h) && (norm(h) === norm(f.label) || f.aliases.includes(norm(h))))
    if (hit) { map[f.key] = hit; used.add(hit) }
  }
  return map
}

function cellToStr(v: unknown): string {
  if (v == null) return ""
  if (typeof v === "object") {
    const o = v as Record<string, unknown>
    if (typeof o.text === "string") return o.text
    if (typeof o.result === "string" || typeof o.result === "number") return String(o.result)
    if (Array.isArray(o.richText)) return (o.richText as { text?: string }[]).map(r => r.text ?? "").join("")
    return ""
  }
  return String(v)
}

type XlsxCell = { value: unknown }
type XlsxRow = {
  eachCell: (
    optsOrCb: { includeEmpty?: boolean } | ((cell: XlsxCell, col: number) => void),
    cb?: (cell: XlsxCell, col: number) => void,
  ) => void
  getCell: (col: number) => XlsxCell
}
type XlsxWorksheet = { getRow: (n: number) => XlsxRow; eachRow: (cb: (row: XlsxRow, n: number) => void) => void }
type XlsxWorkbook = { xlsx: { load: (b: ArrayBuffer) => Promise<unknown> }; worksheets: XlsxWorksheet[] }

async function parseXlsx(file: File): Promise<{ headers: string[]; rows: Record<string, string>[] }> {
  const mod = await import("exceljs") as unknown as { Workbook?: new () => XlsxWorkbook; default?: { Workbook: new () => XlsxWorkbook } }
  const WorkbookCtor = mod.Workbook ?? mod.default?.Workbook
  if (!WorkbookCtor) throw new Error("Could not load the spreadsheet reader.")
  const wb = new WorkbookCtor()
  await wb.xlsx.load(await file.arrayBuffer())
  const ws = wb.worksheets[0]
  if (!ws) return { headers: [], rows: [] }

  // includeEmpty keeps header/data columns aligned by absolute column index even
  // when the sheet has gaps; trailing blanks are trimmed off.
  const headers: string[] = []
  ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => { headers[col - 1] = cellToStr(cell.value).trim() })
  while (headers.length && !headers[headers.length - 1]) headers.pop()

  const rows: Record<string, string>[] = []
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return
    const obj: Record<string, string> = {}
    headers.forEach((h, i) => { if (h) obj[h] = cellToStr(row.getCell(i + 1).value).trim() })
    if (Object.values(obj).some(v => v)) rows.push(obj)
  })
  return { headers: headers.filter(Boolean), rows }
}

function parseCsv(file: File): Promise<{ headers: string[]; rows: Record<string, string>[] }> {
  return new Promise((resolve, reject) => {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const headers = (res.meta.fields ?? []).map(h => h.trim()).filter(Boolean)
        const rows = res.data.map(r => {
          const o: Record<string, string> = {}
          for (const h of headers) o[h] = (r[h] ?? "").toString().trim()
          return o
        })
        resolve({ headers, rows })
      },
      error: reject,
    })
  })
}

export default function VendorImportModal({
  existingNames, onClose, onDone,
}: {
  existingNames: Set<string>
  onClose: () => void
  onDone: (summary: ImportSummary) => void
}) {
  const [step, setStep] = useState<"upload" | "map" | "summary">("upload")
  const [fileName, setFileName] = useState("")
  const [headers, setHeaders] = useState<string[]>([])
  const [rawRows, setRawRows] = useState<Record<string, string>[]>([])
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [parseError, setParseError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [summary, setSummary] = useState<{ inserted: number; skipped: number; invalid: number; skippedNames: string[] } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (!file) return
    setParseError(null)
    setFileName(file.name)
    try {
      const isXlsx = /\.xlsx?$/i.test(file.name) || file.type.includes("spreadsheet") || file.type.includes("excel")
      const parsed = isXlsx ? await parseXlsx(file) : await parseCsv(file)
      if (parsed.headers.length === 0) { setParseError("No columns found in that file."); return }
      setHeaders(parsed.headers)
      setRawRows(parsed.rows)
      setMapping(autoMap(parsed.headers))
      setStep("map")
    } catch (err) {
      setParseError(err instanceof Error ? err.message : "Could not read that file.")
    }
  }

  // Apply the column mapping to produce vendor rows, then bucket them for the
  // pre-commit preview: ready-to-import vs skipped-as-dupe vs missing-name.
  const preview = useMemo(() => {
    const nameCol = mapping.company_name
    const mapped: Record<string, string>[] = []
    const skipped: string[] = []
    let missing = 0
    const seen = new Set(existingNames)   // existing + within-batch
    for (const r of rawRows) {
      const name = nameCol ? (r[nameCol] ?? "").trim() : ""
      if (!name) { missing++; continue }
      const key = normalizeName(name)
      if (seen.has(key)) { skipped.push(name); continue }
      seen.add(key)
      const row: Record<string, string> = {}
      for (const f of FIELDS) {
        const col = mapping[f.key]
        if (col && r[col]?.trim()) row[f.key] = r[col].trim()
      }
      row.company_name = name
      mapped.push(row)
    }
    return { mapped, skipped, missing }
  }, [rawRows, mapping, existingNames])

  async function commit() {
    setImporting(true)
    try {
      const res = await fetch("/api/vendors/import", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows: preview.mapped }),
      })
      const data = await res.json()
      if (!res.ok) { setParseError(data.error ?? "Import failed"); return }
      setSummary({ inserted: data.inserted ?? 0, skipped: data.skipped ?? 0, invalid: data.invalid ?? 0, skippedNames: data.skippedNames ?? [] })
      setStep("summary")
    } catch (err) {
      setParseError(err instanceof Error ? err.message : "Import failed")
    } finally {
      setImporting(false)
    }
  }

  const canImport = !!mapping.company_name && preview.mapped.length > 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#E2E8F0]">
          <div>
            <h3 className="text-[15px] font-semibold text-[#0F172A]">Import vendors</h3>
            <p className="text-[12px] text-[#64748B] mt-0.5">CSV or XLSX. Duplicates (by company name) are skipped; rows import as Untyped.</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded text-[#64748B] hover:text-[#0F172A] hover:bg-[#F8F9FA]"><svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg></button>
        </div>

        <div className="px-5 py-4">
          {parseError && <div className="mb-3 px-3 py-2 rounded-lg bg-red-50 text-red-700 border border-red-200 text-[13px]">{parseError}</div>}

          {step === "upload" && (
            <div className="text-center py-8">
              <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls,text/csv" onChange={handleFile} className="hidden" />
              <button onClick={() => fileRef.current?.click()} className="h-10 px-5 rounded-md bg-[#7B9BB5] text-white text-[14px] font-medium hover:bg-[#6A8AA4] transition-colors">Choose a file…</button>
              <p className="text-[12px] text-[#94A3B8] mt-3">First row must be column headers. Only <span className="font-medium">Company Name</span> is required.</p>
            </div>
          )}

          {step === "map" && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-[13px] text-[#64748B]"><span className="font-medium text-[#0F172A]">{fileName}</span> — {rawRows.length} row{rawRows.length !== 1 ? "s" : ""}</p>
                <button onClick={() => { setStep("upload"); setHeaders([]); setRawRows([]); setMapping({}) }} className="text-[12px] text-[#7B9BB5] hover:underline">Choose a different file</button>
              </div>

              <div>
                <p className="text-[12px] font-semibold text-[#0F172A] mb-2">Map columns</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {FIELDS.map(f => (
                    <div key={f.key} className="flex items-center gap-2">
                      <label className="text-[12px] text-[#64748B] w-32 flex-shrink-0">{f.label}{f.required && <span className="text-red-400"> *</span>}</label>
                      <select
                        value={mapping[f.key] ?? ""}
                        onChange={e => setMapping(m => ({ ...m, [f.key]: e.target.value }))}
                        className="flex-1 h-8 px-2 rounded border border-[#E2E8F0] text-[12px] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40"
                      >
                        <option value="">— not mapped —</option>
                        {headers.map(h => <option key={h} value={h}>{h}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
                {!mapping.company_name && <p className="text-[12px] text-red-500 mt-2">Map a column to <span className="font-medium">Company Name</span> to continue.</p>}
              </div>

              {/* Pre-commit preview: exactly what will land and what won't. */}
              {mapping.company_name && (
                <div className="rounded-lg border border-[#E2E8F0] overflow-hidden">
                  <div className="px-4 py-2.5 bg-[#F8F9FA] border-b border-[#E2E8F0] flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
                    <span className="text-emerald-700 font-medium">{preview.mapped.length} to import</span>
                    {preview.skipped.length > 0 && <span className="text-amber-600">{preview.skipped.length} skipped (duplicate)</span>}
                    {preview.missing > 0 && <span className="text-[#94A3B8]">{preview.missing} skipped (no company name)</span>}
                  </div>
                  <div className="max-h-48 overflow-y-auto">
                    <table className="w-full">
                      <thead className="sticky top-0 bg-white"><tr className="border-b border-[#E2E8F0]">
                        <th className="text-left px-4 py-1.5 text-[11px] font-semibold text-[#64748B] uppercase">Company</th>
                        <th className="text-left px-4 py-1.5 text-[11px] font-semibold text-[#64748B] uppercase">Trade/Specialty</th>
                        <th className="text-left px-4 py-1.5 text-[11px] font-semibold text-[#64748B] uppercase">Contact</th>
                      </tr></thead>
                      <tbody>
                        {preview.mapped.slice(0, 100).map((r, i) => (
                          <tr key={i} className="border-b border-[#F1F5F9]">
                            <td className="px-4 py-1.5 text-[12px] text-[#0F172A]">{r.company_name}</td>
                            <td className="px-4 py-1.5 text-[12px] text-[#64748B]">{r.trade || r.specialty || "—"}</td>
                            <td className="px-4 py-1.5 text-[12px] text-[#64748B]">{r.contact_name || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {preview.mapped.length > 100 && <p className="px-4 py-2 text-[11px] text-[#94A3B8]">…and {preview.mapped.length - 100} more.</p>}
                  </div>
                  {preview.skipped.length > 0 && (
                    <div className="px-4 py-2 border-t border-[#E2E8F0] bg-amber-50/50">
                      <p className="text-[11px] text-amber-700"><span className="font-medium">Skipped as duplicates:</span> {preview.skipped.slice(0, 25).join(", ")}{preview.skipped.length > 25 ? `, +${preview.skipped.length - 25} more` : ""}</p>
                    </div>
                  )}
                </div>
              )}

              <div className="flex justify-end gap-2">
                <button onClick={onClose} className="h-9 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:text-[#0F172A]">Cancel</button>
                <button onClick={commit} disabled={!canImport || importing} className="h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] disabled:opacity-50">
                  {importing ? "Importing…" : `Import ${preview.mapped.length} vendor${preview.mapped.length !== 1 ? "s" : ""}`}
                </button>
              </div>
            </div>
          )}

          {step === "summary" && summary && (
            <div className="py-6 text-center space-y-3">
              <div className="text-[15px] font-semibold text-[#0F172A]">Import complete</div>
              <div className="flex justify-center gap-6 text-[13px]">
                <div><div className="text-[22px] font-bold text-emerald-600">{summary.inserted}</div><div className="text-[#64748B]">imported</div></div>
                <div><div className="text-[22px] font-bold text-amber-500">{summary.skipped}</div><div className="text-[#64748B]">skipped (dupe)</div></div>
                {summary.invalid > 0 && <div><div className="text-[22px] font-bold text-[#94A3B8]">{summary.invalid}</div><div className="text-[#64748B]">no name</div></div>}
              </div>
              <button onClick={() => onDone({ inserted: summary.inserted, skipped: summary.skipped, invalid: summary.invalid })} className="h-9 px-5 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4]">Done</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
