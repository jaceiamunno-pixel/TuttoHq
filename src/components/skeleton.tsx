// Shared skeleton-loader primitives.
//
// Perceived-speed win: while a list/grid page is fetching, render a shape-matched
// placeholder (pulsing neutral bars) instead of a bare "Loading…" string so the
// layout doesn't pop in. Display-only — these render for the exact same `loading`
// condition each page already used; they never touch data-fetch logic.
//
// Palette matches the app: #E2E8F0 (borders/bars) + #F1F5F9 (lighter fills).
// Every bar carries `animate-pulse`, so a composite's bars pulse in sync.

import type { ReactNode } from "react"

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

// A placeholder for the white, border-b action bar every project module renders
// above its content — a title/tab block on the left, a couple of action buttons
// on the right. Shape-matches the real toolbar so it doesn't pop in.
export function SkeletonToolbar({ className = "" }: Props) {
  return (
    <div className={`flex-shrink-0 border-b border-[#E2E8F0] bg-white flex items-center justify-between gap-2 px-4 py-2.5 ${className}`}>
      <div className="flex items-center gap-2 min-w-0">
        <SkeletonLine className="h-7 w-44 rounded-md" />
        <SkeletonLine className="h-3 w-24 hidden sm:block" />
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <SkeletonLine className="h-8 w-20 rounded-md" />
        <SkeletonLine className="h-8 w-24 rounded-md" />
      </div>
    </div>
  )
}

// The full project-module loading frame: the toolbar placeholder over a
// scrolling body. `children` fills the body (defaults to a table, matching the
// log-style modules). Route-level loading.tsx files render this so section
// navigation shows an instant, shape-matched skeleton BEFORE the heavy client
// module mounts and fires its fetch waterfall. It fills only the content area —
// the persistent project chrome (left rail) lives in the layout and stays put.
export function SkeletonModule({ children }: { children?: ReactNode }) {
  return (
    <>
      <SkeletonToolbar />
      <div className="flex-1 overflow-y-auto min-h-0 px-4 py-4">
        {children ?? <SkeletonTable rows={10} cols={7} />}
      </div>
    </>
  )
}

// A month-grid placeholder: a weekday header over 6 weeks × 7 day cells. Matches
// the manpower / schedule month-calendar cell sizing so the grid doesn't reflow
// when the real calendar loads in.
export function SkeletonCalendar({ className = "" }: Props) {
  return (
    <div className={`rounded-xl border border-[#E2E8F0] bg-white overflow-hidden ${className}`}>
      <div className="grid grid-cols-7 bg-[#FAFBFC] border-b border-[#E2E8F0]">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="py-2.5 flex justify-center">
            <SkeletonLine className="h-2.5 w-6" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-px bg-[#EEF1F4]">
        {Array.from({ length: 42 }).map((_, i) => (
          <div key={i} className="min-h-[84px] sm:min-h-[116px] bg-white p-1.5 sm:p-2">
            <SkeletonLine className="h-2.5 w-4" />
          </div>
        ))}
      </div>
    </div>
  )
}
