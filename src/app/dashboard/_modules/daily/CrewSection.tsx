"use client"

// Crew breakdown (step 4f, schema-gated by DAILY_0050_LIVE): repeating
// trade / headcount / hours rows persisted to daily_reports.crew (jsonb).
// The derived headcount total is written to manpower_count on save so the
// existing list / PDF / export readers keep working unchanged.

import { crewHeadcount, crewHours, type CrewRow } from "./types"
import { fieldCls, labelCls, btnGhostCls } from "./ui"
import { XIcon } from "../../_shared/icons"

export default function CrewSection({ crew, onChange, canEdit }: {
  crew: CrewRow[]
  onChange: (crew: CrewRow[]) => void
  canEdit: boolean
}) {
  function patchRow(i: number, patch: Partial<CrewRow>) {
    onChange(crew.map((r, idx) => idx === i ? { ...r, ...patch } : r))
  }
  const totalCount = crewHeadcount(crew)
  const totalHours = crewHours(crew)

  return (
    <div>
      {crew.length > 0 && (
        <div className="space-y-2 mb-2">
          <div className="grid grid-cols-[1fr_72px_72px_32px] gap-2 items-center">
            <span className={labelCls + " mb-0"}>Trade / Crew</span>
            <span className={labelCls + " mb-0"}>Count</span>
            <span className={labelCls + " mb-0"}>Hours</span>
            <span />
          </div>
          {crew.map((row, i) => (
            <div key={i} className="grid grid-cols-[1fr_72px_72px_32px] gap-2 items-center">
              <input type="text" value={row.trade} onChange={e => patchRow(i, { trade: e.target.value })}
                placeholder="e.g. Electricians" disabled={!canEdit} className={fieldCls} />
              <input type="number" min={0} inputMode="numeric" value={row.count ?? ""}
                onChange={e => patchRow(i, { count: e.target.value === "" ? null : Math.max(0, parseInt(e.target.value) || 0) })}
                placeholder="#" disabled={!canEdit} className={fieldCls + " px-2 text-center"} />
              <input type="number" min={0} step="0.5" inputMode="decimal" value={row.hours ?? ""}
                onChange={e => patchRow(i, { hours: e.target.value === "" ? null : Math.max(0, parseFloat(e.target.value) || 0) })}
                placeholder="hrs" disabled={!canEdit} className={fieldCls + " px-2 text-center"} />
              {canEdit ? (
                <button type="button" onClick={() => onChange(crew.filter((_, idx) => idx !== i))}
                  aria-label={`Remove crew row ${i + 1}`}
                  className="h-11 sm:h-9 w-8 rounded-md text-[#64748B] hover:text-red-500 hover:bg-red-50 transition-colors flex items-center justify-center">
                  <XIcon className="h-3.5 w-3.5" />
                </button>
              ) : <span />}
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        {canEdit && (
          <button type="button" onClick={() => onChange([...crew, { trade: "", count: null, hours: null }])}
            className={btnGhostCls}>
            + Add Crew Row
          </button>
        )}
        {crew.length > 0 && (
          <span className="text-[12px] text-[#0F172A] font-medium tabular-nums">
            Total: {totalCount} worker{totalCount !== 1 ? "s" : ""}{totalHours > 0 ? ` · ${totalHours} hrs` : ""}
          </span>
        )}
      </div>
    </div>
  )
}
