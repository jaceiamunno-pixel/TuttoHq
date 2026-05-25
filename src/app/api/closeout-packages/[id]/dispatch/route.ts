import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getValidToken } from "@/lib/gmail"
import { sendGmailMessage } from "@/lib/gmail-send"
import { composeCloseoutPackagePdf } from "@/lib/closeout-package-pdf"

// POST /api/closeout-packages/[id]/dispatch — generate the package PDF, email
// it to the vendor through the PM's connected Gmail, and flip the package
// status → dispatched. Closeout items themselves are unchanged on dispatch;
// their status only moves when the PM places an inbound orphan onto them.

function fmtDate(iso: string | null): string {
  if (!iso) return ""
  const d = new Date(`${iso}T00:00:00`)
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params

  const { data: pkg } = await supabase
    .from("closeout_packages")
    .select("*")
    .eq("id", id)
    .maybeSingle()
  if (!pkg) return NextResponse.json({ error: "Package not found" }, { status: 404 })
  if (pkg.status !== "draft") {
    return NextResponse.json({ error: "This package has already been dispatched" }, { status: 409 })
  }
  if (!pkg.sent_to_email) {
    return NextResponse.json({ error: "This package has no recipient email" }, { status: 400 })
  }

  const { data: items } = await supabase
    .from("closeout_package_items")
    .select("closeout_item_id")
    .eq("package_id", id)
  const itemIds = (items ?? []).map(r => r.closeout_item_id)
  if (itemIds.length === 0) {
    return NextResponse.json({ error: "This package has no closeout items" }, { status: 400 })
  }

  let accessToken: string
  try {
    accessToken = await getValidToken(supabase, user.id)
  } catch {
    return NextResponse.json(
      { error: "Connect a Gmail account in Settings before dispatching packages." },
      { status: 400 },
    )
  }

  const { data: project } = await supabase
    .from("projects")
    .select("name, gc_name")
    .eq("id", pkg.project_id)
    .maybeSingle()
  const projectName = project?.name ?? "Project"
  const gcName = project?.gc_name ?? "the General Contractor"

  let pdfBytes: Uint8Array
  let storagePath: string
  try {
    ({ bytes: pdfBytes, storagePath } = await composeCloseoutPackagePdf(supabase, id))
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to generate the package PDF" },
      { status: 500 },
    )
  }

  const dueLine = pkg.due_date ? fmtDate(pkg.due_date) : "Per closeout schedule"
  const subject = `Closeout Package — ${projectName} — [${pkg.package_number}]`
  const bodyText = [
    `Hello ${pkg.vendor_name_snapshot},`,
    "",
    `Attached is the closeout package for ${projectName}. Please review the`,
    "attached document and return the required closeout items per the schedule.",
    "",
    `Items expected: ${itemIds.length}`,
    `Due date: ${dueLine}`,
    "",
    "When responding, please reply to this email with your closeout documents",
    "attached (warranties, O&M manuals, certifications, etc.). Our system will",
    "route your submission back to this package using the tracking reference below.",
    "",
    `Tracking ref: [${pkg.package_number}]`,
    "",
    `— ${gcName}`,
  ].join("\n")

  let sent: { id: string; threadId: string }
  try {
    sent = await sendGmailMessage(accessToken, {
      to: pkg.sent_to_email,
      subject,
      bodyText,
      attachments: [{
        filename: `Closeout_Package_${pkg.package_number}.pdf`,
        mimeType: "application/pdf",
        content: pdfBytes,
      }],
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to send the dispatch email" },
      { status: 502 },
    )
  }

  await supabase
    .from("closeout_packages")
    .update({
      status: "dispatched",
      dispatched_at: new Date().toISOString(),
      dispatched_by: user.id,
      gmail_thread_id: sent.threadId,
      pdf_file_path: storagePath,
    })
    .eq("id", id)

  return NextResponse.json({ ok: true, gmail_thread_id: sent.threadId })
}
