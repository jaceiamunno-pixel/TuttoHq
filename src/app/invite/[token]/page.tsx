import Link from "next/link"
import { createClient } from "@/lib/supabase/server"
import AcceptForm from "./accept-form"

// Phase 4 — public accept page. Validates the token via get_invite_by_token
// (SECURITY DEFINER, EXECUTE granted to anon) and branches on the result.
// The signup form is the only client component on this page; everything
// else renders server-side.

export const dynamic = "force-dynamic"

export default async function InviteAcceptPage(
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params

  const supabase = await createClient()
  const { data, error } = await supabase.rpc("get_invite_by_token", { p_token: token })

  if (error || !data || data.length === 0) {
    return <ErrorShell title="Invalid invite link" body="This invite link isn't recognized. Ask the admin for a new one." />
  }

  const invite = data[0] as {
    company_name: string
    email:        string
    role:         "admin" | "member" | "field"
    status:       "pending" | "accepted" | "revoked" | "expired"
    expired:      boolean
  }

  if (invite.status === "accepted") {
    return <ErrorShell title="Already used" body={`This invite was already used. Sign in to ${invite.company_name}.`} showLogin />
  }
  if (invite.status === "revoked") {
    return <ErrorShell title="Invite revoked" body="This invite was revoked. Contact the admin for a new one." />
  }
  if (invite.expired) {
    return <ErrorShell title="Invite expired" body={`This invite has expired. Ask ${invite.company_name} for a new one.`} />
  }

  // pending + not expired — render the accept form.
  return (
    <Shell>
      <div className="text-center mb-6">
        <div className="w-12 h-12 rounded-xl bg-[#7B9BB5]/15 border border-[#7B9BB5]/30 flex items-center justify-center mx-auto mb-4">
          <svg className="w-6 h-6 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        </div>
        <h1 className="text-[18px] font-bold text-[#0F172A] tracking-tight">
          You&apos;ve been invited to {invite.company_name}
        </h1>
        <p className="text-[13px] text-[#64748B] mt-1">
          Create your password to accept and sign in.
        </p>
      </div>
      <AcceptForm
        token={token}
        email={invite.email}
        companyName={invite.company_name}
        role={invite.role}
      />
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#F4F5F7] flex items-center justify-center py-10 px-4">
      <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-[400px] p-8">
        {children}
      </div>
    </div>
  )
}

function ErrorShell({ title, body, showLogin }: { title: string; body: string; showLogin?: boolean }) {
  return (
    <Shell>
      <div className="text-center">
        <h1 className="text-[18px] font-bold text-[#0F172A] tracking-tight mb-2">{title}</h1>
        <p className="text-[13px] text-[#64748B] mb-5">{body}</p>
        {showLogin ? (
          <Link href="/login" className="inline-block h-9 px-4 leading-9 bg-[#7B9BB5] text-white text-[13px] font-semibold rounded-md hover:bg-[#6A8AA4] transition-colors">
            Sign in
          </Link>
        ) : (
          <Link href="/login" className="text-[13px] text-[#7B9BB5] hover:text-[#6A8AA4]">
            Go to sign in
          </Link>
        )}
      </div>
    </Shell>
  )
}
