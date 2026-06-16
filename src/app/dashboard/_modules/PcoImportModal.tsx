"use client"

import { useMemo, useRef, useState } from "react"
import type { Project } from "../_shared/types"
import { computePcoTotals } from "../_shared/pco-math"
import { parseWorkbookFilesAsync } from "@/lib/pco-import/parse-client"
import { reconcile, coverSummary } from "@/lib/pco-import/extract"
import type { ParsedPco, PcoFlag } from "@/lib/pco-import/types"

// PCO Import — the human review gate (ADR-001 staging→review→commit). The .xlsx
// is parsed in the browser and NEVER uploaded. Each parsed PCO becomes a card;
// flagged cards (math mismatch, PCO# mismatch, collision, missing fields, bond)
// can't be committed until resolved (edit the values, or exclude the file).
// Clean cards preview the to-be-stored Tutto cover+backup PDFs, then commit.

const usd = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
const num = (v: string): number | null => (v.trim() === "" ? null : Number(v))
const numericKey = (co: string | null | undefined): string => (co ?? "").replace(/[^0-9]/g, "").replace(/^0+(?=\d)/, "") || ""

let seq = 0
const cid = () => `card-${seq++}`

// Residual diagnostic (report-only). For each parsed PCO that still doesn't
// reconcile AFTER Textura extraction, log (stated − computed) and a cluster
// histogram. A cluster on a common value/pattern implies ANOTHER unparsed cover
// line — surface it before assuming the remainder is stale-backup noise. Runs in
// the browser console over whatever batch the reviewer drops (e.g. THP's 49).
function logResidualDiagnostics(pcos: ParsedPco[]) {
  const rows = pcos.flatMap(p => {
    const stated = p.stated.coverTotal
    if (stated == null) return []
    const residual = Math.round((stated - p.computed.total) * 100) / 100
    return Math.abs(residual) > 0.05
      ? [{ pco: p.pcoNumber ?? "?", file: p.sourceFileName, stated, computed: p.computed.total, textura: p.computed.texturaFee, residual }]
      : []
  })
  if (rows.length === 0) return
  console.info(`[pco-import] residual diagnostic — ${rows.length} card(s) still mismatch after Textura:`)
  for (const r of rows) {
    console.info(`  PCO ${r.pco} (${r.file}): stated ${r.stated.toFixed(2)} − computed ${r.computed.toFixed(2)} = ${r.residual.toFixed(2)}  [textura ${r.textura.toFixed(2)}]`)
  }
  const clusters = new Map<string, number>()
  for (const r of rows) { const k = r.residual.toFixed(2); clusters.set(k, (clusters.get(k) ?? 0) + 1) }
  const sorted = [...clusters.entries()].sort((a, b) => b[1] - a[1])
  console.info("[pco-import] residual clusters (value ×count):", sorted.map(([v, c]) => `${v}×${c}`).join("   "))
}

// A real THP workbook is a *.xlsx that is NOT an Office lock file. Office writes
// a hidden "~$name.xlsx" companion while a workbook is open; it has the .xlsx
// extension but is not a workbook, so it must be skipped along with non-xlsx files.
const isImportableXlsx = (name: string) => {
  const base = name.split(/[\\/]/).pop() ?? name
  return base.toLowerCase().endsWith(".xlsx") && !base.startsWith("~$")
}

// Drain a directory reader fully — readEntries() returns results in batches and
// must be called repeatedly until it yields an empty batch.
function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise<FileSystemEntry[]>((resolve, reject) => {
    const out: FileSystemEntry[] = []
    const pump = () => reader.readEntries(batch => {
      if (batch.length === 0) { resolve(out); return }
      out.push(...batch)
      pump()
    }, reject)
    pump()
  })
}

// Recursively collect every leaf File under a dropped entry (file or directory).
async function walkEntry(entry: FileSystemEntry, acc: File[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej))
    acc.push(file)
  } else if (entry.isDirectory) {
    const entries = await readAllEntries((entry as FileSystemDirectoryEntry).createReader())
    for (const e of entries) await walkEntry(e, acc)
  }
}

interface Card {
  id: string
  pco: ParsedPco          // editable copy
  staticFlags: PcoFlag[]  // file-level number flags (cover≠backup notice; cover-missing block)
  excluded: boolean
  committed: boolean
  committing: boolean
  error: string | null
  status: string          // review status, applied AFTER commit (default 'Not submitted')
}

// CHECK-valid change_orders statuses (see migration 0005 / status CHECK).
const STATUS_OPTIONS = ["Not submitted", "Pending", "Approved"]

interface CommitResult { imported: number; total: number; failures: { pco_number: string; reason: string }[] }

// Flags that block commit and can ONLY be cleared by excluding the file.
const EXCLUDE_ONLY: PcoFlag["code"][] = ["pco_number_unverified", "pco_number_conflict", "collision", "unsupported_value"]

// Informational-only flags: shown to the reviewer but they do NOT block commit.
// The stated cover is authoritative, so a stale/foreign backup and any
// recompute-vs-stated difference are notices, not gates.
const NON_BLOCKING: PcoFlag["code"][] = ["pco_number_mismatch", "foreign_backup", "math_mismatch"]

export default function PcoImportModal({ project, onClose, onImported }: {
  project: Project
  onClose: () => void
  onImported: (result: CommitResult) => void
}) {
  const [cards, setCards] = useState<Card[]>([])
  const [parsing, setParsing] = useState(false)
  const [parseMsg, setParseMsg] = useState<string | null>(null)
  const [collisionKeys, setCollisionKeys] = useState<Set<string>>(new Set())
  const [committingAll, setCommittingAll] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // Live gating flags for a card (recomputed from its current edited state).
  function liveFlags(card: Card): PcoFlag[] {
    const p = card.pco
    const f: PcoFlag[] = [...card.staticFlags]
    if (!p.pcoNumber) f.push({ code: "missing_fields", field: "PCO #", message: "PCO # is required." })
    if (!p.title) f.push({ code: "missing_fields", field: "Title", message: "Title is required." })
    if (!p.dateISO) f.push(p.dateSuggestion
      ? { code: "volatile_date", field: "Date", message: `This file's date is auto-generated by Excel (last showed ${p.dateSuggestion}). Confirm or enter the PCO date.` }
      : { code: "missing_fields", field: "Date", message: "Date is required." })
    // Line items are NOT required — a cover-summary-only PCO commits on its stated totals.
    if (p.pcoNumber && collisionKeys.has(numericKey(p.pcoNumber))) f.push({ code: "collision", message: `PCO #${p.pcoNumber} already exists in this project.` })
    const { flags } = reconcile(p.labor, p.materials, p.stated)
    f.push(...flags)
    return f
  }

  // A card is committable when it has no BLOCKING flags. Non-blocking notices
  // (cover≠backup, foreign backup, recompute-vs-stated) never count — the stated
  // cover summary is authoritative and is what commits.
  const blockingFlags = (card: Card) => liveFlags(card).filter(f => !NON_BLOCKING.includes(f.code))
  const committable = (card: Card) => !card.excluded && !card.committed && blockingFlags(card).length === 0

  // Live computed totals (mirrors the server + the generated PDF).
  function totalsOf(p: ParsedPco) {
    const { computed } = reconcile(p.labor, p.materials, p.stated)
    const t = computePcoTotals(
      p.labor.map(l => ({ qty_reg: l.qty_reg, rate_reg: l.rate_reg, qty_ot: l.qty_ot, rate_ot: l.rate_ot, qty_dt: l.qty_dt, rate_dt: l.rate_dt })),
      p.materials.map(m => ({ qty: m.qty, unit_price: m.unit_price })),
      computed.subcontractor ? [{ amount: computed.subcontractor }] : [],
      computed.ohpPercent, computed.feePercent, computed.texturaFee,
    )
    return { computed, t }
  }

  // Entry point for a flat selection (file input). Folders dropped onto the zone
  // go through onDrop → walkEntry first, then land here as a flat File[].
  function ingestFromList(files: File[]) {
    const found = files.length
    const xlsx = files.filter(f => isImportableXlsx(f.name))
    ingest(xlsx, found, found - xlsx.length)
  }

  // Recursively collect dropped files/folders, then ingest the *.xlsx among them.
  async function onDrop(e: React.DragEvent) {
    e.preventDefault()
    const dt = e.dataTransfer
    // webkitGetAsEntry must be read synchronously before the handler yields — the
    // DataTransferItemList is cleared once we await. Capture entries up front.
    const entries = dt.items
      ? Array.from(dt.items).map(it => it.webkitGetAsEntry?.() ?? null).filter((x): x is FileSystemEntry => x !== null)
      : []
    const flatFallback = Array.from(dt.files)
    if (entries.length === 0) { ingestFromList(flatFallback); return }
    setParsing(true); setParseMsg("Reading dropped items…")
    const collected: File[] = []
    try {
      for (const en of entries) await walkEntry(en, collected)
    } catch {
      setParsing(false); setParseMsg("Could not read the dropped folder."); return
    }
    setParsing(false)
    ingestFromList(collected)
  }

  // Parse the importable .xlsx files into cards. `found`/`skipped` drive the
  // "N files found, M parsed, K skipped (non-xlsx)" summary.
  async function ingest(xlsx: File[], found: number, skipped: number) {
    const fileWord = (n: number) => `${n} file${n === 1 ? "" : "s"}`
    if (xlsx.length === 0) {
      setParseMsg(found > 0 ? `${fileWord(found)} found, 0 parsed, ${skipped} skipped (non-xlsx)` : null)
      return
    }
    setParsing(true); setParseMsg(`Parsing ${fileWord(xlsx.length)}…`)
    try {
      // Collision pre-flight: existing CO numbers in this project (covers manual
      // + builder rows; the server re-checks authoritatively on commit).
      const existing = await fetch(`/api/change-orders?project_id=${encodeURIComponent(project.id)}`)
        .then(r => r.json()).then(d => new Set((d.changeOrders ?? []).map((c: { co_number: string }) => numericKey(c.co_number)).filter(Boolean) as string[]))
        .catch(() => new Set<string>())
      setCollisionKeys(existing)

      // Parsed off the main thread in a Web Worker — the UI stays responsive
      // through a 49-file folder and the batch keeps running if the desktop
      // tab is backgrounded. Live per-file progress drives the count below.
      const results = await parseWorkbookFilesAsync(xlsx, ({ done, total }) =>
        setParseMsg(`Parsing ${done} of ${total}…`))
      const newCards: Card[] = results.map(r => {
        if (!r.pco) {
          // Hard parse failure → an excluded error card carrying the file flags.
          const stub: ParsedPco = {
            sourceFileName: r.fileName, sourceSheetCover: null, sourceSheetBackup: null,
            pcoNumber: null, pcoNumberRaw: null, project: null, dateISO: null, dateSuggestion: null, title: r.fileName,
            descriptionOfWork: null, scheduleImpactDays: null, signerName: null, signerTitle: null,
            jobNumber: null, labor: [], materials: [],
            stated: { coverLabor: null, coverMaterials: null, coverSubcontractor: null, coverOhp: null, coverFee: null, coverTextura: null, coverBond: null, coverTotal: null, backupLaborSubtotal: null, backupMaterialsSubtotal: null, backupOhpAmount: null, backupGrandTotal: null },
            computed: { laborSubtotal: 0, materialsSubtotal: 0, ohpPercent: null, feePercent: null, texturaFee: 0, subcontractor: 0, total: 0 },
            flags: r.fileFlags, notes: r.notes,
          }
          return { id: cid(), pco: stub, staticFlags: r.fileFlags, excluded: true, committed: false, committing: false, error: null, status: "Not submitted" }
        }
        // File-level number flags ride along as static (not recomputable from
        // edits): the cover≠backup notice, the foreign-backup notice, the
        // cover-missing fallback, and the conflicting-cover-values block.
        const staticFlags = r.pco.flags.filter(f =>
          f.code === "pco_number_mismatch" || f.code === "pco_number_unverified" ||
          f.code === "pco_number_conflict" || f.code === "foreign_backup")
        return { id: cid(), pco: r.pco, staticFlags, excluded: false, committed: false, committing: false, error: null, status: "Not submitted" }
      })
      setCards(prev => [...prev, ...newCards])
      logResidualDiagnostics(newCards.map(c => c.pco))
      setParseMsg(`${fileWord(found)} found, ${xlsx.length} parsed${skipped > 0 ? `, ${skipped} skipped (non-xlsx)` : ""}`)
    } catch (e) {
      setParseMsg(`Could not parse: ${(e as Error)?.message ?? "unknown error"}`)
    } finally {
      setParsing(false)
      if (fileRef.current) fileRef.current.value = ""
    }
  }

  function patchPco(cardId: string, fn: (p: ParsedPco) => ParsedPco) {
    setCards(prev => prev.map(c => (c.id === cardId ? { ...c, pco: fn(c.pco), error: null } : c)))
  }
  function toggleExclude(cardId: string) {
    setCards(prev => prev.map(c => (c.id === cardId ? { ...c, excluded: !c.excluded } : c)))
  }

  function payloadFor(card: Card) {
    const p = card.pco
    // The STATED cover summary is authoritative — it is what commits (pricing_sum
    // = stated_total = cover TOTAL). Line detail is sent for the backup PDF + log
    // (omitted by the parser for a foreign backup), but never overrides the total.
    const s = coverSummary(p.stated)
    return {
      project_id: project.id,
      pco_number: p.pcoNumber ?? "",
      date: p.dateISO,
      title: p.title ?? "",
      description_of_work: p.descriptionOfWork,
      schedule_impact_days: p.scheduleImpactDays ?? 0,
      oh_p_percent: s.ohpPercent,
      fee_percent: s.feePercent,
      textura_fee: s.texturaFee,
      signer_name: p.signerName,
      signer_title: p.signerTitle,
      labor: p.labor.map(l => ({ description: l.role, qty_reg: l.qty_reg, rate_reg: l.rate_reg, qty_ot: l.qty_ot, rate_ot: l.rate_ot, qty_dt: l.qty_dt, rate_dt: l.rate_dt })),
      materials: p.materials.map(m => ({ description: m.item, qty: m.qty, unit: m.unit, unit_price: m.unit_price, note: m.note })),
      subs: s.subcontractor ? [{ description: "Subcontractor", amount: s.subcontractor }] : [],
      // Authoritative stated cover summary.
      stated_labor: s.labor,
      stated_materials: s.materials,
      stated_subcontractor: s.subcontractor,
      stated_ohp_amount: s.ohpAmount,
      stated_fee_amount: s.feeAmount,
      stated_total: s.total,
      confirmed_total: s.total,
      status: card.status,
    }
  }

  async function preview(card: Card, doc: "cover" | "backup") {
    try {
      const res = await fetch(`/api/change-orders/pco/preview-pdf?doc=${doc}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payloadFor(card)),
      })
      if (!res.ok) { patchError(card.id, "Preview failed"); return }
      const blob = await res.blob()
      window.open(URL.createObjectURL(blob), "_blank")
    } catch { patchError(card.id, "Preview failed") }
  }
  function patchError(cardId: string, msg: string) {
    setCards(prev => prev.map(c => (c.id === cardId ? { ...c, error: msg } : c)))
  }

  async function commit(toCommit: Card[]) {
    if (toCommit.length === 0) return
    const payloads = toCommit.map(payloadFor)
    const res = await fetch("/api/change-orders/pco/import", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pcos: payloads }),
    })
    const result = (await res.json().catch(() => null)) as CommitResult | null
    if (!res.ok || !result) {
      setCards(prev => prev.map(c => (toCommit.find(t => t.id === c.id) ? { ...c, committing: false, error: "Commit failed" } : c)))
      return
    }
    // Mark the successfully-committed numbers so duplicates in the queue flag,
    // and pull committed cards out of the queue.
    const failedNums = new Set(result.failures.map(f => numericKey(f.pco_number)))
    setCollisionKeys(prev => {
      const next = new Set(prev)
      for (const c of toCommit) { const k = numericKey(c.pco.pcoNumber); if (k && !failedNums.has(k)) next.add(k) }
      return next
    })
    setCards(prev => prev.flatMap(c => {
      const wasTried = toCommit.find(t => t.id === c.id)
      if (!wasTried) return [c]
      const failed = failedNums.has(numericKey(c.pco.pcoNumber))
      if (failed) return [{ ...c, committing: false, error: result.failures.find(f => numericKey(f.pco_number) === numericKey(c.pco.pcoNumber))?.reason ?? "Failed" }]
      return [] // committed → remove from queue
    }))
    onImported(result)
  }

  async function commitOne(card: Card) {
    setCards(prev => prev.map(c => (c.id === card.id ? { ...c, committing: true, error: null } : c)))
    await commit([card])
  }
  async function commitAllClean() {
    const clean = cards.filter(committable)
    if (clean.length === 0) return
    setCommittingAll(true)
    try { await commit(clean) } finally { setCommittingAll(false) }
  }

  const cleanCount = useMemo(() => cards.filter(committable).length, [cards, collisionKeys])
  const remaining = cards.length

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-stretch sm:items-center justify-center sm:p-4">
      <div className="bg-[#F4F5F7] w-full sm:max-w-[1080px] sm:rounded-xl shadow-xl flex flex-col max-h-screen sm:max-h-[94vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 bg-white border-b border-[#E2E8F0] sm:rounded-t-xl flex-shrink-0">
          <div>
            <h2 className="text-[16px] font-bold text-[#0F172A]">Import historical PCOs</h2>
            <p className="text-[12px] text-[#64748B] mt-0.5">{project.name} · parsed in your browser — the workbook is never uploaded</p>
          </div>
          <button onClick={onClose} className="h-8 w-8 grid place-items-center rounded-md text-[#64748B] hover:bg-[#F4F5F7] text-[18px]">×</button>
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-4">
          {/* Upload zone */}
          <div className="bg-white rounded-xl border border-dashed border-[#CBD5E1] p-5 text-center"
            onDragOver={e => e.preventDefault()}
            onDrop={onDrop}>
            <input ref={fileRef} type="file" accept=".xlsx" multiple className="hidden" onChange={e => ingestFromList(Array.from(e.target.files ?? []))} />
            <p className="text-[13px] text-[#475569]">Drop THP-format <span className="font-mono">.xlsx</span> workbooks — or a whole folder — here, or</p>
            <button onClick={() => fileRef.current?.click()} disabled={parsing}
              className="mt-2 h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] disabled:opacity-50">
              {parsing ? "Parsing…" : "Choose files"}
            </button>
            {parseMsg && <p className="text-[12px] text-[#64748B] mt-2">{parseMsg}</p>}
          </div>

          {cards.map(card => {
            const flags = liveFlags(card)
            const blocking = flags.filter(f => !NON_BLOCKING.includes(f.code))
            const { t } = totalsOf(card.pco)
            const p = card.pco
            const ok = committable(card)
            return (
              <div key={card.id} className={`bg-white rounded-xl border p-4 ${card.excluded ? "border-[#E2E8F0] opacity-60" : blocking.length ? "border-amber-300" : "border-green-300"}`}>
                {/* Card header */}
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[13px] font-bold text-[#0F172A]">PCO {p.pcoNumber ?? "—"}</span>
                      <span className="text-[11px] text-[#64748B] font-mono truncate">{p.sourceFileName}</span>
                      {card.committed && <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 text-green-700 font-semibold">Committed</span>}
                    </div>
                    <div className="text-[12px] text-[#64748B] mt-0.5 truncate">{p.title ?? "Untitled"} · {p.dateISO ?? "no date"} · {p.project ?? project.name}</div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <label className="flex items-center gap-1.5 text-[11px] text-[#64748B]">
                      Status
                      <select value={card.status} onChange={e => setCards(prev => prev.map(c => (c.id === card.id ? { ...c, status: e.target.value } : c)))}
                        className="h-7 px-1.5 rounded border border-[#E2E8F0] text-[11px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]">
                        {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </label>
                    <label className="flex items-center gap-1.5 text-[11px] text-[#64748B] cursor-pointer">
                      <input type="checkbox" checked={card.excluded} onChange={() => toggleExclude(card.id)} /> Exclude
                    </label>
                  </div>
                </div>

                {/* Flags — volatile_date and the cover≠backup number notice are
                    neutral blue informational prompts (nothing is wrong); real
                    errors are amber. */}
                {flags.length > 0 && !card.excluded && (
                  <div className="mb-3 space-y-1">
                    {flags.map((f, i) => {
                      const info = f.code === "volatile_date" || f.code === "pco_number_mismatch" || f.code === "foreign_backup" || f.code === "math_mismatch"
                      const label = f.code === "volatile_date" ? "Confirm date"
                        : f.code === "foreign_backup" ? "Foreign backup"
                        : f.code === "math_mismatch" ? "Recompute differs"
                        : f.code === "pco_number_mismatch" ? "Note"
                        : f.code.replace(/_/g, " ")
                      return (
                        <div key={i} className={`flex items-start gap-2 text-[11px] rounded-md px-2 py-1 border ${info ? "text-blue-800 bg-blue-50 border-blue-200" : "text-amber-800 bg-amber-50 border-amber-200"}`}>
                          <span className="font-semibold uppercase tracking-wide shrink-0">{label}</span>
                          <span>{f.message}</span>
                          {EXCLUDE_ONLY.includes(f.code) && <span className="text-amber-600 italic ml-auto shrink-0">exclude to proceed</span>}
                        </div>
                      )
                    })}
                  </div>
                )}

                {!card.excluded && (
                  <>
                    {/* Header editable fields */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
                      <Field label="PCO #" value={p.pcoNumber ?? ""} onChange={v => patchPco(card.id, x => ({ ...x, pcoNumber: v.trim() || null }))} />
                      <div>
                        <Field label="Date" type="date" value={p.dateISO ?? ""} onChange={v => patchPco(card.id, x => ({ ...x, dateISO: v || null }))} />
                        {!p.dateISO && p.dateSuggestion && (
                          <button onClick={() => patchPco(card.id, x => ({ ...x, dateISO: x.dateSuggestion }))}
                            className="mt-0.5 text-[10px] text-blue-700 hover:underline">Use {p.dateSuggestion}</button>
                        )}
                      </div>
                      <Field label="Job #" value={p.jobNumber ?? ""} onChange={v => patchPco(card.id, x => ({ ...x, jobNumber: v.trim() || null }))} />
                      <Field label="Schedule days" type="number" value={p.scheduleImpactDays != null ? String(p.scheduleImpactDays) : ""} onChange={v => patchPco(card.id, x => ({ ...x, scheduleImpactDays: v.trim() === "" ? null : parseInt(v, 10) }))} />
                      <div className="col-span-2 sm:col-span-4">
                        <Field label="Title" value={p.title ?? ""} onChange={v => patchPco(card.id, x => ({ ...x, title: v.trim() || null }))} />
                      </div>
                    </div>

                    {/* Labor */}
                    {p.labor.length > 0 && (
                      <EditTable
                        title="Labor (imported rates — frozen on commit)"
                        head={["Role", "Reg hrs", "Reg $/hr", "1.5× hrs", "1.5× $/hr", "2× hrs", "2× $/hr"]}
                        rows={p.labor.map((l, i) => ({
                          key: i,
                          cells: [
                            { v: l.role ?? "", on: (v: string) => editLabor(card.id, i, "role", v) },
                            { v: l.qty_reg, on: (v: string) => editLabor(card.id, i, "qty_reg", v), n: true },
                            { v: l.rate_reg, on: (v: string) => editLabor(card.id, i, "rate_reg", v), n: true },
                            { v: l.qty_ot, on: (v: string) => editLabor(card.id, i, "qty_ot", v), n: true },
                            { v: l.rate_ot, on: (v: string) => editLabor(card.id, i, "rate_ot", v), n: true },
                            { v: l.qty_dt, on: (v: string) => editLabor(card.id, i, "qty_dt", v), n: true },
                            { v: l.rate_dt, on: (v: string) => editLabor(card.id, i, "rate_dt", v), n: true },
                          ],
                          onRemove: () => patchPco(card.id, x => ({ ...x, labor: x.labor.filter((_, j) => j !== i) })),
                        }))}
                      />
                    )}

                    {/* Materials */}
                    {p.materials.length > 0 && (
                      <EditTable
                        title="Material / Equipment"
                        head={["Item", "Qty", "Unit", "Unit price", "Note"]}
                        rows={p.materials.map((m, i) => ({
                          key: i,
                          cells: [
                            { v: m.item ?? "", on: (v: string) => editMat(card.id, i, "item", v) },
                            { v: m.qty, on: (v: string) => editMat(card.id, i, "qty", v), n: true },
                            { v: m.unit ?? "", on: (v: string) => editMat(card.id, i, "unit", v) },
                            { v: m.unit_price, on: (v: string) => editMat(card.id, i, "unit_price", v), n: true },
                            { v: m.note ?? "", on: (v: string) => editMat(card.id, i, "note", v) },
                          ],
                          onRemove: () => patchPco(card.id, x => ({ ...x, materials: x.materials.filter((_, j) => j !== i) })),
                        }))}
                      />
                    )}

                    {/* Pricing — the STATED cover summary is authoritative and is
                        what commits (pricing_sum = cover TOTAL). The line recompute,
                        when present and different, is shown as a quiet diagnostic. */}
                    {(() => {
                      const cs = coverSummary(p.stated)
                      const hasLines = p.labor.length > 0 || p.materials.length > 0
                      const recomputeDiffers = hasLines && Math.abs(t.grandTotal - cs.total) > 0.05
                      return (
                        <div className="mt-3 grid sm:grid-cols-2 gap-3">
                          <div className="text-[12px] space-y-1">
                            <div className="text-[10px] font-bold text-[#64748B] uppercase tracking-wide">Cover summary — committed</div>
                            <StatedRow label="Labor" value={cs.labor} />
                            <StatedRow label="Material & Equipment" value={cs.materials} />
                            {cs.subcontractor !== 0 && <StatedRow label="Subcontractor" value={cs.subcontractor} />}
                            <StatedRow label="OH&P" value={cs.ohpAmount} />
                            <StatedRow label="Fee" value={cs.feeAmount} />
                            {cs.texturaFee !== 0 && <StatedRow label="Textura Fee" value={cs.texturaFee} />}
                            <div className="flex items-center justify-between pt-1 border-t border-[#E2E8F0] font-bold text-[13px]">
                              <span>TOTAL</span><span className="tabular-nums">{usd(cs.total)}</span>
                            </div>
                            {!hasLines && <div className="text-[11px] text-[#64748B] italic">No line detail — committing on the cover summary only.</div>}
                            {recomputeDiffers && <div className="text-[11px] text-blue-700">Line recompute {usd(t.grandTotal)} — diagnostic only; the stated cover total commits.</div>}
                          </div>
                          <div className="flex flex-col justify-end items-stretch sm:items-end gap-2">
                            <div className="flex gap-2">
                              <button onClick={() => preview(card, "cover")} className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[12px] font-medium text-[#0F172A] hover:bg-[#F4F5F7]">Preview cover</button>
                              {hasLines && <button onClick={() => preview(card, "backup")} className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[12px] font-medium text-[#0F172A] hover:bg-[#F4F5F7]">Preview backup</button>}
                            </div>
                            <button onClick={() => commitOne(card)} disabled={!ok || card.committing}
                              className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[12px] font-semibold hover:bg-[#6A8AA4] disabled:opacity-40 disabled:cursor-not-allowed">
                              {card.committing ? "Committing…" : "Commit this PCO"}
                            </button>
                          </div>
                        </div>
                      )
                    })()}

                    {card.error && <p className="text-[11px] text-red-600 mt-2">{card.error}</p>}
                    {p.notes.length > 0 && (
                      <ul className="mt-2 text-[11px] text-[#64748B] list-disc list-inside space-y-0.5">
                        {p.notes.map((n, i) => <li key={i}>{n}</li>)}
                      </ul>
                    )}
                  </>
                )}
              </div>
            )
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-4 px-6 py-4 bg-white border-t border-[#E2E8F0] sm:rounded-b-xl flex-shrink-0">
          <div className="text-[12px] text-[#64748B]">
            {remaining > 0 ? <><span className="font-semibold text-[#0F172A]">{cleanCount}</span> clean of {remaining} ready to import</> : "No PCOs loaded yet"}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="h-9 px-4 rounded-md border border-[#E2E8F0] text-[13px] font-semibold text-[#0F172A] hover:bg-[#F4F5F7]">Close</button>
            <button onClick={commitAllClean} disabled={cleanCount === 0 || committingAll}
              className="h-9 px-5 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] disabled:opacity-50 disabled:cursor-not-allowed">
              {committingAll ? "Committing…" : `Commit all clean (${cleanCount})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )

  // ── line-item editors ───────────────────────────────────────────────────
  function editLabor(cardId: string, idx: number, field: keyof ParsedPco["labor"][number], value: string) {
    patchPco(cardId, p => ({ ...p, labor: p.labor.map((l, j) => (j === idx ? { ...l, [field]: field === "role" ? value : num(value) } : l)) }))
  }
  function editMat(cardId: string, idx: number, field: keyof ParsedPco["materials"][number], value: string) {
    const textFields = ["item", "unit", "note"]
    patchPco(cardId, p => ({ ...p, materials: p.materials.map((m, j) => (j === idx ? { ...m, [field]: textFields.includes(field) ? value : num(value) } : m)) }))
  }
}

function Field({ label, value, onChange, type = "text" }: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <div>
      <label className="block text-[10px] font-semibold text-[#64748B] uppercase tracking-wide mb-0.5">{label}</label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)}
        className="w-full h-8 px-2 rounded-md border border-[#E2E8F0] text-[12px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]" />
    </div>
  )
}

interface EditCell { v: string | number | null; on: (v: string) => void; n?: boolean }
interface EditRow { key: number; cells: EditCell[]; onRemove: () => void }
function EditTable({ title, head, rows }: { title: string; head: string[]; rows: EditRow[] }) {
  return (
    <div className="mb-3">
      <div className="text-[11px] font-bold text-[#0F172A] uppercase tracking-wide mb-1">{title}</div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px] min-w-[640px]">
          <thead>
            <tr className="text-[9px] font-semibold text-[#64748B] uppercase text-left border-b border-[#E2E8F0]">
              {head.map(h => <th key={h} className="py-1 px-1">{h}</th>)}
              <th className="w-7" />
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.key} className="border-b border-[#F1F5F9]">
                {row.cells.map((c, i) => (
                  <td key={i} className="py-1 px-1">
                    <input value={c.v ?? ""} type={c.n ? "number" : "text"} step="0.01"
                      onChange={e => c.on(e.target.value)}
                      className={`w-full h-7 px-1.5 rounded border border-[#E2E8F0] text-[12px] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5] ${c.n ? "text-right tabular-nums" : ""}`} />
                  </td>
                ))}
                <td className="text-right">
                  <button onClick={row.onRemove} className="h-6 w-6 grid place-items-center rounded text-[#94A3B8] hover:text-red-600 hover:bg-red-50">×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// One row of the committed (stated) cover summary.
function StatedRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[#64748B]">{label}</span>
      <span className="tabular-nums text-[#0F172A]">{usd(value)}</span>
    </div>
  )
}
