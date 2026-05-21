// CSI MasterFormat division/section data for the upload + classification forms.
// Lifted verbatim from dashboard/page.tsx during the module split (Step 0).

export const CSI_DIVISIONS = [
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

export const CSI_SECTIONS: Record<string, { code: string; name: string }[]> = {
  "03": [
    { code: "03 10 00", name: "Concrete Forming & Accessories" },
    { code: "03 20 00", name: "Concrete Reinforcing" },
    { code: "03 30 00", name: "Cast-in-Place Concrete" },
    { code: "03 40 00", name: "Precast Concrete" },
    { code: "03 50 00", name: "Cast Decks & Underlayment" },
    { code: "03 60 00", name: "Grouting" },
    { code: "03 70 00", name: "Mass Concrete" },
    { code: "03 80 00", name: "Concrete Cutting & Boring" },
  ],
  "04": [
    { code: "04 20 00", name: "Unit Masonry" },
    { code: "04 40 00", name: "Stone Assemblies" },
    { code: "04 50 00", name: "Refractory Masonry" },
    { code: "04 60 00", name: "Corrosion-Resistant Masonry" },
    { code: "04 70 00", name: "Manufactured Masonry" },
  ],
  "05": [
    { code: "05 10 00", name: "Structural Metal Framing" },
    { code: "05 20 00", name: "Metal Joists" },
    { code: "05 30 00", name: "Metal Decking" },
    { code: "05 40 00", name: "Cold-Formed Metal Framing" },
    { code: "05 50 00", name: "Metal Fabrications" },
    { code: "05 70 00", name: "Decorative Metal" },
  ],
  "06": [
    { code: "06 10 00", name: "Rough Carpentry" },
    { code: "06 20 00", name: "Finish Carpentry" },
    { code: "06 40 00", name: "Architectural Woodwork" },
    { code: "06 50 00", name: "Structural Plastics" },
    { code: "06 60 00", name: "Plastic Fabrications" },
    { code: "06 70 00", name: "Structural Composites" },
    { code: "06 80 00", name: "Composite Fabrications" },
  ],
  "07": [
    { code: "07 10 00", name: "Dampproofing & Waterproofing" },
    { code: "07 20 00", name: "Thermal Protection" },
    { code: "07 25 00", name: "Weather Barriers" },
    { code: "07 30 00", name: "Steep Slope Roofing" },
    { code: "07 40 00", name: "Roofing & Siding Panels" },
    { code: "07 50 00", name: "Membrane Roofing" },
    { code: "07 60 00", name: "Flashing & Sheet Metal" },
    { code: "07 70 00", name: "Roof & Wall Specialties & Accessories" },
    { code: "07 80 00", name: "Fire & Smoke Protection" },
    { code: "07 90 00", name: "Joint Protection" },
  ],
  "08": [
    { code: "08 10 00", name: "Doors & Frames" },
    { code: "08 30 00", name: "Specialty Doors & Frames" },
    { code: "08 40 00", name: "Entrances, Storefronts & Curtain Walls" },
    { code: "08 50 00", name: "Windows" },
    { code: "08 60 00", name: "Roof Windows & Skylights" },
    { code: "08 70 00", name: "Hardware" },
    { code: "08 80 00", name: "Glazing" },
    { code: "08 90 00", name: "Louvers & Vents" },
  ],
  "09": [
    { code: "09 20 00", name: "Plaster & Gypsum Board" },
    { code: "09 30 00", name: "Tiling" },
    { code: "09 50 00", name: "Ceilings" },
    { code: "09 60 00", name: "Flooring" },
    { code: "09 70 00", name: "Wall Finishes" },
    { code: "09 80 00", name: "Acoustic Treatment" },
    { code: "09 90 00", name: "Painting & Coating" },
  ],
  "10": [
    { code: "10 10 00", name: "Information Specialties" },
    { code: "10 20 00", name: "Interior Specialties" },
    { code: "10 30 00", name: "Fireplaces & Stoves" },
    { code: "10 40 00", name: "Safety Specialties" },
    { code: "10 50 00", name: "Storage Specialties" },
    { code: "10 70 00", name: "Exterior Specialties" },
    { code: "10 80 00", name: "Other Specialties" },
  ],
  "11": [
    { code: "11 10 00", name: "Vehicle & Pedestrian Equipment" },
    { code: "11 15 00", name: "Security, Detention & Banking Equipment" },
    { code: "11 20 00", name: "Commercial Equipment" },
    { code: "11 30 00", name: "Residential Equipment" },
    { code: "11 40 00", name: "Foodservice Equipment" },
    { code: "11 50 00", name: "Educational & Scientific Equipment" },
    { code: "11 60 00", name: "Entertainment Equipment" },
    { code: "11 65 00", name: "Athletic & Recreational Equipment" },
    { code: "11 70 00", name: "Healthcare Equipment" },
    { code: "11 80 00", name: "Collection & Disposal Equipment" },
    { code: "11 90 00", name: "Other Equipment" },
  ],
  "12": [
    { code: "12 10 00", name: "Art" },
    { code: "12 20 00", name: "Window Treatments" },
    { code: "12 30 00", name: "Casework" },
    { code: "12 40 00", name: "Furnishings & Accessories" },
    { code: "12 50 00", name: "Furniture" },
    { code: "12 60 00", name: "Multiple Seating" },
    { code: "12 90 00", name: "Other Furnishings" },
  ],
  "13": [
    { code: "13 10 00", name: "Special Facility Components" },
    { code: "13 20 00", name: "Special Purpose Rooms" },
    { code: "13 30 00", name: "Special Structures" },
    { code: "13 40 00", name: "Integrated Construction" },
    { code: "13 50 00", name: "Special Instrumentation" },
  ],
  "14": [
    { code: "14 10 00", name: "Dumbwaiters" },
    { code: "14 20 00", name: "Elevators" },
    { code: "14 30 00", name: "Escalators & Moving Walks" },
    { code: "14 40 00", name: "Lifts" },
    { code: "14 70 00", name: "Turntables" },
    { code: "14 80 00", name: "Scaffolding" },
    { code: "14 90 00", name: "Other Conveying Equipment" },
  ],
  "21": [
    { code: "21 10 00", name: "Water-Based Fire-Suppression Systems" },
    { code: "21 20 00", name: "Fire-Extinguishing Systems" },
    { code: "21 30 00", name: "Fire Pumps" },
    { code: "21 40 00", name: "Fire-Suppression Water Storage" },
  ],
  "22": [
    { code: "22 10 00", name: "Plumbing Piping & Pumps" },
    { code: "22 30 00", name: "Plumbing Equipment" },
    { code: "22 40 00", name: "Plumbing Fixtures" },
    { code: "22 50 00", name: "Pool & Fountain Plumbing Systems" },
    { code: "22 60 00", name: "Gas & Vacuum Systems for Laboratory & Healthcare Facilities" },
  ],
  "23": [
    { code: "23 10 00", name: "Facility Fuel Systems" },
    { code: "23 20 00", name: "HVAC Piping & Pumps" },
    { code: "23 30 00", name: "HVAC Air Distribution" },
    { code: "23 40 00", name: "HVAC Air Cleaning Devices" },
    { code: "23 50 00", name: "Central Heating Equipment" },
    { code: "23 60 00", name: "Central Cooling Equipment" },
    { code: "23 70 00", name: "Central HVAC Equipment" },
    { code: "23 80 00", name: "Decentralized HVAC Equipment" },
  ],
  "25": [
    { code: "25 10 00", name: "Integrated Automation Network Equipment" },
    { code: "25 30 00", name: "Integrated Automation Instrumentation & Terminal Devices" },
    { code: "25 50 00", name: "Integrated Automation Facility Controls" },
    { code: "25 90 00", name: "Integrated Automation Control Sequences" },
  ],
  "26": [
    { code: "26 10 00", name: "Medium-Voltage Electrical Distribution" },
    { code: "26 20 00", name: "Low-Voltage Electrical Transmission" },
    { code: "26 30 00", name: "Facility Electrical Power Generating & Storage Equipment" },
    { code: "26 40 00", name: "Electrical & Cathodic Protection" },
    { code: "26 50 00", name: "Lighting" },
  ],
  "27": [
    { code: "27 10 00", name: "Structured Cabling" },
    { code: "27 20 00", name: "Data Communications" },
    { code: "27 30 00", name: "Voice Communications" },
    { code: "27 40 00", name: "Audio-Video Communications" },
    { code: "27 50 00", name: "Distributed Communications & Monitoring Systems" },
    { code: "27 60 00", name: "Wireless Transceivers" },
  ],
  "28": [
    { code: "28 10 00", name: "Electronic Access Control & Intrusion Detection" },
    { code: "28 20 00", name: "Electronic Surveillance" },
    { code: "28 30 00", name: "Electronic Detection & Alarm" },
    { code: "28 40 00", name: "Electronic Monitoring & Control" },
  ],
  "31": [
    { code: "31 10 00", name: "Site Clearing" },
    { code: "31 20 00", name: "Earth Moving" },
    { code: "31 30 00", name: "Earthwork Methods" },
    { code: "31 40 00", name: "Shoring & Underpinning" },
    { code: "31 50 00", name: "Excavation Support & Protection" },
    { code: "31 60 00", name: "Special Foundations & Load-Bearing Elements" },
    { code: "31 70 00", name: "Tunneling & Mining" },
  ],
  "32": [
    { code: "32 10 00", name: "Bases, Ballasts & Paving" },
    { code: "32 30 00", name: "Site Improvements" },
    { code: "32 70 00", name: "Wetlands" },
    { code: "32 80 00", name: "Irrigation" },
    { code: "32 90 00", name: "Planting" },
  ],
  "33": [
    { code: "33 10 00", name: "Water Utilities" },
    { code: "33 20 00", name: "Wells" },
    { code: "33 30 00", name: "Sanitary Sewerage Utilities" },
    { code: "33 40 00", name: "Storm Drainage Utilities" },
    { code: "33 50 00", name: "Fuel Distribution Utilities" },
    { code: "33 60 00", name: "Hydronic & Steam Energy Utilities" },
    { code: "33 70 00", name: "Electrical Utilities" },
    { code: "33 80 00", name: "Communications Utilities" },
  ],
}

// ─── Submittal log section colour palette ────────────────────────────────────
// Eight pastel triples that visually band the submittal log by spec section.
// Class strings are literal so Tailwind's JIT keeps them in the build.
export interface SectionColor { bg: string; border: string; chip: string }

export const SECTION_PALETTE: SectionColor[] = [
  { bg: "bg-slate-50",   border: "border-l-slate-300",   chip: "bg-slate-100 text-slate-700"     },
  { bg: "bg-blue-50",    border: "border-l-blue-300",    chip: "bg-blue-100 text-blue-700"       },
  { bg: "bg-emerald-50", border: "border-l-emerald-300", chip: "bg-emerald-100 text-emerald-700" },
  { bg: "bg-amber-50",   border: "border-l-amber-300",   chip: "bg-amber-100 text-amber-700"     },
  { bg: "bg-violet-50",  border: "border-l-violet-300",  chip: "bg-violet-100 text-violet-700"   },
  { bg: "bg-rose-50",    border: "border-l-rose-300",    chip: "bg-rose-100 text-rose-700"       },
  { bg: "bg-cyan-50",    border: "border-l-cyan-300",    chip: "bg-cyan-100 text-cyan-700"       },
  { bg: "bg-lime-50",    border: "border-l-lime-300",    chip: "bg-lime-100 text-lime-700"       },
]

/**
 * Maps each distinct spec section to a palette index by sorted order, so the
 * colours cycle (0,1,2,…) and adjacent sections in the log never share one.
 */
export function sectionColorMap(sectionCodes: (string | null | undefined)[]): Map<string, number> {
  const distinct = [...new Set(sectionCodes.map(c => c ?? "—"))].sort()
  const map = new Map<string, number>()
  distinct.forEach((code, i) => map.set(code, i % SECTION_PALETTE.length))
  return map
}
