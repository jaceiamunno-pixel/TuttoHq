import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// Distinct cost_codes the company has already used on estimate lines — the source
// for the editor's freeform-with-autocomplete cost_code input (ADR-002: cost_code
// is TEXT, never an FK). New codes are "remembered" simply by appearing on the
// next load. RLS scopes the rows to the caller's company.
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data, error } = await supabase
    .from("estimate_lines")
    .select("cost_code")
    .not("cost_code", "is", null)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const codes = [...new Set((data ?? []).map(r => (r.cost_code as string)?.trim()).filter(Boolean))].sort()
  return NextResponse.json({ cost_codes: codes })
}
