import { guardProjectModule } from "@/lib/field-access"

// ADR-020 field-role guard: server-side, before the client module mounts.
// No-op for admin/member/demo; field users without a grant for this module
// are redirected to their first granted module.
export default async function ModuleGuard({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ id: string }>
}) {
  await guardProjectModule((await params).id, "takeoff")
  return <>{children}</>
}
