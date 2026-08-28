import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import {
  generateTransmittalPackage, signPaths, parseExtraLines,
  type RecipientType, type CoversheetMode,
} from "@/lib/package-pdf"

export const maxDuration = 60

function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

// POST /api/submittal-packages/[id]/pdf — RE-GENERATE a transmittal package.
// Appends a NEW generation (new generation_id) of files to submittal_package_files
// from the package's stored recipient_type / coversheet_mode / items. It never
// overwrites a prior generation and never re-stamps submittal dates (that
// happened once, at send). Returns the new generation's files with signed URLs.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params

  // Existence doubles as the ownership check (RLS hides other companies).
  const { data: pkg } = await supabase
    .from("submittal_packages")
    .select("id, project_id, company_id, package_number, recipient_type, coversheet_mode, send_date, cover_extra_lines")
    .eq("id", id)
    .maybeSingle()
  if (!pkg) return NextResponse.json({ error: "Package not found" }, { status: 404 })
  if (!pkg.recipient_type || !pkg.coversheet_mode) {
    return NextResponse.json({ error: "Not a transmittal package" }, { status: 400 })
  }
  if (!pkg.company_id) return NextResponse.json({ error: "Package has no company" }, { status: 400 })

  // Item set, ordered by submittal_seq for a stable emit order.
  const { data: itemRows } = await supabase
    .from("submittal_package_items")
    .select("submittal_id, submittals(submittal_seq)")
    .eq("package_id", id)
  const ordered = (itemRows ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((r: any) => ({ id: r.submittal_id as string, seq: r.submittals?.submittal_seq ?? 0 }))
    .sort((a, b) => a.seq - b.seq)
  const submittalIds = ordered.map(r => r.id)
  if (submittalIds.length === 0) {
    return NextResponse.json({ error: "This package has no items" }, { status: 400 })
  }

  try {
    const { generationId, files, warnings } = await generateTransmittalPackage(supabase, {
      packageId: pkg.id,
      projectId: pkg.project_id,
      companyId: pkg.company_id,
      packageNumber: pkg.package_number,
      recipientType: pkg.recipient_type as RecipientType,
      sendDate: pkg.send_date ?? todayISO(),
      coversheetMode: pkg.coversheet_mode as CoversheetMode,
      submittalIds,
      generatedBy: user.id,
      // The manual manifest rows saved at create — re-validated so a regen
      // reproduces the same 'package' cover.
      extraLines: parseExtraLines(pkg.cover_extra_lines),
    })
    const signed = await signPaths(supabase, files.map(f => f.storagePath))
    return NextResponse.json({
      generation: {
        generationId,
        coversheetMode: pkg.coversheet_mode,
        files: files.map(f => ({
          submittalId: f.submittalId,
          fileName: f.fileName,
          url: signed.get(f.storagePath) ?? null,
        })),
      },
      warnings,
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to regenerate the package" },
      { status: 500 },
    )
  }
}
