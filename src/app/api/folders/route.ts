import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export interface SectionNode { code: string; name: string }
export interface DivisionNode { num: string; name: string; sections: SectionNode[]; file_count: number }

const CSI_DIVISIONS = [
  { num: "03", name: "Concrete" },
  { num: "04", name: "Masonry" },
  { num: "05", name: "Metals" },
  { num: "06", name: "Wood, Plastics and Composites" },
  { num: "07", name: "Thermal & Moisture Protection" },
  { num: "08", name: "Openings" },
  { num: "09", name: "Finishes" },
  { num: "10", name: "Specialties" },
  { num: "11", name: "Equipment" },
  { num: "12", name: "Furnishings" },
  { num: "13", name: "Special Construction" },
  { num: "14", name: "Conveying Equipment" },
  { num: "21", name: "Fire Suppression" },
  { num: "22", name: "Plumbing" },
  { num: "23", name: "HVAC" },
  { num: "25", name: "Integrated Automation" },
  { num: "26", name: "Electrical" },
  { num: "27", name: "Communications" },
  { num: "28", name: "Electronic Safety and Security" },
  { num: "31", name: "Earthwork" },
  { num: "32", name: "Exterior Improvements" },
  { num: "33", name: "Utilities" },
]

// Static CSI MasterFormat 2016 sections — shown in sidebar regardless of submittals
const CSI_STATIC_SECTIONS: Record<string, SectionNode[]> = {
  "03": [
    { code: "03 10 00", name: "Concrete Forming and Accessories" },
    { code: "03 20 00", name: "Concrete Reinforcing" },
    { code: "03 30 00", name: "Cast-in-Place Concrete" },
    { code: "03 35 00", name: "Concrete Finishing" },
    { code: "03 40 00", name: "Precast Concrete" },
    { code: "03 45 00", name: "Precast Architectural Concrete" },
    { code: "03 50 00", name: "Cast Decks and Underlayment" },
    { code: "03 60 00", name: "Grouting" },
  ],
  "04": [
    { code: "04 20 00", name: "Unit Masonry" },
    { code: "04 21 00", name: "Clay Unit Masonry" },
    { code: "04 22 00", name: "Concrete Unit Masonry" },
    { code: "04 40 00", name: "Stone Assemblies" },
    { code: "04 43 00", name: "Stone Masonry" },
    { code: "04 70 00", name: "Manufactured Masonry" },
  ],
  "05": [
    { code: "05 10 00", name: "Structural Metal Framing" },
    { code: "05 12 00", name: "Structural Steel Framing" },
    { code: "05 20 00", name: "Metal Joists" },
    { code: "05 30 00", name: "Metal Decking" },
    { code: "05 31 00", name: "Steel Decking" },
    { code: "05 40 00", name: "Cold-Formed Metal Framing" },
    { code: "05 50 00", name: "Metal Fabrications" },
    { code: "05 51 00", name: "Metal Stairs" },
    { code: "05 52 00", name: "Metal Railings" },
    { code: "05 70 00", name: "Decorative Metal" },
  ],
  "06": [
    { code: "06 10 00", name: "Rough Carpentry" },
    { code: "06 11 00", name: "Wood Framing" },
    { code: "06 16 00", name: "Sheathing" },
    { code: "06 20 00", name: "Finish Carpentry" },
    { code: "06 22 00", name: "Millwork" },
    { code: "06 40 00", name: "Architectural Woodwork" },
    { code: "06 41 00", name: "Architectural Wood Casework" },
  ],
  "07": [
    { code: "07 10 00", name: "Dampproofing and Waterproofing" },
    { code: "07 13 00", name: "Sheet Waterproofing" },
    { code: "07 14 00", name: "Fluid-Applied Waterproofing" },
    { code: "07 19 00", name: "Water Repellents" },
    { code: "07 21 00", name: "Thermal Insulation" },
    { code: "07 24 00", name: "Exterior Insulation and Finish Systems" },
    { code: "07 25 00", name: "Weather Barriers" },
    { code: "07 27 00", name: "Air Barriers" },
    { code: "07 31 00", name: "Shingles and Shakes" },
    { code: "07 32 00", name: "Roof Tiles" },
    { code: "07 42 00", name: "Wall Panels and Siding" },
    { code: "07 46 00", name: "Siding" },
    { code: "07 51 00", name: "Built-Up Bituminous Roofing" },
    { code: "07 52 00", name: "Modified Bituminous Membrane Roofing" },
    { code: "07 53 00", name: "Elastomeric Membrane Roofing" },
    { code: "07 54 00", name: "Thermoplastic Membrane Roofing" },
    { code: "07 62 00", name: "Sheet Metal Flashing and Trim" },
    { code: "07 71 00", name: "Manufactured Roof Specialties" },
    { code: "07 81 00", name: "Applied Fireproofing" },
    { code: "07 84 00", name: "Firestopping" },
    { code: "07 92 00", name: "Joint Sealants" },
  ],
  "08": [
    { code: "08 11 00", name: "Metal Doors and Frames" },
    { code: "08 14 00", name: "Wood Doors" },
    { code: "08 31 00", name: "Access Doors and Panels" },
    { code: "08 33 00", name: "Coiling Doors and Grilles" },
    { code: "08 34 00", name: "Special Function Doors" },
    { code: "08 41 00", name: "Entrances and Storefronts" },
    { code: "08 43 00", name: "Storefronts" },
    { code: "08 44 00", name: "Curtain Wall and Glazed Assemblies" },
    { code: "08 51 00", name: "Metal Windows" },
    { code: "08 52 00", name: "Wood Windows" },
    { code: "08 62 00", name: "Unit Skylights" },
    { code: "08 71 00", name: "Door Hardware" },
    { code: "08 81 00", name: "Glass Glazing" },
    { code: "08 88 00", name: "Special Function Glazing" },
    { code: "08 90 00", name: "Louvers and Vents" },
  ],
  "09": [
    { code: "09 20 00", name: "Plaster & Gypsum Board" },
    { code: "09 21 00", name: "Gypsum Board Assemblies" },
    { code: "09 22 16", name: "Non-Structural Metal Framing" },
    { code: "09 23 00", name: "Gypsum Plastering" },
    { code: "09 24 00", name: "Portland Cement Plastering" },
    { code: "09 29 00", name: "Gypsum Board" },
    { code: "09 30 00", name: "Tiling" },
    { code: "09 31 00", name: "Ceramic Tiling" },
    { code: "09 51 00", name: "Acoustical Ceilings" },
    { code: "09 54 00", name: "Specialty Ceilings" },
    { code: "09 64 00", name: "Wood Flooring" },
    { code: "09 65 00", name: "Resilient Flooring" },
    { code: "09 66 00", name: "Terrazzo Flooring" },
    { code: "09 67 00", name: "Fluid-Applied Flooring" },
    { code: "09 68 00", name: "Carpet" },
    { code: "09 72 00", name: "Wall Coverings" },
    { code: "09 91 00", name: "Paints" },
    { code: "09 96 00", name: "High-Performance Coatings" },
  ],
  "10": [
    { code: "10 14 00", name: "Signage" },
    { code: "10 21 00", name: "Compartments and Cubicles" },
    { code: "10 22 00", name: "Partitions" },
    { code: "10 26 00", name: "Wall and Door Protection" },
    { code: "10 28 00", name: "Toilet, Bath and Laundry Accessories" },
    { code: "10 44 00", name: "Fire Protection Specialties" },
    { code: "10 51 00", name: "Lockers" },
    { code: "10 71 00", name: "Exterior Protection" },
    { code: "10 73 00", name: "Protective Covers" },
  ],
  "11": [
    { code: "11 13 00", name: "Loading Dock Equipment" },
    { code: "11 31 00", name: "Residential Appliances" },
    { code: "11 40 00", name: "Foodservice Equipment" },
    { code: "11 68 00", name: "Play Field Equipment and Structures" },
  ],
  "12": [
    { code: "12 22 00", name: "Curtains and Drapes" },
    { code: "12 24 00", name: "Window Blinds" },
    { code: "12 32 00", name: "Manufactured Wood Casework" },
    { code: "12 36 00", name: "Countertops" },
    { code: "12 51 00", name: "Office Furniture" },
    { code: "12 52 00", name: "Seating" },
  ],
  "13": [
    { code: "13 11 00", name: "Swimming Pools" },
    { code: "13 34 00", name: "Fabricated Engineered Structures" },
    { code: "13 48 00", name: "Sound, Vibration and Seismic Control" },
  ],
  "14": [
    { code: "14 21 00", name: "Electric Traction Elevators" },
    { code: "14 24 00", name: "Hydraulic Elevators" },
    { code: "14 31 00", name: "Escalators" },
    { code: "14 42 00", name: "Wheelchair Lifts" },
    { code: "14 45 00", name: "Vehicle Lifts" },
  ],
  "21": [
    { code: "21 11 00", name: "Facility Fire Suppression Water-Service Piping" },
    { code: "21 12 00", name: "Fire Suppression Standpipes" },
    { code: "21 13 00", name: "Fire Suppression Sprinkler Systems" },
    { code: "21 22 00", name: "Clean-Agent Fire Extinguishing Systems" },
  ],
  "22": [
    { code: "22 11 00", name: "Facility Water Distribution" },
    { code: "22 13 00", name: "Facility Sanitary Sewerage" },
    { code: "22 14 00", name: "Facility Storm Drainage" },
    { code: "22 33 00", name: "Electric Domestic Water Heaters" },
    { code: "22 34 00", name: "Fuel-Fired Domestic Water Heaters" },
    { code: "22 41 00", name: "Residential Plumbing Fixtures" },
    { code: "22 42 00", name: "Commercial Plumbing Fixtures" },
    { code: "22 47 00", name: "Drinking Fountains and Water Coolers" },
  ],
  "23": [
    { code: "23 07 00", name: "HVAC Insulation" },
    { code: "23 09 00", name: "Instrumentation and Control for HVAC" },
    { code: "23 21 00", name: "Hydronic Piping and Pumps" },
    { code: "23 31 00", name: "HVAC Ducts and Casings" },
    { code: "23 33 00", name: "Air Duct Accessories" },
    { code: "23 34 00", name: "HVAC Fans" },
    { code: "23 36 00", name: "Air Terminal Units" },
    { code: "23 37 00", name: "Air Outlets and Inlets" },
    { code: "23 41 00", name: "Particulate Air Filtration" },
    { code: "23 52 00", name: "Heating Boilers" },
    { code: "23 62 00", name: "Packaged Compressor and Condenser Units" },
    { code: "23 64 00", name: "Packaged Water Chillers" },
    { code: "23 65 00", name: "Cooling Towers" },
    { code: "23 73 00", name: "Indoor Central Station Air-Handling Units" },
    { code: "23 74 00", name: "Packaged Outdoor HVAC Equipment" },
    { code: "23 81 00", name: "Decentralized Unitary HVAC Equipment" },
    { code: "23 82 00", name: "Convective Heating and Cooling Units" },
  ],
  "25": [
    { code: "25 13 00", name: "Integrated Automation Control and Monitoring Network" },
    { code: "25 35 00", name: "Integrated Automation Control Panels" },
    { code: "25 51 00", name: "Integrated Automation Control of Facility HVAC" },
    { code: "25 52 00", name: "Integrated Automation Control of Facility Lighting" },
  ],
  "26": [
    { code: "26 05 19", name: "Low-Voltage Electrical Power Conductors and Cables" },
    { code: "26 05 26", name: "Grounding and Bonding" },
    { code: "26 05 33", name: "Raceways and Boxes" },
    { code: "26 05 43", name: "Underground Ducts and Raceways" },
    { code: "26 12 00", name: "Medium-Voltage Transformers" },
    { code: "26 22 00", name: "Low-Voltage Transformers" },
    { code: "26 24 00", name: "Switchboards, Panelboards and Control Centers" },
    { code: "26 28 00", name: "Low-Voltage Circuit Protective Devices" },
    { code: "26 32 00", name: "Packaged Generator Assemblies" },
    { code: "26 33 00", name: "Battery Equipment" },
    { code: "26 36 00", name: "Transfer Switches" },
    { code: "26 51 00", name: "Interior Lighting" },
    { code: "26 52 00", name: "Emergency Lighting" },
    { code: "26 53 00", name: "Exit Signs" },
    { code: "26 56 00", name: "Exterior Lighting" },
  ],
  "27": [
    { code: "27 11 00", name: "Communications Equipment Room Fittings" },
    { code: "27 13 00", name: "Communications Backbone Cabling" },
    { code: "27 15 00", name: "Communications Horizontal Cabling" },
    { code: "27 21 00", name: "Data Communications Network Equipment" },
    { code: "27 25 00", name: "Telephone Systems" },
    { code: "27 41 00", name: "Audio-Video Systems" },
    { code: "27 51 00", name: "Distributed Audio-Video Communications Systems" },
  ],
  "28": [
    { code: "28 13 00", name: "Access Control" },
    { code: "28 16 00", name: "Intrusion Detection" },
    { code: "28 23 00", name: "Video Surveillance" },
    { code: "28 31 00", name: "Fire Detection and Alarm" },
    { code: "28 34 00", name: "Carbon Monoxide Detection" },
  ],
  "31": [
    { code: "31 10 00", name: "Site Clearing" },
    { code: "31 22 00", name: "Grading" },
    { code: "31 23 00", name: "Excavation and Fill" },
    { code: "31 25 00", name: "Erosion and Sedimentation Controls" },
    { code: "31 31 00", name: "Soil Treatment" },
    { code: "31 41 00", name: "Shoring" },
    { code: "31 62 00", name: "Driven Piles" },
    { code: "31 63 00", name: "Bored Piles" },
    { code: "31 64 00", name: "Caissons" },
  ],
  "32": [
    { code: "32 12 00", name: "Flexible Paving" },
    { code: "32 13 00", name: "Rigid Paving" },
    { code: "32 14 00", name: "Unit Paving" },
    { code: "32 16 00", name: "Curbs and Gutters" },
    { code: "32 17 00", name: "Paving Specialties" },
    { code: "32 18 00", name: "Athletic and Recreational Surfacing" },
    { code: "32 31 00", name: "Fences and Gates" },
    { code: "32 32 00", name: "Retaining Walls" },
    { code: "32 33 00", name: "Site Furnishings" },
    { code: "32 92 00", name: "Turf and Grasses" },
    { code: "32 93 00", name: "Plants" },
  ],
  "33": [
    { code: "33 11 00", name: "Water Utility Distribution Piping" },
    { code: "33 31 00", name: "Sanitary Utility Sewerage Piping" },
    { code: "33 34 00", name: "Sanitary Utility Sewerage Force Mains" },
    { code: "33 41 00", name: "Subdrainage" },
    { code: "33 42 00", name: "Culverts" },
    { code: "33 43 00", name: "Storm Utility Drainage Piping" },
    { code: "33 51 00", name: "Natural Gas Distribution" },
    { code: "33 71 00", name: "Communications Structures" },
    { code: "33 73 00", name: "Exterior Lighting" },
  ],
}

export async function GET() {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("submittals")
    .select("csi_division, csi_section, section_name")
    .eq("status", "active")
    .order("csi_division")
    .order("csi_section")

  if (error) {
    console.error("Failed to load divisions:", error)
    return NextResponse.json({ error: "Failed to load divisions" }, { status: 500 })
  }

  // Count files per division and collect any DB sections not in the static list
  const dbSectionsByDiv = new Map<string, SectionNode[]>()
  const countsByDiv     = new Map<string, number>()

  for (const row of data ?? []) {
    if (!row.csi_division) continue
    const divNum = row.csi_division.trim().padStart(2, "0")
    countsByDiv.set(divNum, (countsByDiv.get(divNum) ?? 0) + 1)
    if (!row.csi_section) continue
    if (!dbSectionsByDiv.has(divNum)) dbSectionsByDiv.set(divNum, [])
    const sections = dbSectionsByDiv.get(divNum)!
    if (!sections.find(s => s.code === row.csi_section)) {
      sections.push({ code: row.csi_section, name: row.section_name ?? row.csi_section })
    }
  }

  const divisions: DivisionNode[] = CSI_DIVISIONS.map(d => {
    const staticSections = CSI_STATIC_SECTIONS[d.num] ?? []
    const dbSections     = dbSectionsByDiv.get(d.num) ?? []

    // Merge: start with static list, append any DB sections not already present
    const staticCodes = new Set(staticSections.map(s => s.code))
    const extra       = dbSections.filter(s => !staticCodes.has(s.code))
    const sections    = [...staticSections, ...extra]

    return {
      num:        d.num,
      name:       d.name,
      sections,
      file_count: countsByDiv.get(d.num) ?? 0,
    }
  })

  return NextResponse.json({ divisions })
}
