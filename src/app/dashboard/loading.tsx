import { SkeletonLine, SkeletonGrid } from "@/components/skeleton"

// The dashboard (project landing grid) renders its own AppChrome inside the
// page, so this route-level fallback stands in for the whole page while it
// loads. We draw a STATIC navy header placeholder here — never the real
// AppChrome, which is a client component that would re-run its settings/auth
// fetches on the fallback→page swap — over the same project-grid skeleton the
// page itself shows while its projects load.
export default function Loading() {
  return (
    <div className="flex flex-col bg-[#F4F5F7] w-full overflow-hidden" style={{ height: "100dvh" }}>
      {/* Static top-chrome placeholder — mirrors AppChrome's navy header shape. */}
      <div className="flex flex-shrink-0 items-center gap-3 h-14 bg-[#0A1628] border-b border-white/10 px-3">
        <div className="h-4 w-24 rounded bg-white/10 animate-pulse" />
        <div className="hidden sm:flex items-center gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-4 w-16 rounded bg-white/[0.06] animate-pulse" />
          ))}
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-[1100px] mx-auto px-4 sm:px-6 py-8 sm:py-10">
          <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-6">
            <div className="space-y-2">
              <SkeletonLine className="h-6 w-28" />
              <SkeletonLine className="h-3 w-64" />
            </div>
            <SkeletonLine className="h-9 w-full sm:w-64 rounded-lg" />
          </div>
          <SkeletonGrid count={6} lines={2} />
        </div>
      </div>
    </div>
  )
}
