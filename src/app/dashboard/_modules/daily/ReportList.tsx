"use client"

// Report list (step 2): desktop table + mobile cards. Presentational —
// all state and handlers live in the DailyModule orchestrator. In the
// desktop two-pane layout the table is the left rail: row click selects
// into the detail pane, so per-row actions stay minimal (they live in the
// detail header). Mobile cards keep their inline action row (one less tap).

import type { DailyReport } from "../../_shared/types"
import { fmtDateOnly } from "../../_shared/format"
import { SpinnerIcon } from "../../_shared/icons"
import { crewHeadcount, isSubmitted } from "./types"

function SyncBadges({ id, pendingIds, syncingCounts, stuckCounts }: {
  id: string
  pendingIds: Set<string>
  syncingCounts: Map<string, number>
  stuckCounts: Map<string, number>
}) {
  return (
    <>
      {pendingIds.has(id) && (
        <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-full align-middle">
          <SpinnerIcon className="h-2.5 w-2.5" /> Pending sync
        </span>
      )}
      {syncingCounts.get(id) ? (
        <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-full align-middle">
          <SpinnerIcon className="h-2.5 w-2.5" /> {syncingCounts.get(id)} syncing
        </span>
      ) : null}
      {stuckCounts.get(id) ? (
        <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-red-700 bg-red-50 border border-red-200 px-1.5 py-0.5 rounded-full align-middle">
          {stuckCounts.get(id)} stuck
        </span>
      ) : null}
    </>
  )
}

function SubmittedBadge({ report }: { report: DailyReport }) {
  // Positive-signal-only: 'submitted' gets a badge; drafts (incl. every
  // legacy pre-0050 row) get NOTHING and render exactly as today.
  if (!isSubmitted(report)) return null
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded-full align-middle">
      <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
      Submitted
    </span>
  )
}

function PhotoCountBadge({ count }: { count: number }) {
  if (!count) return null
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-[#64748B] tabular-nums" title={`${count} photo${count !== 1 ? "s" : ""}`}>
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
        <circle cx="12" cy="13" r="3.2" />
      </svg>
      {count}
    </span>
  )
}

export default function ReportList({ reports, pendingIds, syncingCounts, stuckCounts, photoCounts, selectedId, onSelect, onEdit, onPdf, onDelete, canEdit, generatingPdf, navRegionProps }: {
  reports: DailyReport[]
  pendingIds: Set<string>
  syncingCounts: Map<string, number>
  stuckCounts: Map<string, number>
  photoCounts: Map<string, number>
  selectedId: string | null
  onSelect: (r: DailyReport) => void
  onEdit: (r: DailyReport) => void
  onPdf: (id: string) => void
  onDelete: (id: string) => void
  canEdit: boolean
  generatingPdf: boolean
  navRegionProps?: React.HTMLAttributes<HTMLTableSectionElement>
}) {
  return (
    <>
      {/* Desktop table (left rail of the two-pane layout) */}
      <div className="hidden sm:block mx-3 my-3 rounded-xl border border-[#E2E8F0] overflow-clip bg-white">
        <table className="w-full text-[13px] border-collapse">
          <thead className="sticky top-0 bg-[#F8F9FA] z-10">
            <tr className="border-b border-[#E2E8F0]">
              <th className="text-left px-3 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-9">#</th>
              <th className="text-left px-3 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-32">Date</th>
              <th className="text-left px-3 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest">Work Performed</th>
              <th className="text-left px-3 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-16" title="Manpower">Crew</th>
              <th className="text-left px-3 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-14">📷</th>
            </tr>
          </thead>
          <tbody {...navRegionProps}>
            {reports.map((r, i) => {
              const manpower = r.crew?.length ? crewHeadcount(r.crew) : r.manpower_count
              const isSelected = r.id === selectedId
              return (
                <tr key={r.id} data-nav-item
                  onClick={() => onSelect(r)}
                  className={[
                    "border-b border-[#E2E8F0]/60 transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#7B9BB5]",
                    isSelected ? "bg-[#7B9BB5]/10" : pendingIds.has(r.id) ? "bg-amber-50/40 hover:bg-amber-50/70" : "hover:bg-[#F8F9FA]",
                  ].join(" ")}>
                  <td className="px-3 py-2.5 text-[#64748B] tabular-nums text-[12px]">{reports.length - i}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    <span className="text-[#0F172A] font-medium text-[12px]">{fmtDateOnly(r.report_date)}</span>
                    <span className="ml-2 inline-flex items-center gap-1 flex-wrap">
                      <SubmittedBadge report={r} />
                      <SyncBadges id={r.id} pendingIds={pendingIds} syncingCounts={syncingCounts} stuckCounts={stuckCounts} />
                    </span>
                  </td>
                  <td className="px-3 py-2.5 max-w-0">
                    <p className="text-[#64748B] text-[12px] truncate">{r.work_performed ?? <span className="italic">No description</span>}</p>
                  </td>
                  <td className="px-3 py-2.5 text-[#64748B] text-[12px] text-center tabular-nums">{manpower ?? "—"}</td>
                  <td className="px-3 py-2.5"><PhotoCountBadge count={photoCounts.get(r.id) ?? 0} /></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile card list */}
      <div className="sm:hidden px-3 py-3 space-y-2">
        {reports.map(r => {
          const isPending = pendingIds.has(r.id)
          const manpower = r.crew?.length ? crewHeadcount(r.crew) : r.manpower_count
          return (
            <div key={r.id}
              className={`bg-white rounded-xl border p-3 shadow-sm cursor-pointer ${isPending ? "border-amber-200 bg-amber-50/40" : "border-[#E2E8F0]"}`}
              onClick={() => onSelect(r)}>
              <div className="flex items-start justify-between gap-2 mb-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-[14px] font-semibold text-[#0F172A]">{fmtDateOnly(r.report_date)}</p>
                  <SubmittedBadge report={r} />
                  <SyncBadges id={r.id} pendingIds={pendingIds} syncingCounts={syncingCounts} stuckCounts={stuckCounts} />
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <PhotoCountBadge count={photoCounts.get(r.id) ?? 0} />
                  {manpower != null && <span className="text-[11px] text-[#64748B] whitespace-nowrap">{manpower} workers</span>}
                </div>
              </div>
              {r.work_performed && <p className="text-[12px] text-[#64748B] mb-1 line-clamp-2">{r.work_performed}</p>}
              <div className="flex items-center gap-3 text-[11px] text-[#64748B] mb-2">
                {r.prepared_by && <span>{r.prepared_by}</span>}
                {r.weather_conditions && <span>{r.weather_conditions}{r.temperature ? ` · ${r.temperature}` : ""}</span>}
              </div>
              {!isPending && (
                <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                  {canEdit && (
                    <button onClick={() => onEdit(r)} className="text-[12px] text-[#64748B] px-3 py-2 rounded border border-[#E2E8F0] bg-[#F8F9FA]">Edit</button>
                  )}
                  <button onClick={() => onPdf(r.id)} disabled={generatingPdf} className="text-[12px] text-[#7B9BB5] px-3 py-2 rounded border border-[#E2E8F0] bg-[#F8F9FA] disabled:opacity-50">PDF</button>
                  {canEdit && (
                    <button onClick={() => onDelete(r.id)} className="text-[12px] text-red-400 px-3 py-2 rounded border border-[#E2E8F0] bg-[#F8F9FA]">Del</button>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}
