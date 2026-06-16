import { redirect } from "next/navigation"

// Bare /projects/[id] has no module of its own — land on the Submittal Log,
// the project's default work surface. The guard in layout.tsx has already
// verified ownership before this redirect resolves.
export default async function ProjectIndex({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  redirect(`/projects/${id}/submittals`)
}
