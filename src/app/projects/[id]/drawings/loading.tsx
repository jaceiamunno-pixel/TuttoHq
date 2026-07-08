import { SkeletonModule, SkeletonGrid } from "@/components/skeleton"

// The Drawing Log is a thumbnail grid, not a table. Mirror DrawingsModule's own
// in-flight SkeletonGrid (same cols/gap/media) so the route skeleton → module
// skeleton → content handoff is seamless.
export default function Loading() {
  return (
    <SkeletonModule>
      <SkeletonGrid
        count={10}
        cols="grid-cols-2 sm:grid-cols-3 lg:grid-cols-5"
        gap="gap-4"
        media={180}
        lines={2}
      />
    </SkeletonModule>
  )
}
