"use client"

import { useState, useEffect, useRef } from "react"
import Link from "next/link"
import { createClient } from "@/lib/supabase/client"

// ─── Types ────────────────────────────────────────────────────────────────────

interface SubmittalFile {
  id: string
  file_name: string
  file_url: string
  mime_type: string | null
  file_size: number | null
  created_at: string
  csi_division?: string
  division_name?: string
  csi_section?: string
  section_name?: string
}

interface Section  { code: string; name: string }
interface Division { num: string; name: string; sections: Section[]; file_count: number }

type UploadStep = "file" | "classifying" | "suggested" | "manual" | "naming"
interface NameOptions { materials: string[]; manufacturers: string[]; dimensions: string[] }
interface AiResult { division_num: string; division_name: string; section_code: string; section_name: string; material_name?: string | null; manufacturer?: string | null; dimensions?: string | null; confidence?: number; reasoning?: string }

interface SubmittalRecord {
  id: string
  file_name: string
  storage_path: string
  mime_type: string | null
  file_size: number | null
  csi_division: string | null
  division_name: string | null
  csi_section: string | null
  section_name: string | null
  material_name: string | null
  manufacturer: string | null
  dimensions: string | null
  review_status: string | null
  ai_confidence: number | null
  ai_reasoning: string | null
  status: string
  uploaded_by: string
  created_at: string
  project_id: string | null
  sender_email: string | null
  received_at: string | null
  manually_overridden: boolean | null
  overridden_by: string | null
}

type BatchStatus = "pending" | "classifying" | "ready" | "error" | "uploading" | "done" | "upload-error"
type BatchPhase  = "select" | "classifying" | "review" | "uploading" | "done"
interface BatchItem { id: string; file: File; status: BatchStatus; divNum: string; divName: string; secCode: string; secName: string; nameMatl: string; nameMfr: string; nameDims: string; expanded: boolean; errorMsg?: string }

interface Project { id: string; name: string; number: string | null; location: string | null; gc_name: string | null; architect: string | null }
interface TeamMember { id: string; name: string; title: string | null; email: string | null }
interface RFI { id: string; rfi_number: string; subject: string; description: string | null; submitted_by: string | null; assigned_to: string | null; date_issued: string | null; due_date: string | null; status: string; response: string | null; project_id: string | null; created_at: string; uploaded_by: string }
interface PunchItem { id: string; item_number: string; description: string; location: string | null; assigned_to: string | null; due_date: string | null; priority: string; status: string; notes: string | null; project_id: string | null; created_at: string; completed_at: string | null; uploaded_by: string }
interface DailyReport { id: string; report_date: string; project_id: string | null; prepared_by: string | null; weather_conditions: string | null; temperature: string | null; manpower_count: number | null; work_performed: string | null; equipment: string | null; materials_delivered: string | null; visitors: string | null; issues_delays: string | null; safety_notes: string | null; created_at: string; uploaded_by: string }
interface DrawingRecord { id: string; drawing_number: string; sheet_title: string; discipline: string | null; revision: string; revision_date: string | null; status: string; scale: string | null; notes: string | null; project_id: string | null; is_current: boolean; superseded_at: string | null; created_at: string; uploaded_by: string }
type FileModalStep = "project" | "coversheet" | "form"
interface OpenFileCtx { file: SubmittalFile; divNum: string; divName: string; secCode: string; secName: string }
interface CoverFormData { projectName: string; projectNumber: string; projectLocation: string; gcName: string; architect: string; specSectionNo: string; specSectionTitle: string; description: string; dateSubmitted: string; submittalNo: string; reviewedBy: string; certifiedBy: string; notes: string }

// ─── CSI division list for upload form ───────────────────────────────────────

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

const CSI_SECTIONS: Record<string, { code: string; name: string }[]> = {
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MIME_DOT: Record<string, string> = {
  "application/pdf":                                                            "bg-red-400",
  "application/vnd.google-apps.document":                                      "bg-blue-400",
  "application/vnd.google-apps.spreadsheet":                                   "bg-emerald-400",
  "application/vnd.google-apps.presentation":                                  "bg-amber-400",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":   "bg-blue-400",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":         "bg-emerald-400",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "bg-amber-400",
}

function getDot(mime: string | null) {
  return (mime && MIME_DOT[mime]) ?? "bg-stone-400"
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

function fmtDateOnly(d: string) {
  const [y, m, day] = d.split("-").map(Number)
  return new Date(y, m - 1, day).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

// ─── Icons ────────────────────────────────────────────────────────────────────

function ToggleIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={`h-[9px] w-[9px] flex-shrink-0 fill-[#4f617a] transition-transform duration-150 ${open ? "rotate-90" : ""}`}
      viewBox="0 0 8 10"
    >
      <path d="M1.5 1l5 4-5 4z" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 115 11a6 6 0 0112 0z" />
    </svg>
  )
}

function XIcon({ className = "h-3 w-3" }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
    </svg>
  )
}

function SlidersIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg className="h-2.5 w-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
    </svg>
  )
}

function SpinnerIcon({ className = "h-3 w-3" }: { className?: string }) {
  return (
    <svg className={`${className} animate-spin text-[#4f617a]`} fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
    </svg>
  )
}

const STATUS_STYLES: Record<string, string> = {
  "Received":               "bg-blue-400/15 text-blue-300 border-blue-400/20",
  "Under Review":           "bg-amber-400/15 text-amber-300 border-amber-400/20",
  "Approved":               "bg-emerald-400/15 text-emerald-300 border-emerald-400/20",
  "Approved with Comments": "bg-teal-400/15 text-teal-300 border-teal-400/20",
  "Rejected":               "bg-red-400/15 text-red-300 border-red-400/20",
  "Revise and Resubmit":    "bg-orange-400/15 text-orange-300 border-orange-400/20",
  "Needs Review":           "bg-amber-400/15 text-amber-300 border-amber-400/20",
}
function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_STYLES[status] ?? "bg-[#2a3347] text-[#8b9ab5] border-[#2a3347]"
  return <span className={`inline-flex items-center px-2 py-0.5 rounded border text-[11px] font-medium ${cls}`}>{status}</span>
}

const RFI_STATUS_STYLES: Record<string, string> = {
  "Open":         "bg-blue-400/15 text-blue-300 border-blue-400/20",
  "Under Review": "bg-amber-400/15 text-amber-300 border-amber-400/20",
  "Answered":     "bg-teal-400/15 text-teal-300 border-teal-400/20",
  "Closed":       "bg-emerald-400/15 text-emerald-300 border-emerald-400/20",
  "Void":         "bg-[#2a3347] text-[#4f617a] border-[#2a3347]",
}
function RfiStatusBadge({ status }: { status: string }) {
  const cls = RFI_STATUS_STYLES[status] ?? "bg-[#2a3347] text-[#8b9ab5] border-[#2a3347]"
  return <span className={`inline-flex items-center px-2 py-0.5 rounded border text-[11px] font-medium ${cls}`}>{status}</span>
}

const PUNCH_STATUS_STYLES: Record<string, string> = {
  "Open":        "bg-blue-400/15 text-blue-300 border-blue-400/20",
  "In Progress": "bg-amber-400/15 text-amber-300 border-amber-400/20",
  "Completed":   "bg-emerald-400/15 text-emerald-300 border-emerald-400/20",
  "Void":        "bg-[#2a3347] text-[#4f617a] border-[#2a3347]",
}
const PUNCH_PRIORITY_STYLES: Record<string, string> = {
  "Low":      "bg-[#2a3347] text-[#8b9ab5] border-[#2a3347]",
  "Medium":   "bg-blue-400/15 text-blue-300 border-blue-400/20",
  "High":     "bg-amber-400/15 text-amber-300 border-amber-400/20",
  "Critical": "bg-red-400/15 text-red-300 border-red-400/20",
}
function PunchStatusBadge({ status }: { status: string }) {
  const cls = PUNCH_STATUS_STYLES[status] ?? "bg-[#2a3347] text-[#8b9ab5] border-[#2a3347]"
  return <span className={`inline-flex items-center px-2 py-0.5 rounded border text-[11px] font-medium ${cls}`}>{status}</span>
}
function PunchPriorityBadge({ priority }: { priority: string }) {
  const cls = PUNCH_PRIORITY_STYLES[priority] ?? "bg-[#2a3347] text-[#8b9ab5] border-[#2a3347]"
  return <span className={`inline-flex items-center px-2 py-0.5 rounded border text-[11px] font-medium ${cls}`}>{priority}</span>
}

const DRAWING_STATUS_STYLES: Record<string, string> = {
  "Issued for Construction": "bg-emerald-400/15 text-emerald-300 border-emerald-400/20",
  "Issued for Bid":          "bg-blue-400/15 text-blue-300 border-blue-400/20",
  "Issued for Review":       "bg-amber-400/15 text-amber-300 border-amber-400/20",
  "Record Drawings":         "bg-teal-400/15 text-teal-300 border-teal-400/20",
  "Superseded":              "bg-[#2a3347] text-[#4f617a] border-[#2a3347]",
  "Void":                    "bg-red-400/15 text-red-300 border-red-400/20",
}
function DrawingStatusBadge({ status }: { status: string }) {
  const cls = DRAWING_STATUS_STYLES[status] ?? "bg-[#2a3347] text-[#8b9ab5] border-[#2a3347]"
  return <span className={`inline-flex items-center px-2 py-0.5 rounded border text-[11px] font-medium ${cls}`}>{status}</span>
}

function nextRevision(rev: string): string {
  const n = parseInt(rev)
  if (!isNaN(n)) return String(n + 1)
  if (/^[A-Za-z]$/.test(rev)) return String.fromCharCode(rev.toUpperCase().charCodeAt(0) + 1)
  return ""
}

function LayersIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
    </svg>
  )
}

// ─── Combobox ─────────────────────────────────────────────────────────────────

function Combobox({ value, onChange, options, placeholder, autoFocus }: {
  value: string
  onChange: (v: string) => void
  options: string[]
  placeholder?: string
  autoFocus?: boolean
}) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const filtered = value.trim()
    ? options.filter(o => o.toLowerCase().includes(value.toLowerCase()))
    : options

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", onMouseDown)
    return () => document.removeEventListener("mousedown", onMouseDown)
  }, [])

  return (
    <div ref={containerRef} className="relative">
      <input
        type="text"
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={e => { onChange(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onKeyDown={e => { if (e.key === "Escape") setOpen(false) }}
        className="w-full h-9 px-3 rounded-md border border-[#2a3347] text-[13px] text-[#e8edf5] bg-[#0d1117] focus:outline-none focus:ring-1 focus:ring-[#2563eb]/40 focus:border-[#2563eb]/50 placeholder:text-[#4f617a] transition-all"
      />
      {open && filtered.length > 0 && (
        <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-[#1c2333] border border-[#2a3347] rounded-md shadow-xl max-h-44 overflow-y-auto">
          {filtered.map(opt => (
            <button
              key={opt}
              type="button"
              onMouseDown={e => { e.preventDefault(); onChange(opt); setOpen(false) }}
              className="w-full text-left px-3 py-1.5 text-[13px] text-[#c8d3e6] hover:bg-white/[0.07] transition-colors"
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Sidebar file row ─────────────────────────────────────────────────────────

function SidebarFileRow({ file, indent, onDelete, onOpen }: { file: SubmittalFile; indent: number; onDelete?: () => void; onOpen: () => void }) {
  const dot = getDot(file.mime_type)
  return (
    <div
      className="group flex items-center gap-1.5 h-7 rounded-md hover:bg-white/[0.05] transition-colors cursor-pointer"
      style={{ paddingLeft: `${indent}px`, paddingRight: "4px" }}
      onClick={onOpen}
      title={`${file.file_name} · ${fmtDate(file.created_at)}`}
    >
      <span className={`flex-shrink-0 w-1.5 h-1.5 rounded-full ${dot}`} />
      <span className="flex-1 min-w-0 text-[12px] text-[#8b9ab5] truncate">{file.file_name}</span>
      {onDelete && (
        <button
          onClick={e => { e.stopPropagation(); onDelete() }}
          title="Delete file"
          className="opacity-0 group-hover:opacity-100 flex-shrink-0 text-[#4f617a] hover:text-red-400 transition-all rounded p-0.5"
        >
          <XIcon className="h-2.5 w-2.5" />
        </button>
      )}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Home() {
  // Tree state
  const [divisions, setDivisions]     = useState<Division[]>([])
  const [treeLoading, setTreeLoading] = useState(true)
  const [treeError, setTreeError]     = useState<string | null>(null)

  // Accordion state — keyed by division.num and section.code
  const [openDivisions, setOpenDivisions] = useState<Set<string>>(new Set())
  const [openSections, setOpenSections]   = useState<Set<string>>(new Set())

  // Files per section, loaded on demand, keyed by section.code
  const [sectionFiles, setSectionFiles]       = useState<Record<string, SubmittalFile[]>>({})
  const [loadingSections, setLoadingSections] = useState<Set<string>>(new Set())

  // Search
  const [query, setQuery]                 = useState("")
  const [searchResults, setSearchResults] = useState<SubmittalFile[] | null>(null)
  const [searching, setSearching]         = useState(false)
  const [searchError, setSearchError]     = useState<string | null>(null)
  const [searchAiSummary, setSearchAiSummary] = useState<string | null>(null)

  // Upload modal
  const [showUpload, setShowUpload]         = useState(false)
  const [uploadFile, setUploadFile]         = useState<File | null>(null)
  const [uploadDiv, setUploadDiv]           = useState("")
  const [uploadDivName, setUploadDivName]   = useState("")
  const [uploadSec, setUploadSec]           = useState("")
  const [uploadSecName, setUploadSecName]   = useState("")
  const [uploading, setUploading]           = useState(false)
  const [uploadError, setUploadError]       = useState<string | null>(null)
  const [uploadStep, setUploadStep]         = useState<UploadStep>("file")
  const [aiResult, setAiResult]             = useState<AiResult | null>(null)
  const [nameMatl, setNameMatl]             = useState("")
  const [nameMfr, setNameMfr]               = useState("")
  const [nameDims, setNameDims]             = useState("")
  const [nameOpts, setNameOpts]             = useState<NameOptions>({ materials: [], manufacturers: [], dimensions: [] })

  // Submittal log
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [logSubmittals, setLogSubmittals]       = useState<SubmittalRecord[]>([])
  const [logLoading, setLogLoading]             = useState(true)
  const [editSubmittal, setEditSubmittal]       = useState<SubmittalRecord | null>(null)
  const [editStatus, setEditStatus]             = useState("")
  const [editDiv, setEditDiv]                   = useState("")
  const [editDivName, setEditDivName]           = useState("")
  const [editSec, setEditSec]                   = useState("")
  const [editSecName, setEditSecName]           = useState("")
  const [editSaving, setEditSaving]             = useState(false)

  // Batch upload
  const [showBatch, setShowBatch]     = useState(false)
  const [batchItems, setBatchItems]   = useState<BatchItem[]>([])
  const [batchPhase, setBatchPhase]   = useState<BatchPhase>("select")
  const [batchDragOver, setBatchDragOver] = useState(false)

  // Auth + company settings
  const [userEmail, setUserEmail] = useState<string | null>(null)
  const [logoUrl, setLogoUrl]     = useState<string | null>(null)

  // Division visibility
  const [hiddenDivisions, setHiddenDivisions] = useState<Set<string>>(new Set())
  const [showManage, setShowManage] = useState(false)

  // Projects + team
  const [appProjects, setAppProjects]     = useState<Project[]>([])
  const [teamMembers, setTeamMembers]     = useState<TeamMember[]>([])

  // File open modal
  const [openFileCtx, setOpenFileCtx]     = useState<OpenFileCtx | null>(null)
  const [fileModalStep, setFileModalStep] = useState<FileModalStep>("project")
  const [modalProjectId, setModalProjectId] = useState("")
  const [coverForm, setCoverForm]         = useState<CoverFormData | null>(null)
  const [generatingCover, setGeneratingCover] = useState(false)

  // Module navigation
  const [activeModule, setActiveModule] = useState<"submittals" | "rfis" | "punch" | "daily" | "drawings">("submittals")

  // RFI log
  const [rfis, setRfis]                               = useState<RFI[]>([])
  const [rfisLoading, setRfisLoading]                 = useState(false)
  const [showNewRfi, setShowNewRfi]                   = useState(false)
  const [viewRfi, setViewRfi]                         = useState<RFI | null>(null)
  const [rfiSubject, setRfiSubject]                   = useState("")
  const [rfiDescription, setRfiDescription]           = useState("")
  const [rfiSubmittedBy, setRfiSubmittedBy]           = useState("")
  const [rfiAssignedTo, setRfiAssignedTo]             = useState("")
  const [rfiDateIssued, setRfiDateIssued]             = useState(() => new Date().toISOString().slice(0, 10))
  const [rfiDueDate, setRfiDueDate]                   = useState("")
  const [rfiProjectId, setRfiProjectId]               = useState("")
  const [rfiSaving, setRfiSaving]                     = useState(false)
  const [rfiResponse, setRfiResponse]                 = useState("")
  const [rfiResponseStatus, setRfiResponseStatus]     = useState("")
  const [rfiRespondSaving, setRfiRespondSaving]       = useState(false)

  // Punch list
  const [punchItems, setPunchItems]               = useState<PunchItem[]>([])
  const [punchLoading, setPunchLoading]           = useState(false)
  const [showNewPunch, setShowNewPunch]           = useState(false)
  const [viewPunch, setViewPunch]                 = useState<PunchItem | null>(null)
  const [punchDesc, setPunchDesc]                 = useState("")
  const [punchLocation, setPunchLocation]         = useState("")
  const [punchAssignedTo, setPunchAssignedTo]     = useState("")
  const [punchDueDate, setPunchDueDate]           = useState("")
  const [punchPriority, setPunchPriority]         = useState("Medium")
  const [punchProjectId, setPunchProjectId]       = useState("")
  const [punchNotes, setPunchNotes]               = useState("")
  const [punchSaving, setPunchSaving]             = useState(false)
  const [punchEditStatus, setPunchEditStatus]     = useState("")
  const [punchEditNotes, setPunchEditNotes]       = useState("")
  const [punchEditSaving, setPunchEditSaving]     = useState(false)

  // Daily reports
  const [dailyReports, setDailyReports]               = useState<DailyReport[]>([])
  const [dailyLoading, setDailyLoading]               = useState(false)
  const [showNewDaily, setShowNewDaily]               = useState(false)
  const [viewDaily, setViewDaily]                     = useState<DailyReport | null>(null)
  const [dailyDate, setDailyDate]                     = useState(() => new Date().toISOString().slice(0, 10))
  const [dailyProjectId, setDailyProjectId]           = useState("")
  const [dailyPreparedBy, setDailyPreparedBy]         = useState("")
  const [dailyWeather, setDailyWeather]               = useState("")
  const [dailyTemp, setDailyTemp]                     = useState("")
  const [dailyManpower, setDailyManpower]             = useState("")
  const [dailyWorkPerformed, setDailyWorkPerformed]   = useState("")
  const [dailyEquipment, setDailyEquipment]           = useState("")
  const [dailyMaterials, setDailyMaterials]           = useState("")
  const [dailyVisitors, setDailyVisitors]             = useState("")
  const [dailyIssues, setDailyIssues]                 = useState("")
  const [dailySafety, setDailySafety]                 = useState("")
  const [dailySaving, setDailySaving]                 = useState(false)
  const [dailyEditing, setDailyEditing]               = useState(false)
  const [dailyEditSaving, setDailyEditSaving]         = useState(false)

  // Drawing log
  const [drawings, setDrawings]                       = useState<DrawingRecord[]>([])
  const [drawingsLoading, setDrawingsLoading]         = useState(false)
  const [showNewDrawing, setShowNewDrawing]           = useState(false)
  const [addRevisionFor, setAddRevisionFor]           = useState<DrawingRecord | null>(null)
  const [expandedDrawings, setExpandedDrawings]       = useState<Set<string>>(new Set())
  const [dwgNumber, setDwgNumber]                     = useState("")
  const [dwgTitle, setDwgTitle]                       = useState("")
  const [dwgDiscipline, setDwgDiscipline]             = useState("")
  const [dwgRevision, setDwgRevision]                 = useState("0")
  const [dwgRevDate, setDwgRevDate]                   = useState("")
  const [dwgStatus, setDwgStatus]                     = useState("Issued for Review")
  const [dwgScale, setDwgScale]                       = useState("")
  const [dwgNotes, setDwgNotes]                       = useState("")
  const [dwgProjectId, setDwgProjectId]               = useState("")
  const [dwgSaving, setDwgSaving]                     = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)

  // Load user email + company logo + projects + team
  useEffect(() => {
    createClient().auth.getUser().then(({ data }) => {
      setUserEmail(data.user?.email ?? null)
    })
    fetch("/api/settings")
      .then(r => r.json())
      .then(d => { if (d.logo_url) setLogoUrl(d.logo_url) })
      .catch(() => {})
    fetch("/api/projects").then(r => r.json()).then(d => setAppProjects(d.projects ?? [])).catch(() => {})
    fetch("/api/team").then(r => r.json()).then(d => setTeamMembers(d.members ?? [])).catch(() => {})
  }, [])

  // Load division tree
  function loadTree() {
    setTreeLoading(true)
    fetch("/api/folders")
      .then(r => r.json())
      .then(d => {
        if (d.error) throw new Error(d.error)
        setDivisions(d.divisions)
      })
      .catch(e => setTreeError(e instanceof Error ? e.message : "Failed to load folders"))
      .finally(() => setTreeLoading(false))
  }

  useEffect(() => { loadTree() }, [])

  useEffect(() => {
    try {
      const saved = localStorage.getItem("submittal-hidden-divisions")
      if (saved) setHiddenDivisions(new Set(JSON.parse(saved)))
    } catch {}
  }, [])

  useEffect(() => {
    if (showUpload || showBatch) {
      fetch("/api/submittal-names")
        .then(r => r.json())
        .then(d => setNameOpts(d))
        .catch(() => {})
    }
  }, [showUpload, showBatch])

  function toggleDivisionVisibility(num: string) {
    setHiddenDivisions(prev => {
      const next = new Set(prev)
      next.has(num) ? next.delete(num) : next.add(num)
      localStorage.setItem("submittal-hidden-divisions", JSON.stringify([...next]))
      return next
    })
  }

  async function signOut() {
    await createClient().auth.signOut()
    window.location.href = "/login"
  }

  function closeModal() {
    setShowUpload(false)
    setUploadFile(null)
    setUploadDiv("")
    setUploadDivName("")
    setUploadSec("")
    setUploadSecName("")
    setUploadStep("file")
    setAiResult(null)
    setUploadError(null)
    setNameMatl("")
    setNameMfr("")
    setNameDims("")
  }

  function acceptSuggestion() {
    if (!aiResult) return
    setUploadDiv(aiResult.division_num)
    setUploadDivName(aiResult.division_name)
    setUploadSec(aiResult.section_code)
    setUploadSecName(aiResult.section_name)
    if (aiResult.material_name) setNameMatl(aiResult.material_name)
    if (aiResult.manufacturer)  setNameMfr(aiResult.manufacturer)
    if (aiResult.dimensions)    setNameDims(aiResult.dimensions)
    setUploadStep("manual")
  }

  function handleFileOpen(file: SubmittalFile, divNum: string, divName: string, secCode: string, secName: string) {
    setOpenFileCtx({ file, divNum, divName, secCode, secName })
    setFileModalStep("project")
    setModalProjectId("")
    setCoverForm(null)
  }

  function closeFileModal() { setOpenFileCtx(null); setModalProjectId(""); setCoverForm(null) }

  function openFileDirectly() {
    if (!openFileCtx) return
    window.open(openFileCtx.file.mime_type === "application/pdf" ? `/api/download/${openFileCtx.file.id}` : openFileCtx.file.file_url, "_blank")
    closeFileModal()
  }

  function initCoverForm() {
    if (!openFileCtx) return
    const proj = appProjects.find(p => p.id === modalProjectId)
    const today = new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" })
    setCoverForm({ projectName: proj?.name ?? "", projectNumber: proj?.number ?? "", projectLocation: proj?.location ?? "", gcName: proj?.gc_name ?? "", architect: proj?.architect ?? "", specSectionNo: openFileCtx.secCode, specSectionTitle: openFileCtx.secName, description: openFileCtx.file.file_name.replace(/\.[^.]+$/, ""), dateSubmitted: today, submittalNo: "1", reviewedBy: "", certifiedBy: "", notes: "" })
    setFileModalStep("form")
  }

  function openTransmittal(s: SubmittalRecord) {
    setOpenFileCtx({
      file: { id: s.id, file_name: s.file_name, file_url: "", mime_type: s.mime_type, file_size: s.file_size, created_at: s.created_at },
      divNum: s.csi_division ?? "", divName: s.division_name ?? "",
      secCode: s.csi_section ?? "", secName: s.section_name ?? "",
    })
    const pid = s.project_id ?? ""
    setModalProjectId(pid)
    const proj = appProjects.find(p => p.id === pid)
    const today = new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" })
    setCoverForm({
      projectName: proj?.name ?? "", projectNumber: proj?.number ?? "",
      projectLocation: proj?.location ?? "", gcName: proj?.gc_name ?? "",
      architect: proj?.architect ?? "", specSectionNo: s.csi_section ?? "",
      specSectionTitle: s.section_name ?? "",
      description: s.file_name.replace(/\.[^.]+$/, ""),
      dateSubmitted: today, submittalNo: "1",
      reviewedBy: "", certifiedBy: "", notes: "",
    })
    setFileModalStep("form")
  }

  async function handleGenerateCover(e: React.FormEvent) {
    e.preventDefault()
    if (!coverForm || !openFileCtx) return
    setGeneratingCover(true)
    try {
      const res = await fetch("/api/generate-cover", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ submittalId: openFileCtx.file.id, ...coverForm }) })
      if (!res.ok) throw new Error("Failed")
      const blob = await res.blob()
      const a = document.createElement("a")
      a.href = URL.createObjectURL(blob)
      a.download = openFileCtx.file.file_name.replace(/\.[^.]+$/, "") + "_transmittal.pdf"
      a.click()
      URL.revokeObjectURL(a.href)
      closeFileModal()
    } catch { } finally { setGeneratingCover(false) }
  }

  function toggleDivision(num: string) {
    setOpenDivisions(prev => {
      const next = new Set(prev)
      next.has(num) ? next.delete(num) : next.add(num)
      return next
    })
  }

  async function toggleSection(code: string) {
    setOpenSections(prev => {
      const next = new Set(prev)
      next.has(code) ? next.delete(code) : next.add(code)
      return next
    })
    if (sectionFiles[code] !== undefined || loadingSections.has(code)) return
    setLoadingSections(prev => new Set([...prev, code]))
    try {
      const res  = await fetch(`/api/files?code=${encodeURIComponent(code)}`)
      const data = await res.json()
      setSectionFiles(prev => ({ ...prev, [code]: data.files ?? [] }))
    } catch {
      setSectionFiles(prev => ({ ...prev, [code]: [] }))
    } finally {
      setLoadingSections(prev => { const n = new Set(prev); n.delete(code); return n })
    }
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    const q = query.trim()
    if (!q) { clearSearch(); return }
    setSearching(true)
    setSearchError(null)
    setSearchAiSummary(null)
    try {
      const res  = await fetch(`/api/search?q=${encodeURIComponent(q)}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Search failed")
      setSearchResults(data.files)
      setSearchAiSummary(data.aiSummary ?? null)
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : "Search failed")
      setSearchResults(null)
    } finally {
      setSearching(false)
    }
  }

  function clearSearch() {
    setQuery("")
    setSearchResults(null)
    setSearchError(null)
    setSearchAiSummary(null)
    inputRef.current?.focus()
  }

  function refetchSection(code: string) {
    setLoadingSections(prev => new Set([...prev, code]))
    fetch(`/api/files?code=${encodeURIComponent(code)}`)
      .then(r => r.json())
      .then(d => setSectionFiles(prev => ({ ...prev, [code]: d.files ?? [] })))
      .catch(() => setSectionFiles(prev => ({ ...prev, [code]: [] })))
      .finally(() => setLoadingSections(prev => { const n = new Set(prev); n.delete(code); return n }))
  }

  function loadSubmittals(pid = activeProjectId) {
    setLogLoading(true)
    const url = pid ? `/api/submittals?project_id=${encodeURIComponent(pid)}` : "/api/submittals"
    fetch(url)
      .then(r => r.json())
      .then(d => setLogSubmittals(d.submittals ?? []))
      .catch(() => setLogSubmittals([]))
      .finally(() => setLogLoading(false))
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadSubmittals(activeProjectId) }, [activeProjectId])

  function loadRfis() {
    setRfisLoading(true)
    fetch("/api/rfis")
      .then(r => r.json())
      .then(d => setRfis(d.rfis ?? []))
      .catch(() => setRfis([]))
      .finally(() => setRfisLoading(false))
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (activeModule === "rfis") loadRfis() }, [activeModule])

  function loadPunch() {
    setPunchLoading(true)
    fetch("/api/punch")
      .then(r => r.json())
      .then(d => setPunchItems(d.items ?? []))
      .catch(() => setPunchItems([]))
      .finally(() => setPunchLoading(false))
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (activeModule === "punch") loadPunch() }, [activeModule])

  function loadDaily() {
    setDailyLoading(true)
    fetch("/api/daily-reports")
      .then(r => r.json())
      .then(d => setDailyReports(d.reports ?? []))
      .catch(() => setDailyReports([]))
      .finally(() => setDailyLoading(false))
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (activeModule === "daily") loadDaily() }, [activeModule])

  function loadDrawings() {
    setDrawingsLoading(true)
    fetch("/api/drawings")
      .then(r => r.json())
      .then(d => setDrawings(d.drawings ?? []))
      .catch(() => setDrawings([]))
      .finally(() => setDrawingsLoading(false))
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (activeModule === "drawings") loadDrawings() }, [activeModule])

  function openAddRevision(d: DrawingRecord) {
    setAddRevisionFor(d)
    setDwgNumber(d.drawing_number)
    setDwgTitle(d.sheet_title)
    setDwgDiscipline(d.discipline ?? "")
    setDwgRevision(nextRevision(d.revision))
    setDwgRevDate("")
    setDwgStatus(d.status)
    setDwgScale(d.scale ?? "")
    setDwgNotes("")
    setDwgProjectId(d.project_id ?? "")
  }

  function resetDwgForm() {
    setDwgNumber(""); setDwgTitle(""); setDwgDiscipline(""); setDwgRevision("0")
    setDwgRevDate(""); setDwgStatus("Issued for Review"); setDwgScale(""); setDwgNotes(""); setDwgProjectId("")
  }

  async function createDrawing(e: React.FormEvent) {
    e.preventDefault()
    setDwgSaving(true)
    try {
      const res = await fetch("/api/drawings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ drawing_number: dwgNumber, sheet_title: dwgTitle, discipline: dwgDiscipline || null, revision: dwgRevision, revision_date: dwgRevDate || null, status: dwgStatus, scale: dwgScale || null, notes: dwgNotes || null, project_id: dwgProjectId || null }),
      })
      if (res.ok) {
        setShowNewDrawing(false); setAddRevisionFor(null); resetDwgForm(); loadDrawings()
        // Collapse revision history so updated row is visible
        setExpandedDrawings(prev => { const n = new Set(prev); n.delete(dwgNumber); return n })
      }
    } finally { setDwgSaving(false) }
  }

  function openEditModal(s: SubmittalRecord) {
    setEditSubmittal(s)
    setEditStatus(s.review_status ?? "Received")
    setEditDiv(s.csi_division ?? "")
    setEditDivName(s.division_name ?? "")
    setEditSec(s.csi_section ?? "")
    setEditSecName(s.section_name ?? "")
  }

  async function deleteSubmittal(s: SubmittalRecord) {
    if (!window.confirm(`Delete "${s.file_name}"? This cannot be undone.`)) return
    const res = await fetch(`/api/submittals/${s.id}`, { method: "DELETE" })
    if (res.ok) {
      setLogSubmittals(prev => prev.filter(x => x.id !== s.id))
      setSectionFiles(prev => {
        const next = { ...prev }
        for (const code of Object.keys(next)) {
          next[code] = next[code].filter(f => f.id !== s.id)
        }
        return next
      })
      loadTree()
    }
  }

  async function saveEdit() {
    if (!editSubmittal) return
    setEditSaving(true)
    const div = CSI_DIVISIONS.find(d => d.num === editDiv)
    const sec = (CSI_SECTIONS[editDiv] ?? []).find(s => s.code === editSec)
    const updates: Record<string, string | null> = {
      review_status: editStatus || null,
      csi_division:  editDiv || null,
      division_name: (div?.name ?? editDivName) || null,
      csi_section:   editSec || null,
      section_name:  (sec?.name ?? editSecName) || null,
    }
    try {
      const res = await fetch(`/api/submittals/${editSubmittal.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(updates),
      })
      if (res.ok) { setEditSubmittal(null); loadSubmittals(); loadTree() }
    } finally { setEditSaving(false) }
  }

  async function createRfi(e: React.FormEvent) {
    e.preventDefault()
    setRfiSaving(true)
    try {
      const res = await fetch("/api/rfis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: rfiSubject, description: rfiDescription || null, submitted_by: rfiSubmittedBy || null, assigned_to: rfiAssignedTo || null, date_issued: rfiDateIssued || null, due_date: rfiDueDate || null, project_id: rfiProjectId || null }),
      })
      if (res.ok) {
        setShowNewRfi(false)
        setRfiSubject(""); setRfiDescription(""); setRfiSubmittedBy(""); setRfiAssignedTo(""); setRfiDueDate(""); setRfiProjectId("")
        setRfiDateIssued(new Date().toISOString().slice(0, 10))
        loadRfis()
      }
    } finally { setRfiSaving(false) }
  }

  function openDailyForEdit(r: DailyReport) {
    setViewDaily(r)
    setDailyDate(r.report_date)
    setDailyProjectId(r.project_id ?? "")
    setDailyPreparedBy(r.prepared_by ?? "")
    setDailyWeather(r.weather_conditions ?? "")
    setDailyTemp(r.temperature ?? "")
    setDailyManpower(r.manpower_count != null ? String(r.manpower_count) : "")
    setDailyWorkPerformed(r.work_performed ?? "")
    setDailyEquipment(r.equipment ?? "")
    setDailyMaterials(r.materials_delivered ?? "")
    setDailyVisitors(r.visitors ?? "")
    setDailyIssues(r.issues_delays ?? "")
    setDailySafety(r.safety_notes ?? "")
    setDailyEditing(true)
  }

  async function createDaily(e: React.FormEvent) {
    e.preventDefault()
    setDailySaving(true)
    try {
      const res = await fetch("/api/daily-reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ report_date: dailyDate, project_id: dailyProjectId || null, prepared_by: dailyPreparedBy || null, weather_conditions: dailyWeather || null, temperature: dailyTemp || null, manpower_count: dailyManpower || null, work_performed: dailyWorkPerformed || null, equipment: dailyEquipment || null, materials_delivered: dailyMaterials || null, visitors: dailyVisitors || null, issues_delays: dailyIssues || null, safety_notes: dailySafety || null }),
      })
      if (res.ok) {
        setShowNewDaily(false)
        setDailyDate(new Date().toISOString().slice(0, 10)); setDailyProjectId(""); setDailyPreparedBy(""); setDailyWeather(""); setDailyTemp(""); setDailyManpower(""); setDailyWorkPerformed(""); setDailyEquipment(""); setDailyMaterials(""); setDailyVisitors(""); setDailyIssues(""); setDailySafety("")
        loadDaily()
      }
    } finally { setDailySaving(false) }
  }

  async function saveDaily(e: React.FormEvent) {
    e.preventDefault()
    if (!viewDaily) return
    setDailyEditSaving(true)
    try {
      const res = await fetch(`/api/daily-reports/${viewDaily.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ report_date: dailyDate, project_id: dailyProjectId || null, prepared_by: dailyPreparedBy || null, weather_conditions: dailyWeather || null, temperature: dailyTemp || null, manpower_count: dailyManpower ? parseInt(dailyManpower) : null, work_performed: dailyWorkPerformed || null, equipment: dailyEquipment || null, materials_delivered: dailyMaterials || null, visitors: dailyVisitors || null, issues_delays: dailyIssues || null, safety_notes: dailySafety || null }),
      })
      if (res.ok) { setViewDaily(null); setDailyEditing(false); loadDaily() }
    } finally { setDailyEditSaving(false) }
  }

  async function createPunch(e: React.FormEvent) {
    e.preventDefault()
    setPunchSaving(true)
    try {
      const res = await fetch("/api/punch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: punchDesc, location: punchLocation || null, assigned_to: punchAssignedTo || null, due_date: punchDueDate || null, priority: punchPriority, project_id: punchProjectId || null, notes: punchNotes || null }),
      })
      if (res.ok) {
        setShowNewPunch(false)
        setPunchDesc(""); setPunchLocation(""); setPunchAssignedTo(""); setPunchDueDate(""); setPunchPriority("Medium"); setPunchProjectId(""); setPunchNotes("")
        loadPunch()
      }
    } finally { setPunchSaving(false) }
  }

  async function updatePunch() {
    if (!viewPunch) return
    setPunchEditSaving(true)
    try {
      const res = await fetch(`/api/punch/${viewPunch.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: punchEditStatus, notes: punchEditNotes }),
      })
      if (res.ok) { setViewPunch(null); loadPunch() }
    } finally { setPunchEditSaving(false) }
  }

  async function respondRfi() {
    if (!viewRfi) return
    setRfiRespondSaving(true)
    try {
      const res = await fetch(`/api/rfis/${viewRfi.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: rfiResponse, status: rfiResponseStatus }),
      })
      if (res.ok) { setViewRfi(null); setRfiResponse(""); loadRfis() }
    } finally { setRfiRespondSaving(false) }
  }

  function closeBatch() {
    setShowBatch(false)
    setBatchItems([])
    setBatchPhase("select")
    setBatchDragOver(false)
  }

  function updateBatchItem(id: string, update: Partial<BatchItem>) {
    setBatchItems(prev => prev.map(it => it.id === id ? { ...it, ...update } : it))
  }

  function initBatchFiles(files: File[]) {
    const valid = files.filter(f => /\.(pdf|doc|docx|xls|xlsx|dwg|rvt)$/i.test(f.name))
    if (!valid.length) return
    setBatchItems(valid.map((file, i) => ({
      id: `${Date.now()}-${i}`, file, status: "pending",
      divNum: "", divName: "", secCode: "", secName: "",
      nameMatl: "", nameMfr: "", nameDims: "", expanded: false,
    })))
  }

  async function classifyBatch() {
    setBatchPhase("classifying")
    const items = [...batchItems]
    const CONCURRENCY = 4

    async function classifyOne(item: BatchItem) {
      updateBatchItem(item.id, { status: "classifying" })
      try {
        const fd = new FormData()
        fd.append("file", item.file)
        const res  = await fetch("/api/classify", { method: "POST", body: fd })
        const data = await res.json()
        if (res.ok && data.division_num && data.section_code) {
          updateBatchItem(item.id, {
            status: "ready",
            divNum: data.division_num, divName: data.division_name,
            secCode: data.section_code, secName: data.section_name,
            nameMatl: data.material_name ?? "", nameMfr: data.manufacturer ?? "", nameDims: data.dimensions ?? "",
          })
        } else {
          updateBatchItem(item.id, { status: "error", errorMsg: "Could not classify — assign manually" })
        }
      } catch {
        updateBatchItem(item.id, { status: "error", errorMsg: "Network error" })
      }
    }

    // Run in chunks of CONCURRENCY to stay within API rate limits
    for (let i = 0; i < items.length; i += CONCURRENCY) {
      await Promise.all(items.slice(i, i + CONCURRENCY).map(classifyOne))
    }
    setBatchPhase("review")
  }

  async function uploadBatch() {
    setBatchPhase("uploading")
    const toUpload = batchItems.filter(it => (it.status === "ready" || it.status === "error") && it.divNum && it.secCode)

    async function uploadOne(item: BatchItem) {
      updateBatchItem(item.id, { status: "uploading" })
      try {
        const fd = new FormData()
        fd.append("file",          item.file)
        fd.append("division_num",  item.divNum)
        fd.append("division_name", item.divName)
        fd.append("section_code",  item.secCode)
        fd.append("section_name",  item.secName)
        if (item.nameMatl) fd.append("material_name", item.nameMatl)
        if (item.nameMfr)  fd.append("manufacturer",  item.nameMfr)
        if (item.nameDims) fd.append("dimensions",     item.nameDims)
        const res = await fetch("/api/upload", { method: "POST", body: fd })
        updateBatchItem(item.id, { status: res.ok ? "done" : "upload-error", errorMsg: res.ok ? undefined : "Upload failed" })
      } catch {
        updateBatchItem(item.id, { status: "upload-error", errorMsg: "Network error" })
      }
    }

    // Uploads can all run in parallel — no AI rate limit concern
    await Promise.all(toUpload.map(uploadOne))
    setBatchPhase("done")
    loadTree()
    loadSubmittals()
    setSectionFiles({})
  }

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault()
    if (!uploadFile || !uploadDiv || !uploadSec) return
    setUploading(true)
    setUploadError(null)

    const fd = new FormData()
    fd.append("file",          uploadFile)
    fd.append("division_num",  uploadDiv)
    fd.append("division_name", uploadDivName)
    fd.append("section_code",  uploadSec)
    fd.append("section_name",  uploadSecName)
    fd.append("material_name", nameMatl)
    fd.append("manufacturer",  nameMfr)
    fd.append("dimensions",    nameDims)
    if (aiResult?.confidence != null) fd.append("ai_confidence", String(aiResult.confidence))
    if (aiResult?.reasoning)          fd.append("ai_reasoning",  aiResult.reasoning)

    try {
      const res  = await fetch("/api/upload", { method: "POST", body: fd })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Upload failed")

      // Append new name values to local opts so they appear in next upload
      setNameOpts(prev => ({
        materials:     nameMatl.trim() && !prev.materials.includes(nameMatl.trim())     ? [...prev.materials,     nameMatl.trim()].sort()     : prev.materials,
        manufacturers: nameMfr.trim()  && !prev.manufacturers.includes(nameMfr.trim()) ? [...prev.manufacturers, nameMfr.trim()].sort()  : prev.manufacturers,
        dimensions:    nameDims.trim() && !prev.dimensions.includes(nameDims.trim())   ? [...prev.dimensions,    nameDims.trim()].sort()    : prev.dimensions,
      }))

      // Open the division + section and immediately fetch the files
      setOpenDivisions(prev => new Set([...prev, uploadDiv]))
      setOpenSections(prev => new Set([...prev, uploadSec]))
      setSectionFiles(prev => { const n = { ...prev }; delete n[uploadSec]; return n })
      refetchSection(uploadSec)
      loadTree()
      loadSubmittals()
      closeModal()
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed")
    } finally {
      setUploading(false)
    }
  }

  const isSearchMode = searchResults !== null || searching

  const inputCls = "w-full h-9 px-3 rounded-md border border-[#2a3347] text-[13px] text-[#e8edf5] bg-[#0d1117] focus:outline-none focus:ring-1 focus:ring-[#2563eb]/40 focus:border-[#2563eb]/50 placeholder:text-[#4f617a] transition-all"
  const labelCls = "block text-[12px] font-medium text-[#8b9ab5] mb-1"

  return (
    <div className="flex min-h-screen bg-[#0f1117]">

      {/* ── Sidebar ───────────────────────────────────────────────────────── */}
      <aside style={{ width: "33.333vw" }} className="flex-shrink-0 bg-[#161b27] border-r border-[#2a3347] flex flex-col h-screen sticky top-0 overflow-hidden">

        {/* Workspace header */}
        <div className="flex-shrink-0 px-3 pt-4 pb-2">
          <div className="flex items-center gap-2.5 px-2 h-9 cursor-default select-none">
            <div className="w-6 h-6 rounded-md bg-[#2563eb]/20 border border-[#2563eb]/30 flex items-center justify-center flex-shrink-0">
              <svg className="w-3.5 h-3.5 text-[#60a5fa]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <span className="text-[14px] font-bold text-[#e8edf5] tracking-tight truncate">Submittal Library</span>
          </div>
          <p className="text-[11px] text-[#4f617a] px-2 pb-1">THP Construction</p>
        </div>

        {/* Search */}
        <div className="flex-shrink-0 px-3 pb-2">
          <form onSubmit={handleSearch}>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 flex items-center pl-2.5 pointer-events-none text-[#4f617a]">
                <SearchIcon />
              </div>
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => e.key === "Escape" && clearSearch()}
                placeholder="Search submittals…"
                className="w-full h-8 pl-8 pr-6 rounded-md text-[13px] bg-[#0d1117] border border-[#2a3347] text-[#e8edf5] placeholder-[#4f617a] focus:outline-none focus:ring-1 focus:ring-[#2563eb]/40 focus:border-[#2563eb]/50 transition-all"
              />
              {query && (
                <button
                  type="button"
                  onClick={clearSearch}
                  className="absolute inset-y-0 right-0 flex items-center pr-2 text-[#4f617a] hover:text-[#8b9ab5] transition-colors"
                >
                  <XIcon />
                </button>
              )}
            </div>
          </form>
        </div>

        <div className="flex-shrink-0 border-t border-[#2a3347] mx-3 mt-0.5 mb-1.5" />

        {/* Section label + upload button */}
        <div className="flex-shrink-0 px-4 pb-1">
          {isSearchMode && searchAiSummary && !searching && (
            <p className="text-[11px] text-[#2563eb] mb-1 flex items-center gap-1">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm1 14.93V17a1 1 0 0 1-2 0v-.07A8 8 0 0 1 4.07 9H5a1 1 0 0 1 0 2 6 6 0 0 0 6 6zm-1-6.93A2 2 0 1 1 14 12a2 2 0 0 1-2-1.93z"/></svg>
              AI: {searchAiSummary}
            </p>
          )}
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-bold text-[#4f617a] uppercase tracking-widest">
            {isSearchMode
              ? (searching ? "Searching…" : `${searchResults?.length ?? 0} results`)
              : "Divisions"}
          </span>
          <div className="flex items-center gap-2">
            {isSearchMode && !searching && (
              <button
                onClick={clearSearch}
                className="text-[11px] text-[#8b9ab5] hover:text-[#e8edf5] transition-colors"
              >
                Clear
              </button>
            )}
            {!isSearchMode && (
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setShowManage(true)}
                  title="Manage divisions"
                  className="text-[#4f617a] hover:text-[#8b9ab5] transition-colors"
                >
                  <SlidersIcon />
                </button>
                <button
                  onClick={() => { setShowBatch(true); setBatchPhase("select"); setBatchItems([]) }}
                  title="Batch upload"
                  className="text-[#4f617a] hover:text-[#8b9ab5] transition-colors"
                >
                  <LayersIcon />
                </button>
                <button
                  onClick={() => setShowUpload(true)}
                  title="Upload submittal"
                  className="text-[#4f617a] hover:text-[#8b9ab5] transition-colors"
                >
                  <PlusIcon />
                </button>
              </div>
            )}
          </div>
        </div>
        </div>

        {/* Scrollable tree */}
        <div className="flex-1 overflow-y-auto px-2 pb-2 min-h-0">

          {treeLoading && !isSearchMode && (
            <div className="flex items-center gap-2 px-3 py-2 text-[13px] text-[#4f617a]">
              <SpinnerIcon /> Loading…
            </div>
          )}

          {treeError && !isSearchMode && (
            <p className="px-3 py-1 text-[12px] text-red-400">{treeError}</p>
          )}

          {searching && (
            <div className="flex items-center gap-2 px-3 py-2 text-[13px] text-[#4f617a]">
              <SpinnerIcon /> Searching…
            </div>
          )}

          {/* Search results */}
          {!searching && isSearchMode && (
            <>
              {searchError && <p className="px-3 py-1 text-[12px] text-red-400">{searchError}</p>}
              {searchResults?.length === 0 && (
                <p className="px-3 py-2 text-[13px] text-[#4f617a]">No results for &ldquo;{query}&rdquo;</p>
              )}
              {searchResults?.map(file => (
                <SidebarFileRow
                  key={file.id}
                  file={file}
                  indent={8}
                  onOpen={() => handleFileOpen(file, file.csi_division ?? "", file.division_name ?? "", file.csi_section ?? "", file.section_name ?? "")}
                />
              ))}
            </>
          )}

          {/* Division tree */}
          {!isSearchMode && !treeLoading && !treeError && divisions.filter(d => !hiddenDivisions.has(d.num)).map(div => {
            const isOpen = openDivisions.has(div.num)
            return (
              <div key={div.num}>
                <button
                  onClick={() => toggleDivision(div.num)}
                  className="w-full flex items-center gap-1.5 h-8 px-2 rounded-md hover:bg-white/[0.05] transition-colors text-left group"
                >
                  <span className="w-4 flex items-center justify-center flex-shrink-0">
                    <ToggleIcon open={isOpen} />
                  </span>
                  <span className="text-[11px] font-mono text-[#4f617a] w-5 text-right flex-shrink-0">{div.num}</span>
                  <span className="flex-1 text-[13px] font-semibold text-[#c8d3e6] truncate">{div.name}</span>
                  {div.file_count > 0 && (
                    <span className="text-[10px] text-[#4f617a] flex-shrink-0 tabular-nums bg-[#2563eb]/10 px-1.5 py-0.5 rounded">{div.file_count}</span>
                  )}
                </button>

                <div className={`grid transition-all duration-150 ${isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
                  <div className="overflow-hidden">
                    <div className="ml-[20px] border-l border-[#2a3347] pl-1">
                      {div.sections.map(sec => {
                        const secOpen    = openSections.has(sec.code)
                        const secLoading = loadingSections.has(sec.code)
                        const files      = sectionFiles[sec.code] ?? []
                        return (
                          <div key={sec.code}>
                            <button
                              onClick={() => toggleSection(sec.code)}
                              className="w-full flex items-center gap-1.5 h-7 px-1.5 rounded-md hover:bg-white/[0.04] transition-colors text-left group"
                            >
                              <span className="w-3.5 flex items-center justify-center flex-shrink-0">
                                {secLoading
                                  ? <SpinnerIcon className="h-2.5 w-2.5" />
                                  : <ToggleIcon open={secOpen} />
                                }
                              </span>
                              <span className="flex-1 text-[12px] text-[#8b9ab5] truncate">
                                <span className="font-mono text-[#4f617a] mr-1.5">{sec.code}</span>{sec.name}
                              </span>
                              {!secLoading && sectionFiles[sec.code] !== undefined && (
                                <span className="text-[10px] text-[#4f617a] flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                                  {files.length}
                                </span>
                              )}
                            </button>

                            <div className={`grid transition-all duration-150 ${secOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
                              <div className="overflow-hidden">
                                <div className="ml-[14px] border-l border-[#2a3347] pl-1">
                                  {secLoading && (
                                    <div className="flex items-center gap-1.5 h-7 px-2 text-[12px] text-[#4f617a]">
                                      <SpinnerIcon className="h-2.5 w-2.5" /> Loading…
                                    </div>
                                  )}
                                  {!secLoading && sectionFiles[sec.code] !== undefined && files.length === 0 && (
                                    <p className="px-2 h-7 flex items-center text-[12px] text-[#4f617a]">Empty</p>
                                  )}
                                  {!secLoading && files.map(file => (
                                    <SidebarFileRow
                                      key={file.id}
                                      file={file}
                                      indent={8}
                                      onOpen={() => handleFileOpen(file, div.num, div.name, sec.code, sec.name)}
                                      onDelete={async () => {
                                        const res = await fetch(`/api/files/${file.id}`, { method: "DELETE" })
                                        if (res.ok) {
                                          setSectionFiles(prev => ({
                                            ...prev,
                                            [sec.code]: (prev[sec.code] ?? []).filter(f => f.id !== file.id),
                                          }))
                                          loadTree()
                                        }
                                      }}
                                    />
                                  ))}
                                </div>
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {/* Settings + sign out */}
        <div className="flex-shrink-0 border-t border-[#2a3347]">
          <div className="px-2 pt-1.5">
            <Link
              href="/settings"
              className="flex items-center gap-2 h-8 px-2 rounded-md text-[12px] text-[#8b9ab5] hover:bg-white/[0.05] hover:text-[#e8edf5] transition-colors"
            >
              <svg className="h-3.5 w-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              Settings
            </Link>
          </div>
          <div className="flex items-center justify-between px-3 py-2.5">
            <span className="text-[11px] text-[#4f617a] truncate min-w-0">{userEmail}</span>
            <button
              onClick={signOut}
              className="text-[11px] text-[#8b9ab5] hover:text-[#e8edf5] transition-colors flex-shrink-0 ml-2"
            >
              Sign out
            </button>
          </div>
        </div>
      </aside>

      {/* ── Main content area ─────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-h-0">

        {/* Logo bar */}
        {logoUrl && (
          <div className="flex-shrink-0 border-b border-[#2a3347] flex items-center justify-end px-6 py-2 bg-[#161b27]">
            <img src={logoUrl} alt="Company logo" className="h-7 max-w-[160px] object-contain" />
          </div>
        )}

        {/* Module navigation */}
        <div className="flex-shrink-0 border-b border-[#2a3347] bg-[#161b27] flex items-center px-4 gap-1">
          <button onClick={() => setActiveModule("submittals")}
            className={`px-3 py-2.5 text-[13px] font-medium border-b-2 transition-colors whitespace-nowrap ${activeModule === "submittals" ? "border-[#2563eb] text-[#e8edf5]" : "border-transparent text-[#4f617a] hover:text-[#8b9ab5]"}`}>
            Submittals
          </button>
          <button onClick={() => setActiveModule("rfis")}
            className={`px-3 py-2.5 text-[13px] font-medium border-b-2 transition-colors whitespace-nowrap ${activeModule === "rfis" ? "border-[#2563eb] text-[#e8edf5]" : "border-transparent text-[#4f617a] hover:text-[#8b9ab5]"}`}>
            RFIs
          </button>
          <button onClick={() => setActiveModule("punch")}
            className={`px-3 py-2.5 text-[13px] font-medium border-b-2 transition-colors whitespace-nowrap ${activeModule === "punch" ? "border-[#2563eb] text-[#e8edf5]" : "border-transparent text-[#4f617a] hover:text-[#8b9ab5]"}`}>
            Punch List
          </button>
          <button onClick={() => setActiveModule("daily")}
            className={`px-3 py-2.5 text-[13px] font-medium border-b-2 transition-colors whitespace-nowrap ${activeModule === "daily" ? "border-[#2563eb] text-[#e8edf5]" : "border-transparent text-[#4f617a] hover:text-[#8b9ab5]"}`}>
            Daily Reports
          </button>
          <button onClick={() => setActiveModule("drawings")}
            className={`px-3 py-2.5 text-[13px] font-medium border-b-2 transition-colors whitespace-nowrap ${activeModule === "drawings" ? "border-[#2563eb] text-[#e8edf5]" : "border-transparent text-[#4f617a] hover:text-[#8b9ab5]"}`}>
            Drawing Log
          </button>
        </div>

        {/* Submittal action bar */}
        {activeModule === "submittals" && (
        <div className="flex-shrink-0 border-b border-[#2a3347] bg-[#161b27] flex items-center justify-between px-4 py-2 gap-3">
          <div className="relative flex-1 max-w-xs">
            <select
              value={activeProjectId ?? ""}
              onChange={e => setActiveProjectId(e.target.value || null)}
              className="w-full h-8 pl-3 pr-8 rounded-md border border-[#2a3347] bg-[#1e2535] text-[13px] text-[#c8d3e6] appearance-none cursor-pointer hover:border-[#3a4a63] transition-colors focus:outline-none focus:border-[#2563eb]"
            >
              <option value="">All Submittals</option>
              {appProjects.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.number ? ` — ${p.number}` : ""}
                </option>
              ))}
            </select>
            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[#4f617a]">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </span>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={() => { setShowBatch(true); setBatchPhase("select"); setBatchItems([]) }}
              className="h-8 px-3 rounded-md border border-[#2a3347] text-[12px] text-[#8b9ab5] hover:bg-white/[0.05] transition-colors flex items-center gap-1.5"
            >
              <LayersIcon /> Batch
            </button>
            <button
              onClick={() => setShowUpload(true)}
              className="h-8 px-4 rounded-md bg-[#2563eb] text-white text-[13px] font-semibold hover:bg-[#1d4ed8] transition-colors flex items-center gap-1.5"
            >
              <PlusIcon /> Upload
            </button>
          </div>
        </div>
        )}

        {/* RFI action bar */}
        {activeModule === "rfis" && (
          <div className="flex-shrink-0 border-b border-[#2a3347] bg-[#161b27] flex items-center justify-between px-4 py-2.5">
            <p className="text-[13px] font-semibold text-[#e8edf5]">RFI Log <span className="text-[#4f617a] font-normal ml-1">({rfis.length})</span></p>
            <button onClick={() => setShowNewRfi(true)} className="h-8 px-4 rounded-md bg-[#2563eb] text-white text-[13px] font-semibold hover:bg-[#1d4ed8] transition-colors flex items-center gap-1.5">
              <PlusIcon /> New RFI
            </button>
          </div>
        )}

        {/* Punch list action bar */}
        {activeModule === "punch" && (
          <div className="flex-shrink-0 border-b border-[#2a3347] bg-[#161b27] flex items-center justify-between px-4 py-2.5">
            <div className="flex items-center gap-3">
              <p className="text-[13px] font-semibold text-[#e8edf5]">Punch List <span className="text-[#4f617a] font-normal ml-1">({punchItems.filter(p => p.status !== "Void").length} items)</span></p>
              {punchItems.filter(p => p.status === "Open" || p.status === "In Progress").length > 0 && (
                <span className="text-[11px] text-amber-400">{punchItems.filter(p => p.status === "Open" || p.status === "In Progress").length} open</span>
              )}
            </div>
            <button onClick={() => setShowNewPunch(true)} className="h-8 px-4 rounded-md bg-[#2563eb] text-white text-[13px] font-semibold hover:bg-[#1d4ed8] transition-colors flex items-center gap-1.5">
              <PlusIcon /> New Item
            </button>
          </div>
        )}

        {/* Daily reports action bar */}
        {activeModule === "daily" && (
          <div className="flex-shrink-0 border-b border-[#2a3347] bg-[#161b27] flex items-center justify-between px-4 py-2.5">
            <p className="text-[13px] font-semibold text-[#e8edf5]">Daily Reports <span className="text-[#4f617a] font-normal ml-1">({dailyReports.length})</span></p>
            <button onClick={() => setShowNewDaily(true)} className="h-8 px-4 rounded-md bg-[#2563eb] text-white text-[13px] font-semibold hover:bg-[#1d4ed8] transition-colors flex items-center gap-1.5">
              <PlusIcon /> New Report
            </button>
          </div>
        )}

        {/* Drawing log action bar */}
        {activeModule === "drawings" && (
          <div className="flex-shrink-0 border-b border-[#2a3347] bg-[#161b27] flex items-center justify-between px-4 py-2.5">
            <p className="text-[13px] font-semibold text-[#e8edf5]">Drawing Log <span className="text-[#4f617a] font-normal ml-1">({drawings.filter(d => d.is_current).length} sheets)</span></p>
            <button onClick={() => { setShowNewDrawing(true); setAddRevisionFor(null); resetDwgForm() }} className="h-8 px-4 rounded-md bg-[#2563eb] text-white text-[13px] font-semibold hover:bg-[#1d4ed8] transition-colors flex items-center gap-1.5">
              <PlusIcon /> Add Drawing
            </button>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto min-h-0">

          {/* Submittal log */}
          {activeModule === "submittals" && (<>
          {logLoading ? (
            <div className="flex items-center justify-center h-40 gap-2 text-[13px] text-[#4f617a]">
              <SpinnerIcon className="h-4 w-4" /> Loading…
            </div>
          ) : logSubmittals.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full py-24 text-center">
              <div className="w-14 h-14 rounded-2xl bg-[#2563eb]/10 border border-[#2563eb]/20 flex items-center justify-center mb-4">
                <svg className="w-7 h-7 text-[#3b82f6]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </div>
              <p className="text-[15px] font-bold text-[#c8d3e6]">No submittals yet</p>
              <p className="text-[13px] text-[#4f617a] mt-1.5">Upload your first submittal to get started.</p>
              <button onClick={() => setShowUpload(true)} className="mt-5 h-9 px-5 rounded-lg bg-[#2563eb] text-white text-[13px] font-semibold hover:bg-[#1d4ed8] transition-colors inline-flex items-center gap-2">
                <PlusIcon /> Upload submittal
              </button>
            </div>
          ) : (
            <table className="w-full text-[13px] border-collapse">
              <thead className="sticky top-0 bg-[#161b27] z-10">
                <tr className="border-b border-[#2a3347]">
                  <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#4f617a] uppercase tracking-widest w-10">#</th>
                  <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#4f617a] uppercase tracking-widest">Title</th>
                  <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#4f617a] uppercase tracking-widest w-32">Division</th>
                  <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#4f617a] uppercase tracking-widest w-48">Section</th>
                  <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#4f617a] uppercase tracking-widest w-24">Date</th>
                  <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#4f617a] uppercase tracking-widest w-36">Status</th>
                  <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#4f617a] uppercase tracking-widest w-40">Actions</th>
                </tr>
              </thead>
              <tbody>
                {logSubmittals.map((s, i) => (
                  <tr key={s.id} className="border-b border-[#2a3347]/40 hover:bg-white/[0.02] transition-colors group">
                    <td className="px-4 py-2.5 text-[#4f617a] tabular-nums text-[12px]">{logSubmittals.length - i}</td>
                    <td className="px-4 py-2.5 max-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="text-[#c8d3e6] font-medium truncate" title={s.file_name}>{s.file_name}</p>
                        {s.sender_email && (
                          <span title={`Received from ${s.sender_email}`} className="flex-shrink-0 text-[#4f617a] hover:text-[#8b9ab5] transition-colors">
                            <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                            </svg>
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        {s.ai_confidence != null && s.ai_confidence < 70 && (
                          <span className="text-[10px] text-amber-400">⚠ Low confidence</span>
                        )}
                        {s.manually_overridden && (
                          <span className="text-[10px] text-[#60a5fa]">✎ Overridden</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-[#8b9ab5] text-[12px] whitespace-nowrap">
                      {s.csi_division && <span className="font-mono text-[#4f617a] mr-1">{s.csi_division}</span>}
                      {s.division_name}
                    </td>
                    <td className="px-4 py-2.5 text-[#8b9ab5] text-[12px]">{s.section_name ?? s.csi_section ?? "—"}</td>
                    <td className="px-4 py-2.5 text-[#4f617a] text-[12px] whitespace-nowrap">{fmtDate(s.received_at ?? s.created_at)}</td>
                    <td className="px-4 py-2.5"><StatusBadge status={s.review_status ?? "Received"} /></td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => handleFileOpen(
                            { id: s.id, file_name: s.file_name, file_url: "", mime_type: s.mime_type, file_size: s.file_size, created_at: s.created_at },
                            s.csi_division ?? "", s.division_name ?? "", s.csi_section ?? "", s.section_name ?? ""
                          )}
                          className="text-[11px] text-[#8b9ab5] hover:text-[#e8edf5] px-2 py-1 rounded hover:bg-white/[0.05] transition-colors"
                        >Open</button>
                        <button
                          onClick={() => openEditModal(s)}
                          className="text-[11px] text-[#8b9ab5] hover:text-[#e8edf5] px-2 py-1 rounded hover:bg-white/[0.05] transition-colors"
                        >Edit</button>
                        <button
                          onClick={() => openTransmittal(s)}
                          className="text-[11px] text-[#60a5fa] hover:text-[#93c5fd] px-2 py-1 rounded hover:bg-white/[0.05] transition-colors"
                        >Transmittal</button>
                        <button
                          onClick={() => deleteSubmittal(s)}
                          className="text-[11px] text-[#4f617a] hover:text-red-400 px-2 py-1 rounded hover:bg-white/[0.05] transition-colors"
                          title="Delete submittal"
                        >Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          </>)}

          {/* RFI log */}
          {activeModule === "rfis" && (
            rfisLoading ? (
              <div className="flex items-center justify-center h-40 gap-2 text-[13px] text-[#4f617a]">
                <SpinnerIcon className="h-4 w-4" /> Loading…
              </div>
            ) : rfis.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full py-24 text-center">
                <div className="w-14 h-14 rounded-2xl bg-[#2563eb]/10 border border-[#2563eb]/20 flex items-center justify-center mb-4">
                  <svg className="w-7 h-7 text-[#3b82f6]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <p className="text-[15px] font-bold text-[#c8d3e6]">No RFIs yet</p>
                <p className="text-[13px] text-[#4f617a] mt-1.5">Create your first RFI to track questions and responses.</p>
                <button onClick={() => setShowNewRfi(true)} className="mt-5 h-9 px-5 rounded-lg bg-[#2563eb] text-white text-[13px] font-semibold hover:bg-[#1d4ed8] transition-colors inline-flex items-center gap-2">
                  <PlusIcon /> New RFI
                </button>
              </div>
            ) : (
              <table className="w-full text-[13px] border-collapse">
                <thead className="sticky top-0 bg-[#161b27] z-10">
                  <tr className="border-b border-[#2a3347]">
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#4f617a] uppercase tracking-widest w-10">#</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#4f617a] uppercase tracking-widest w-24">RFI No.</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#4f617a] uppercase tracking-widest">Subject</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#4f617a] uppercase tracking-widest w-32">Assigned To</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#4f617a] uppercase tracking-widest w-24">Issued</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#4f617a] uppercase tracking-widest w-24">Due</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#4f617a] uppercase tracking-widest w-28">Status</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#4f617a] uppercase tracking-widest w-20">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rfis.map((r, i) => {
                    const isOverdue = r.due_date && new Date(r.due_date) < new Date() && r.status !== "Closed" && r.status !== "Answered" && r.status !== "Void"
                    return (
                      <tr key={r.id} className="border-b border-[#2a3347]/40 hover:bg-white/[0.02] transition-colors">
                        <td className="px-4 py-2.5 text-[#4f617a] tabular-nums text-[12px]">{rfis.length - i}</td>
                        <td className="px-4 py-2.5 text-[12px] font-mono text-[#60a5fa]">{r.rfi_number}</td>
                        <td className="px-4 py-2.5 max-w-0">
                          <p className="text-[#c8d3e6] font-medium truncate" title={r.subject}>{r.subject}</p>
                          {r.description && <p className="text-[11px] text-[#4f617a] truncate">{r.description}</p>}
                        </td>
                        <td className="px-4 py-2.5 text-[#8b9ab5] text-[12px]">{r.assigned_to ?? "—"}</td>
                        <td className="px-4 py-2.5 text-[#4f617a] text-[12px] whitespace-nowrap">{r.date_issued ? fmtDateOnly(r.date_issued) : "—"}</td>
                        <td className="px-4 py-2.5 text-[12px] whitespace-nowrap">
                          {r.due_date
                            ? <span className={isOverdue ? "text-red-400 font-medium" : "text-[#4f617a]"}>{fmtDateOnly(r.due_date)}{isOverdue ? " ⚠" : ""}</span>
                            : <span className="text-[#4f617a]">—</span>}
                        </td>
                        <td className="px-4 py-2.5"><RfiStatusBadge status={r.status} /></td>
                        <td className="px-4 py-2.5">
                          <button onClick={() => { setViewRfi(r); setRfiResponse(r.response ?? ""); setRfiResponseStatus(r.status) }}
                            className="text-[11px] text-[#8b9ab5] hover:text-[#e8edf5] px-2 py-1 rounded hover:bg-white/[0.05] transition-colors">
                            View
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )
          )}

          {/* Punch list */}
          {activeModule === "punch" && (
            punchLoading ? (
              <div className="flex items-center justify-center h-40 gap-2 text-[13px] text-[#4f617a]">
                <SpinnerIcon className="h-4 w-4" /> Loading…
              </div>
            ) : punchItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full py-24 text-center">
                <div className="w-14 h-14 rounded-2xl bg-[#2563eb]/10 border border-[#2563eb]/20 flex items-center justify-center mb-4">
                  <svg className="w-7 h-7 text-[#3b82f6]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                  </svg>
                </div>
                <p className="text-[15px] font-bold text-[#c8d3e6]">No punch items yet</p>
                <p className="text-[13px] text-[#4f617a] mt-1.5">Add items to track deficiencies and corrections.</p>
                <button onClick={() => setShowNewPunch(true)} className="mt-5 h-9 px-5 rounded-lg bg-[#2563eb] text-white text-[13px] font-semibold hover:bg-[#1d4ed8] transition-colors inline-flex items-center gap-2">
                  <PlusIcon /> New Item
                </button>
              </div>
            ) : (
              <table className="w-full text-[13px] border-collapse">
                <thead className="sticky top-0 bg-[#161b27] z-10">
                  <tr className="border-b border-[#2a3347]">
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#4f617a] uppercase tracking-widest w-10">#</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#4f617a] uppercase tracking-widest w-20">Item</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#4f617a] uppercase tracking-widest">Description</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#4f617a] uppercase tracking-widest w-32">Location</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#4f617a] uppercase tracking-widest w-32">Assigned To</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#4f617a] uppercase tracking-widest w-24">Due</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#4f617a] uppercase tracking-widest w-24">Priority</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#4f617a] uppercase tracking-widest w-28">Status</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#4f617a] uppercase tracking-widest w-16">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {punchItems.map((p, i) => {
                    const isOverdue = p.due_date && new Date(p.due_date) < new Date() && p.status !== "Completed" && p.status !== "Void"
                    const isStruck  = p.status === "Completed" || p.status === "Void"
                    return (
                      <tr key={p.id} className={`border-b border-[#2a3347]/40 hover:bg-white/[0.02] transition-colors ${isStruck ? "opacity-50" : ""}`}>
                        <td className="px-4 py-2.5 text-[#4f617a] tabular-nums text-[12px]">{punchItems.length - i}</td>
                        <td className="px-4 py-2.5 text-[12px] font-mono text-[#60a5fa]">{p.item_number}</td>
                        <td className="px-4 py-2.5 max-w-0">
                          <p className={`font-medium truncate ${isStruck ? "line-through text-[#4f617a]" : "text-[#c8d3e6]"}`} title={p.description}>{p.description}</p>
                        </td>
                        <td className="px-4 py-2.5 text-[#8b9ab5] text-[12px]">{p.location ?? "—"}</td>
                        <td className="px-4 py-2.5 text-[#8b9ab5] text-[12px]">{p.assigned_to ?? "—"}</td>
                        <td className="px-4 py-2.5 text-[12px] whitespace-nowrap">
                          {p.due_date
                            ? <span className={isOverdue ? "text-red-400 font-medium" : "text-[#4f617a]"}>{fmtDateOnly(p.due_date)}{isOverdue ? " ⚠" : ""}</span>
                            : <span className="text-[#4f617a]">—</span>}
                        </td>
                        <td className="px-4 py-2.5"><PunchPriorityBadge priority={p.priority} /></td>
                        <td className="px-4 py-2.5"><PunchStatusBadge status={p.status} /></td>
                        <td className="px-4 py-2.5">
                          <button onClick={() => { setViewPunch(p); setPunchEditStatus(p.status); setPunchEditNotes(p.notes ?? "") }}
                            className="text-[11px] text-[#8b9ab5] hover:text-[#e8edf5] px-2 py-1 rounded hover:bg-white/[0.05] transition-colors">
                            Edit
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )
          )}
          {/* Daily reports */}
          {activeModule === "daily" && (
            dailyLoading ? (
              <div className="flex items-center justify-center h-40 gap-2 text-[13px] text-[#4f617a]">
                <SpinnerIcon className="h-4 w-4" /> Loading…
              </div>
            ) : dailyReports.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full py-24 text-center">
                <div className="w-14 h-14 rounded-2xl bg-[#2563eb]/10 border border-[#2563eb]/20 flex items-center justify-center mb-4">
                  <svg className="w-7 h-7 text-[#3b82f6]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                </div>
                <p className="text-[15px] font-bold text-[#c8d3e6]">No daily reports yet</p>
                <p className="text-[13px] text-[#4f617a] mt-1.5">Log daily site activity, weather, and manpower.</p>
                <button onClick={() => setShowNewDaily(true)} className="mt-5 h-9 px-5 rounded-lg bg-[#2563eb] text-white text-[13px] font-semibold hover:bg-[#1d4ed8] transition-colors inline-flex items-center gap-2">
                  <PlusIcon /> New Report
                </button>
              </div>
            ) : (
              <table className="w-full text-[13px] border-collapse">
                <thead className="sticky top-0 bg-[#161b27] z-10">
                  <tr className="border-b border-[#2a3347]">
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#4f617a] uppercase tracking-widest w-10">#</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#4f617a] uppercase tracking-widest w-28">Date</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#4f617a] uppercase tracking-widest">Work Performed</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#4f617a] uppercase tracking-widest w-28">Prepared By</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#4f617a] uppercase tracking-widest w-28">Weather</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#4f617a] uppercase tracking-widest w-20">Manpower</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#4f617a] uppercase tracking-widest w-20">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {dailyReports.map((r, i) => (
                    <tr key={r.id} className="border-b border-[#2a3347]/40 hover:bg-white/[0.02] transition-colors cursor-pointer" onClick={() => { setViewDaily(r); setDailyEditing(false) }}>
                      <td className="px-4 py-2.5 text-[#4f617a] tabular-nums text-[12px]">{dailyReports.length - i}</td>
                      <td className="px-4 py-2.5 text-[#c8d3e6] font-medium text-[12px] whitespace-nowrap">{fmtDateOnly(r.report_date)}</td>
                      <td className="px-4 py-2.5 max-w-0">
                        <p className="text-[#8b9ab5] text-[12px] truncate">{r.work_performed ?? <span className="text-[#4f617a] italic">No description</span>}</p>
                      </td>
                      <td className="px-4 py-2.5 text-[#8b9ab5] text-[12px]">{r.prepared_by ?? "—"}</td>
                      <td className="px-4 py-2.5 text-[#8b9ab5] text-[12px]">{r.weather_conditions ?? "—"}{r.temperature ? ` · ${r.temperature}` : ""}</td>
                      <td className="px-4 py-2.5 text-[#8b9ab5] text-[12px] text-center">{r.manpower_count ?? "—"}</td>
                      <td className="px-4 py-2.5">
                        <button onClick={e => { e.stopPropagation(); openDailyForEdit(r) }}
                          className="text-[11px] text-[#8b9ab5] hover:text-[#e8edf5] px-2 py-1 rounded hover:bg-white/[0.05] transition-colors">
                          Edit
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}
          {/* Drawing log */}
          {activeModule === "drawings" && (() => {
            const currentDrawings = drawings.filter(d => d.is_current)
            const allSuperseded   = drawings.filter(d => !d.is_current)
            return drawingsLoading ? (
              <div className="flex items-center justify-center h-40 gap-2 text-[13px] text-[#4f617a]">
                <SpinnerIcon className="h-4 w-4" /> Loading…
              </div>
            ) : currentDrawings.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full py-24 text-center">
                <div className="w-14 h-14 rounded-2xl bg-[#2563eb]/10 border border-[#2563eb]/20 flex items-center justify-center mb-4">
                  <svg className="w-7 h-7 text-[#3b82f6]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                </div>
                <p className="text-[15px] font-bold text-[#c8d3e6]">No drawings yet</p>
                <p className="text-[13px] text-[#4f617a] mt-1.5">Add drawings to track revisions and status.</p>
                <button onClick={() => { setShowNewDrawing(true); setAddRevisionFor(null); resetDwgForm() }} className="mt-5 h-9 px-5 rounded-lg bg-[#2563eb] text-white text-[13px] font-semibold hover:bg-[#1d4ed8] transition-colors inline-flex items-center gap-2">
                  <PlusIcon /> Add Drawing
                </button>
              </div>
            ) : (
              <table className="w-full text-[13px] border-collapse">
                <thead className="sticky top-0 bg-[#161b27] z-10">
                  <tr className="border-b border-[#2a3347]">
                    <th className="w-8" />
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#4f617a] uppercase tracking-widest w-28">Drawing No.</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#4f617a] uppercase tracking-widest">Sheet Title</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#4f617a] uppercase tracking-widest w-28">Discipline</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#4f617a] uppercase tracking-widest w-16">Rev</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#4f617a] uppercase tracking-widest w-24">Rev Date</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#4f617a] uppercase tracking-widest w-44">Status</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#4f617a] uppercase tracking-widest w-28">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {currentDrawings.map(d => {
                    const history = allSuperseded.filter(s => s.drawing_number === d.drawing_number)
                    const isExpanded = expandedDrawings.has(d.drawing_number)
                    return (
                      <>
                        <tr key={d.id} className="border-b border-[#2a3347]/40 hover:bg-white/[0.02] transition-colors">
                          <td className="px-2 py-2.5 text-center">
                            {history.length > 0 && (
                              <button onClick={() => setExpandedDrawings(prev => { const n = new Set(prev); isExpanded ? n.delete(d.drawing_number) : n.add(d.drawing_number); return n })}
                                className="text-[#4f617a] hover:text-[#8b9ab5] transition-colors flex items-center justify-center w-full" title={`${history.length} previous revision${history.length !== 1 ? "s" : ""}`}>
                                <ToggleIcon open={isExpanded} />
                              </button>
                            )}
                          </td>
                          <td className="px-4 py-2.5 text-[12px] font-mono text-[#60a5fa] whitespace-nowrap">{d.drawing_number}</td>
                          <td className="px-4 py-2.5 max-w-0"><p className="text-[#c8d3e6] font-medium truncate" title={d.sheet_title}>{d.sheet_title}</p></td>
                          <td className="px-4 py-2.5 text-[#8b9ab5] text-[12px]">{d.discipline ?? "—"}</td>
                          <td className="px-4 py-2.5 text-[12px] font-mono font-bold text-[#e8edf5]">{d.revision}</td>
                          <td className="px-4 py-2.5 text-[#4f617a] text-[12px] whitespace-nowrap">{d.revision_date ? fmtDateOnly(d.revision_date) : "—"}</td>
                          <td className="px-4 py-2.5"><DrawingStatusBadge status={d.status} /></td>
                          <td className="px-4 py-2.5">
                            <div className="flex items-center gap-1">
                              <button onClick={() => openAddRevision(d)}
                                className="text-[11px] text-[#60a5fa] hover:text-[#93c5fd] px-2 py-1 rounded hover:bg-white/[0.05] transition-colors whitespace-nowrap">
                                + Rev
                              </button>
                            </div>
                          </td>
                        </tr>
                        {/* Revision history rows */}
                        {isExpanded && history.map(h => (
                          <tr key={h.id} className="border-b border-[#2a3347]/20 bg-[#0d1117]/40">
                            <td />
                            <td className="px-4 py-1.5 text-[11px] font-mono text-[#4f617a]">{h.drawing_number}</td>
                            <td className="px-4 py-1.5 text-[11px] text-[#4f617a] truncate max-w-0">{h.sheet_title}</td>
                            <td className="px-4 py-1.5 text-[11px] text-[#4f617a]">{h.discipline ?? "—"}</td>
                            <td className="px-4 py-1.5 text-[11px] font-mono text-[#4f617a]">{h.revision}</td>
                            <td className="px-4 py-1.5 text-[11px] text-[#4f617a] whitespace-nowrap">{h.revision_date ? fmtDateOnly(h.revision_date) : "—"}</td>
                            <td className="px-4 py-1.5"><span className="text-[10px] text-[#4f617a]">Superseded {h.superseded_at ? fmtDate(h.superseded_at) : ""}</span></td>
                            <td />
                          </tr>
                        ))}
                      </>
                    )
                  })}
                </tbody>
              </table>
            )
          })()}
        </div>
      </div>

      {/* ── New / Edit Daily Report modal ────────────────────────────────── */}
      {(showNewDaily || (viewDaily && dailyEditing)) && (() => {
        const isEdit = !!(viewDaily && dailyEditing)
        const onClose = () => { setShowNewDaily(false); setViewDaily(null); setDailyEditing(false) }
        const tareaClass = "w-full px-3 py-2 rounded-md border border-[#2a3347] text-[13px] text-[#e8edf5] bg-[#0d1117] focus:outline-none focus:ring-1 focus:ring-[#2563eb]/40 resize-none placeholder:text-[#4f617a]"
        return (
          <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
            onClick={e => { if (e.target === e.currentTarget) onClose() }}>
            <div className="bg-[#1c2333] rounded-xl border border-[#2a3347] shadow-2xl w-[680px] max-h-[90vh] flex flex-col">
              <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#2a3347] flex-shrink-0">
                <h2 className="text-[15px] font-bold text-[#e8edf5]">{isEdit ? "Edit Daily Report" : "New Daily Report"}</h2>
                <button onClick={onClose} className="text-[#4f617a] hover:text-[#8b9ab5] transition-colors"><XIcon className="h-4 w-4" /></button>
              </div>
              <form onSubmit={isEdit ? saveDaily : createDaily} className="flex flex-col flex-1 min-h-0">
                <div className="px-6 py-4 space-y-4 overflow-y-auto flex-1 min-h-0">

                  {/* Row 1: Date, Project, Prepared By */}
                  <div className="flex gap-3">
                    <div className="w-36 flex-shrink-0">
                      <label className={labelCls}>Date <span className="text-red-400">*</span></label>
                      <input type="date" required value={dailyDate} onChange={e => setDailyDate(e.target.value)} className={inputCls} />
                    </div>
                    <div className="flex-1">
                      <label className={labelCls}>Project</label>
                      <select value={dailyProjectId} onChange={e => setDailyProjectId(e.target.value)}
                        className="w-full h-9 px-3 rounded-md border border-[#2a3347] text-[13px] text-[#e8edf5] bg-[#0d1117] focus:outline-none focus:ring-1 focus:ring-[#2563eb]/40">
                        <option value="">None</option>
                        {appProjects.map(p => <option key={p.id} value={p.id}>{p.name}{p.number ? ` — ${p.number}` : ""}</option>)}
                      </select>
                    </div>
                    <div className="flex-1">
                      <label className={labelCls}>Prepared By</label>
                      <select value={dailyPreparedBy} onChange={e => setDailyPreparedBy(e.target.value)}
                        className="w-full h-9 px-3 rounded-md border border-[#2a3347] text-[13px] text-[#e8edf5] bg-[#0d1117] focus:outline-none focus:ring-1 focus:ring-[#2563eb]/40">
                        <option value="">Select…</option>
                        {teamMembers.map(m => <option key={m.id} value={m.name}>{m.name}</option>)}
                      </select>
                    </div>
                  </div>

                  {/* Row 2: Weather, Temp, Manpower */}
                  <div className="flex gap-3">
                    <div className="flex-1">
                      <label className={labelCls}>Weather</label>
                      <select value={dailyWeather} onChange={e => setDailyWeather(e.target.value)}
                        className="w-full h-9 px-3 rounded-md border border-[#2a3347] text-[13px] text-[#e8edf5] bg-[#0d1117] focus:outline-none focus:ring-1 focus:ring-[#2563eb]/40">
                        <option value="">Select…</option>
                        {["Clear", "Partly Cloudy", "Cloudy", "Rain", "Heavy Rain", "Snow", "Fog", "Wind"].map(w => <option key={w} value={w}>{w}</option>)}
                      </select>
                    </div>
                    <div className="w-28 flex-shrink-0">
                      <label className={labelCls}>Temperature</label>
                      <input type="text" value={dailyTemp} onChange={e => setDailyTemp(e.target.value)} placeholder="e.g. 72°F" className={inputCls} />
                    </div>
                    <div className="w-28 flex-shrink-0">
                      <label className={labelCls}>Manpower</label>
                      <input type="number" min={0} value={dailyManpower} onChange={e => setDailyManpower(e.target.value)} placeholder="# workers" className={inputCls} />
                    </div>
                  </div>

                  {/* Work Performed */}
                  <div>
                    <label className={labelCls}>Work Performed</label>
                    <textarea rows={3} value={dailyWorkPerformed} onChange={e => setDailyWorkPerformed(e.target.value)}
                      placeholder="Describe the work completed on site today…" className={tareaClass} />
                  </div>

                  {/* Equipment & Materials side by side */}
                  <div className="flex gap-3">
                    <div className="flex-1">
                      <label className={labelCls}>Equipment on Site</label>
                      <textarea rows={2} value={dailyEquipment} onChange={e => setDailyEquipment(e.target.value)}
                        placeholder="List equipment used…" className={tareaClass} />
                    </div>
                    <div className="flex-1">
                      <label className={labelCls}>Materials Delivered</label>
                      <textarea rows={2} value={dailyMaterials} onChange={e => setDailyMaterials(e.target.value)}
                        placeholder="List deliveries received…" className={tareaClass} />
                    </div>
                  </div>

                  {/* Visitors & Issues side by side */}
                  <div className="flex gap-3">
                    <div className="flex-1">
                      <label className={labelCls}>Visitors / Inspections</label>
                      <textarea rows={2} value={dailyVisitors} onChange={e => setDailyVisitors(e.target.value)}
                        placeholder="Inspectors, owner reps, visitors…" className={tareaClass} />
                    </div>
                    <div className="flex-1">
                      <label className={labelCls}>Issues / Delays</label>
                      <textarea rows={2} value={dailyIssues} onChange={e => setDailyIssues(e.target.value)}
                        placeholder="Any delays, problems, or concerns…" className={tareaClass} />
                    </div>
                  </div>

                  {/* Safety Notes */}
                  <div>
                    <label className={labelCls}>Safety Notes</label>
                    <textarea rows={2} value={dailySafety} onChange={e => setDailySafety(e.target.value)}
                      placeholder="Safety observations, incidents, toolbox talks…" className={tareaClass} />
                  </div>
                </div>
                <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#2a3347] flex-shrink-0">
                  <button type="button" onClick={onClose}
                    className="h-8 px-4 rounded-md border border-[#2a3347] text-[13px] text-[#8b9ab5] hover:bg-white/[0.05] transition-colors">
                    Cancel
                  </button>
                  <button type="submit" disabled={isEdit ? dailyEditSaving : dailySaving}
                    className="h-8 px-4 rounded-md bg-[#2563eb] text-white text-[13px] font-semibold hover:bg-[#1d4ed8] transition-colors disabled:opacity-50 flex items-center gap-2">
                    {(isEdit ? dailyEditSaving : dailySaving) && <SpinnerIcon className="h-3 w-3" />}
                    {isEdit ? (dailyEditSaving ? "Saving…" : "Save Changes") : (dailySaving ? "Creating…" : "Create Report")}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )
      })()}

      {/* ── View Daily Report modal ───────────────────────────────────────── */}
      {viewDaily && !dailyEditing && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
          onClick={e => { if (e.target === e.currentTarget) setViewDaily(null) }}>
          <div className="bg-[#1c2333] rounded-xl border border-[#2a3347] shadow-2xl w-[620px] max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#2a3347] flex-shrink-0">
              <div>
                <p className="text-[11px] text-[#4f617a] uppercase tracking-widest font-bold">Daily Report</p>
                <h2 className="text-[16px] font-bold text-[#e8edf5] mt-0.5">{fmtDateOnly(viewDaily.report_date)}</h2>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => openDailyForEdit(viewDaily)}
                  className="h-7 px-3 rounded-md border border-[#2a3347] text-[12px] text-[#8b9ab5] hover:bg-white/[0.05] transition-colors">
                  Edit
                </button>
                <button onClick={() => setViewDaily(null)} className="text-[#4f617a] hover:text-[#8b9ab5] transition-colors">
                  <XIcon className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="px-6 py-4 space-y-4 overflow-y-auto flex-1 min-h-0">
              {/* Meta row */}
              <div className="flex flex-wrap gap-4 text-[12px]">
                {viewDaily.prepared_by && <span><span className="text-[#4f617a]">Prepared by: </span><span className="text-[#c8d3e6]">{viewDaily.prepared_by}</span></span>}
                {viewDaily.weather_conditions && <span><span className="text-[#4f617a]">Weather: </span><span className="text-[#c8d3e6]">{viewDaily.weather_conditions}{viewDaily.temperature ? ` · ${viewDaily.temperature}` : ""}</span></span>}
                {viewDaily.manpower_count != null && <span><span className="text-[#4f617a]">Manpower: </span><span className="text-[#c8d3e6]">{viewDaily.manpower_count} workers</span></span>}
              </div>
              {[
                { label: "Work Performed", value: viewDaily.work_performed },
                { label: "Equipment on Site", value: viewDaily.equipment },
                { label: "Materials Delivered", value: viewDaily.materials_delivered },
                { label: "Visitors / Inspections", value: viewDaily.visitors },
                { label: "Issues / Delays", value: viewDaily.issues_delays },
                { label: "Safety Notes", value: viewDaily.safety_notes },
              ].filter(f => f.value).map(f => (
                <div key={f.label} className="rounded-md bg-[#1a2235] border border-[#2a3347] px-4 py-3">
                  <p className="text-[10px] font-bold text-[#4f617a] uppercase tracking-widest mb-1.5">{f.label}</p>
                  <p className="text-[13px] text-[#c8d3e6] whitespace-pre-wrap">{f.value}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── New Drawing / Add Revision modal ─────────────────────────────── */}
      {(showNewDrawing || addRevisionFor) && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
          onClick={e => { if (e.target === e.currentTarget) { setShowNewDrawing(false); setAddRevisionFor(null) } }}>
          <div className="bg-[#1c2333] rounded-xl border border-[#2a3347] shadow-2xl w-[560px]">
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#2a3347]">
              <div>
                <h2 className="text-[15px] font-bold text-[#e8edf5]">{addRevisionFor ? "Add Revision" : "Add Drawing"}</h2>
                {addRevisionFor && <p className="text-[12px] text-[#4f617a] mt-0.5">Supersedes {addRevisionFor.drawing_number} Rev {addRevisionFor.revision}</p>}
              </div>
              <button onClick={() => { setShowNewDrawing(false); setAddRevisionFor(null) }} className="text-[#4f617a] hover:text-[#8b9ab5] transition-colors">
                <XIcon className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={createDrawing}>
              <div className="px-6 py-4 space-y-3">
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className={labelCls}>Drawing Number <span className="text-red-400">*</span></label>
                    <input type="text" required value={dwgNumber} onChange={e => setDwgNumber(e.target.value)}
                      placeholder="e.g. A-101" readOnly={!!addRevisionFor} autoFocus={!addRevisionFor}
                      className={`${inputCls} ${addRevisionFor ? "opacity-60 cursor-not-allowed" : ""}`} />
                  </div>
                  <div className="w-24 flex-shrink-0">
                    <label className={labelCls}>Revision <span className="text-red-400">*</span></label>
                    <input type="text" required value={dwgRevision} onChange={e => setDwgRevision(e.target.value)}
                      placeholder="0" autoFocus={!!addRevisionFor} className={inputCls} />
                  </div>
                </div>
                <div>
                  <label className={labelCls}>Sheet Title <span className="text-red-400">*</span></label>
                  <input type="text" required value={dwgTitle} onChange={e => setDwgTitle(e.target.value)}
                    placeholder="e.g. First Floor Plan" className={inputCls} />
                </div>
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className={labelCls}>Discipline</label>
                    <select value={dwgDiscipline} onChange={e => setDwgDiscipline(e.target.value)}
                      className="w-full h-9 px-3 rounded-md border border-[#2a3347] text-[13px] text-[#e8edf5] bg-[#0d1117] focus:outline-none focus:ring-1 focus:ring-[#2563eb]/40">
                      <option value="">Select…</option>
                      {["Architectural","Structural","Mechanical","Electrical","Plumbing","Civil","Landscape","Fire Protection","Low Voltage","General"].map(d => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </div>
                  <div className="flex-1">
                    <label className={labelCls}>Status</label>
                    <select value={dwgStatus} onChange={e => setDwgStatus(e.target.value)}
                      className="w-full h-9 px-3 rounded-md border border-[#2a3347] text-[13px] text-[#e8edf5] bg-[#0d1117] focus:outline-none focus:ring-1 focus:ring-[#2563eb]/40">
                      {["Issued for Construction","Issued for Bid","Issued for Review","Record Drawings","Void"].map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                </div>
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className={labelCls}>Revision Date</label>
                    <input type="date" value={dwgRevDate} onChange={e => setDwgRevDate(e.target.value)} className={inputCls} />
                  </div>
                  <div className="flex-1">
                    <label className={labelCls}>Scale</label>
                    <input type="text" value={dwgScale} onChange={e => setDwgScale(e.target.value)} placeholder='e.g. 1/4" = 1&apos;-0"' className={inputCls} />
                  </div>
                </div>
                {appProjects.length > 0 && (
                  <div>
                    <label className={labelCls}>Project</label>
                    <select value={dwgProjectId} onChange={e => setDwgProjectId(e.target.value)}
                      className="w-full h-9 px-3 rounded-md border border-[#2a3347] text-[13px] text-[#e8edf5] bg-[#0d1117] focus:outline-none focus:ring-1 focus:ring-[#2563eb]/40">
                      <option value="">None</option>
                      {appProjects.map(p => <option key={p.id} value={p.id}>{p.name}{p.number ? ` — ${p.number}` : ""}</option>)}
                    </select>
                  </div>
                )}
                <div>
                  <label className={labelCls}>Notes</label>
                  <textarea rows={2} value={dwgNotes} onChange={e => setDwgNotes(e.target.value)}
                    placeholder="Revision notes, changes from previous…"
                    className="w-full px-3 py-2 rounded-md border border-[#2a3347] text-[13px] text-[#e8edf5] bg-[#0d1117] focus:outline-none focus:ring-1 focus:ring-[#2563eb]/40 resize-none placeholder:text-[#4f617a]" />
                </div>
              </div>
              <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#2a3347]">
                <button type="button" onClick={() => { setShowNewDrawing(false); setAddRevisionFor(null) }}
                  className="h-8 px-4 rounded-md border border-[#2a3347] text-[13px] text-[#8b9ab5] hover:bg-white/[0.05] transition-colors">
                  Cancel
                </button>
                <button type="submit" disabled={dwgSaving}
                  className="h-8 px-4 rounded-md bg-[#2563eb] text-white text-[13px] font-semibold hover:bg-[#1d4ed8] transition-colors disabled:opacity-50 flex items-center gap-2">
                  {dwgSaving && <SpinnerIcon className="h-3 w-3" />}
                  {dwgSaving ? "Saving…" : addRevisionFor ? "Add Revision" : "Add Drawing"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── New Punch Item modal ─────────────────────────────────────────── */}
      {showNewPunch && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
          onClick={e => { if (e.target === e.currentTarget) setShowNewPunch(false) }}>
          <div className="bg-[#1c2333] rounded-xl border border-[#2a3347] shadow-2xl w-[520px]">
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#2a3347]">
              <h2 className="text-[15px] font-bold text-[#e8edf5]">New Punch Item</h2>
              <button onClick={() => setShowNewPunch(false)} className="text-[#4f617a] hover:text-[#8b9ab5] transition-colors">
                <XIcon className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={createPunch}>
              <div className="px-6 py-4 space-y-3">
                <div>
                  <label className={labelCls}>Description <span className="text-red-400">*</span></label>
                  <textarea required rows={2} value={punchDesc} onChange={e => setPunchDesc(e.target.value)} autoFocus
                    placeholder="Describe the deficiency, item to correct, or work to complete"
                    className="w-full px-3 py-2 rounded-md border border-[#2a3347] text-[13px] text-[#e8edf5] bg-[#0d1117] focus:outline-none focus:ring-1 focus:ring-[#2563eb]/40 resize-none placeholder:text-[#4f617a]" />
                </div>
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className={labelCls}>Location / Room</label>
                    <input type="text" value={punchLocation} onChange={e => setPunchLocation(e.target.value)}
                      placeholder="e.g. Room 201, Lobby, Roof" className={inputCls} />
                  </div>
                  <div className="flex-1">
                    <label className={labelCls}>Assigned To</label>
                    <input type="text" value={punchAssignedTo} onChange={e => setPunchAssignedTo(e.target.value)}
                      placeholder="Trade or subcontractor" className={inputCls} />
                  </div>
                </div>
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className={labelCls}>Priority</label>
                    <select value={punchPriority} onChange={e => setPunchPriority(e.target.value)}
                      className="w-full h-9 px-3 rounded-md border border-[#2a3347] text-[13px] text-[#e8edf5] bg-[#0d1117] focus:outline-none focus:ring-1 focus:ring-[#2563eb]/40">
                      {["Low", "Medium", "High", "Critical"].map(p => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </div>
                  <div className="flex-1">
                    <label className={labelCls}>Due Date</label>
                    <input type="date" value={punchDueDate} onChange={e => setPunchDueDate(e.target.value)} className={inputCls} />
                  </div>
                </div>
                {appProjects.length > 0 && (
                  <div>
                    <label className={labelCls}>Project</label>
                    <select value={punchProjectId} onChange={e => setPunchProjectId(e.target.value)}
                      className="w-full h-9 px-3 rounded-md border border-[#2a3347] text-[13px] text-[#e8edf5] bg-[#0d1117] focus:outline-none focus:ring-1 focus:ring-[#2563eb]/40">
                      <option value="">None</option>
                      {appProjects.map(p => <option key={p.id} value={p.id}>{p.name}{p.number ? ` — ${p.number}` : ""}</option>)}
                    </select>
                  </div>
                )}
                <div>
                  <label className={labelCls}>Notes</label>
                  <textarea rows={2} value={punchNotes} onChange={e => setPunchNotes(e.target.value)}
                    placeholder="Additional context, spec references, etc."
                    className="w-full px-3 py-2 rounded-md border border-[#2a3347] text-[13px] text-[#e8edf5] bg-[#0d1117] focus:outline-none focus:ring-1 focus:ring-[#2563eb]/40 resize-none placeholder:text-[#4f617a]" />
                </div>
              </div>
              <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#2a3347]">
                <button type="button" onClick={() => setShowNewPunch(false)}
                  className="h-8 px-4 rounded-md border border-[#2a3347] text-[13px] text-[#8b9ab5] hover:bg-white/[0.05] transition-colors">
                  Cancel
                </button>
                <button type="submit" disabled={punchSaving || !punchDesc.trim()}
                  className="h-8 px-4 rounded-md bg-[#2563eb] text-white text-[13px] font-semibold hover:bg-[#1d4ed8] transition-colors disabled:opacity-50 flex items-center gap-2">
                  {punchSaving && <SpinnerIcon className="h-3 w-3" />}
                  {punchSaving ? "Adding…" : "Add Item"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── View/Edit Punch Item modal ────────────────────────────────────── */}
      {viewPunch && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
          onClick={e => { if (e.target === e.currentTarget) setViewPunch(null) }}>
          <div className="bg-[#1c2333] rounded-xl border border-[#2a3347] shadow-2xl w-[500px]">
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#2a3347]">
              <div>
                <span className="text-[11px] font-mono text-[#60a5fa]">{viewPunch.item_number}</span>
                <h2 className="text-[15px] font-bold text-[#e8edf5] mt-0.5">{viewPunch.description}</h2>
              </div>
              <button onClick={() => setViewPunch(null)} className="text-[#4f617a] hover:text-[#8b9ab5] transition-colors ml-4 flex-shrink-0">
                <XIcon className="h-4 w-4" />
              </button>
            </div>
            <div className="px-6 py-4 space-y-4">
              <div className="grid grid-cols-2 gap-3 text-[12px]">
                {viewPunch.location && <div><span className="text-[#4f617a]">Location: </span><span className="text-[#c8d3e6]">{viewPunch.location}</span></div>}
                {viewPunch.assigned_to && <div><span className="text-[#4f617a]">Assigned to: </span><span className="text-[#c8d3e6]">{viewPunch.assigned_to}</span></div>}
                {viewPunch.due_date && <div><span className="text-[#4f617a]">Due: </span><span className={new Date(viewPunch.due_date) < new Date() && viewPunch.status !== "Completed" ? "text-red-400 font-medium" : "text-[#c8d3e6]"}>{fmtDateOnly(viewPunch.due_date)}</span></div>}
                <div className="flex items-center gap-1.5"><span className="text-[#4f617a]">Priority: </span><PunchPriorityBadge priority={viewPunch.priority} /></div>
              </div>
              {viewPunch.notes && (
                <div className="rounded-md bg-[#2a3347]/50 px-3 py-2">
                  <p className="text-[11px] font-bold text-[#4f617a] uppercase tracking-widest mb-1">Notes</p>
                  <p className="text-[13px] text-[#c8d3e6]">{viewPunch.notes}</p>
                </div>
              )}
              <div className="border-t border-[#2a3347] pt-4 space-y-3">
                <div>
                  <label className={labelCls}>Update Notes</label>
                  <textarea value={punchEditNotes} onChange={e => setPunchEditNotes(e.target.value)} rows={3}
                    placeholder="Add resolution notes, corrective action taken, etc."
                    className="w-full px-3 py-2 rounded-md border border-[#2a3347] text-[13px] text-[#e8edf5] bg-[#0d1117] focus:outline-none focus:ring-1 focus:ring-[#2563eb]/40 resize-none placeholder:text-[#4f617a]" />
                </div>
                <div>
                  <label className={labelCls}>Status</label>
                  <select value={punchEditStatus} onChange={e => setPunchEditStatus(e.target.value)}
                    className="w-full h-9 px-3 rounded-md border border-[#2a3347] text-[13px] text-[#e8edf5] bg-[#0d1117] focus:outline-none focus:ring-1 focus:ring-[#2563eb]/40">
                    {["Open", "In Progress", "Completed", "Void"].map(s => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#2a3347]">
              <button onClick={() => setViewPunch(null)}
                className="h-8 px-4 rounded-md border border-[#2a3347] text-[13px] text-[#8b9ab5] hover:bg-white/[0.05] transition-colors">
                Close
              </button>
              <button onClick={updatePunch} disabled={punchEditSaving}
                className="h-8 px-4 rounded-md bg-[#2563eb] text-white text-[13px] font-semibold hover:bg-[#1d4ed8] transition-colors disabled:opacity-50 flex items-center gap-2">
                {punchEditSaving && <SpinnerIcon className="h-3 w-3" />}
                {punchEditSaving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── New RFI modal ────────────────────────────────────────────────── */}
      {showNewRfi && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
          onClick={e => { if (e.target === e.currentTarget) setShowNewRfi(false) }}>
          <div className="bg-[#1c2333] rounded-xl border border-[#2a3347] shadow-2xl w-[520px]">
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#2a3347]">
              <h2 className="text-[15px] font-bold text-[#e8edf5]">New RFI</h2>
              <button onClick={() => setShowNewRfi(false)} className="text-[#4f617a] hover:text-[#8b9ab5] transition-colors">
                <XIcon className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={createRfi}>
              <div className="px-6 py-4 space-y-3">
                <div>
                  <label className={labelCls}>Subject <span className="text-red-400">*</span></label>
                  <input type="text" required value={rfiSubject} onChange={e => setRfiSubject(e.target.value)}
                    placeholder="Brief description of the question or issue" autoFocus className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Description</label>
                  <textarea value={rfiDescription} onChange={e => setRfiDescription(e.target.value)}
                    rows={3} placeholder="Detailed description, reference specs, drawings, etc."
                    className="w-full px-3 py-2 rounded-md border border-[#2a3347] text-[13px] text-[#e8edf5] bg-[#0d1117] focus:outline-none focus:ring-1 focus:ring-[#2563eb]/40 resize-none placeholder:text-[#4f617a]" />
                </div>
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className={labelCls}>Submitted By</label>
                    <select value={rfiSubmittedBy} onChange={e => setRfiSubmittedBy(e.target.value)}
                      className="w-full h-9 px-3 rounded-md border border-[#2a3347] text-[13px] text-[#e8edf5] bg-[#0d1117] focus:outline-none focus:ring-1 focus:ring-[#2563eb]/40">
                      <option value="">Select…</option>
                      {teamMembers.map(m => <option key={m.id} value={m.name}>{m.name}</option>)}
                    </select>
                  </div>
                  <div className="flex-1">
                    <label className={labelCls}>Assigned To</label>
                    <input type="text" value={rfiAssignedTo} onChange={e => setRfiAssignedTo(e.target.value)}
                      placeholder="Architect, Engineer, GC…" className={inputCls} />
                  </div>
                </div>
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className={labelCls}>Date Issued</label>
                    <input type="date" value={rfiDateIssued} onChange={e => setRfiDateIssued(e.target.value)} className={inputCls} />
                  </div>
                  <div className="flex-1">
                    <label className={labelCls}>Due Date</label>
                    <input type="date" value={rfiDueDate} onChange={e => setRfiDueDate(e.target.value)} className={inputCls} />
                  </div>
                </div>
                {appProjects.length > 0 && (
                  <div>
                    <label className={labelCls}>Project</label>
                    <select value={rfiProjectId} onChange={e => setRfiProjectId(e.target.value)}
                      className="w-full h-9 px-3 rounded-md border border-[#2a3347] text-[13px] text-[#e8edf5] bg-[#0d1117] focus:outline-none focus:ring-1 focus:ring-[#2563eb]/40">
                      <option value="">None</option>
                      {appProjects.map(p => <option key={p.id} value={p.id}>{p.name}{p.number ? ` — ${p.number}` : ""}</option>)}
                    </select>
                  </div>
                )}
              </div>
              <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#2a3347]">
                <button type="button" onClick={() => setShowNewRfi(false)}
                  className="h-8 px-4 rounded-md border border-[#2a3347] text-[13px] text-[#8b9ab5] hover:bg-white/[0.05] transition-colors">
                  Cancel
                </button>
                <button type="submit" disabled={rfiSaving || !rfiSubject.trim()}
                  className="h-8 px-4 rounded-md bg-[#2563eb] text-white text-[13px] font-semibold hover:bg-[#1d4ed8] transition-colors disabled:opacity-50 flex items-center gap-2">
                  {rfiSaving && <SpinnerIcon className="h-3 w-3" />}
                  {rfiSaving ? "Creating…" : "Create RFI"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── View/Respond RFI modal ────────────────────────────────────────── */}
      {viewRfi && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
          onClick={e => { if (e.target === e.currentTarget) setViewRfi(null) }}>
          <div className="bg-[#1c2333] rounded-xl border border-[#2a3347] shadow-2xl w-[560px]">
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#2a3347]">
              <div>
                <span className="text-[11px] font-mono text-[#60a5fa]">{viewRfi.rfi_number}</span>
                <h2 className="text-[15px] font-bold text-[#e8edf5] mt-0.5">{viewRfi.subject}</h2>
              </div>
              <button onClick={() => setViewRfi(null)} className="text-[#4f617a] hover:text-[#8b9ab5] transition-colors ml-4 flex-shrink-0">
                <XIcon className="h-4 w-4" />
              </button>
            </div>
            <div className="px-6 py-4 space-y-4 max-h-[70vh] overflow-y-auto">
              {viewRfi.description && (
                <div className="rounded-md bg-[#2a3347]/50 px-3 py-2.5">
                  <p className="text-[11px] font-bold text-[#4f617a] uppercase tracking-widest mb-1">Description</p>
                  <p className="text-[13px] text-[#c8d3e6]">{viewRfi.description}</p>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3 text-[12px]">
                {viewRfi.submitted_by && <div><span className="text-[#4f617a]">Submitted by: </span><span className="text-[#c8d3e6]">{viewRfi.submitted_by}</span></div>}
                {viewRfi.assigned_to && <div><span className="text-[#4f617a]">Assigned to: </span><span className="text-[#c8d3e6]">{viewRfi.assigned_to}</span></div>}
                {viewRfi.date_issued && <div><span className="text-[#4f617a]">Issued: </span><span className="text-[#c8d3e6]">{fmtDateOnly(viewRfi.date_issued)}</span></div>}
                {viewRfi.due_date && <div><span className="text-[#4f617a]">Due: </span><span className={new Date(viewRfi.due_date) < new Date() && viewRfi.status !== "Closed" && viewRfi.status !== "Answered" ? "text-red-400 font-medium" : "text-[#c8d3e6]"}>{fmtDateOnly(viewRfi.due_date)}</span></div>}
              </div>
              <div className="border-t border-[#2a3347] pt-4 space-y-3">
                <p className="text-[11px] font-bold text-[#4f617a] uppercase tracking-widest">Response</p>
                <textarea value={rfiResponse} onChange={e => setRfiResponse(e.target.value)} rows={4}
                  placeholder="Enter response here…"
                  className="w-full px-3 py-2 rounded-md border border-[#2a3347] text-[13px] text-[#e8edf5] bg-[#0d1117] focus:outline-none focus:ring-1 focus:ring-[#2563eb]/40 resize-none placeholder:text-[#4f617a]" />
                <div>
                  <label className={labelCls}>Status</label>
                  <select value={rfiResponseStatus} onChange={e => setRfiResponseStatus(e.target.value)}
                    className="w-full h-9 px-3 rounded-md border border-[#2a3347] text-[13px] text-[#e8edf5] bg-[#0d1117] focus:outline-none focus:ring-1 focus:ring-[#2563eb]/40">
                    {["Open", "Under Review", "Answered", "Closed", "Void"].map(s => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#2a3347]">
              <button onClick={() => setViewRfi(null)}
                className="h-8 px-4 rounded-md border border-[#2a3347] text-[13px] text-[#8b9ab5] hover:bg-white/[0.05] transition-colors">
                Close
              </button>
              <button onClick={respondRfi} disabled={rfiRespondSaving}
                className="h-8 px-4 rounded-md bg-[#2563eb] text-white text-[13px] font-semibold hover:bg-[#1d4ed8] transition-colors disabled:opacity-50 flex items-center gap-2">
                {rfiRespondSaving && <SpinnerIcon className="h-3 w-3" />}
                {rfiRespondSaving ? "Saving…" : "Save Response"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── File open modal ───────────────────────────────────────────────── */}
      {openFileCtx && fileModalStep === "project" && (
        <div
          className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
          onClick={e => { if (e.target === e.currentTarget) closeFileModal() }}
        >
          <div className="bg-[#1c2333] rounded-xl border border-[#2a3347] shadow-2xl w-[460px] p-6">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-[15px] font-bold text-[#e8edf5]">Open Submittal</h2>
              <button onClick={closeFileModal} className="text-[#4f617a] hover:text-[#8b9ab5] transition-colors">
                <XIcon className="h-4 w-4" />
              </button>
            </div>
            <p className="text-[12px] text-[#4f617a] mb-4 truncate">{openFileCtx.file.file_name}</p>

            <div className="mb-4">
              <label className="block text-[12px] font-medium text-[#8b9ab5] mb-1">Which project is this for?</label>
              <select
                value={modalProjectId}
                onChange={e => setModalProjectId(e.target.value)}
                className="w-full h-9 px-3 rounded-md border border-[#2a3347] text-[13px] text-[#e8edf5] bg-[#0d1117] focus:outline-none focus:ring-1 focus:ring-[#2563eb]/40"
              >
                <option value="">No project / skip</option>
                {appProjects.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name}{p.number ? ` — ${p.number}` : ""}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex justify-between items-center gap-2">
              <button
                onClick={closeFileModal}
                className="h-8 px-3 rounded-md border border-[#2a3347] text-[13px] text-[#8b9ab5] hover:bg-white/[0.05] transition-colors"
              >
                Cancel
              </button>
              <div className="flex gap-2">
                <button
                  onClick={openFileDirectly}
                  className="h-8 px-3 rounded-md border border-[#2a3347] text-[13px] text-[#8b9ab5] hover:bg-white/[0.05] transition-colors"
                >
                  Skip &amp; Open
                </button>
                <button
                  onClick={() => setFileModalStep("coversheet")}
                  className="h-8 px-4 rounded-md bg-[#2563eb] text-white text-[13px] font-semibold hover:bg-[#1d4ed8] transition-colors"
                >
                  Continue →
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {openFileCtx && fileModalStep === "coversheet" && (
        <div
          className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
          onClick={e => { if (e.target === e.currentTarget) closeFileModal() }}
        >
          <div className="bg-[#1c2333] rounded-xl border border-[#2a3347] shadow-2xl w-[460px] p-6">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-[15px] font-bold text-[#e8edf5]">Add Cover Sheet?</h2>
              <button onClick={closeFileModal} className="text-[#4f617a] hover:text-[#8b9ab5] transition-colors">
                <XIcon className="h-4 w-4" />
              </button>
            </div>
            <p className="text-[12px] font-semibold text-[#c8d3e6] mb-1">
              {modalProjectId ? (appProjects.find(p => p.id === modalProjectId)?.name ?? "Project") : "No project selected"}
            </p>
            <p className="text-[13px] text-[#8b9ab5] mb-5">
              Generate a submittal transmittal cover sheet and merge it with this document.
            </p>
            <div className="flex flex-col gap-2">
              <button
                onClick={initCoverForm}
                className="h-9 px-4 rounded-md bg-[#2563eb] text-white text-[13px] font-semibold hover:bg-[#1d4ed8] transition-colors"
              >
                Yes, add cover sheet
              </button>
              <button
                onClick={openFileDirectly}
                className="h-9 px-4 rounded-md border border-[#2a3347] text-[13px] text-[#8b9ab5] hover:bg-white/[0.05] transition-colors"
              >
                No, just open
              </button>
              <button
                onClick={closeFileModal}
                className="h-9 px-4 rounded-md border border-[#2a3347] text-[13px] text-[#4f617a] hover:bg-white/[0.05] transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {openFileCtx && fileModalStep === "form" && coverForm && (
        <div
          className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
          onClick={e => { if (e.target === e.currentTarget) closeFileModal() }}
        >
          <div className="bg-[#1c2333] rounded-xl border border-[#2a3347] shadow-2xl w-[680px]">
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#2a3347]">
              <h2 className="text-[15px] font-bold text-[#e8edf5]">Submittal Transmittal</h2>
              <button onClick={closeFileModal} className="text-[#4f617a] hover:text-[#8b9ab5] transition-colors">
                <XIcon className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleGenerateCover}>
              <div className="px-6 py-4 space-y-3 overflow-y-auto max-h-[75vh]">

                <div className="flex gap-3">
                  <div className="flex-[2]">
                    <label className={labelCls}>Project Name</label>
                    <input type="text" value={coverForm.projectName} onChange={e => setCoverForm(prev => ({ ...prev!, projectName: e.target.value }))} placeholder="Project name" className={inputCls} />
                  </div>
                  <div className="flex-1">
                    <label className={labelCls}>Project No.</label>
                    <input type="text" value={coverForm.projectNumber} onChange={e => setCoverForm(prev => ({ ...prev!, projectNumber: e.target.value }))} placeholder="2024-001" className={inputCls} />
                  </div>
                </div>

                <div>
                  <label className={labelCls}>Location</label>
                  <input type="text" value={coverForm.projectLocation} onChange={e => setCoverForm(prev => ({ ...prev!, projectLocation: e.target.value }))} placeholder="City, State" className={inputCls} />
                </div>

                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className={labelCls}>General Contractor</label>
                    <input type="text" value={coverForm.gcName} onChange={e => setCoverForm(prev => ({ ...prev!, gcName: e.target.value }))} placeholder="GC name" className={inputCls} />
                  </div>
                  <div className="flex-1">
                    <label className={labelCls}>Architect</label>
                    <input type="text" value={coverForm.architect} onChange={e => setCoverForm(prev => ({ ...prev!, architect: e.target.value }))} placeholder="Architecture firm" className={inputCls} />
                  </div>
                </div>

                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className={labelCls}>Spec Section No.</label>
                    <input type="text" value={coverForm.specSectionNo} onChange={e => setCoverForm(prev => ({ ...prev!, specSectionNo: e.target.value }))} placeholder="03 30 00" className={inputCls} />
                  </div>
                  <div className="flex-[2]">
                    <label className={labelCls}>Spec Section Title</label>
                    <input type="text" value={coverForm.specSectionTitle} onChange={e => setCoverForm(prev => ({ ...prev!, specSectionTitle: e.target.value }))} placeholder="Cast-in-Place Concrete" className={inputCls} />
                  </div>
                </div>

                <div>
                  <label className={labelCls}>Submittal Description</label>
                  <input type="text" value={coverForm.description} onChange={e => setCoverForm(prev => ({ ...prev!, description: e.target.value }))} placeholder="Description of submittal" className={inputCls} />
                </div>

                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className={labelCls}>Date Submitted</label>
                    <input type="text" value={coverForm.dateSubmitted} onChange={e => setCoverForm(prev => ({ ...prev!, dateSubmitted: e.target.value }))} placeholder="MM/DD/YYYY" className={inputCls} />
                  </div>
                  <div className="flex-1">
                    <label className={labelCls}>Submittal No.</label>
                    <input type="text" value={coverForm.submittalNo} onChange={e => setCoverForm(prev => ({ ...prev!, submittalNo: e.target.value }))} placeholder="1" className={inputCls} />
                  </div>
                </div>

                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className={labelCls}>Reviewed By</label>
                    <select value={coverForm.reviewedBy} onChange={e => setCoverForm(prev => ({ ...prev!, reviewedBy: e.target.value }))} className="w-full h-9 px-3 rounded-md border border-[#2a3347] text-[13px] text-[#e8edf5] bg-[#0d1117] focus:outline-none focus:ring-1 focus:ring-[#2563eb]/40">
                      <option value="">Select…</option>
                      {teamMembers.map(m => <option key={m.id} value={m.name}>{m.name}{m.title ? ` — ${m.title}` : ""}</option>)}
                    </select>
                  </div>
                  <div className="flex-1">
                    <label className={labelCls}>Certified by CQM</label>
                    <select value={coverForm.certifiedBy} onChange={e => setCoverForm(prev => ({ ...prev!, certifiedBy: e.target.value }))} className="w-full h-9 px-3 rounded-md border border-[#2a3347] text-[13px] text-[#e8edf5] bg-[#0d1117] focus:outline-none focus:ring-1 focus:ring-[#2563eb]/40">
                      <option value="">Select…</option>
                      {teamMembers.map(m => <option key={m.id} value={m.name}>{m.name}{m.title ? ` — ${m.title}` : ""}</option>)}
                    </select>
                  </div>
                </div>

                <div>
                  <label className={labelCls}>Notes</label>
                  <textarea
                    value={coverForm.notes}
                    onChange={e => setCoverForm(prev => ({ ...prev!, notes: e.target.value }))}
                    rows={3}
                    placeholder="Additional notes or instructions…"
                    className="w-full px-3 py-2 rounded-md border border-[#2a3347] text-[13px] text-[#e8edf5] bg-[#0d1117] focus:outline-none focus:ring-1 focus:ring-[#2563eb]/40 resize-none placeholder:text-[#4f617a]"
                  />
                </div>

              </div>

              <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#2a3347]">
                <button
                  type="button"
                  onClick={closeFileModal}
                  className="h-8 px-4 rounded-md border border-[#2a3347] text-[13px] text-[#8b9ab5] hover:bg-white/[0.05] transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={generatingCover}
                  className="h-8 px-4 rounded-md bg-[#2563eb] text-white text-[13px] font-semibold hover:bg-[#1d4ed8] transition-colors disabled:opacity-50 flex items-center gap-2"
                >
                  {generatingCover && <SpinnerIcon className="h-3 w-3" />}
                  {generatingCover ? "Generating…" : "Generate & Download"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Upload modal ──────────────────────────────────────────────────── */}
      {showUpload && (
        <div
          className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
          onClick={e => { if (e.target === e.currentTarget) closeModal() }}
        >
          <div className="bg-[#1c2333] rounded-xl border border-[#2a3347] shadow-2xl w-[440px] p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-[15px] font-bold text-[#e8edf5]">Upload Submittal</h2>
              <button onClick={closeModal} className="text-[#4f617a] hover:text-[#8b9ab5] transition-colors">
                <XIcon className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleUpload} className="space-y-3">
              {/* File */}
              <div>
                <label className="block text-[12px] font-medium text-[#8b9ab5] mb-1">File</label>
                <input
                  type="file"
                  accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.dwg,.rvt"
                  disabled={uploadStep === "classifying"}
                  onChange={async e => {
                    const f = e.target.files?.[0] ?? null
                    setUploadFile(f)
                    setAiResult(null)
                    if (!f) { setUploadStep("file"); return }
                    setUploadStep("classifying")
                    try {
                      const fd = new FormData()
                      fd.append("file", f)
                      const res = await fetch("/api/classify", { method: "POST", body: fd })
                      if (res.ok) {
                        const data = await res.json()
                        if (data.division_num && data.section_code) {
                          setAiResult(data)
                          setUploadStep("suggested")
                          return
                        }
                      }
                    } catch {}
                    setUploadStep("manual")
                  }}
                  required
                  className="w-full text-[13px] text-[#c8d3e6] file:mr-3 file:text-[12px] file:bg-[#2a3347] file:border-0 file:rounded-md file:px-3 file:py-1.5 file:text-[#c8d3e6] file:cursor-pointer cursor-pointer disabled:opacity-50"
                />
              </div>

              {/* Classifying spinner */}
              {uploadStep === "classifying" && (
                <div className="flex items-center gap-2 py-1 text-[13px] text-[#8b9ab5]">
                  <SpinnerIcon className="h-4 w-4" /> Analyzing document…
                </div>
              )}

              {/* AI suggestion card */}
              {uploadStep === "suggested" && aiResult && (
                <div className="rounded-lg border border-[#2563eb]/30 bg-[#2563eb]/10 p-3 space-y-2">
                  <p className="text-[11px] font-bold text-[#60a5fa] uppercase tracking-widest">✦ AI Suggestion</p>
                  <div>
                    <p className="text-[13px] font-semibold text-[#e8edf5]">{aiResult.division_num} — {aiResult.division_name}</p>
                    <p className="text-[12px] text-[#8b9ab5] mt-0.5">{aiResult.section_code} — {aiResult.section_name}</p>
                  </div>
                  {(aiResult.material_name || aiResult.manufacturer || aiResult.dimensions) && (
                    <div className="border-t border-[#2563eb]/20 pt-2 space-y-0.5">
                      {aiResult.material_name && <p className="text-[12px] text-[#c8d3e6]"><span className="text-[#4f617a]">Material:</span> {aiResult.material_name}</p>}
                      {aiResult.manufacturer  && <p className="text-[12px] text-[#c8d3e6]"><span className="text-[#4f617a]">Mfr:</span> {aiResult.manufacturer}</p>}
                      {aiResult.dimensions    && <p className="text-[12px] text-[#c8d3e6]"><span className="text-[#4f617a]">Dims:</span> {aiResult.dimensions}</p>}
                    </div>
                  )}
                  {aiResult.confidence != null && (
                    <div className="border-t border-[#2563eb]/20 pt-2 flex items-center gap-2">
                      <div className="flex-1 h-1 rounded-full bg-[#2a3347] overflow-hidden">
                        <div className={`h-full rounded-full transition-all ${aiResult.confidence >= 70 ? "bg-emerald-400" : "bg-amber-400"}`} style={{ width: `${aiResult.confidence}%` }} />
                      </div>
                      <span className={`text-[11px] font-medium ${aiResult.confidence >= 70 ? "text-emerald-400" : "text-amber-400"}`}>{aiResult.confidence}% confident</span>
                    </div>
                  )}
                  {aiResult.confidence != null && aiResult.confidence < 70 && (
                    <p className="text-[11px] text-amber-300 bg-amber-400/10 rounded px-2 py-1">Low confidence — verify the classification before uploading</p>
                  )}
                  {aiResult.reasoning && <p className="text-[11px] text-[#4f617a] italic">{aiResult.reasoning}</p>}
                  <div className="flex gap-2 pt-0.5">
                    <button type="button" onClick={acceptSuggestion}
                      className="h-7 px-3 rounded-md bg-[#2563eb] text-white text-[12px] font-semibold hover:bg-[#1d4ed8] transition-colors">
                      Use this →
                    </button>
                    <button type="button" onClick={() => { setUploadDiv(""); setUploadDivName(""); setUploadSec(""); setUploadSecName(""); setUploadStep("manual") }}
                      className="h-7 px-3 rounded-md border border-[#2a3347] text-[12px] text-[#8b9ab5] hover:bg-white/[0.05] transition-colors">
                      Classify manually
                    </button>
                  </div>
                </div>
              )}

              {/* Manual classification */}
              {uploadStep === "manual" && (
                <>
                  <div>
                    <label className="block text-[12px] font-medium text-[#8b9ab5] mb-1">Division</label>
                    <select
                      value={uploadDiv}
                      onChange={e => {
                        const picked = CSI_DIVISIONS.find(d => d.num === e.target.value)
                        setUploadDiv(e.target.value)
                        setUploadDivName(picked?.name ?? "")
                        setUploadSec("")
                        setUploadSecName("")
                      }}
                      required
                      className="w-full h-9 px-2 rounded-md border border-[#2a3347] text-[13px] text-[#e8edf5] bg-[#0d1117] focus:outline-none focus:ring-1 focus:ring-[#2563eb]/40"
                    >
                      <option value="">Select a division…</option>
                      {CSI_DIVISIONS.map(d => (
                        <option key={d.num} value={d.num}>{d.num} — {d.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[12px] font-medium text-[#8b9ab5] mb-1">Section</label>
                    <select
                      value={uploadSec}
                      onChange={e => {
                        const picked = (CSI_SECTIONS[uploadDiv] ?? []).find(s => s.code === e.target.value)
                        setUploadSec(e.target.value)
                        setUploadSecName(picked?.name ?? "")
                      }}
                      disabled={!uploadDiv}
                      className="w-full h-9 px-2 rounded-md border border-[#2a3347] text-[13px] text-[#e8edf5] bg-[#0d1117] focus:outline-none focus:ring-1 focus:ring-[#2563eb]/40 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <option value="">{uploadDiv ? "Select a section…" : "Select a division first"}</option>
                      {(CSI_SECTIONS[uploadDiv] ?? []).map(s => (
                        <option key={s.code} value={s.code}>{s.code} — {s.name}</option>
                      ))}
                    </select>
                  </div>
                </>
              )}

              {/* Naming step */}
              {uploadStep === "naming" && (
                <div className="space-y-3 pt-1">
                  <div className="h-px bg-[#2a3347]" />
                  <p className="text-[11px] font-bold text-[#4f617a] uppercase tracking-widest">Submittal Name</p>

                  <div>
                    <label className="block text-[12px] font-medium text-[#8b9ab5] mb-1">Material</label>
                    <Combobox value={nameMatl} onChange={setNameMatl} options={nameOpts.materials} placeholder="e.g. Gypsum Board" autoFocus />
                  </div>

                  <div>
                    <label className="block text-[12px] font-medium text-[#8b9ab5] mb-1">Manufacturer</label>
                    <Combobox value={nameMfr} onChange={setNameMfr} options={nameOpts.manufacturers} placeholder="e.g. Georgia-Pacific" />
                  </div>

                  <div>
                    <label className="block text-[12px] font-medium text-[#8b9ab5] mb-1">Dimensions</label>
                    <Combobox value={nameDims} onChange={setNameDims} options={nameOpts.dimensions} placeholder='e.g. 5/8" x 4&apos; x 8&apos;' />
                  </div>

                  {(nameMatl || nameMfr || nameDims) && (
                    <div className="rounded-md bg-[#2563eb]/10 border border-[#2563eb]/20 px-3 py-2">
                      <p className="text-[10px] font-bold text-[#60a5fa] uppercase tracking-widest mb-0.5">Name preview</p>
                      <p className="text-[13px] font-medium text-[#e8edf5] truncate">
                        {[nameMatl, nameMfr, nameDims].filter(Boolean).join(" — ")}
                      </p>
                    </div>
                  )}
                </div>
              )}

              {uploadError && <p className="text-[12px] text-red-400">{uploadError}</p>}

              <div className="flex justify-between gap-2 pt-1">
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={closeModal}
                    className="h-8 px-4 rounded-md border border-[#2a3347] text-[13px] text-[#8b9ab5] hover:bg-white/[0.05] transition-colors"
                  >
                    Cancel
                  </button>
                  {uploadStep === "naming" && (
                    <button
                      type="button"
                      onClick={() => setUploadStep(aiResult ? "suggested" : "manual")}
                      className="h-8 px-3 rounded-md border border-[#2a3347] text-[13px] text-[#8b9ab5] hover:bg-white/[0.05] transition-colors"
                    >
                      ← Back
                    </button>
                  )}
                </div>
                {uploadStep === "manual" && (
                  <button
                    type="button"
                    disabled={!uploadFile || !uploadDiv || !uploadSec}
                    onClick={() => setUploadStep("naming")}
                    className="h-8 px-4 rounded-md bg-[#2563eb] text-white text-[13px] font-semibold hover:bg-[#1d4ed8] transition-colors disabled:opacity-50"
                  >
                    Next →
                  </button>
                )}
                {uploadStep === "naming" && (
                  <button
                    type="submit"
                    disabled={uploading}
                    className="h-8 px-4 rounded-md bg-[#2563eb] text-white text-[13px] font-semibold hover:bg-[#1d4ed8] transition-colors disabled:opacity-50 flex items-center gap-2"
                  >
                    {uploading && <SpinnerIcon className="h-3 w-3" />}
                    {uploading ? "Uploading…" : "Upload"}
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Edit submittal modal ─────────────────────────────────────────── */}
      {editSubmittal && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
          onClick={e => { if (e.target === e.currentTarget) setEditSubmittal(null) }}>
          <div className="bg-[#1c2333] rounded-xl border border-[#2a3347] shadow-2xl w-[460px] p-6">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-[15px] font-bold text-[#e8edf5]">Edit Submittal</h2>
              <button onClick={() => setEditSubmittal(null)} className="text-[#4f617a] hover:text-[#8b9ab5] transition-colors"><XIcon className="h-4 w-4" /></button>
            </div>
            <p className="text-[12px] text-[#4f617a] mb-4 truncate">{editSubmittal.file_name}</p>

            <div className="space-y-3">
              <div>
                <label className="block text-[12px] font-medium text-[#8b9ab5] mb-1">Status</label>
                <select value={editStatus} onChange={e => setEditStatus(e.target.value)}
                  className="w-full h-9 px-3 rounded-md border border-[#2a3347] text-[13px] text-[#e8edf5] bg-[#0d1117] focus:outline-none focus:ring-1 focus:ring-[#2563eb]/40">
                  {["Received","Under Review","Approved","Approved with Comments","Rejected","Revise and Resubmit","Needs Review"].map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[12px] font-medium text-[#8b9ab5] mb-1">Division</label>
                <select value={editDiv} onChange={e => {
                  const d = CSI_DIVISIONS.find(d => d.num === e.target.value)
                  setEditDiv(e.target.value); setEditDivName(d?.name ?? ""); setEditSec(""); setEditSecName("")
                }} className="w-full h-9 px-3 rounded-md border border-[#2a3347] text-[13px] text-[#e8edf5] bg-[#0d1117] focus:outline-none focus:ring-1 focus:ring-[#2563eb]/40">
                  <option value="">Select division…</option>
                  {CSI_DIVISIONS.map(d => <option key={d.num} value={d.num}>{d.num} — {d.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[12px] font-medium text-[#8b9ab5] mb-1">Section</label>
                <select value={editSec} disabled={!editDiv} onChange={e => {
                  const s = (CSI_SECTIONS[editDiv] ?? []).find(s => s.code === e.target.value)
                  setEditSec(e.target.value); setEditSecName(s?.name ?? "")
                }} className="w-full h-9 px-3 rounded-md border border-[#2a3347] text-[13px] text-[#e8edf5] bg-[#0d1117] focus:outline-none focus:ring-1 focus:ring-[#2563eb]/40 disabled:opacity-50">
                  <option value="">{editDiv ? "Select section…" : "Select a division first"}</option>
                  {(CSI_SECTIONS[editDiv] ?? []).map(s => <option key={s.code} value={s.code}>{s.code} — {s.name}</option>)}
                </select>
              </div>
              {editSubmittal.ai_reasoning && (
                <div className="rounded-md bg-[#2a3347]/50 px-3 py-2">
                  <p className="text-[10px] font-bold text-[#4f617a] uppercase tracking-widest mb-0.5">AI Reasoning</p>
                  <p className="text-[12px] text-[#8b9ab5] italic">{editSubmittal.ai_reasoning}</p>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setEditSubmittal(null)}
                className="h-8 px-4 rounded-md border border-[#2a3347] text-[13px] text-[#8b9ab5] hover:bg-white/[0.05] transition-colors">
                Cancel
              </button>
              <button onClick={saveEdit} disabled={editSaving}
                className="h-8 px-4 rounded-md bg-[#2563eb] text-white text-[13px] font-semibold hover:bg-[#1d4ed8] transition-colors disabled:opacity-50 flex items-center gap-2">
                {editSaving && <SpinnerIcon className="h-3 w-3" />}
                {editSaving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Batch upload modal ───────────────────────────────────────────── */}
      {showBatch && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
          onClick={e => { if (e.target === e.currentTarget) closeBatch() }}>
          <div className="bg-[#1c2333] rounded-xl border border-[#2a3347] shadow-2xl w-[700px] max-h-[85vh] flex flex-col">

            {/* Header */}
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#2a3347] flex-shrink-0">
              <div>
                <h2 className="text-[15px] font-bold text-[#e8edf5]">Batch Upload</h2>
                <p className="text-[12px] text-[#4f617a] mt-0.5">AI will classify each file — review before uploading</p>
              </div>
              <button onClick={closeBatch} className="text-[#4f617a] hover:text-[#8b9ab5] transition-colors">
                <XIcon className="h-4 w-4" />
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0">

              {/* ── Select phase ── */}
              {batchPhase === "select" && (
                <div
                  onDragOver={e => { e.preventDefault(); setBatchDragOver(true) }}
                  onDragLeave={() => setBatchDragOver(false)}
                  onDrop={e => { e.preventDefault(); setBatchDragOver(false); initBatchFiles(Array.from(e.dataTransfer.files)) }}
                  className={`border-2 border-dashed rounded-xl p-10 text-center transition-colors ${batchDragOver ? "border-[#2563eb]/60 bg-[#2563eb]/5" : "border-[#2a3347]"}`}
                >
                  <div className="w-12 h-12 rounded-xl bg-[#2a3347] flex items-center justify-center mx-auto mb-3">
                    <LayersIcon />
                  </div>
                  <p className="text-[14px] font-semibold text-[#c8d3e6] mb-1">Drop files here</p>
                  <p className="text-[12px] text-[#4f617a] mb-4">PDF, DOC, DOCX, XLS, XLSX, DWG, RVT</p>
                  <label className="cursor-pointer h-8 px-4 rounded-md bg-[#2563eb] text-white text-[13px] font-semibold hover:bg-[#1d4ed8] transition-colors inline-flex items-center gap-2">
                    <PlusIcon /> Choose files
                    <input type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.dwg,.rvt" className="hidden"
                      onChange={e => { if (e.target.files) initBatchFiles(Array.from(e.target.files)) }} />
                  </label>
                  {batchItems.length > 0 && (
                    <p className="mt-4 text-[13px] text-[#60a5fa]">{batchItems.length} file{batchItems.length !== 1 ? "s" : ""} selected</p>
                  )}
                </div>
              )}

              {/* ── Classifying + review phase ── */}
              {(batchPhase === "classifying" || batchPhase === "review" || batchPhase === "uploading" || batchPhase === "done") && (
                <div className="space-y-1.5">
                  {/* Column headers */}
                  <div className="grid gap-2 px-2 pb-1" style={{ gridTemplateColumns: "1fr 155px 195px 20px 20px 20px" }}>
                    <span className="text-[10px] font-bold text-[#4f617a] uppercase tracking-widest">File</span>
                    <span className="text-[10px] font-bold text-[#4f617a] uppercase tracking-widest">Division</span>
                    <span className="text-[10px] font-bold text-[#4f617a] uppercase tracking-widest">Section</span>
                    <span /><span /><span />
                  </div>
                  {batchItems.map(item => {
                    const isEditable = batchPhase === "review" || batchPhase === "classifying"
                    const hasName = item.nameMatl || item.nameMfr || item.nameDims
                    return (
                      <div key={item.id} className="bg-[#161b27] rounded-lg overflow-hidden mb-1">
                        {/* Main row */}
                        <div className="grid gap-2 items-center px-2 py-1.5" style={{ gridTemplateColumns: "1fr 155px 195px 20px 20px 20px" }}>
                          <span className="text-[12px] text-[#c8d3e6] truncate min-w-0" title={item.file.name}>{item.file.name}</span>

                          <select value={item.divNum} disabled={!isEditable}
                            onChange={e => {
                              const d = CSI_DIVISIONS.find(d => d.num === e.target.value)
                              updateBatchItem(item.id, { divNum: e.target.value, divName: d?.name ?? "", secCode: "", secName: "", status: "ready" })
                            }}
                            className="h-7 px-1.5 rounded-md border border-[#2a3347] text-[11px] text-[#e8edf5] bg-[#0d1117] focus:outline-none disabled:opacity-60 w-full">
                            <option value="">Division…</option>
                            {CSI_DIVISIONS.map(d => <option key={d.num} value={d.num}>{d.num} — {d.name}</option>)}
                          </select>

                          <select value={item.secCode} disabled={!isEditable || !item.divNum}
                            onChange={e => {
                              const s = (CSI_SECTIONS[item.divNum] ?? []).find(s => s.code === e.target.value)
                              updateBatchItem(item.id, { secCode: e.target.value, secName: s?.name ?? "", status: "ready" })
                            }}
                            className="h-7 px-1.5 rounded-md border border-[#2a3347] text-[11px] text-[#e8edf5] bg-[#0d1117] focus:outline-none disabled:opacity-60 w-full">
                            <option value="">{item.divNum ? "Section…" : "—"}</option>
                            {(CSI_SECTIONS[item.divNum] ?? []).map(s => <option key={s.code} value={s.code}>{s.code} — {s.name}</option>)}
                          </select>

                          {/* Status */}
                          <div className="flex items-center justify-center">
                            {(item.status === "classifying" || item.status === "uploading") && <SpinnerIcon className="h-3.5 w-3.5" />}
                            {item.status === "pending"      && <span className="w-2 h-2 rounded-full bg-[#2a3347]" />}
                            {item.status === "ready"        && <span className="w-2 h-2 rounded-full bg-emerald-400" />}
                            {item.status === "error"        && <span className="w-2 h-2 rounded-full bg-amber-400" title={item.errorMsg} />}
                            {item.status === "done"         && <span className="w-2 h-2 rounded-full bg-emerald-400" />}
                            {item.status === "upload-error" && <span className="w-2 h-2 rounded-full bg-red-400" title={item.errorMsg} />}
                          </div>

                          {/* Expand naming */}
                          {isEditable && (
                            <button type="button" onClick={() => updateBatchItem(item.id, { expanded: !item.expanded })}
                              title="Edit name (Material / Manufacturer / Dimensions)"
                              className={`flex items-center justify-center transition-colors ${item.expanded || hasName ? "text-[#60a5fa]" : "text-[#4f617a] hover:text-[#8b9ab5]"}`}>
                              <svg className={`h-3 w-3 transition-transform ${item.expanded ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                              </svg>
                            </button>
                          )}

                          {/* Remove */}
                          {isEditable && (
                            <button type="button" onClick={() => setBatchItems(prev => prev.filter(it => it.id !== item.id))}
                              className="text-[#4f617a] hover:text-red-400 transition-colors flex items-center justify-center">
                              <XIcon className="h-3 w-3" />
                            </button>
                          )}
                        </div>

                        {/* Expanded naming row */}
                        {item.expanded && isEditable && (
                          <div className="border-t border-[#2a3347] px-2 pb-2 pt-2 grid grid-cols-3 gap-2">
                            <div>
                              <label className="block text-[10px] font-medium text-[#4f617a] mb-1">Material</label>
                              <Combobox value={item.nameMatl} onChange={v => updateBatchItem(item.id, { nameMatl: v })} options={nameOpts.materials} placeholder="e.g. Gypsum Board" />
                            </div>
                            <div>
                              <label className="block text-[10px] font-medium text-[#4f617a] mb-1">Manufacturer</label>
                              <Combobox value={item.nameMfr} onChange={v => updateBatchItem(item.id, { nameMfr: v })} options={nameOpts.manufacturers} placeholder="e.g. USG" />
                            </div>
                            <div>
                              <label className="block text-[10px] font-medium text-[#4f617a] mb-1">Dimensions</label>
                              <Combobox value={item.nameDims} onChange={v => updateBatchItem(item.id, { nameDims: v })} options={nameOpts.dimensions} placeholder='e.g. 5/8"' />
                            </div>
                            {hasName && (
                              <div className="col-span-3 text-[11px] text-[#60a5fa] truncate">
                                {[item.nameMatl, item.nameMfr, item.nameDims].filter(Boolean).join(" — ")}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}

                  {batchPhase === "classifying" && (
                    <p className="text-[12px] text-[#4f617a] pt-2 text-center">
                      Analyzing {batchItems.filter(it => it.status === "classifying").length > 0
                        ? `"${batchItems.find(it => it.status === "classifying")?.file.name ?? ""}"`
                        : "files"}…
                    </p>
                  )}

                  {batchPhase === "done" && (() => {
                    const done = batchItems.filter(it => it.status === "done").length
                    const errs = batchItems.filter(it => it.status === "upload-error").length
                    return (
                      <div className="mt-3 rounded-lg border border-[#2a3347] bg-[#161b27] px-4 py-3 text-center">
                        <p className="text-[13px] font-semibold text-[#c8d3e6]">
                          {done} file{done !== 1 ? "s" : ""} uploaded successfully
                          {errs > 0 && <span className="text-red-400"> · {errs} failed</span>}
                        </p>
                      </div>
                    )
                  })()}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex-shrink-0 border-t border-[#2a3347] px-6 py-4 flex justify-between items-center">
              <button onClick={closeBatch} className="h-8 px-4 rounded-md border border-[#2a3347] text-[13px] text-[#8b9ab5] hover:bg-white/[0.05] transition-colors">
                {batchPhase === "done" ? "Close" : "Cancel"}
              </button>
              <div className="flex items-center gap-3">
                {batchPhase === "review" && (
                  <p className="text-[12px] text-[#4f617a]">
                    {batchItems.filter(it => it.status === "ready").length} ready ·{" "}
                    {batchItems.filter(it => it.status === "error" && it.divNum && it.secCode).length} manual ·{" "}
                    {batchItems.filter(it => it.status === "error" && (!it.divNum || !it.secCode)).length} unassigned
                  </p>
                )}
                {batchPhase === "select" && (
                  <button
                    disabled={batchItems.length === 0}
                    onClick={classifyBatch}
                    className="h-8 px-5 rounded-md bg-[#2563eb] text-white text-[13px] font-semibold hover:bg-[#1d4ed8] transition-colors disabled:opacity-40 flex items-center gap-2"
                  >
                    <SpinnerIcon className="h-3 w-3 hidden" />
                    Analyze {batchItems.length > 0 ? `${batchItems.length} files` : "files"}
                  </button>
                )}
                {batchPhase === "review" && (
                  <button
                    disabled={!batchItems.some(it => it.divNum && it.secCode)}
                    onClick={uploadBatch}
                    className="h-8 px-5 rounded-md bg-[#2563eb] text-white text-[13px] font-semibold hover:bg-[#1d4ed8] transition-colors disabled:opacity-40"
                  >
                    Upload {batchItems.filter(it => it.divNum && it.secCode).length} files
                  </button>
                )}
                {batchPhase === "uploading" && (
                  <div className="flex items-center gap-2 text-[13px] text-[#8b9ab5]">
                    <SpinnerIcon className="h-3.5 w-3.5" /> Uploading…
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Manage divisions modal ────────────────────────────────────────── */}
      {showManage && (
        <div
          className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
          onClick={e => { if (e.target === e.currentTarget) setShowManage(false) }}
        >
          <div className="bg-[#1c2333] rounded-xl border border-[#2a3347] shadow-2xl w-[360px] p-5">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-[15px] font-bold text-[#e8edf5]">Manage Divisions</h2>
              <button onClick={() => setShowManage(false)} className="text-[#4f617a] hover:text-[#8b9ab5] transition-colors">
                <XIcon className="h-4 w-4" />
              </button>
            </div>
            <p className="text-[12px] text-[#8b9ab5] mb-3">Uncheck divisions to hide them from the sidebar.</p>
            <div className="space-y-0.5 max-h-[420px] overflow-y-auto">
              {CSI_DIVISIONS.map(d => {
                const hidden = hiddenDivisions.has(d.num)
                return (
                  <button
                    key={d.num}
                    onClick={() => toggleDivisionVisibility(d.num)}
                    className="w-full flex items-center gap-2.5 h-8 px-2 rounded-md hover:bg-white/[0.05] transition-colors text-left"
                  >
                    <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${hidden ? "border-[#2a3347] bg-transparent" : "border-[#2563eb] bg-[#2563eb]"}`}>
                      {!hidden && <CheckIcon />}
                    </span>
                    <span className="text-[11px] font-mono text-[#4f617a] w-5 text-right flex-shrink-0">{d.num}</span>
                    <span className={`text-[13px] truncate transition-colors ${hidden ? "text-[#4f617a]" : "text-[#c8d3e6]"}`}>{d.name}</span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
