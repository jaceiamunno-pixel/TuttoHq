import { NextRequest, NextResponse } from "next/server"
import Anthropic from "@anthropic-ai/sdk"
import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { enforceAiLimit } from "@/lib/ratelimit"

export const maxDuration = 60

const CSI_LIST = `
03: Concrete — 03 10 00 Concrete Forming & Accessories, 03 20 00 Concrete Reinforcing, 03 30 00 Cast-in-Place Concrete, 03 40 00 Precast Concrete, 03 50 00 Cast Decks & Underlayment, 03 60 00 Grouting, 03 70 00 Mass Concrete, 03 80 00 Concrete Cutting & Boring
04: Masonry — 04 20 00 Unit Masonry, 04 40 00 Stone Assemblies, 04 50 00 Refractory Masonry, 04 60 00 Corrosion-Resistant Masonry, 04 70 00 Manufactured Masonry
05: Metals — 05 10 00 Structural Metal Framing, 05 20 00 Metal Joists, 05 30 00 Metal Decking, 05 40 00 Cold-Formed Metal Framing, 05 50 00 Metal Fabrications, 05 70 00 Decorative Metal
06: Wood, Plastics and Composites — 06 10 00 Rough Carpentry, 06 20 00 Finish Carpentry, 06 40 00 Architectural Woodwork, 06 50 00 Structural Plastics, 06 60 00 Plastic Fabrications, 06 70 00 Structural Composites, 06 80 00 Composite Fabrications
07: Thermal & Moisture Protection — 07 10 00 Dampproofing & Waterproofing, 07 20 00 Thermal Protection, 07 25 00 Weather Barriers, 07 30 00 Steep Slope Roofing, 07 40 00 Roofing & Siding Panels, 07 50 00 Membrane Roofing, 07 60 00 Flashing & Sheet Metal, 07 70 00 Roof & Wall Specialties & Accessories, 07 80 00 Fire & Smoke Protection, 07 90 00 Joint Protection
08: Openings — 08 10 00 Doors & Frames, 08 30 00 Specialty Doors & Frames, 08 40 00 Entrances Storefronts & Curtain Walls, 08 50 00 Windows, 08 60 00 Roof Windows & Skylights, 08 70 00 Hardware, 08 80 00 Glazing, 08 90 00 Louvers & Vents
09: Finishes — 09 20 00 Plaster & Gypsum Board, 09 30 00 Tiling, 09 50 00 Ceilings, 09 60 00 Flooring, 09 70 00 Wall Finishes, 09 80 00 Acoustic Treatment, 09 90 00 Painting & Coating
10: Specialties — 10 10 00 Information Specialties, 10 20 00 Interior Specialties, 10 30 00 Fireplaces & Stoves, 10 40 00 Safety Specialties, 10 50 00 Storage Specialties, 10 70 00 Exterior Specialties, 10 80 00 Other Specialties
11: Equipment — 11 10 00 Vehicle & Pedestrian Equipment, 11 15 00 Security Detention & Banking Equipment, 11 20 00 Commercial Equipment, 11 30 00 Residential Equipment, 11 40 00 Foodservice Equipment, 11 50 00 Educational & Scientific Equipment, 11 60 00 Entertainment Equipment, 11 65 00 Athletic & Recreational Equipment, 11 70 00 Healthcare Equipment, 11 80 00 Collection & Disposal Equipment, 11 90 00 Other Equipment
12: Furnishings — 12 10 00 Art, 12 20 00 Window Treatments, 12 30 00 Casework, 12 40 00 Furnishings & Accessories, 12 50 00 Furniture, 12 60 00 Multiple Seating, 12 90 00 Other Furnishings
13: Special Construction — 13 10 00 Special Facility Components, 13 20 00 Special Purpose Rooms, 13 30 00 Special Structures, 13 40 00 Integrated Construction, 13 50 00 Special Instrumentation
14: Conveying Equipment — 14 10 00 Dumbwaiters, 14 20 00 Elevators, 14 30 00 Escalators & Moving Walks, 14 40 00 Lifts, 14 70 00 Turntables, 14 80 00 Scaffolding, 14 90 00 Other Conveying Equipment
21: Fire Suppression — 21 10 00 Water-Based Fire-Suppression Systems, 21 20 00 Fire-Extinguishing Systems, 21 30 00 Fire Pumps, 21 40 00 Fire-Suppression Water Storage
22: Plumbing — 22 10 00 Plumbing Piping & Pumps, 22 30 00 Plumbing Equipment, 22 40 00 Plumbing Fixtures, 22 50 00 Pool & Fountain Plumbing Systems, 22 60 00 Gas & Vacuum Systems
23: HVAC — 23 10 00 Facility Fuel Systems, 23 20 00 HVAC Piping & Pumps, 23 30 00 HVAC Air Distribution, 23 40 00 HVAC Air Cleaning Devices, 23 50 00 Central Heating Equipment, 23 60 00 Central Cooling Equipment, 23 70 00 Central HVAC Equipment, 23 80 00 Decentralized HVAC Equipment
25: Integrated Automation — 25 10 00 Integrated Automation Network Equipment, 25 30 00 Integrated Automation Instrumentation & Terminal Devices, 25 50 00 Integrated Automation Facility Controls, 25 90 00 Integrated Automation Control Sequences
26: Electrical — 26 10 00 Medium-Voltage Electrical Distribution, 26 20 00 Low-Voltage Electrical Transmission, 26 30 00 Facility Electrical Power Generating & Storage Equipment, 26 40 00 Electrical & Cathodic Protection, 26 50 00 Lighting
27: Communications — 27 10 00 Structured Cabling, 27 20 00 Data Communications, 27 30 00 Voice Communications, 27 40 00 Audio-Video Communications, 27 50 00 Distributed Communications & Monitoring Systems, 27 60 00 Wireless Transceivers
28: Electronic Safety and Security — 28 10 00 Electronic Access Control & Intrusion Detection, 28 20 00 Electronic Surveillance, 28 30 00 Electronic Detection & Alarm, 28 40 00 Electronic Monitoring & Control
31: Earthwork — 31 10 00 Site Clearing, 31 20 00 Earth Moving, 31 30 00 Earthwork Methods, 31 40 00 Shoring & Underpinning, 31 50 00 Excavation Support & Protection, 31 60 00 Special Foundations & Load-Bearing Elements, 31 70 00 Tunneling & Mining
32: Exterior Improvements — 32 10 00 Bases Ballasts & Paving, 32 30 00 Site Improvements, 32 70 00 Wetlands, 32 80 00 Irrigation, 32 90 00 Planting
33: Utilities — 33 10 00 Water Utilities, 33 20 00 Wells, 33 30 00 Sanitary Sewerage Utilities, 33 40 00 Storm Drainage Utilities, 33 50 00 Fuel Distribution Utilities, 33 60 00 Hydronic & Steam Energy Utilities, 33 70 00 Electrical Utilities, 33 80 00 Communications Utilities
`.trim()

const SYSTEM = `You are an expert construction document classifier specializing in CSI MasterFormat.
Your job is to read a submittal document and assign it to the single most appropriate CSI division and section.

CSI Divisions and Sections available:
${CSI_LIST}

General classification guidance:
- Product data sheets / cut sheets: match the product's primary material or system
- Shop drawings: match the fabricated element
- Material certifications / test reports: match the tested material
- If a CSI section code (e.g. "09 20 00") appears explicitly in the document, use that
- Choose the most specific section that fits

Critical construction-specific rules (these override generic reasoning):
- Non-structural metal framing, light-gauge steel studs, drywall framing, metal track → 09 20 00 Plaster & Gypsum Board (NOT Division 05)
- Structural steel columns, beams, moment frames, HSS, wide flange → 05 10 00 Structural Metal Framing
- Cold-formed metal framing for structural floor/roof systems → 05 40 00
- Gypsum board, drywall, shaftwall, shaft liner → 09 20 00 Plaster & Gypsum Board
- Acoustical ceiling tiles, suspension grid → 09 50 00 Ceilings
- Carpet, VCT, LVT, hardwood, epoxy flooring → 09 60 00 Flooring
- Paint, primer, coating, stain → 09 90 00 Painting & Coating
- Spray foam, batt insulation, rigid insulation board → 07 20 00 Thermal Protection
- Roofing membrane, TPO, EPDM, modified bitumen → 07 50 00 Membrane Roofing
- Sheet metal flashing, gutters, downspouts → 07 60 00 Flashing & Sheet Metal
- Firestopping, intumescent sealant → 07 80 00 Fire & Smoke Protection
- Hollow metal doors, wood doors → 08 10 00 Doors & Frames
- Storefront, curtain wall, aluminum framing → 08 40 00 Entrances Storefronts & Curtain Walls
- Glass, glazing, window film → 08 80 00 Glazing
- Ceramic tile, porcelain tile, stone tile → 09 30 00 Tiling
- Toilet partitions, lockers, fire extinguisher cabinets → 10 20 00 Interior Specialties
- Mechanical pipe insulation → 22 10 00 or 23 20 00 depending on system
- Conduit, wire, cable tray → 26 20 00 Low-Voltage Electrical Transmission

Also extract from the document (if present):
- material_name: the primary product or material being submitted (e.g. "Gypsum Board", "Type X Drywall", "Steel Stud Framing")
- manufacturer: the manufacturer or brand name (e.g. "USG", "National Gypsum", "ClarkDietrich")
- dimensions: size, thickness, or gauge (e.g. '5/8" x 4\' x 8\'', "25 Gauge", "3-5/8\" 20ga")

Also provide:
- confidence: integer 0–100 reflecting how certain you are (100 = explicit section code in document, 70–99 = clear product match, 50–69 = reasonable inference, <50 = guessing)
- reasoning: one sentence explaining what in the document led to this classification

Respond with ONLY a compact JSON object — no markdown, no explanation:
{"division_num":"XX","division_name":"Name","section_code":"XX XX XX","section_name":"Name","material_name":"...or null","manufacturer":"...or null","dimensions":"...or null","confidence":85,"reasoning":"..."}`

const MAX_PDF_BYTES = 20 * 1024 * 1024 // 20 MB

// POST /api/classify — classifies an already-uploaded submittal.
//
// The file is PUT straight to the `submittals` bucket from the browser via a
// signed upload URL, so this route receives only `storage_path`. It downloads
// the bytes server-side (not subject to Vercel's 4.5 MB request-body limit)
// before sending them to Claude.
export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY not set" }, { status: 500 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  // TIER 2 cost guard (company-keyed, FAIL CLOSED) — see src/lib/ratelimit.ts.
  const limited = await enforceAiLimit(supabase)
  if (limited) return limited

  const body = await req.json().catch(() => null)
  const storagePath = typeof body?.storage_path === "string" ? body.storage_path.trim() : ""
  const fileName    = typeof body?.file_name    === "string" ? body.file_name.trim()    : ""
  if (!storagePath || !fileName) {
    return NextResponse.json({ error: "storage_path and file_name are required" }, { status: 400 })
  }

  // Defense-in-depth on top of the storage RLS: validate that the client-
  // supplied storage_path starts with the caller's company_id segment AND
  // the presigned-upload prefix. The admin-client download below intentionally
  // bypasses storage RLS (freshly-uploaded blobs sit outside any user-scoped
  // policy), so this guard is doing real work — without it, an authenticated
  // user could aim this route at any object in the submittals bucket,
  // including other tenants'. Same companyId-resolution shape as
  // /api/upload and /api/spec-books/finalize.
  const { data: companyId } = await supabase.rpc("get_my_company_id")
  if (!companyId) {
    return NextResponse.json({ error: "No company association" }, { status: 500 })
  }
  if (!storagePath.startsWith(`${companyId}/uploads/`)) {
    return NextResponse.json({ error: "Invalid storage path" }, { status: 400 })
  }

  // Use the service-role client for the storage read: presigned uploads land
  // outside any user-scoped RLS policy on storage.objects, so the cookie-bound
  // client can't see the freshly-uploaded blob. Auth was already verified above.
  const admin = createAdminClient()
  const { data: blob, error: dlError } = await admin.storage
    .from("submittals")
    .download(storagePath)
  if (dlError || !blob) {
    return NextResponse.json({ error: "Could not read the uploaded file" }, { status: 400 })
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  try {
    const isPdf = blob.type === "application/pdf" || fileName.toLowerCase().endsWith(".pdf")
    const withinSizeLimit = blob.size <= MAX_PDF_BYTES

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let userContent: any

    if (isPdf && withinSizeLimit) {
      const bytes = await blob.arrayBuffer()
      const base64 = Buffer.from(bytes).toString("base64")
      userContent = [
        {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: base64 },
        },
        {
          type: "text",
          text: `Filename: "${fileName}"\n\nClassify this construction submittal into the correct CSI division and section.`,
        },
      ]
    } else {
      userContent = `Filename: "${fileName}"\n\nClassify this construction submittal into the correct CSI division and section based on the filename.`
    }

    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system: SYSTEM,
      messages: [{ role: "user", content: userContent }],
    })

    const text = message.content[0].type === "text" ? message.content[0].text.trim() : ""
    const match = text.match(/\{[\s\S]*?\}/)
    if (!match) throw new Error("No JSON in response")

    const result = JSON.parse(match[0])
    if (!result.division_num || !result.section_code) throw new Error("Incomplete response")

    return NextResponse.json(result)
  } catch (err) {
    console.error("Classify error:", err)
    return NextResponse.json({ error: "Classification failed" }, { status: 500 })
  }
}
