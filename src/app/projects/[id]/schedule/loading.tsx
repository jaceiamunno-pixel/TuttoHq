import { SkeletonLine } from "@/components/skeleton"

// Schedule is a padded heading + a bordered two-panel Gantt (task labels on the
// left, time-scaled bars on the right), not the white-toolbar table frame.
// Match that structure so the swap to the real module doesn't jump. Bar
// offsets/widths are static (deterministic render, no layout jitter).
const GANTT_ROWS = [
  { offset: "0%", width: "34%" },
  { offset: "18%", width: "46%" },
  { offset: "30%", width: "24%" },
  { offset: "14%", width: "52%" },
  { offset: "44%", width: "34%" },
  { offset: "50%", width: "38%" },
  { offset: "24%", width: "30%" },
  { offset: "58%", width: "30%" },
]

export default function Loading() {
  return (
    <div className="flex-1 min-h-0 flex flex-col bg-[#F4F5F7]">
      {/* Heading + primary actions */}
      <div className="flex flex-wrap items-end justify-between gap-3 px-4 sm:px-6 pt-6 pb-3">
        <div className="min-w-0 space-y-2">
          <SkeletonLine className="h-6 w-32" />
          <SkeletonLine className="h-3 w-64" />
        </div>
        <div className="flex items-center gap-2">
          <SkeletonLine className="h-9 w-32 rounded-md" />
          <SkeletonLine className="h-9 w-24 rounded-md" />
          <SkeletonLine className="h-9 w-28 rounded-md" />
        </div>
      </div>
      {/* Gantt panel */}
      <div className="flex-1 min-h-0 px-4 sm:px-6 pb-6">
        <div className="h-full rounded-xl border border-[#E2E8F0] bg-white overflow-hidden">
          <div className="flex items-center gap-4 px-4 py-2.5 bg-[#FAFBFC] border-b border-[#E2E8F0]">
            <SkeletonLine className="h-2.5 w-40 shrink-0" />
            <SkeletonLine className="h-2.5 flex-1" />
          </div>
          {GANTT_ROWS.map((bar, i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-3 border-b border-[#E2E8F0]/60">
              <SkeletonLine className="h-3 w-40 shrink-0" />
              <div className="flex-1">
                <div
                  className="h-4 rounded bg-[#E2E8F0] animate-pulse"
                  style={{ marginLeft: bar.offset, width: bar.width }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
