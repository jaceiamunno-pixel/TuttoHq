import { redirect } from "next/navigation"
import { resolveProjectLanding } from "@/lib/field-access"

// Bare /projects/[id] has no module of its own. Admin/member/demo land on the
// Submittal Log (the default work surface). Field users (ADR-020) land on
// their first granted module instead — resolveProjectLanding picks it. The
// guard in layout.tsx has already verified visibility before this resolves.
export default async function ProjectIndex({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  redirect(await resolveProjectLanding(id))
}
