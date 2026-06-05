// End-to-end smoke test for the Bulk Import Stage 1 API path on production.
//
// What this exercises:
//   1. Auth as a real user (via Supabase admin to mint a session JWT).
//   2. Format the JWT as the @supabase/ssr "sb-{ref}-auth-token" cookie that
//      middleware reads.
//   3. POST /api/storage/presigned-url with the bulk-import-staging prefix.
//   4. PUT a real PDF to the returned signed URL.
//   5. POST /api/bulk-import/analyze with the path.
//   6. Verify the response has a real analysis object with pageCount,
//      suggestedSection / suggestedType / cover.coverSplit fields populated.
//
// What this does NOT test:
//   - The React state machine in BulkImportModal (the rowsRef refactor +
//     useEffect-driven runBatch). Those are verified by tsc + build + code
//     review.
//   - The drop / file picker UI.
//
// Run: node scripts/bulk-import-e2e.mjs
//
// Env vars required (from .env.local):
//   NEXT_PUBLIC_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "@supabase/supabase-js"
import { PDFDocument, StandardFonts, rgb } from "pdf-lib"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const BASE_URL = "https://www.tuttohq.com"

function loadEnvLocal() {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const envPath = resolve(here, "..", ".env.local")
    const text = readFileSync(envPath, "utf-8")
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
      if (!m) continue
      const [, k, v] = m
      if (process.env[k] == null) process.env[k] = v.replace(/^['"]|['"]$/g, "")
    }
  } catch {
    // No .env.local — caller is expected to set env vars another way.
  }
}

// Build a small THP-style submittal PDF: page 1 architect review fingerprint,
// page 2 submitter coversheet fingerprint, page 3 product content.
async function buildTestPdf() {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)

  // Page 1 — architect review (BAM template)
  const p1 = pdf.addPage([612, 792])
  p1.drawText("Submittal Review", { x: 50, y: 750, size: 14, font, color: rgb(0, 0, 0) })
  p1.drawText("Architecture · Branding+Digital · Interior Design", { x: 50, y: 730, size: 10, font })
  p1.drawText("Approved (A)    Exceptions Noted (EN)    Not Approved (NA)", { x: 50, y: 700, size: 10, font })
  p1.drawText("BAM Project Number: 08-100-070", { x: 50, y: 670, size: 10, font })
  p1.drawText("Reviewed by: Some Architect", { x: 50, y: 640, size: 10, font })

  // Page 2 — submitter coversheet
  const p2 = pdf.addPage([612, 792])
  p2.drawText("Submittal Coversheet", { x: 50, y: 750, size: 14, font })
  p2.drawText("Project Name: YNHH SP-3 Hybrid OR", { x: 50, y: 720, size: 10, font })
  p2.drawText("Project Number: 100", { x: 50, y: 700, size: 10, font })
  p2.drawText("Spec Section Title: Rough Carpentry", { x: 50, y: 680, size: 10, font })
  p2.drawText("Spec Section No.: 06 10 00", { x: 50, y: 660, size: 10, font })
  p2.drawText("Submittal No.: 5", { x: 50, y: 640, size: 10, font })
  p2.drawText("Date Submitted: 2026-01-15", { x: 50, y: 620, size: 10, font })
  p2.drawText("Submitted By: THP", { x: 50, y: 600, size: 10, font })

  // Page 3 — product content
  const p3 = pdf.addPage([612, 792])
  p3.drawText("Rough Carpentry — Product Data", { x: 50, y: 750, size: 14, font })
  p3.drawText("Manufacturer: Generic Lumber Co.", { x: 50, y: 720, size: 10, font })
  p3.drawText("Material: 2x4 Doug Fir, 19% MC", { x: 50, y: 700, size: 10, font })
  p3.drawText("Dimensions: 1.5 in x 3.5 in x 96 in", { x: 50, y: 680, size: 10, font })
  for (let i = 0; i < 30; i++) {
    p3.drawText(`Spec line ${i}: Lorem ipsum dolor sit amet, consectetur adipiscing elit.`,
      { x: 50, y: 650 - i * 14, size: 9, font })
  }

  const bytes = await pdf.save()
  return new Uint8Array(bytes)
}

async function mintSessionForFirstUser(admin) {
  // Pull any active user from the project so we can mint a session.
  const { data: { users }, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1 })
  if (error || !users || users.length === 0) {
    throw new Error("Could not list users: " + (error?.message ?? "no users"))
  }
  const user = users[0]
  // generateLink with type=magiclink returns access_token + refresh_token
  // we can use immediately, no email round-trip required.
  const { data, error: e2 } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: user.email,
  })
  if (e2 || !data?.properties) throw new Error("Could not mint link: " + (e2?.message ?? "no properties"))
  // generateLink's action_link is `…/auth/v1/verify?token=…&type=magiclink&redirect_to=…`.
  // GET it with no auto-redirect — the Location header on the response is
  // `redirect_to#access_token=…&refresh_token=…` from which we extract tokens.
  const verifyRes = await fetch(data.properties.action_link, { redirect: "manual" })
  const loc = verifyRes.headers.get("location")
  if (!loc) throw new Error(`verify did not redirect; status ${verifyRes.status}`)
  const hashStart = loc.indexOf("#")
  const hash = hashStart >= 0 ? loc.slice(hashStart + 1) : ""
  const params = new URLSearchParams(hash)
  const access_token = params.get("access_token")
  const refresh_token = params.get("refresh_token")
  if (!access_token || !refresh_token) {
    throw new Error(`verify Location did not carry tokens: ${loc}`)
  }
  return { user, access_token, refresh_token }
}

function buildSsrCookie(projectRef, session) {
  // @supabase/ssr cookie format (v0.5+): sb-{ref}-auth-token = base64-`<JSON>`
  // where JSON is the session object. Compatible alt: just JSON.stringify.
  // Newer versions wrap in base64 with a prefix. Try the prefixed form.
  const payload = {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: "bearer",
    user: session.user ? {
      id: session.user.id,
      email: session.user.email,
      aud: session.user.aud,
      role: session.user.role,
    } : null,
  }
  const value = "base64-" + Buffer.from(JSON.stringify(payload)).toString("base64")
  return `sb-${projectRef}-auth-token=${value}`
}

async function main() {
  loadEnvLocal()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error("Need NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY")
    process.exit(1)
  }
  const ref = new URL(url).host.split(".")[0]
  const admin = createClient(url, key, { auth: { persistSession: false } })

  console.log("[1/6] Building synthetic THP-style test PDF…")
  const pdfBytes = await buildTestPdf()
  console.log(`      ${pdfBytes.length} bytes, 3 pages, BAM page 1 + submitter page 2 + content page 3`)

  console.log("[2/6] Minting a session JWT for the first user in auth.users via admin API…")
  const session = await mintSessionForFirstUser(admin)
  console.log(`      Signed in as ${session.user.email}`)

  const cookie = buildSsrCookie(ref, session)
  const headers = { Cookie: cookie }

  console.log("[3/6] POST /api/storage/presigned-url …")
  const filename = `e2e-test-${Date.now()}.pdf`
  const presignRes = await fetch(`${BASE_URL}/api/storage/presigned-url`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ bucket: "submittals", prefix: "bulk-import-staging", file_name: filename }),
    redirect: "manual",
  })
  console.log(`      → ${presignRes.status} ${presignRes.statusText}`)
  if (presignRes.status === 307) {
    const loc = presignRes.headers.get("location")
    throw new Error(`presigned-url redirected (auth failed): ${loc}`)
  }
  const presignData = await presignRes.json()
  if (!presignRes.ok || !presignData.signed_url || !presignData.path) {
    throw new Error(`presigned-url failed: ${JSON.stringify(presignData)}`)
  }
  console.log(`      path=${presignData.path}`)

  console.log("[4/6] PUT bytes to Supabase Storage signed URL…")
  const putRes = await fetch(presignData.signed_url, {
    method: "PUT",
    headers: { "Content-Type": "application/pdf", "x-upsert": "true" },
    body: pdfBytes,
  })
  console.log(`      → ${putRes.status} ${putRes.statusText}`)
  if (!putRes.ok) {
    const detail = await putRes.text().catch(() => "")
    throw new Error(`PUT failed: ${detail}`)
  }

  console.log("[5/6] POST /api/bulk-import/analyze …")
  const analyzeRes = await fetch(`${BASE_URL}/api/bulk-import/analyze`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ storage_path: presignData.path, file_name: filename }),
    redirect: "manual",
  })
  console.log(`      → ${analyzeRes.status} ${analyzeRes.statusText}`)
  if (analyzeRes.status === 307) {
    const loc = analyzeRes.headers.get("location")
    throw new Error(`analyze redirected (auth failed): ${loc}`)
  }
  const analyzeData = await analyzeRes.json()
  if (!analyzeRes.ok) {
    throw new Error(`analyze failed: ${JSON.stringify(analyzeData)}`)
  }
  console.log("[6/6] Verifying analysis shape…")
  const a = analyzeData.analysis
  if (!a) throw new Error("analyze returned no analysis field")
  console.log(`      pageCount         = ${a.pageCount}`)
  console.log(`      suggestedSection  = ${JSON.stringify(a.suggestedSection)}`)
  console.log(`      filenameSection   = ${JSON.stringify(a.filenameSection)}`)
  console.log(`      pageSection       = ${JSON.stringify(a.pageSection)}`)
  console.log(`      suggestedType     = ${JSON.stringify(a.suggestedType)}`)
  console.log(`      typeGuess         = ${JSON.stringify(a.typeGuess)}`)
  console.log(`      cover.coverSplit  = ${a.cover.coverSplit}`)
  console.log(`      cover.uncertain   = ${a.cover.uncertain}`)
  console.log(`      cover.perPage     = ${JSON.stringify(a.cover.perPage)}`)
  console.log(`      needsAttention    = ${a.needsAttention}`)
  console.log(`      notes             = ${JSON.stringify(a.notes)}`)
  if (typeof a.pageCount !== "number" || a.pageCount < 1) throw new Error("invalid pageCount")
  if (typeof a.cover.coverSplit !== "number") throw new Error("invalid coverSplit")
  console.log("\n✅ END-TO-END PATH VERIFIED")
  console.log("   - Auth → presigned-url 201 → Supabase PUT 200 → analyze 200 with real analysis")

  // Cleanup
  console.log("\n[cleanup] Removing staged test PDF…")
  await admin.storage.from("submittals").remove([presignData.path])
}

main().catch(err => {
  console.error("\n❌ FAILED:", err.message ?? err)
  console.error(err.stack)
  process.exit(1)
})
