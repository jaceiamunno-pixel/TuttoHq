import AppChrome from "@/components/app-chrome"
import WorkersRoster from "./workers-roster"

// Top-level Manpower section (company-scoped, like Library/Directories — workers
// belong to the company, not a single project). Two tabs: the Workers roster
// (Phase 2) and the company-wide scheduling calendar (Phase 4 — the shared
// month grid with no project filter). Auth is handled by middleware (every
// non-public path requires a session).
export default function ManpowerPage() {
  return (
    <AppChrome>
      <WorkersRoster />
    </AppChrome>
  )
}
