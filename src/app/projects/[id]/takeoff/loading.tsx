import { SkeletonLine } from "@/components/skeleton"

// Takeoff is a split view — a drawing canvas on the left, the count-matrix
// controls on the right (fixed 460px) — not a table. Match that frame so the
// real module doesn't shift the layout when it mounts.
export default function Loading() {
  return (
    <div className="flex h-full min-h-0">
      {/* LEFT — sheet toolbar + canvas */}
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex-shrink-0 border-b border-[#E2E8F0] bg-white px-3 py-2 flex items-center gap-3">
          <SkeletonLine className="h-3 w-12" />
          <SkeletonLine className="h-8 w-56 rounded-md" />
          <SkeletonLine className="h-8 w-20 rounded-md ml-auto" />
        </div>
        <div className="flex-1 min-h-0 bg-[#F1F3F5] flex items-center justify-center p-6">
          <div className="w-full max-w-3xl h-full rounded-lg border border-[#E2E8F0] bg-white animate-pulse" />
        </div>
      </div>
      {/* RIGHT — controls + matrix (fixed 460px, matches TakeoffModule) */}
      <div className="w-[460px] shrink-0 border-l border-[#E2E8F0] bg-[#FBFCFD] p-3 space-y-3">
        <SkeletonLine className="h-8 w-full rounded-md" />
        <div className="rounded-lg border border-[#E2E8F0] bg-white p-3 space-y-2.5">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <SkeletonLine className="h-3 flex-1" />
              <SkeletonLine className="h-3 w-10 shrink-0" />
              <SkeletonLine className="h-3 w-10 shrink-0" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
