import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { PDFDocument } from "pdf-lib"
import { renderToStaticMarkup } from "react-dom/server"
import React from "react"
import fs from "fs"
import path from "path"
import SubmittalCoversheet, { type SubmittalCoversheetProps } from "@/components/submittals/SubmittalCoversheet"

// Vercel Pro: allow up to 60 s for browser launch + PDF render
export const maxDuration = 60

// Read CSS once at module load (cached across warm invocations)
const CSS_PATH = path.join(process.cwd(), "src/components/submittals/submittal-coversheet.css")
let _css: string | null = null
function getCss(): string {
  if (!_css) _css = fs.readFileSync(CSS_PATH, "utf-8")
  return _css
}

async function launchBrowser() {
  // Production (Vercel Lambda): use @sparticuz/chromium binary
  if (process.env.NODE_ENV === "production") {
    const chromium = (await import("@sparticuz/chromium")).default
    const puppeteer = (await import("puppeteer-core")).default
    return puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
      defaultViewport: chromium.defaultViewport,
    })
  }

  // Local dev: use Chrome pointed to via CHROMIUM_EXECUTABLE_PATH env var.
  // Set in .env.local, e.g.:
  //   Windows: CHROMIUM_EXECUTABLE_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe"
  //   macOS:   CHROMIUM_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH
  if (!executablePath) {
    throw new Error(
      "Set CHROMIUM_EXECUTABLE_PATH in .env.local to your local Chrome path for PDF generation in development."
    )
  }
  const puppeteer = (await import("puppeteer-core")).default
  return puppeteer.launch({ headless: true, executablePath })
}

async function renderCoversheetToPdf(props: SubmittalCoversheetProps): Promise<Buffer> {
  const css = getCss()
  const markup = renderToStaticMarkup(React.createElement(SubmittalCoversheet, props))
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>${css}</style>
</head>
<body>${markup}</body>
</html>`

  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: "networkidle0" })
    await page.emulateMediaType("print")
    const pdfBuffer = await page.pdf({
      format: "Letter",
      printBackground: true,   // required for steel-blue field fills
    })
    return Buffer.from(pdfBuffer)
  } finally {
    await browser.close()
  }
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json()
  const {
    submittalId,
    projectId,
    existingId,
    projectName,
    projectNumber,
    projectLocation,
    gcName,
    architect,
    specSectionNo,
    specSectionTitle,
    description,
    dateSubmitted,
    submittalNo,
    reviewedBy,
    certifiedBy,
    notes,
    sendToType,
    sendToCompany,
    sendToContact,
    sendToEmail,
    sendToPhone,
    sendToAddress,
    transmittedBy,
    transmittedByCompany,
  } = body

  // Fetch company logo as a signed URL (Puppeteer needs an absolute URL it can fetch)
  const { data: settings } = await supabase
    .from("company_settings")
    .select("logo_path")
    .maybeSingle()

  let gcLogoUrl: string | undefined
  if (settings?.logo_path) {
    const { data: signed } = await supabase.storage
      .from("company-assets")
      .createSignedUrl(settings.logo_path, 3600)
    gcLogoUrl = signed?.signedUrl ?? undefined
  }

  // Build coversheet props from the form payload.
  // Fields marked "(pending migration)" will be wired up once the columns exist.
  const coversheetProps: SubmittalCoversheetProps = {
    gcLogoUrl,
    gcName:                gcName         || "",
    projectName:           projectName    || "",
    projectNumber:         projectNumber  || "",
    projectLocation:       projectLocation || "",
    submittalDescription:  description    || "",
    specSectionTitle:      specSectionTitle || "",
    specSectionNumber:     specSectionNo  || "",
    submittalNumber:       String(Math.max(1, parseInt(submittalNo || "1", 10) || 1)).padStart(2, "0"),
    revisionNumber:        "00",          // pending migration: submittals.revision_number
    dateSubmitted:         dateSubmitted  || "",
    submittalDueDate:      "",            // pending migration: submittals.due_date
    criticalSubmittal:     false,         // pending migration: submittals.is_critical
    submittalPartyRequired: false,        // pending migration: submittals.party_required
    copyTo:                "",            // pending migration: submittals.copy_to
    // stamps: all empty — pending migration: submittal_reviews table
  }

  // Render the React component to a PDF via Puppeteer
  const coverBytes = await renderCoversheetToPdf(coversheetProps)

  // Merge cover page with original submittal PDF (if any)
  const mergedDoc = await PDFDocument.create()
  const coverDoc = await PDFDocument.load(coverBytes)
  const coverPages = await mergedDoc.copyPages(coverDoc, coverDoc.getPageIndices())
  coverPages.forEach(p => mergedDoc.addPage(p))

  if (submittalId) {
    try {
      const { data: submittalRow } = await supabase
        .from("submittals")
        .select("storage_path, mime_type")
        .eq("id", submittalId)
        .maybeSingle()

      if (submittalRow?.storage_path && submittalRow.mime_type === "application/pdf") {
        const { data: submittalBlob } = await supabase.storage
          .from("submittals")
          .download(submittalRow.storage_path)

        if (submittalBlob) {
          const submittalDoc = await PDFDocument.load(await submittalBlob.arrayBuffer())
          const submittalPages = await mergedDoc.copyPages(submittalDoc, submittalDoc.getPageIndices())
          submittalPages.forEach(p => mergedDoc.addPage(p))
        }
      }
    } catch {
      // If merging fails, return cover sheet only
    }
  }

  const finalBytes = await mergedDoc.save()
  const filename = submittalId ? "submittal_transmittal.pdf" : "cover_sheet.pdf"

  // Save merged PDF to project submittal log if a project was selected
  if (projectId) {
    try {
      const safeName = (description ?? "submittal").replace(/[^a-zA-Z0-9._-]/g, "_")
      const storagePath = `project-submittals/${projectId}/${Date.now()}_${safeName}_transmittal.pdf`

      await supabase.storage.from("submittals").upload(storagePath, finalBytes, {
        contentType: "application/pdf",
        upsert: false,
      })

      const targetId = existingId || null

      const transmittalFields = {
        send_to_type:           sendToType    || null,
        send_to_company:        sendToCompany || null,
        send_to_contact:        sendToContact || null,
        send_to_email:          sendToEmail   || null,
        send_to_phone:          sendToPhone   || null,
        send_to_address:        sendToAddress || null,
        transmitted_by:         transmittedBy || null,
        transmitted_by_company: transmittedByCompany || null,
      }

      if (targetId) {
        await supabase.from("submittals").update({
          file_name:    description?.trim() || safeName,
          storage_path: storagePath,
          mime_type:    "application/pdf",
          project_id:   projectId,
          review_status: "Received",
          ...transmittalFields,
        }).eq("id", targetId)
      } else if (submittalId) {
        const { data: orig } = await supabase.from("submittals")
          .select("csi_division, division_name, csi_section, section_name, material_name, manufacturer, dimensions")
          .eq("id", submittalId).maybeSingle()

        await supabase.from("submittals").insert({
          file_name:     description?.trim() || safeName,
          storage_path:  storagePath,
          mime_type:     "application/pdf",
          csi_division:  orig?.csi_division  ?? null,
          division_name: orig?.division_name ?? null,
          csi_section:   orig?.csi_section   ?? null,
          section_name:  orig?.section_name  ?? null,
          material_name: orig?.material_name ?? null,
          manufacturer:  orig?.manufacturer  ?? null,
          dimensions:    orig?.dimensions    ?? null,
          project_id:    projectId,
          status:        "active",
          review_status: "Received",
          uploaded_by:   user.id,
          ...transmittalFields,
        })
      }
    } catch {
      // Non-fatal: PDF still downloads even if DB save fails
    }
  }

  return new NextResponse(Buffer.from(finalBytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  })
}
