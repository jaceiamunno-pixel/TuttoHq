"use client"

// New / Edit composer (steps 3a, 3b, 3d): a single-column sectioned sheet.
// Full-screen on mobile with a sticky bottom Save bar and 44px+ targets;
// a centered modal on sm+. Sections collapse (mobile starts with the
// core sections open) and show a completion dot once they hold content.
//
// Presentational: form state, draft persistence, and the offline-first
// create path all live in the DailyModule orchestrator.

import { useMemo, useState } from "react"
import { DAILY_0050_LIVE, DAILY_0051_LIVE } from "@/lib/daily-flags"
import type { DailyDraftPhotoRow } from "@/lib/idb-photos"
import type { TeamMember } from "../../_shared/types"
import { SpinnerIcon, XIcon } from "../../_shared/icons"
import CrewSection from "./CrewSection"
import WeatherField from "./WeatherField"
import LaborField from "./LaborField"
import { DraftPhotoGrid } from "./PhotoSection"
import { fieldCls, selectCls, tareaCls, labelCls } from "./ui"
import { fmtDateOnly } from "../../_shared/format"
import { nonEmptyCrew, type DailyForm } from "./types"

interface SectionDef {
  id: string
  label: string
  filled: boolean
  defaultOpenMobile: boolean
}

function Section({ def, open, onToggle, children }: {
  def: SectionDef
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div className="border border-[#E2E8F0] rounded-lg overflow-clip bg-white">
      <button type="button" onClick={onToggle} aria-expanded={open}
        className="w-full h-11 px-4 flex items-center justify-between gap-2 bg-[#F8F9FA] hover:bg-[#F1F3F5] transition-colors">
        <span className="flex items-center gap-2 text-[12px] font-bold text-[#0F172A] uppercase tracking-wider">
          {def.label}
          {def.filled && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" title="Has content" />}
        </span>
        <svg className={`w-4 h-4 text-[#64748B] transition-transform ${open ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && <div className="px-4 py-3 space-y-3">{children}</div>}
    </div>
  )
}

export default function ReportComposer({ mode, form, patch, teamMembers, projectLocation, canEdit, saving, saveError, draftPhotos, compressProgress, photoError, onIngestPhotos, fileRef, copySource, onCopyLast, onSave, onClose }: {
  mode: "new" | "edit"
  form: DailyForm
  patch: (p: Partial<DailyForm>) => void
  teamMembers: TeamMember[]
  projectLocation: string | null
  canEdit: boolean
  saving: boolean
  saveError: string
  draftPhotos: DailyDraftPhotoRow[]
  compressProgress: { done: number; total: number } | null
  photoError: string
  onIngestPhotos: (files: File[]) => void
  fileRef: React.RefObject<HTMLInputElement | null>
  copySource: { date: string } | null
  onCopyLast: () => void
  onSave: (e: React.FormEvent) => void
  onClose: () => void
}) {
  const isNew = mode === "new"
  const crewOn = DAILY_0050_LIVE
  // Labor on Site (0051 labor_notes) hides until the column exists — a value
  // typed pre-migration would be silently dropped server-side.
  const laborOn = DAILY_0051_LIVE

  // Auto-context split (feat/daily-report-context): Deliveries and Delays are
  // their own lightweight sections (same materials_delivered / issues_delays
  // columns as before — labels only, no schema change).
  const sections: SectionDef[] = useMemo(() => [
    { id: "basics",     label: "Basics",                filled: !!form.prepared_by, defaultOpenMobile: true },
    { id: "weather",    label: "Weather",               filled: !!form.weather_conditions || !!form.temperature, defaultOpenMobile: true },
    { id: "crew",       label: crewOn ? "Crew" : "Manpower", filled: crewOn ? nonEmptyCrew(form.crew).length > 0 : !!form.manpower_count, defaultOpenMobile: true },
    ...(laborOn ? [{ id: "labor", label: "Labor on Site", filled: !!form.labor_notes.trim(), defaultOpenMobile: true }] : []),
    { id: "work",       label: "Work Performed",        filled: !!form.work_performed.trim(), defaultOpenMobile: true },
    { id: "equipment",  label: "Equipment",             filled: !!form.equipment.trim(), defaultOpenMobile: false },
    { id: "deliveries", label: "Deliveries",            filled: !!form.materials_delivered.trim(), defaultOpenMobile: false },
    { id: "delays",     label: "Delays",                filled: !!form.issues_delays.trim(), defaultOpenMobile: false },
    { id: "visitors",   label: "Visitors / Inspections", filled: !!form.visitors.trim(), defaultOpenMobile: false },
    { id: "safety",     label: "Safety",                filled: !!form.safety_notes.trim(), defaultOpenMobile: false },
    ...(isNew ? [{ id: "photos", label: "Photos & Attachment", filled: draftPhotos.length > 0, defaultOpenMobile: true }] : []),
  ], [form, crewOn, laborOn, isNew, draftPhotos.length])

  const sec = (id: string) => sections.find(s => s.id === id)

  // Collapse state: mobile starts with the core capture sections open;
  // desktop starts fully expanded. Evaluated once on mount.
  const [openMap, setOpenMap] = useState<Record<string, boolean>>(() => {
    const mobile = typeof window !== "undefined" && window.innerWidth < 640
    const map: Record<string, boolean> = {}
    for (const s of [
      "basics", "weather", "crew", "labor", "work", "equipment", "deliveries", "delays", "visitors", "safety", "photos",
    ]) map[s] = mobile ? ["basics", "weather", "crew", "labor", "work", "photos"].includes(s) : true
    return map
  })
  const toggle = (id: string) => setOpenMap(m => ({ ...m, [id]: !m[id] }))

  const filledCount = sections.filter(s => s.filled).length

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-[#F8F9FA] sm:rounded-xl border-0 sm:border border-[#E2E8F0] shadow-2xl w-full h-full sm:h-auto sm:w-[680px] sm:mx-0 sm:max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 sm:px-6 pt-4 sm:pt-5 pb-3 border-b border-[#E2E8F0] bg-white flex-shrink-0">
          <div>
            <h2 className="text-[15px] font-bold text-[#0F172A]">{isNew ? "New Daily Report" : "Edit Daily Report"}</h2>
            <p className="text-[11px] text-[#64748B] mt-0.5">{filledCount} of {sections.length} sections filled</p>
          </div>
          <div className="flex items-center gap-2">
            {isNew && copySource && canEdit && (
              <button type="button" onClick={onCopyLast}
                title="Prefill crew, labor and every text section from the most recent report — edit what changed. Never copies photos or weather."
                className="h-9 sm:h-8 px-3 rounded-md border border-[#7B9BB5]/40 text-[12px] text-[#7B9BB5] font-medium hover:bg-[#7B9BB5]/10 transition-colors">
                ⧉ Copy from {fmtDateOnly(copySource.date)}
              </button>
            )}
            <button onClick={onClose} aria-label="Close composer" className="h-9 w-9 rounded-md text-[#64748B] hover:text-[#0F172A] hover:bg-[#0F172A]/[0.04] transition-colors flex items-center justify-center">
              <XIcon className="h-4 w-4" />
            </button>
          </div>
        </div>

        <form onSubmit={onSave} className="flex flex-col flex-1 min-h-0">
          <div className="px-3 sm:px-6 py-3 sm:py-4 space-y-3 overflow-y-auto flex-1 min-h-0">

            <Section def={sec("basics")!} open={!!openMap.basics} onToggle={() => toggle("basics")}>
              {/* No project picker: the module is locked to the route's
                  active project — the draft carries its project_id from
                  mint time (DailyModule.openNewDailyDraft). */}
              <div className="sm:w-40">
                <label className={labelCls}>Date <span className="text-red-400">*</span></label>
                <input type="date" required value={form.report_date} disabled={!canEdit}
                  onChange={e => patch({ report_date: e.target.value })} className={fieldCls} />
              </div>
              <div>
                <label className={labelCls}>Prepared By</label>
                <select value={form.prepared_by} disabled={!canEdit} onChange={e => patch({ prepared_by: e.target.value })} className={selectCls}>
                  <option value="">Select…</option>
                  {teamMembers.map(m => <option key={m.id} value={m.name}>{m.name}</option>)}
                  {form.prepared_by && !teamMembers.some(m => m.name === form.prepared_by) && (
                    <option value={form.prepared_by}>{form.prepared_by}</option>
                  )}
                </select>
              </div>
            </Section>

            <Section def={sec("weather")!} open={!!openMap.weather} onToggle={() => toggle("weather")}>
              <WeatherField
                weather={form.weather_conditions}
                temperature={form.temperature}
                onWeather={v => patch({ weather_conditions: v })}
                onTemperature={v => patch({ temperature: v })}
                reportDate={form.report_date}
                projectLocation={projectLocation}
                canEdit={canEdit}
              />
            </Section>

            <Section def={sec("crew")!} open={!!openMap.crew} onToggle={() => toggle("crew")}>
              {crewOn ? (
                <>
                  <CrewSection crew={form.crew} onChange={crew => patch({ crew })} canEdit={canEdit} />
                  {nonEmptyCrew(form.crew).length === 0 && (
                    <div className="sm:w-40">
                      <label className={labelCls}>Manpower (total)</label>
                      <input type="number" min={0} inputMode="numeric" value={form.manpower_count} disabled={!canEdit}
                        onChange={e => patch({ manpower_count: e.target.value })} placeholder="# workers" className={fieldCls} />
                    </div>
                  )}
                </>
              ) : (
                <div className="sm:w-40">
                  <label className={labelCls}>Manpower</label>
                  <input type="number" min={0} inputMode="numeric" value={form.manpower_count} disabled={!canEdit}
                    onChange={e => patch({ manpower_count: e.target.value })} placeholder="# workers" className={fieldCls} />
                </div>
              )}
            </Section>

            {laborOn && (
              <Section def={sec("labor")!} open={!!openMap.labor} onToggle={() => toggle("labor")}>
                <LaborField
                  value={form.labor_notes}
                  onChange={v => patch({ labor_notes: v })}
                  projectId={form.project_id}
                  reportDate={form.report_date}
                  canEdit={canEdit}
                />
              </Section>
            )}

            <Section def={sec("work")!} open={!!openMap.work} onToggle={() => toggle("work")}>
              <textarea rows={4} value={form.work_performed} disabled={!canEdit}
                onChange={e => patch({ work_performed: e.target.value })}
                placeholder="Describe the work completed on site today…" className={tareaCls} />
            </Section>

            <Section def={sec("equipment")!} open={!!openMap.equipment} onToggle={() => toggle("equipment")}>
              <textarea rows={2} value={form.equipment} disabled={!canEdit}
                onChange={e => patch({ equipment: e.target.value })}
                placeholder="List equipment used…" className={tareaCls} />
            </Section>

            <Section def={sec("deliveries")!} open={!!openMap.deliveries} onToggle={() => toggle("deliveries")}>
              <textarea rows={2} value={form.materials_delivered} disabled={!canEdit}
                onChange={e => patch({ materials_delivered: e.target.value })}
                placeholder="Materials and deliveries received…" className={tareaCls} />
            </Section>

            <Section def={sec("delays")!} open={!!openMap.delays} onToggle={() => toggle("delays")}>
              <textarea rows={2} value={form.issues_delays} disabled={!canEdit}
                onChange={e => patch({ issues_delays: e.target.value })}
                placeholder="Any delays, problems, or concerns…" className={tareaCls} />
            </Section>

            <Section def={sec("visitors")!} open={!!openMap.visitors} onToggle={() => toggle("visitors")}>
              <textarea rows={2} value={form.visitors} disabled={!canEdit}
                onChange={e => patch({ visitors: e.target.value })}
                placeholder="Inspectors, owner reps, visitors…" className={tareaCls} />
            </Section>

            <Section def={sec("safety")!} open={!!openMap.safety} onToggle={() => toggle("safety")}>
              <textarea rows={2} value={form.safety_notes} disabled={!canEdit}
                onChange={e => patch({ safety_notes: e.target.value })}
                placeholder="Safety observations, incidents, toolbox talks…" className={tareaCls} />
            </Section>

            {isNew && sec("photos") && (
              <Section def={sec("photos")!} open={!!openMap.photos} onToggle={() => toggle("photos")}>
                <DraftPhotoGrid
                  photos={draftPhotos}
                  compressProgress={compressProgress}
                  error={photoError}
                  onIngest={onIngestPhotos}
                  canEdit={canEdit}
                />
                <div className="pt-2 border-t border-[#E2E8F0]">
                  <label className={labelCls}>Attachment <span className="text-[#64748B] font-normal normal-case">(optional, non-photo)</span></label>
                  <input ref={fileRef} type="file" disabled={!canEdit}
                    className="w-full text-[12px] text-[#64748B] file:mr-3 file:py-2 file:px-3 file:rounded file:border file:border-[#E2E8F0] file:bg-[#F4F5F7] file:text-[#64748B] file:text-[11px] file:cursor-pointer hover:file:bg-white/[0.05]" />
                </div>
              </Section>
            )}
          </div>

          {/* Sticky bottom save bar */}
          <div className="flex items-center justify-between gap-2 px-4 sm:px-6 py-3 sm:py-4 border-t border-[#E2E8F0] bg-white flex-shrink-0 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {isNew && compressProgress ? (
              <p className="text-[12px] text-[#64748B] flex-1 mr-2 flex items-center gap-1.5">
                <SpinnerIcon className="h-3 w-3" /> Processing {Math.min(compressProgress.done + 1, compressProgress.total)} of {compressProgress.total} photos… Save enables when done.
              </p>
            ) : saveError ? (
              <p className="text-[12px] text-red-500 flex-1 mr-2">{saveError}</p>
            ) : <span />}
            <div className="flex gap-2 flex-shrink-0">
              <button type="button" onClick={onClose}
                className="h-11 sm:h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors">
                Cancel
              </button>
              <button type="submit" disabled={!canEdit || saving || !!compressProgress}
                className="h-11 sm:h-8 px-5 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 flex items-center gap-2">
                {saving && <SpinnerIcon className="h-3 w-3" />}
                {isNew ? (saving ? "Creating…" : "Create Report") : (saving ? "Saving…" : "Save Changes")}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
