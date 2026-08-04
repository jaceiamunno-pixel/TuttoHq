"use client"

// "Labor on Site" textarea with manpower-schedule prefill (auto-context,
// 0051). Reads that date's manpower_assignments for the report's project —
// the same rows the manpower calendar shows — and summarizes crew/worker
// counts by trade into editable text. READ-ONLY against manpower: nothing
// here ever writes back to the manpower tables.
//
// Prefill contract mirrors WeatherField:
//   - Auto-fill fires only while the field is untouched (empty, or still
//     equal to the last auto summary) — a manual edit wins for the session.
//   - Every failure (offline, no project, no assignments) is silent: the
//     field stays a plain textarea and save never blocks.

import { useEffect, useRef, useState } from "react"
import { tareaCls } from "./ui"
import { SpinnerIcon } from "../../_shared/icons"

interface AssignmentRow {
  assignee_type: "worker" | "vendor"
  crew_size: number | null
  worker: { full_name: string | null; trade: string | null } | null
  vendor: { company_name: string | null } | null
}

/** Crew/worker counts by trade, one line each, with a total. Workers count 1
 *  under their trade; vendor crews count crew_size under the company name —
 *  the same headcount rule the manpower calendar uses. */
export function buildLaborSummary(assignments: AssignmentRow[]): string | null {
  const byTrade = new Map<string, number>()
  const vendorLines: string[] = []
  let total = 0
  for (const a of assignments) {
    if (a.assignee_type === "vendor") {
      const n = a.crew_size ?? 1
      vendorLines.push(`${a.vendor?.company_name || "Vendor crew"}: ${n}`)
      total += n
    } else {
      const trade = a.worker?.trade?.trim() || "General labor"
      byTrade.set(trade, (byTrade.get(trade) ?? 0) + 1)
      total += 1
    }
  }
  if (total === 0) return null
  return [
    ...[...byTrade.entries()].map(([trade, n]) => `${trade}: ${n}`),
    ...vendorLines,
    `Total on site: ${total}`,
  ].join("\n")
}

async function fetchLaborSummary(projectId: string, dateISO: string): Promise<string | null> {
  try {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return null
    const res = await fetch(
      `/api/manpower-assignments?project_id=${encodeURIComponent(projectId)}&from=${dateISO}&to=${dateISO}`,
      { signal: AbortSignal.timeout(8_000) },
    )
    if (!res.ok) return null
    const data = await res.json() as { assignments?: AssignmentRow[] }
    return buildLaborSummary(data.assignments ?? [])
  } catch {
    return null
  }
}

export default function LaborField({ value, onChange, projectId, reportDate, canEdit }: {
  value: string
  onChange: (v: string) => void
  projectId: string
  reportDate: string
  canEdit: boolean
}) {
  const [fetching, setFetching] = useState(false)
  const [lastAuto, setLastAuto] = useState<string | null>(null)
  const currentRef = useRef(value)
  currentRef.current = value
  const lastAutoRef = useRef<string | null>(null)
  useEffect(() => { lastAutoRef.current = lastAuto }, [lastAuto])
  const seqRef = useRef(0)

  async function runPrefill(force: boolean) {
    if (!projectId || !canEdit) return
    const untouched = currentRef.current === "" || currentRef.current === lastAutoRef.current
    if (!force && !untouched) return
    const seq = ++seqRef.current
    setFetching(true)
    const summary = await fetchLaborSummary(projectId, reportDate)
    if (seq !== seqRef.current) return // superseded by a newer request
    setFetching(false)
    if (!summary) return
    onChange(summary)
    setLastAuto(summary)
  }

  // Auto-attempt whenever the date or project changes (and on first open).
  useEffect(() => {
    runPrefill(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, reportDate])

  const isAuto = !!lastAuto && value === lastAuto

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        {/* labelCls minus its bottom margin — the flex row owns the spacing */}
        <label className="block text-[11px] font-semibold text-[#64748B] uppercase tracking-[0.08em]">
          Labor on Site
          {isAuto && (
            <span className="ml-2 normal-case tracking-normal inline-flex items-center gap-1 text-[10px] font-semibold text-sky-700 bg-sky-50 border border-sky-200 px-1.5 py-0.5 rounded-full" title="Prefilled from the manpower schedule — edit freely">
              ⚡ From schedule
            </span>
          )}
          {fetching && <SpinnerIcon className="ml-2 inline h-3 w-3 text-[#64748B]" />}
        </label>
        {projectId && canEdit && (
          <button type="button" onClick={() => runPrefill(true)} disabled={fetching}
            title="Pull this date's crew from the manpower schedule"
            className="h-7 px-2.5 rounded-md border border-[#E2E8F0] text-[11px] text-[#64748B] bg-[#F4F5F7] hover:bg-white/50 transition-colors disabled:opacity-50 flex-shrink-0">
            {fetching ? <SpinnerIcon className="h-3 w-3" /> : "Prefill"}
          </button>
        )}
      </div>
      <textarea rows={3} value={value} disabled={!canEdit}
        onChange={e => onChange(e.target.value)}
        placeholder={projectId ? "Crew counts by trade — prefills from the manpower schedule…" : "Crew counts by trade…"}
        className={tareaCls} />
    </div>
  )
}
