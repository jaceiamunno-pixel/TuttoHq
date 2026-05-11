import { NextRequest, NextResponse } from "next/server"
import Anthropic from "@anthropic-ai/sdk"

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

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY not set" }, { status: 500 })
  }

  const formData = await req.formData()
  const file = formData.get("file") as File | null
  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 })
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const prompt = `You are a construction document classifier specializing in CSI MasterFormat divisions.

Classify this construction submittal into the single most appropriate CSI division and section.

CSI Divisions and Sections (format: "XX XX XX Section Name"):
${CSI_LIST}

Filename: ${file.name}

Respond with ONLY a compact JSON object — no markdown, no explanation:
{"division_num":"XX","division_name":"Name","section_code":"XX XX XX","section_name":"Name"}`

  try {
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 150,
      messages: [{ role: "user", content: prompt }],
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
