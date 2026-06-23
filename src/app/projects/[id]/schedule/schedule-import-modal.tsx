"use client"

// ── Schedule-import: upload → parse → select-scope → commit (ADR-012) ─────────
// The select-scope step IS the feature. A GC/CM schedule PDF lists EVERY task on
// the job; THP performs only a subset. We parse the table (POST /api/schedule-
// import/parse — read-only, stores nothing), show the proposed rows grouped by the
// detected hierarchy with a keyword filter, let the user CHECK their scope and
// inline-fix any parse error, then commit ONLY the checked rows one-by-one through
// the existing POST /api/schedule-tasks write path. Nothing is auto-classified and
// nothing commits without an explicit check.

import { useCallback, useMemo, useRef, useState } from "react"

interface ProposedRow {
  name: string
  start_date: string | null
  end_date: string | null
  duration_days: number | null
  is_milestone: boolean
  phase: string | null
  wbs_code: string | null
  predecessors_raw: string | null
  percent_complete: number | null
  resources: string | null
  actual_start_date: string | null
  actual_end_date: string | null
  needsReview: boolean
  reviewReasons: string[]
}
type EditableRow = ProposedRow & { _key: string }

const FAMILY_LABEL: Record<string, string> = {
  msp: "MS Project", p6: "Primavera P6", asta: "Asta / PowerProject", unknown: "Unrecognized",
}
const inputCls = "h-7 px-2 rounded border border-[#E2E8F0] text-[12px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40"

export default function ScheduleImportModal({
  projectId, onClose, onCommitted,
}: {
  projectId: string
  onClose: () => void
  onCommitted: (count: number) => void
}) {
  const [step, setStep] = useState<"upload" | "review">("upload")
  const [parsing, setParsing] = useState(false)
  const [parseError, setParseError] = useState<string | null>(null)
  const [meta, setMeta] = useState<{ family: string; pageCount: number; warnings: string[] } | null>(null)
  const [rows, setRows] = useState<EditableRow[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState("")
  const [showWarnings, setShowWarnings] = useState(false)

  const [committing, setCommitting] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [rowErrors, setRowErrors] = useState<Map<string, string>>(new Map())
  const [summary, setSummary] = useState<{ ok: number; fail: number } | null>(null)

  const fileRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)

  // ── Parse ──────────────────────────────────────────────────────────────────
  const parse = useCallback(async (file: File) => {
    setParsing(true); setParseError(null)
    const fd = new FormData()
    fd.append("file", file)
    try {
      const res = await fetch("/api/schedule-import/parse", { method: "POST", body: fd })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setParseError(d?.error ?? "Couldn't read that PDF."); setParsing(false); return }
      const er: EditableRow[] = (d.rows ?? []).map((r: ProposedRow, i: number) => ({ ...r, _key: `r${i}` }))
      setRows(er)
      setMeta({ family: d.family, pageCount: d.pageCount, warnings: d.warnings ?? [] })
      setSelected(new Set()) // nothing pre-checked — the user picks THP's scope
      setSummary(null); setRowErrors(new Map())
      setStep("review")
    } catch (e) {
      setParseError(e instanceof Error ? e.message : "Upload failed")
    }
    setParsing(false)
  }, [])

  const updateRow = useCallback((key: string, patch: Partial<EditableRow>) => {
    setRows((rs) => rs.map((r) => (r._key === key ? { ...r, ...patch } : r)))
  }, [])

  // ── Group by detected hierarchy + keyword filter ─────────────────────────────
  const groups = useMemo(() => {
    const f = filter.trim().toLowerCase()
    const match = (r: EditableRow) => !f || `${r.name} ${r.phase ?? ""} ${r.wbs_code ?? ""}`.toLowerCase().includes(f)
    const order: string[] = []
    const byPhase = new Map<string, EditableRow[]>()
    for (const r of rows) {
      if (!match(r)) continue
      const key = r.phase?.trim() || "Ungrouped"
      if (!byPhase.has(key)) { byPhase.set(key, []); order.push(key) }
      byPhase.get(key)!.push(r)
    }
    return order.map((phase) => ({ phase, rows: byPhase.get(phase)! }))
  }, [rows, filter])

  const visibleKeys = useMemo(() => groups.flatMap((g) => g.rows.map((r) => r._key)), [groups])
  const visibleSelected = useMemo(() => visibleKeys.filter((k) => selected.has(k)).length, [visibleKeys, selected])

  const toggleRow = useCallback((key: string) => {
    setSelected((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n })
  }, [])
  const setMany = useCallback((keys: string[], on: boolean) => {
    setSelected((s) => { const n = new Set(s); for (const k of keys) on ? n.add(k) : n.delete(k); return n })
  }, [])

  // ── Commit checked rows one-by-one through the existing write route ──────────
  async function commit() {
    const toCommit = rows.filter((r) => selected.has(r._key))
    if (toCommit.length === 0) return
    setCommitting(true); setSummary(null)
    const errs = new Map<string, string>()
    const keepSelected = new Set<string>()
    let ok = 0, fail = 0
    for (let i = 0; i < toCommit.length; i++) {
      setProgress({ done: i, total: toCommit.length })
      const r = toCommit[i]
      const payload = {
        project_id: projectId,
        name: r.name,
        start_date: r.start_date,
        end_date: r.is_milestone ? r.start_date : r.end_date,
        is_milestone: r.is_milestone,
        phase: r.phase?.trim() || null,
        wbs_code: r.wbs_code?.trim() || null,
        percent_complete: r.percent_complete ?? undefined,
      }
      try {
        const res = await fetch("/api/schedule-tasks", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
        })
        if (res.ok) { ok++ }
        else { const d = await res.json().catch(() => ({})); errs.set(r._key, d?.error ?? `Failed (${res.status})`); keepSelected.add(r._key); fail++ }
      } catch {
        errs.set(r._key, "Network error"); keepSelected.add(r._key); fail++
      }
    }
    setProgress({ done: toCommit.length, total: toCommit.length })
    setRowErrors(errs)
    setSelected(keepSelected) // drop the rows that landed; keep failures for a retry
    setSummary({ ok, fail })
    setCommitting(false)
    if (ok > 0) onCommitted(ok) // parent refetches the Gantt; failures stay open to fix
    if (fail === 0) onClose()
  }

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/40" onClick={committing ? undefined : onClose}>
      <div className="w-full max-w-5xl bg-white rounded-xl border border-[#E2E8F0] shadow-xl max-h-[92vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[#E2E8F0]">
          <div>
            <h2 className="text-[15px] font-bold text-[#0F172A]">Import schedule PDF</h2>
            {meta && (
              <p className="text-[12px] text-[#64748B] mt-0.5">
                {FAMILY_LABEL[meta.family] ?? meta.family} · {rows.length} task{rows.length === 1 ? "" : "s"} found across {meta.pageCount} page{meta.pageCount === 1 ? "" : "s"}
              </p>
            )}
          </div>
          <button onClick={onClose} disabled={committing} aria-label="Close" className="text-[#94A3B8] hover:text-[#0F172A] disabled:opacity-40">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        {step === "upload" ? (
          <div className="px-5 py-8">
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) parse(f) }}
              onClick={() => fileRef.current?.click()}
              className={`flex flex-col items-center justify-center text-center rounded-xl border-2 border-dashed px-6 py-14 cursor-pointer transition-colors ${dragOver ? "border-[#7B9BB5] bg-[#F4F8FB]" : "border-[#CBD5E1] hover:bg-[#F8FAFC]"}`}
            >
              <div className="w-12 h-12 rounded-full bg-[#EEF2F6] grid place-items-center mb-3">
                <svg className="w-6 h-6 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.9A5 5 0 1115.9 6 4.5 4.5 0 0117 16m-5-4v8m0-8l-3 3m3-3l3 3" /></svg>
              </div>
              <p className="text-[14px] font-semibold text-[#0F172A]">{parsing ? "Reading the schedule…" : "Drop a schedule PDF here, or click to choose"}</p>
              <p className="text-[12px] text-[#64748B] mt-1 max-w-md">MS Project, Primavera P6, or Asta / PowerProject exports with a real text layer (not a scan). Up to 4 MB.</p>
              <input ref={fileRef} type="file" accept="application/pdf,.pdf" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) parse(f) }} />
            </div>
            {parseError && <p className="mt-3 text-[12px] text-red-600">{parseError}</p>}
          </div>
        ) : (
          <>
            {/* Toolbar: filter + select-all + warnings */}
            <div className="px-5 py-3 border-b border-[#E2E8F0] space-y-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative flex-1 min-w-[200px]">
                  <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#94A3B8]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" /></svg>
                  <input
                    value={filter} onChange={(e) => setFilter(e.target.value)}
                    placeholder="Filter your scope — e.g. masonry, framing, flooring…"
                    className="w-full h-8 pl-8 pr-3 rounded-md border border-[#E2E8F0] text-[13px] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 placeholder:text-[#94A3B8]"
                  />
                </div>
                <button onClick={() => setMany(visibleKeys, true)} className="h-8 px-3 rounded-md border border-[#E2E8F0] bg-white text-[12px] font-semibold text-[#0F172A] hover:bg-[#F8FAFC]">Select all {filter ? "shown" : ""}</button>
                <button onClick={() => setMany(visibleKeys, false)} className="h-8 px-3 rounded-md border border-[#E2E8F0] bg-white text-[12px] font-semibold text-[#0F172A] hover:bg-[#F8FAFC]">Clear</button>
              </div>
              {meta && meta.warnings.length > 0 && (
                <div className="text-[12px]">
                  <button onClick={() => setShowWarnings((v) => !v)} className="text-amber-700 font-medium hover:underline">{showWarnings ? "▾" : "▸"} {meta.warnings.length} parser note{meta.warnings.length === 1 ? "" : "s"}</button>
                  {showWarnings && <ul className="mt-1 pl-4 list-disc text-amber-800 space-y-0.5">{meta.warnings.map((wn, i) => <li key={i}>{wn}</li>)}</ul>}
                </div>
              )}
            </div>

            {/* Grouped, filtered, checkable, editable table */}
            <div className="flex-1 overflow-auto">
              {groups.length === 0 ? (
                <p className="px-5 py-10 text-center text-[13px] text-[#64748B]">No tasks match “{filter}”.</p>
              ) : (
                <table className="w-full text-[12px] border-collapse">
                  <thead className="sticky top-0 z-10 bg-[#FAFBFC] text-[10px] font-bold uppercase tracking-wide text-[#64748B]">
                    <tr className="border-b border-[#E2E8F0]">
                      <th className="w-8 px-2 py-2"></th>
                      <th className="text-left px-2 py-2">Task</th>
                      <th className="text-left px-2 py-2 w-32">Start</th>
                      <th className="text-left px-2 py-2 w-32">Finish</th>
                      <th className="text-right px-2 py-2 w-14">%</th>
                      <th className="text-left px-2 py-2 w-24">ID / preds</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((g) => {
                      const keys = g.rows.map((r) => r._key)
                      const selCount = keys.filter((k) => selected.has(k)).length
                      const allSel = selCount === keys.length
                      return (
                        <GroupBlock
                          key={g.phase} phase={g.phase} rows={g.rows}
                          allSelected={allSel} someSelected={selCount > 0 && !allSel}
                          onToggleGroup={() => setMany(keys, !allSel)}
                          selected={selected} onToggleRow={toggleRow}
                          onEdit={updateRow} rowErrors={rowErrors}
                        />
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* Footer: commit */}
            <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-t border-[#E2E8F0]">
              <div className="text-[12px] text-[#64748B]">
                {summary ? (
                  <span className={summary.fail === 0 ? "text-emerald-700" : "text-amber-700"}>
                    Committed {summary.ok}{summary.fail > 0 ? ` · ${summary.fail} failed — fix and retry the rows still checked` : ""}
                  </span>
                ) : committing && progress ? (
                  <span>Committing {progress.done}/{progress.total}…</span>
                ) : (
                  <span><span className="font-semibold text-[#0F172A]">{visibleSelected}</span> checked{visibleSelected !== selected.size ? ` (${selected.size} total)` : ""}</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button onClick={onClose} disabled={committing} className="h-9 px-4 rounded-md border border-[#E2E8F0] bg-white text-[13px] font-semibold text-[#0F172A] hover:bg-[#F8FAFC] disabled:opacity-50">Close</button>
                <button onClick={commit} disabled={committing || selected.size === 0} className="h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] disabled:opacity-50">
                  {committing ? "Committing…" : `Commit ${selected.size} selected task${selected.size === 1 ? "" : "s"}`}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── One phase band + its rows ────────────────────────────────────────────────
function GroupBlock({
  phase, rows, allSelected, someSelected, onToggleGroup, selected, onToggleRow, onEdit, rowErrors,
}: {
  phase: string
  rows: EditableRow[]
  allSelected: boolean
  someSelected: boolean
  onToggleGroup: () => void
  selected: Set<string>
  onToggleRow: (k: string) => void
  onEdit: (k: string, patch: Partial<EditableRow>) => void
  rowErrors: Map<string, string>
}) {
  return (
    <>
      <tr className="bg-[#F4F7FA] border-b border-[#E2E8F0]">
        <td className="px-2 py-1.5 text-center">
          <input type="checkbox" checked={allSelected} ref={(el) => { if (el) el.indeterminate = someSelected }} onChange={onToggleGroup} className="w-3.5 h-3.5 rounded border-[#CBD5E1] text-[#7B9BB5]" />
        </td>
        <td colSpan={5} className="px-2 py-1.5 font-semibold text-[12px] text-[#334155]">
          {phase} <span className="ml-1 font-normal text-[#94A3B8]">{rows.length}</span>
        </td>
      </tr>
      {rows.map((r) => (
        <RowItem key={r._key} row={r} selected={selected.has(r._key)} onToggle={() => onToggleRow(r._key)} onEdit={onEdit} error={rowErrors.get(r._key)} />
      ))}
    </>
  )
}

// Memoized so editing one row doesn't re-render the whole (possibly 400-row) table.
const RowItem = function RowItem({
  row, selected, onToggle, onEdit, error,
}: {
  row: EditableRow
  selected: boolean
  onToggle: () => void
  onEdit: (k: string, patch: Partial<EditableRow>) => void
  error?: string
}) {
  const flag = row.needsReview || !!error
  return (
    <tr className={`border-b border-[#F1F5F9] ${selected ? "bg-[#F4F8FB]" : ""} ${flag ? "bg-amber-50/60" : ""}`}>
      <td className="px-2 py-1 text-center align-top pt-2">
        <input type="checkbox" checked={selected} onChange={onToggle} className="w-3.5 h-3.5 rounded border-[#CBD5E1] text-[#7B9BB5]" />
      </td>
      <td className="px-2 py-1">
        <div className="flex items-center gap-1.5">
          <button
            type="button" title={row.is_milestone ? "Milestone (zero duration)" : "Mark as milestone"}
            onClick={() => onEdit(row._key, { is_milestone: !row.is_milestone })}
            className={`flex-shrink-0 w-3 h-3 rotate-45 rounded-[1px] border ${row.is_milestone ? "bg-[#475569] border-[#334155]" : "bg-transparent border-[#CBD5E1]"}`}
          />
          <input value={row.name} onChange={(e) => onEdit(row._key, { name: e.target.value })} className="flex-1 min-w-0 h-7 px-1.5 rounded border border-transparent hover:border-[#E2E8F0] focus:border-[#7B9BB5] text-[12px] text-[#0F172A] bg-transparent focus:bg-white focus:outline-none" />
        </div>
        {flag && <p className="pl-5 text-[11px] text-amber-700">{error ?? row.reviewReasons.join(" · ")}</p>}
      </td>
      <td className="px-2 py-1 align-top">
        <input type="date" value={row.start_date ?? ""} onChange={(e) => onEdit(row._key, { start_date: e.target.value || null })} className={inputCls + " w-28"} />
      </td>
      <td className="px-2 py-1 align-top">
        <input type="date" value={(row.is_milestone ? row.start_date : row.end_date) ?? ""} disabled={row.is_milestone} onChange={(e) => onEdit(row._key, { end_date: e.target.value || null })} className={inputCls + " w-28 disabled:bg-[#F1F5F9] disabled:text-[#94A3B8]"} />
      </td>
      <td className="px-2 py-1 align-top text-right">
        <input type="number" min={0} max={100} value={row.percent_complete ?? ""} onChange={(e) => onEdit(row._key, { percent_complete: e.target.value === "" ? null : Math.max(0, Math.min(100, Number(e.target.value))) })} className={inputCls + " w-12 text-right"} />
      </td>
      <td className="px-2 py-1 align-top text-[11px] text-[#94A3B8]">
        <div className="truncate max-w-[96px]" title={`${row.wbs_code ?? ""}${row.predecessors_raw ? ` · preds: ${row.predecessors_raw}` : ""}`}>
          {row.wbs_code ?? "—"}
          {row.predecessors_raw && <span className="block text-[#CBD5E1] truncate">⇠ {row.predecessors_raw}</span>}
        </div>
      </td>
    </tr>
  )
}
