import AppChrome from "@/components/app-chrome"
import WorkersRoster from "./workers-roster"

// Top-level Manpower section (company-scoped, like Library/Directories — workers
// belong to the company, not a single project). Phase 2 lands on the Workers
// roster; the scheduling calendar is a later phase (placeholder tab inside).
// Auth is handled by middleware (every non-public path requires a session).
export default function ManpowerPage() {
  return (
    <AppChrome>
      <WorkersRoster />
    </AppChrome>
  )
}
