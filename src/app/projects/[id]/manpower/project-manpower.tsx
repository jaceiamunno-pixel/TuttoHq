"use client"

import ManpowerCalendar from "@/components/manpower-calendar"

// ── Per-project Manpower tab (Phase 4) ───────────────────────────────────────
// Thin page wrapper: the project heading + scroll/width chrome, then the shared
// month-calendar pinned to THIS project (projectId set → the grid reads with
// ?project_id, chips show the time range, and the form pins the project). The same
// <ManpowerCalendar /> backs the company-wide "Schedule" tab with no projectId.
export default function ProjectManpower({ projectId, projectName }: { projectId: string; projectName: string }) {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="max-w-[1100px] mx-auto px-4 sm:px-6 py-8 sm:py-10">
        <div className="mb-5">
          <h1 className="text-[20px] sm:text-[22px] font-bold text-[#0F172A] tracking-tight">Manpower</h1>
          <p className="text-[13px] text-[#64748B] mt-0.5">Crew schedule for {projectName}. Assign workers and subcontractor crews by day.</p>
        </div>
        <ManpowerCalendar projectId={projectId} />
      </div>
    </div>
  )
}
