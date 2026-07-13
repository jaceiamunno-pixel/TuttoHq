import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"

// Per-user PO numbering settings (Settings → Account). Each user sets their OWN
// po_prefix + po_next_seq; issue_po_number() reads them from the caller's
// user_profiles row (auth.uid()) at PO-create time and increments atomically.
//
// Write path mirrors /api/profile (full_name): the SERVICE-ROLE client updates
// the caller's OWN row, hard-scoped in code to .eq("user_id", user.id) and
// allow-listing EXACTLY po_prefix + po_next_seq. user_profiles deliberately has
// NO UPDATE RLS policy (one would re-expose the role column to self-escalation),
// so a user id is NEVER accepted from the client — only auth.uid()'s own row is
// ever touched. This only affects FUTURE issued numbers; no existing PO row is
// changed.

const MAX_PREFIX_LEN = 16
// po_next_seq is int4; issue_po_number() does seq + 1, so leave headroom for the
// increment to avoid an overflow at issuance.
const MAX_SEQ = 2_147_483_646

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  // Own-row read is permitted by the "user_profiles: select own" RLS policy.
  const { data: profile } = await supabase
    .from("user_profiles").select("po_prefix, po_next_seq").eq("user_id", user.id).maybeSingle()

  return NextResponse.json({
    po_prefix: profile?.po_prefix ?? null,
    po_next_seq: profile?.po_next_seq ?? null,
  })
}

export async function PATCH(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 })
  }

  // po_next_seq — required, must be a positive integer. Reject <= 0, non-integer,
  // or out-of-int4-range with a 400.
  const rawSeq = (body as { po_next_seq?: unknown }).po_next_seq
  if (typeof rawSeq !== "number" || !Number.isInteger(rawSeq)) {
    return NextResponse.json({ error: "Starting number must be a whole number" }, { status: 400 })
  }
  if (rawSeq <= 0) {
    return NextResponse.json({ error: "Starting number must be greater than 0" }, { status: 400 })
  }
  if (rawSeq > MAX_SEQ) {
    return NextResponse.json({ error: "Starting number is too large" }, { status: 400 })
  }
  const po_next_seq = rawSeq

  // po_prefix — optional. Trim; an empty string stores as NULL (a NULL prefix is
  // valid: the user issues bare numeric PO numbers).
  const rawPrefix = (body as { po_prefix?: unknown }).po_prefix
  let po_prefix: string | null
  if (rawPrefix === null || rawPrefix === undefined) {
    po_prefix = null
  } else if (typeof rawPrefix === "string") {
    const trimmed = rawPrefix.trim()
    if (trimmed.length > MAX_PREFIX_LEN) {
      return NextResponse.json({ error: `Prefix must be ${MAX_PREFIX_LEN} characters or fewer` }, { status: 400 })
    }
    po_prefix = trimmed === "" ? null : trimmed
  } else {
    return NextResponse.json({ error: "Prefix must be text" }, { status: 400 })
  }

  // Read the current seq BEFORE writing so we can warn on a backward move. POs
  // already issued used numbers up to (current po_next_seq − 1); setting the new
  // start at/below the current value risks re-emitting an already-issued number,
  // which the company-wide unique index now rejects at issue time (409). This is
  // a soft warning, not a block: a user who over-set the seq and never issued
  // anything legitimately needs to lower it.
  const { data: before } = await supabase
    .from("user_profiles").select("po_next_seq").eq("user_id", user.id).maybeSingle()
  const currentSeq = before?.po_next_seq ?? null

  // Service client bypasses RLS; scope to the caller's OWN row, pass ONLY the two
  // PO columns. Treat zero affected rows as a hard 404 (profile row not created
  // yet) rather than a silent success — same contract as /api/profile.
  const admin = createAdminClient()
  const { data, error } = await admin
    .from("user_profiles")
    .update({ po_prefix, po_next_seq })
    .eq("user_id", user.id)
    .select("user_id")

  if (error) {
    console.error("[api/profile/po-numbering] update failed", error)
    return NextResponse.json({ error: "Could not save PO numbering" }, { status: 500 })
  }
  if (!data || data.length === 0) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 })
  }

  const warning = (typeof currentSeq === "number" && po_next_seq <= currentSeq)
    ? `Heads up: you've issued PO numbers up to ${currentSeq - 1}. Starting at ${po_next_seq} can re-use an already-issued number, which will be rejected as a duplicate when you issue.`
    : null

  return NextResponse.json({ po_prefix, po_next_seq, warning })
}
