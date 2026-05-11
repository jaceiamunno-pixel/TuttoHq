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

  // Build section map and count files per division
  const sectionsByDiv = new Map<string, SectionNode[]>()
  const countsByDiv   = new Map<string, number>()

  for (const row of data ?? []) {
    if (!row.csi_division) continue
    countsByDiv.set(row.csi_division, (countsByDiv.get(row.csi_division) ?? 0) + 1)
    if (!row.csi_section) continue
    if (!sectionsByDiv.has(row.csi_division)) sectionsByDiv.set(row.csi_division, [])
    const sections = sectionsByDiv.get(row.csi_division)!
    if (!sections.find(s => s.code === row.csi_section)) {
      sections.push({ code: row.csi_section, name: row.section_name ?? row.csi_section })
    }
  }

  const divisions: DivisionNode[] = CSI_DIVISIONS.map(d => ({
    num:        d.num,
    name:       d.name,
    sections:   sectionsByDiv.get(d.num) ?? [],
    file_count: countsByDiv.get(d.num) ?? 0,
  }))

  return NextResponse.json({ divisions })
}
