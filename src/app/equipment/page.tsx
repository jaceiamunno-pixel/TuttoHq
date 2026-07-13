import AppChrome from "@/components/app-chrome"
import EquipmentView from "./equipment-view"

// Top-level Equipment section (company-scoped, like Library/Manpower — equipment
// is OWNED by the company and checked out TO projects, so it lives outside any one
// project). Auth is handled by middleware (every non-public path requires a
// session). ADR-018; tables live via migration 0040.
export default function EquipmentPage() {
  return (
    <AppChrome>
      <EquipmentView />
    </AppChrome>
  )
}
