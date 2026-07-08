import { SkeletonModule } from "@/components/skeleton"

// Instant route-level skeleton for the project sections. Next.js renders this
// the moment a nav link is clicked — before the heavy client module mounts and
// fires its on-mount fetch waterfall — so the content area never sits blank.
//
// It fills ONLY the content area: the project's left-rail chrome lives in the
// persistent layout (project-chrome.tsx) and is not redrawn here. Sections whose
// content isn't a table (drawings, schedule, manpower, takeoff) override this
// with their own loading.tsx; everything else (submittals, rfis, change-orders,
// purchase-orders, commitments, punch, daily, rfq, closeout) uses this frame.
export default function Loading() {
  return <SkeletonModule />
}
