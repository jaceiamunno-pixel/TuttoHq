import { guardProjectModule } from "@/lib/field-access"

export default async function ModuleGuard({ children, params }: {
  children: React.ReactNode
  params: Promise<{ id: string }>
}) {
  await guardProjectModule((await params).id, "sub-change-orders")
  return <>{children}</>
}
