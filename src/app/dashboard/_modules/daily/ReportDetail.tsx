"use client"

// Report detail (step 2 + 3e + 4g): the right pane on desktop, a modal
// sheet on mobile. Presentational — the orchestrator owns the wrapper
// (backdrop/focus trap for the modal variant) and every handler.
//
// Draft→submitted display is positive-signal-only: 'submitted' adds the
// lock banner / badge; a draft (incl. every legacy pre-0050 row) renders
// exactly like today's read view, plus a Submit action when 0050 is live.

import { DAILY_0050_LIVE } from "@/lib/daily-flags"
import type { DailyDraftPhotoRow } from "@/lib/idb-photos"
import type { DailyReport } from "../../_shared/types"
import { fmtDateOnly } from "../../_shared/format"
import { SpinnerIcon, XIcon } from "../../_shared/icons"
import { SavedPhotoGrid } from "./PhotoSection"
import { crewHeadcount, crewHours, editedAfterSubmit, isSubmitted, type ServerPhoto } from "./types"

function fmtStamp(iso: string | null | undefined): string {
  if (!iso) return ""
  const d = new Date(iso)
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`
}

export default function ReportDetail({ report, pendingSync, photos, photosLoading, idbPhotos, inFlightIds, photoUploading, canEdit, generatingPdf, submitting, userNames, onClose, onEdit, onPdf, onDelete, onSubmit, onAddPhotos, onDeletePhoto, onCaption }: {
  report: DailyReport
  pendingSync: boolean
  photos: ServerPhoto[]
  photosLoading: boolean
  idbPhotos: DailyDraftPhotoRow[]
  inFlightIds: ReadonlySet<string>
  photoUploading: boolean
  canEdit: boolean
  generatingPdf: boolean
  submitting: boolean
  userNames: Record<string, string>
  onClose: () => void
  onEdit: (r: DailyReport) => void
  onPdf: (id: string) => void
  onDelete: (id: string) => void
  onSubmit: (id: string) => void
  onAddPhotos: (files: File[]) => void
  onDeletePhoto: (photoId: string) => void
  onCaption: (photoId: string, caption: string) => void
}) {
  const submitted = isSubmitted(report)
  const showSubmit = DAILY_0050_LIVE && canEdit && !submitted && !pendingSync
  const crew = report.crew ?? []

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 px-4 sm:px-6 pt-4 pb-3 border-b border-[#E2E8F0] flex-shrink-0">
        <div className="min-w-0">
          <p className="text-[11px] text-[#64748B] uppercase tracking-widest font-bold">Daily Report</p>
          <h2 className="text-[16px] font-bold text-[#0F172A] mt-0.5 flex items-center gap-2 flex-wrap">
            {fmtDateOnly(report.report_date)}
            {pendingSync && (
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-full">
                <SpinnerIcon className="h-2.5 w-2.5" /> Pending sync
              </span>
            )}
            {submitted && (
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded-full">
                <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                Submitted
              </span>
            )}
          </h2>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0 flex-wrap justify-end">
          {!pendingSync && (
            <>
              {showSubmit && (
                <button onClick={() => onSubmit(report.id)} disabled={submitting}
                  className="h-9 sm:h-7 px-3 rounded-md bg-emerald-600 text-[12px] font-semibold text-white hover:bg-emerald-700 transition-colors disabled:opacity-50 flex items-center gap-1.5">
                  {submitting && <SpinnerIcon className="h-3 w-3" />} Submit
                </button>
              )}
              {canEdit && (
                <button onClick={() => onEdit(report)}
                  className="h-9 sm:h-7 px-3 rounded-md border border-[#E2E8F0] text-[12px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors">
                  Edit
                </button>
              )}
              <button onClick={() => onPdf(report.id)} disabled={generatingPdf}
                className="h-9 sm:h-7 px-3 rounded-md border border-[#E2E8F0] text-[12px] text-[#7B9BB5] hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50 flex items-center gap-1.5">
                {generatingPdf ? <><SpinnerIcon className="h-3 w-3" />Generating…</> : "PDF"}
              </button>
              {canEdit && (
                <button onClick={() => onDelete(report.id)}
                  className="h-9 sm:h-7 px-3 rounded-md border border-red-200 text-[12px] text-red-500 hover:bg-red-50 transition-colors">
                  Delete
                </button>
              )}
            </>
          )}
          <button onClick={onClose} aria-label="Close report" className="h-9 w-9 sm:h-7 sm:w-7 rounded-md text-[#64748B] hover:text-[#0F172A] hover:bg-[#0F172A]/[0.04] transition-colors flex items-center justify-center">
            <XIcon className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="px-4 sm:px-6 py-4 space-y-4 overflow-y-auto flex-1 min-h-0">
        {/* Submitted lock banner + edited-after-submission attribution (4g) */}
        {submitted && (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-[12px] text-emerald-800 flex items-center gap-2">
            <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
            <span>
              Submitted {fmtStamp(report.submitted_at)}
              {report.submitted_by && userNames[report.submitted_by] ? ` by ${userNames[report.submitted_by]}` : ""}
            </span>
          </div>
        )}
        {editedAfterSubmit(report) && (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-2.5 text-[12px] text-amber-800">
            Edited after submission — {fmtStamp(report.updated_at)}
            {report.updated_by && userNames[report.updated_by] ? ` by ${userNames[report.updated_by]}` : ""}
          </div>
        )}

        {/* Meta row */}
        <div className="flex flex-wrap gap-4 text-[12px]">
          {report.prepared_by && <span><span className="text-[#64748B]">Prepared by: </span><span className="text-[#0F172A]">{report.prepared_by}</span></span>}
          {report.weather_conditions && <span><span className="text-[#64748B]">Weather: </span><span className="text-[#0F172A]">{report.weather_conditions}{report.temperature ? ` · ${report.temperature}` : ""}</span></span>}
          {(crew.length > 0 || report.manpower_count != null) && (
            <span><span className="text-[#64748B]">Manpower: </span><span className="text-[#0F172A]">{crew.length > 0 ? crewHeadcount(crew) : report.manpower_count} workers</span></span>
          )}
        </div>

        {/* Crew breakdown (4f) */}
        {crew.length > 0 && (
          <div className="rounded-md border border-[#E2E8F0] overflow-clip">
            <table className="w-full text-[12px]">
              <thead className="bg-[#F8F9FA]">
                <tr className="border-b border-[#E2E8F0]">
                  <th className="text-left px-3 py-2 text-[10px] font-bold text-[#64748B] uppercase tracking-widest">Trade / Crew</th>
                  <th className="text-right px-3 py-2 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-20">Count</th>
                  <th className="text-right px-3 py-2 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-20">Hours</th>
                </tr>
              </thead>
              <tbody>
                {crew.map((row, i) => (
                  <tr key={i} className="border-b border-[#E2E8F0]/60 last:border-0">
                    <td className="px-3 py-2 text-[#0F172A]">{row.trade || "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-[#0F172A]">{row.count ?? "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-[#0F172A]">{row.hours ?? "—"}</td>
                  </tr>
                ))}
                <tr className="bg-[#F8F9FA] font-semibold">
                  <td className="px-3 py-2 text-[#0F172A]">Total</td>
                  <td className="px-3 py-2 text-right tabular-nums text-[#0F172A]">{crewHeadcount(crew)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-[#0F172A]">{crewHours(crew) || "—"}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}

        {[
          { label: "Work Performed", value: report.work_performed },
          { label: "Equipment on Site", value: report.equipment },
          { label: "Materials Delivered", value: report.materials_delivered },
          { label: "Visitors / Inspections", value: report.visitors },
          { label: "Issues / Delays", value: report.issues_delays },
          { label: "Safety Notes", value: report.safety_notes },
        ].filter(f => f.value).map(f => (
          <div key={f.label} className="rounded-md bg-[#F4F5F7] border border-[#E2E8F0] px-4 py-3">
            <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-1.5">{f.label}</p>
            <p className="text-[13px] text-[#0F172A] whitespace-pre-wrap">{f.value}</p>
          </div>
        ))}

        {report.file_name && (
          <div className="flex items-center gap-2 text-[12px] text-[#64748B] px-1">
            <svg className="h-3.5 w-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
            <span>{report.file_name}</span>
          </div>
        )}

        <SavedPhotoGrid
          serverPhotos={photos}
          idbPhotos={idbPhotos}
          inFlightIds={inFlightIds}
          loading={photosLoading}
          uploading={photoUploading}
          canEdit={canEdit && !pendingSync}
          onAdd={onAddPhotos}
          onDelete={onDeletePhoto}
          onCaption={onCaption}
        />
      </div>
    </div>
  )
}
