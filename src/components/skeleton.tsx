// Shared skeleton-loader primitives.
//
// Perceived-speed win: while a list/grid page is fetching, render a shape-matched
// placeholder (pulsing neutral bars) instead of a bare "Loading…" string so the
// layout doesn't pop in. Display-only — these render for the exact same `loading`
// condition each page already used; they never touch data-fetch logic.
//
// Palette matches the app: #E2E8F0 (borders/bars) + #F1F5F9 (lighter fills).
// Every bar carries `animate-pulse`, so a composite's bars pulse in sync.

type Props = { className?: string }

// A single pulsing bar. Default height 12px; override width/height via className.
export function SkeletonLine({ className = "" }: Props) {
  return <div className={`h-3 rounded bg-[#E2E8F0] animate-pulse ${className}`} />
}

// A card placeholder. `media` (true or a pixel height) renders a tall preview
// block on top — matches thumbnail cards (e.g. the drawing grid). `lines` sets
// how many body bars follow the title row.
export function SkeletonCard({
  className = "",
  lines = 2,
  media = false,
}: Props & { lines?: number; media?: boolean | number }) {
  const mediaHeight = typeof media === "number" ? media : 140
  return (
    <div className={`bg-white rounded-xl border border-[#E2E8F0] overflow-hidden ${className}`}>
      {media !== false && (
        <div className="bg-[#F1F5F9] animate-pulse" style={{ height: mediaHeight }} />
      )}
      <div className="p-4 space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <SkeletonLine className="h-3.5 w-1/2" />
          <SkeletonLine className="h-3 w-12 shrink-0" />
        </div>
        {Array.from({ length: lines }).map((_, i) => (
          <SkeletonLine key={i} className={i === lines - 1 ? "w-2/3" : "w-full"} />
        ))}
      </div>
    </div>
  )
}

// One table-style row: a fixed-width leading cell, a flexible label cell, then
// trailing fixed cells — reads as a data row without matching exact columns.
export function SkeletonRow({ cols = 5, className = "" }: Props & { cols?: number }) {
  return (
    <div className={`flex items-center gap-4 px-4 py-3 border-b border-[#E2E8F0]/60 ${className}`}>
      {Array.from({ length: cols }).map((_, i) => (
        <SkeletonLine
          key={i}
          className={i === 0 ? "w-16 shrink-0" : i === 1 ? "flex-1" : "w-20 shrink-0"}
        />
      ))}
    </div>
  )
}

// A grid of SkeletonCards. `cols`/`gap` default to the project-card layout
// (1 / sm:2 / lg:3). Override for other grids (e.g. the drawing thumbnails).
export function SkeletonGrid({
  count = 6,
  cols = "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
  gap = "gap-3",
  className = "",
  media = false,
  lines = 2,
}: Props & {
  count?: number
  cols?: string
  gap?: string
  media?: boolean | number
  lines?: number
}) {
  return (
    <div className={`grid ${cols} ${gap} ${className}`}>
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} media={media} lines={lines} />
      ))}
    </div>
  )
}

// A bordered table placeholder: a header bar over `rows` SkeletonRows. Used for
// the log/list pages that render a real <table> once loaded.
export function SkeletonTable({
  rows = 8,
  cols = 6,
  className = "",
}: Props & { rows?: number; cols?: number }) {
  return (
    <div className={`rounded-xl border border-[#E2E8F0] overflow-hidden bg-white ${className}`}>
      <div className="flex items-center gap-4 px-4 py-2.5 bg-[#F8F9FA] border-b border-[#E2E8F0]">
        {Array.from({ length: cols }).map((_, i) => (
          <SkeletonLine key={i} className={`h-2.5 ${i === 1 ? "flex-1" : "w-16 shrink-0"}`} />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonRow key={i} cols={cols} />
      ))}
    </div>
  )
}
