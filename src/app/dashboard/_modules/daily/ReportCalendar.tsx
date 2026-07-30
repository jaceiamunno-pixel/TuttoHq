"use client"

// Month-grid calendar per project (step 4j — usable pre-0050: dots need
// only report_date; the submitted-✓ distinction lights up once status
// exists). Gaps are made obvious: past workdays with no report get an
// amber tint, and the summary line counts workdays reported.

import { useMemo } from "react"
import type { DailyReport } from "../../_shared/types"
import { isSubmitted } from "./types"

const WEEKDAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"]

function ymd(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${d.getFullYear()}-${m}-${day}`
}

export default function ReportCalendar({ reports, month, onMonth, selectedId, onSelect, onNewForDate, canEdit }: {
  reports: DailyReport[]
  /** First-of-month Date for the displayed month. */
  month: Date
  onMonth: (m: Date) => void
  selectedId: string | null
  onSelect: (r: DailyReport) => void
  /** Tap an empty past/today workday → new report pinned to that date. */
  onNewForDate?: (dateISO: string) => void
  canEdit: boolean
}) {
  const y = month.getFullYear()
  const m0 = month.getMonth()

  const byDay = useMemo(() => {
    const map = new Map<string, DailyReport[]>()
    for (const r of reports) {
      const key = (r.report_date || "").slice(0, 10)
      if (!key) continue
      const list = map.get(key)
      if (list) list.push(r); else map.set(key, [r])
    }
    return map
  }, [reports])

  const today = new Date(); today.setHours(0, 0, 0, 0)
  const todayKey = ymd(today)
  const first = new Date(y, m0, 1)
  const daysInMonth = new Date(y, m0 + 1, 0).getDate()
  const leadingBlanks = first.getDay()

  // Summary: Mon–Fri days elapsed in this month (through today) vs. how
  // many of them have at least one report.
  const summary = useMemo(() => {
    let workdays = 0, reported = 0
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(y, m0, d)
      if (date.getTime() > today.getTime()) break
      const dow = date.getDay()
      if (dow === 0 || dow === 6) continue
      workdays++
      if (byDay.has(ymd(date))) reported++
    }
    return { workdays, reported }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byDay, y, m0, daysInMonth])

  const monthLabel = first.toLocaleDateString("en-US", { month: "long", year: "numeric" })

  const cells: (number | null)[] = [
    ...Array.from({ length: leadingBlanks }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ]

  return (
    <div className="p-3 sm:p-4">
      <div className="flex items-center justify-between mb-2">
        <button onClick={() => onMonth(new Date(y, m0 - 1, 1))} aria-label="Previous month"
          className="h-9 w-9 rounded-md text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors text-[15px]">‹</button>
        <p className="text-[13px] font-bold text-[#0F172A]">{monthLabel}</p>
        <button onClick={() => onMonth(new Date(y, m0 + 1, 1))} aria-label="Next month"
          className="h-9 w-9 rounded-md text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors text-[15px]">›</button>
      </div>

      <div className="grid grid-cols-7 mb-1">
        {WEEKDAY_LABELS.map((d, i) => (
          <span key={i} className="text-center text-[10px] font-bold text-[#64748B] uppercase">{d}</span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((day, i) => {
          if (day == null) return <div key={`b${i}`} />
          const date = new Date(y, m0, day)
          const key = ymd(date)
          const dayReports = byDay.get(key) ?? []
          const has = dayReports.length > 0
          const allSubmitted = has && dayReports.every(isSubmitted)
          const dow = date.getDay()
          const isWeekend = dow === 0 || dow === 6
          const isPast = date.getTime() < today.getTime()
          const isToday = key === todayKey
          const isSelected = has && dayReports.some(r => r.id === selectedId)
          const isGap = !has && isPast && !isWeekend

          const clickable = has || (!!onNewForDate && canEdit && !isWeekend && date.getTime() <= today.getTime())
          return (
            <button key={key} type="button" disabled={!clickable}
              onClick={() => {
                if (has) onSelect(dayReports[0])
                else if (onNewForDate) onNewForDate(key)
              }}
              title={has ? `${dayReports.length} report${dayReports.length > 1 ? "s" : ""} — ${key}` : isGap ? `No report — ${key}` : key}
              className={[
                "relative h-12 sm:h-11 rounded-md border text-left px-1.5 pt-1 transition-colors",
                isSelected ? "border-[#7B9BB5] bg-[#7B9BB5]/15 ring-1 ring-[#7B9BB5]/40"
                  : has ? "border-[#E2E8F0] bg-white hover:bg-[#7B9BB5]/10"
                  : isGap ? "border-amber-200/70 bg-amber-50/60 hover:bg-amber-50"
                  : "border-transparent bg-[#F8F9FA]",
                isWeekend && !has ? "opacity-55" : "",
                clickable ? "cursor-pointer" : "cursor-default",
              ].join(" ")}>
              <span className={`text-[11px] tabular-nums ${isToday ? "font-bold text-[#7B9BB5]" : has ? "font-semibold text-[#0F172A]" : "text-[#64748B]"}`}>
                {day}
              </span>
              <span className="absolute bottom-1 left-1/2 -translate-x-1/2 flex items-center gap-0.5">
                {has && (allSubmitted ? (
                  <svg className="w-3.5 h-3.5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <span className="w-2 h-2 rounded-full bg-[#7B9BB5]" />
                ))}
                {dayReports.length > 1 && <span className="text-[9px] font-bold text-[#64748B]">×{dayReports.length}</span>}
              </span>
            </button>
          )
        })}
      </div>

      <p className="mt-3 text-[12px] text-[#64748B] text-center">
        <span className={`font-semibold ${summary.reported === summary.workdays && summary.workdays > 0 ? "text-emerald-600" : "text-[#0F172A]"}`}>
          {summary.reported} of {summary.workdays}
        </span>{" "}
        workday{summary.workdays !== 1 ? "s" : ""} reported this month
      </p>
    </div>
  )
}
