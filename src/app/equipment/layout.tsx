import { guardCompanySurface } from "@/lib/field-access"

// ADR-020: company-level surface — field users are redirected to /dashboard
// (server-side; the RLS lockout would render this empty for them anyway).
export default async function CompanySurfaceGuard({ children }: { children: React.ReactNode }) {
  await guardCompanySurface()
  return <>{children}</>
}
