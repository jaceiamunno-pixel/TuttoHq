import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getValidToken } from "@/lib/gmail"
import { sendGmailMessage } from "@/lib/gmail-send"
import { composePackagePdf } from "@/lib/package-pdf"

// POST /api/submittal-packages/[id]/dispatch — generate the package PDF, email
// it to the vendor through the PM's connected Gmail, and apply the side
// effects: status → dispatched, every item submittal gets sent_to_sub_date +
// "Sent to Sub" status.

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
    .from("submittal_packages")
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

  // Item set — needed for the body count and the dispatch side effects.
  const { data: items } = await supabase
    .from("submittal_package_items")
    .select("submittal_id")
    .eq("package_id", id)
  const itemIds = (items ?? []).map(r => r.submittal_id)
  if (itemIds.length === 0) {
    return NextResponse.json({ error: "This package has no submittal items" }, { status: 400 })
  }

  // The PM dispatches from their own connected Gmail account.
  let accessToken: string
  try {
    accessToken = await getValidToken(supabase, user.id)
  } catch {
    return NextResponse.json(
      { error: "Connect a Gmail account in Settings before dispatching packages." },
      { status: 400 },
    )
  }

  // Project name for the subject + body.
  const { data: project } = await supabase
    .from("projects")
    .select("name, gc_name")
    .eq("id", pkg.project_id)
    .maybeSingle()
  const projectName = project?.name ?? "Project"
  const gcName = project?.gc_name ?? "the General Contractor"

  // Build the package PDF.
  let pdfBytes: Uint8Array
  let storagePath: string
  try {
    ({ bytes: pdfBytes, storagePath } = await composePackagePdf(supabase, id))
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to generate the package PDF" },
      { status: 500 },
    )
  }

  // Compose the email.
  const dueLine = pkg.due_date ? fmtDate(pkg.due_date) : "Per project schedule"
  const subject = `Submittal Package — ${projectName} — [${pkg.package_number}]`
  const bodyText = [
    `Hello ${pkg.vendor_name_snapshot},`,
    "",
    `Attached is the submittal package for ${projectName}. Please review the`,
    "attached document and submit the required items per the schedule.",
    "",
    `Items expected: ${itemIds.length}`,
    `Due date: ${dueLine}`,
    "",
    "When responding, please reply to this email with your submittal documents",
    "attached. Our system will automatically match your submissions back to",
    "this package using the tracking reference below.",
    "",
    `Tracking ref: [${pkg.package_number}]`,
    "",
    `— ${gcName}`,
  ].join("\n")

  // Send.
  let sent: { id: string; threadId: string }
  try {
    sent = await sendGmailMessage(accessToken, {
      to: pkg.sent_to_email,
      subject,
      bodyText,
      attachments: [{
        filename: `Submittal_Package_${pkg.package_number}.pdf`,
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

  // Persist dispatch state.
  await supabase
    .from("submittal_packages")
    .update({
      status: "dispatched",
      dispatched_at: new Date().toISOString(),
      dispatched_by: user.id,
      gmail_thread_id: sent.threadId,
      pdf_file_path: storagePath,
    })
    .eq("id", id)

  // Side effects: the clock starts for every submittal in the package.
  const today = new Date().toISOString().slice(0, 10)
  await supabase
    .from("submittals")
    .update({ sent_to_sub_date: today, review_status: "Sent to Sub" })
    .in("id", itemIds)

  return NextResponse.json({ ok: true, gmail_thread_id: sent.threadId })
}
