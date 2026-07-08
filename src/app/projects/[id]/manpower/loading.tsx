import { SkeletonLine, SkeletonCalendar } from "@/components/skeleton"

// Manpower is a centered month-calendar (heading + month nav + grid), not a
// table. Mirror ProjectManpower's container + ManpowerCalendar's month chrome so
// the loaded view slots straight in without reflow.
export default function Loading() {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="max-w-[1100px] mx-auto px-4 sm:px-6 py-8 sm:py-10">
        <div className="mb-5 space-y-2">
          <SkeletonLine className="h-6 w-40" />
          <SkeletonLine className="h-3 w-80" />
        </div>
        {/* Month chrome: ◀ Month Year ▶ · Today · Add assignment */}
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-1.5">
            <SkeletonLine className="h-8 w-8 rounded-md" />
            <SkeletonLine className="h-4 w-32" />
            <SkeletonLine className="h-8 w-8 rounded-md" />
            <SkeletonLine className="h-8 w-16 rounded-md ml-1" />
          </div>
          <SkeletonLine className="h-8 w-32 rounded-md" />
        </div>
        <SkeletonCalendar />
      </div>
    </div>
  )
}
