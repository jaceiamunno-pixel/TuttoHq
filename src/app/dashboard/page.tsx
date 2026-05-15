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

interface Section  { code: string; name: string; file_count?: number }
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
  send_to_type: string | null
  send_to_company: string | null
  send_to_contact: string | null
  send_to_email: string | null
  send_to_phone: string | null
  send_to_address: string | null
  transmitted_by: string | null
  transmitted_by_company: string | null
}

type BatchStatus = "pending" | "classifying" | "ready" | "error" | "uploading" | "done" | "upload-error"
type BatchPhase  = "select" | "classifying" | "review" | "uploading" | "done"
interface BatchItem { id: string; file: File; status: BatchStatus; divNum: string; divName: string; secCode: string; secName: string; nameMatl: string; nameMfr: string; nameDims: string; customName: string; expanded: boolean; errorMsg?: string }

interface Project { id: string; name: string; number: string | null; location: string | null; gc_name: string | null; architect: string | null }
interface TeamMember { id: string; name: string; title: string | null; email: string | null }
interface RFI {
  id: string; rfi_number: string; subject: string; description: string | null;
  received_from: string | null; submitted_by: string | null;
  specification_section: string | null; location: string | null;
  schedule_impact: string; cost_impact: string;
  assigned_to: string | null; date_issued: string | null; due_date: string | null;
  status: string; response: string | null; project_id: string | null;
  file_path: string | null; file_name: string | null; generated_pdf_path: string | null;
  created_at: string; uploaded_by: string;
}
interface ChangeOrder {
  id: string; co_number: string; project_id: string | null; date: string | null;
  proposal: string | null; qualifications: string | null; pricing_sum: number | null;
  schedule_impact: string; schedule_impact_days: number | null;
  file_path: string | null; file_name: string | null;
  status: string; submitted_by: string | null; assigned_to: string | null;
  generated_pdf_path: string | null; approved_at: string | null;
  created_at: string; uploaded_by: string;
}
interface PunchItem { id: string; item_number: string; description: string; location: string | null; assigned_to: string | null; due_date: string | null; priority: string; status: string; notes: string | null; project_id: string | null; created_at: string; completed_at: string | null; uploaded_by: string; generated_pdf_path?: string | null; file_name?: string | null; file_path?: string | null }
interface DailyReport { id: string; report_date: string; project_id: string | null; prepared_by: string | null; weather_conditions: string | null; temperature: string | null; manpower_count: number | null; work_performed: string | null; equipment: string | null; materials_delivered: string | null; visitors: string | null; issues_delays: string | null; safety_notes: string | null; created_at: string; uploaded_by: string; generated_pdf_path?: string | null; file_name?: string | null; file_path?: string | null }
interface DrawingRecord { id: string; drawing_number: string; sheet_title: string; discipline: string | null; revision: string; revision_date: string | null; status: string; scale: string | null; notes: string | null; project_id: string | null; is_current: boolean; superseded_at: string | null; created_at: string; uploaded_by: string; generated_pdf_path?: string | null; file_name?: string | null; file_path?: string | null; file_url?: string | null }
interface CloseoutItem { id: string; project_id: string; category: string; item_type: string; title: string; status: string; assigned_to: string | null; due_date: string | null; file_url: string | null; file_name: string | null; notes: string | null; sort_order: number; folder_name: string | null; linked_record_id: string | null; linked_record_type: string | null; completed_at: string | null; created_at: string }
type FileModalStep = "project" | "coversheet" | "form"
interface OpenFileCtx { file: SubmittalFile; divNum: string; divName: string; secCode: string; secName: string }
interface CoverFormData { projectName: string; projectNumber: string; projectLocation: string; gcName: string; architect: string; specSectionNo: string; specSectionTitle: string; description: string; dateSubmitted: string; submittalNo: string; reviewedBy: string; certifiedBy: string; notes: string; sendToType: "cm" | "subcontractor" | "supplier" | ""; sendToCompany: string; sendToContact: string; sendToEmail: string; sendToPhone: string; sendToAddress: string; transmittedBy: string; transmittedByCompany: string }
interface CoverContact { id: string; company_name: string; contact_name: string | null; email: string | null; phone: string | null; address?: string | null }

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
      className={`h-[9px] w-[9px] flex-shrink-0 fill-[#64748B] transition-transform duration-150 ${open ? "rotate-90" : ""}`}
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
    <svg className="h-2.5 w-2.5 text-[#0F172A]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
    </svg>
  )
}

function SpinnerIcon({ className = "h-3 w-3" }: { className?: string }) {
  return (
    <svg className={`${className} animate-spin text-[#64748B]`} fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
    </svg>
  )
}

const STATUS_STYLES: Record<string, string> = {
  "Received":               "bg-blue-100 text-blue-700",
  "Under Review":           "bg-amber-100 text-amber-700",
  "Approved":               "bg-green-100 text-green-700",
  "Approved with Comments": "bg-blue-100 text-blue-700",
  "Rejected":               "bg-red-100 text-red-700",
  "Revise and Resubmit":    "bg-amber-100 text-amber-700",
  "Needs Review":           "bg-amber-100 text-amber-700",
}
function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_STYLES[status] ?? "bg-gray-100 text-gray-500"
  return <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold ${cls}`}>{status}</span>
}

const RFI_STATUS_STYLES: Record<string, string> = {
  "Open":         "bg-blue-100 text-blue-700",
  "Under Review": "bg-amber-100 text-amber-700",
  "Answered":     "bg-blue-100 text-blue-700",
  "Closed":       "bg-green-100 text-green-700",
  "Void":         "bg-gray-100 text-gray-500",
}
function RfiStatusBadge({ status }: { status: string }) {
  const cls = RFI_STATUS_STYLES[status] ?? "bg-gray-100 text-gray-500"
  return <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold ${cls}`}>{status}</span>
}

const PUNCH_STATUS_STYLES: Record<string, string> = {
  "Open":        "bg-blue-100 text-blue-700",
  "In Progress": "bg-amber-100 text-amber-700",
  "Completed":   "bg-green-100 text-green-700",
  "Void":        "bg-gray-100 text-gray-500",
}
const PUNCH_PRIORITY_STYLES: Record<string, string> = {
  "Low":      "bg-gray-100 text-gray-500",
  "Medium":   "bg-blue-100 text-blue-700",
  "High":     "bg-amber-100 text-amber-700",
  "Critical": "bg-red-100 text-red-700",
}
function PunchStatusBadge({ status }: { status: string }) {
  const cls = PUNCH_STATUS_STYLES[status] ?? "bg-gray-100 text-gray-500"
  return <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold ${cls}`}>{status}</span>
}
function PunchPriorityBadge({ priority }: { priority: string }) {
  const cls = PUNCH_PRIORITY_STYLES[priority] ?? "bg-gray-100 text-gray-500"
  return <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold ${cls}`}>{priority}</span>
}

const DRAWING_STATUS_STYLES: Record<string, string> = {
  "Issued for Construction": "bg-green-100 text-green-700",
  "Issued for Bid":          "bg-blue-100 text-blue-700",
  "Issued for Review":       "bg-amber-100 text-amber-700",
  "Record Drawings":         "bg-blue-100 text-blue-700",
  "Superseded":              "bg-gray-100 text-gray-500",
  "Void":                    "bg-red-100 text-red-700",
}
function DrawingStatusBadge({ status }: { status: string }) {
  const cls = DRAWING_STATUS_STYLES[status] ?? "bg-gray-100 text-gray-500"
  return <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold ${cls}`}>{status}</span>
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
        className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 focus:border-[#7B9BB5]/50 placeholder:text-[#64748B] transition-all"
      />
      {open && filtered.length > 0 && (
        <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-white border border-[#E2E8F0] rounded-md shadow-xl max-h-44 overflow-y-auto">
          {filtered.map(opt => (
            <button
              key={opt}
              type="button"
              onMouseDown={e => { e.preventDefault(); onChange(opt); setOpen(false) }}
              className="w-full text-left px-3 py-1.5 text-[13px] text-[#0F172A] hover:bg-white/[0.07] transition-colors"
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
      className="group flex items-center gap-1.5 h-7 rounded-md hover:bg-[#0F172A]/[0.04] transition-colors cursor-pointer"
      style={{ paddingLeft: `${indent}px`, paddingRight: "4px" }}
      onClick={onOpen}
      title={`${file.file_name} · ${fmtDate(file.created_at)}`}
    >
      <span className={`flex-shrink-0 w-1.5 h-1.5 rounded-full ${dot}`} />
      <span className="flex-1 min-w-0 text-[12px] text-[#64748B] truncate">{file.file_name}</span>
      {onDelete && (
        <button
          onClick={e => { e.stopPropagation(); onDelete() }}
          title="Delete file"
          className="opacity-0 group-hover:opacity-100 flex-shrink-0 text-[#64748B] hover:text-red-400 transition-all rounded p-0.5"
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
  const [coverEditId, setCoverEditId]     = useState<string | null>(null)
  const [generatingCover, setGeneratingCover] = useState(false)
  const [coverProjectSubs, setCoverProjectSubs]           = useState<CoverContact[]>([])
  const [coverProjectSuppliers, setCoverProjectSuppliers] = useState<CoverContact[]>([])
  const [coverProjectCms, setCoverProjectCms]             = useState<CoverContact[]>([])
  const [coverSelectedId, setCoverSelectedId]             = useState<string>("")

  // Sidebar
  const [sidebarOpen, setSidebarOpen] = useState(false)
  useEffect(() => {
    if (sessionStorage.getItem("sidebarOpen") === "true") setSidebarOpen(true)
  }, [])

  // Module navigation
  const [activeModule, setActiveModule] = useState<"submittals" | "rfis" | "changeorders" | "punch" | "daily" | "drawings" | "closeout">("submittals")
  const [globalProjectId, setGlobalProjectId] = useState<string>("")
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  // Sync submittal project filter with global project selection
  useEffect(() => { setActiveProjectId(globalProjectId || null) }, [globalProjectId])

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
  const [rfiQuestion, setRfiQuestion]                 = useState("")
  const [rfiReceivedFrom, setRfiReceivedFrom]         = useState("")
  const [rfiReceivedFromCustom, setRfiReceivedFromCustom] = useState("")
  const [rfiSpecSection, setRfiSpecSection]           = useState("")
  const [rfiLocation, setRfiLocation]                 = useState("")
  const [rfiScheduleImpact, setRfiScheduleImpact]     = useState("TBD")
  const [rfiCostImpact, setRfiCostImpact]             = useState("TBD")
  const [rfiFile, setRfiFile]                         = useState<File | null>(null)
  const [rfiGeneratingPdf, setRfiGeneratingPdf]       = useState(false)

  // Change Orders
  const [changeOrders, setChangeOrders]               = useState<ChangeOrder[]>([])
  const [coLoading, setCoLoading]                     = useState(false)
  const [showNewCo, setShowNewCo]                     = useState(false)
  const [viewCo, setViewCo]                           = useState<ChangeOrder | null>(null)
  const [coProjectId, setCoProjectId]                 = useState("")
  const [coDate, setCoDate]                           = useState(() => new Date().toISOString().slice(0, 10))
  const [coProposal, setCoProposal]                   = useState("")
  const [coQualifications, setCoQualifications]       = useState("")
  const [coPricingSum, setCoPricingSum]               = useState("")
  const [coScheduleImpact, setCoScheduleImpact]       = useState("TBD")
  const [coScheduleDays, setCoScheduleDays]           = useState("")
  const [coSubmittedBy, setCoSubmittedBy]             = useState("")
  const [coAssignedTo, setCoAssignedTo]               = useState("")
  const [coStatus, setCoStatus]                       = useState("Draft")
  const [coFile, setCoFile]                           = useState<File | null>(null)
  const [coSaving, setCoSaving]                       = useState(false)
  const [coRespondSaving, setCoRespondSaving]         = useState(false)
  const [coResponseStatus, setCoResponseStatus]       = useState("")
  const [coGeneratingPdf, setCoGeneratingPdf]         = useState(false)
  const [punchGeneratingPdf, setPunchGeneratingPdf]   = useState(false)
  const [dailyGeneratingPdf, setDailyGeneratingPdf]   = useState(false)
  const [drawingGeneratingPdf, setDrawingGeneratingPdf] = useState(false)

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
  const punchFileRef  = useRef<HTMLInputElement>(null)
  const [punchSaving, setPunchSaving]             = useState(false)
  const [punchEditStatus, setPunchEditStatus]     = useState("")
  const [punchEditNotes, setPunchEditNotes]       = useState("")
  const [punchEditSaving, setPunchEditSaving]     = useState(false)
  const [punchPhotos, setPunchPhotos]             = useState<{id: string; url: string; file_name: string}[]>([])
  const [punchPhotosLoading, setPunchPhotosLoading] = useState(false)
  const [punchPhotoUploading, setPunchPhotoUploading] = useState(false)
  const punchPhotoRef = useRef<HTMLInputElement>(null)

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
  const dailyFileRef  = useRef<HTMLInputElement>(null)
  const [dailySaving, setDailySaving]                 = useState(false)
  const [dailySaveError, setDailySaveError]           = useState("")
  const [dailyEditing, setDailyEditing]               = useState(false)
  const [dailyEditSaving, setDailyEditSaving]         = useState(false)
  const [dailyPhotos, setDailyPhotos]                 = useState<{id: string; url: string; file_name: string}[]>([])
  const [dailyPhotosLoading, setDailyPhotosLoading]   = useState(false)
  const [dailyPhotoUploading, setDailyPhotoUploading] = useState(false)
  const dailyPhotoRef = useRef<HTMLInputElement>(null)

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
  const dwgFileRef    = useRef<HTMLInputElement>(null)
  const [dwgSaving, setDwgSaving]                     = useState(false)

  // Closeout
  const [closeoutItems, setCloseoutItems]         = useState<CloseoutItem[]>([])
  const [closeoutPunch, setCloseoutPunch]         = useState<PunchItem[]>([])
  const [closeoutSubmittals, setCloseoutSubmittals] = useState<SubmittalRecord[]>([])
  const [closeoutRFIs, setCloseoutRFIs]           = useState<RFI[]>([])
  const [closeoutCOs, setCloseoutCOs]             = useState<ChangeOrder[]>([])
  const [closeoutDrawings, setCloseoutDrawings]   = useState<DrawingRecord[]>([])
  // Full sets (all records, not just pending)
  const [closeoutAllSubmittals, setCloseoutAllSubmittals] = useState<SubmittalRecord[]>([])
  const [closeoutAllRFIs, setCloseoutAllRFIs]     = useState<RFI[]>([])
  const [closeoutAllCOs, setCloseoutAllCOs]       = useState<ChangeOrder[]>([])
  const [closeoutAllDrawings, setCloseoutAllDrawings] = useState<DrawingRecord[]>([])
  const [closeoutAllPunch, setCloseoutAllPunch]   = useState<PunchItem[]>([])
  const [closeoutTeam, setCloseoutTeam]           = useState<{id:string;name:string;title:string|null}[]>([])
  const [closeoutLoading, setCloseoutLoading]     = useState(false)
  const [closeoutIniting, setCloseoutIniting]     = useState(false)
  const [closeoutGenerating, setCloseoutGenerating] = useState(false)
  const [closeoutEditId, setCloseoutEditId]       = useState<string | null>(null)
  const [closeoutEditTitle, setCloseoutEditTitle] = useState("")
  const [closeoutEditAssigned, setCloseoutEditAssigned] = useState("")
  const [closeoutEditDue, setCloseoutEditDue]     = useState("")
  const [closeoutEditNotes, setCloseoutEditNotes] = useState("")
  const [showNewCloseout, setShowNewCloseout]     = useState(false)
  const [newCloseoutCategory, setNewCloseoutCategory] = useState("documents")
  const [newCloseoutTitle, setNewCloseoutTitle]   = useState("")
  const [newCloseoutAssigned, setNewCloseoutAssigned] = useState("")
  const [newCloseoutDue, setNewCloseoutDue]       = useState("")
  const [newCloseoutFolder, setNewCloseoutFolder] = useState("")
  const [showAddFolder, setShowAddFolder]         = useState(false)
  const [newFolderName, setNewFolderName]         = useState("")
  const [newFolderType, setNewFolderType]         = useState<"subcontractors"|"suppliers">("subcontractors")
  const closeoutFileRef = useRef<HTMLInputElement>(null)
  const [closeoutUploadingId, setCloseoutUploadingId] = useState<string | null>(null)

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

  function handleFileOpen(file: SubmittalFile, divNum: string, divName: string, secCode: string, secName: string, existingProjectId?: string | null) {
    setOpenFileCtx({ file, divNum, divName, secCode, secName })
    if (existingProjectId) {
      setModalProjectId(existingProjectId)
      setFileModalStep("coversheet")
    } else {
      setFileModalStep("project")
      setModalProjectId("")
    }
    setCoverForm(null)
  }

  function closeFileModal() { setOpenFileCtx(null); setModalProjectId(""); setCoverForm(null); setCoverEditId(null) }

  function openEditCoverSheet(s: SubmittalRecord) {
    const proj = appProjects.find(p => p.id === s.project_id)
    const today = new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" })
    const myName = teamMembers.find(m => m.email === userEmail)?.name ?? userEmail ?? ""
    setOpenFileCtx({
      file: { id: s.id, file_name: s.file_name, file_url: "", mime_type: s.mime_type, file_size: s.file_size, created_at: s.created_at },
      divNum: s.csi_division ?? "", divName: s.division_name ?? "",
      secCode: s.csi_section ?? "", secName: s.section_name ?? "",
    })
    setModalProjectId(s.project_id ?? "")
    setCoverEditId(s.id)
    setCoverForm({
      projectName: proj?.name ?? "", projectNumber: proj?.number ?? "",
      projectLocation: proj?.location ?? "", gcName: proj?.gc_name ?? "",
      architect: proj?.architect ?? "", specSectionNo: s.csi_section ?? "",
      specSectionTitle: s.section_name ?? "",
      description: s.file_name.replace(/\.[^.]+$/, ""),
      dateSubmitted: today, submittalNo: "1",
      reviewedBy: "", certifiedBy: "", notes: "",
      sendToType: (s.send_to_type as "cm"|"subcontractor"|"supplier"|"") ?? "",
      sendToCompany: s.send_to_company ?? "",
      sendToContact: s.send_to_contact ?? "",
      sendToEmail: s.send_to_email ?? "",
      sendToPhone: s.send_to_phone ?? "",
      sendToAddress: s.send_to_address ?? "",
      transmittedBy: s.transmitted_by ?? myName,
      transmittedByCompany: s.transmitted_by_company ?? proj?.gc_name ?? "",
    })
    setCoverSelectedId(s.send_to_type ? "__manual__" : "")
    setFileModalStep("form")
    if (s.project_id) loadCoverContacts(s.project_id)
  }

  function openFileDirectly() {
    if (!openFileCtx) return
    window.open(openFileCtx.file.mime_type === "application/pdf" ? `/api/download/${openFileCtx.file.id}` : openFileCtx.file.file_url, "_blank")
    closeFileModal()
  }

  async function loadCoverContacts(projectId: string) {
    if (!projectId) { setCoverProjectSubs([]); setCoverProjectSuppliers([]); setCoverProjectCms([]); return }
    const [subsRes, supplRes, cmsRes] = await Promise.all([
      fetch(`/api/projects/${projectId}/subcontractors`),
      fetch(`/api/projects/${projectId}/suppliers`),
      fetch(`/api/projects/${projectId}/cms`),
    ])
    setCoverProjectSubs(subsRes.ok ? await subsRes.json() : [])
    setCoverProjectSuppliers(supplRes.ok ? await supplRes.json() : [])
    setCoverProjectCms(cmsRes.ok ? await cmsRes.json() : [])
  }

  function initCoverForm() {
    if (!openFileCtx) return
    const proj = appProjects.find(p => p.id === modalProjectId)
    const today = new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" })
    const myName = teamMembers.find(m => m.email === userEmail)?.name ?? userEmail ?? ""
    setCoverSelectedId("")
    setCoverForm({ projectName: proj?.name ?? "", projectNumber: proj?.number ?? "", projectLocation: proj?.location ?? "", gcName: proj?.gc_name ?? "", architect: proj?.architect ?? "", specSectionNo: openFileCtx.secCode, specSectionTitle: openFileCtx.secName, description: openFileCtx.file.file_name.replace(/\.[^.]+$/, ""), dateSubmitted: today, submittalNo: "1", reviewedBy: "", certifiedBy: "", notes: "", sendToType: "", sendToCompany: "", sendToContact: "", sendToEmail: "", sendToPhone: "", sendToAddress: "", transmittedBy: myName, transmittedByCompany: proj?.gc_name ?? "" })
    setFileModalStep("form")
    if (modalProjectId) loadCoverContacts(modalProjectId)
  }

  function openTransmittal(s: SubmittalRecord) {
    setOpenFileCtx({
      file: { id: s.id, file_name: s.file_name, file_url: "", mime_type: s.mime_type, file_size: s.file_size, created_at: s.created_at },
      divNum: s.csi_division ?? "", divName: s.division_name ?? "",
      secCode: s.csi_section ?? "", secName: s.section_name ?? "",
    })
    const pid = s.project_id ?? ""
    setModalProjectId(pid)
    setCoverEditId(s.id)
    const proj = appProjects.find(p => p.id === pid)
    const today = new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" })
    const myName = teamMembers.find(m => m.email === userEmail)?.name ?? userEmail ?? ""
    setCoverForm({
      projectName: proj?.name ?? "", projectNumber: proj?.number ?? "",
      projectLocation: proj?.location ?? "", gcName: proj?.gc_name ?? "",
      architect: proj?.architect ?? "", specSectionNo: s.csi_section ?? "",
      specSectionTitle: s.section_name ?? "",
      description: s.file_name.replace(/\.[^.]+$/, ""),
      dateSubmitted: today, submittalNo: "1",
      reviewedBy: "", certifiedBy: "", notes: "",
      sendToType: (s.send_to_type as "cm"|"subcontractor"|"supplier"|"") ?? "",
      sendToCompany: s.send_to_company ?? "",
      sendToContact: s.send_to_contact ?? "",
      sendToEmail: s.send_to_email ?? "",
      sendToPhone: s.send_to_phone ?? "",
      sendToAddress: s.send_to_address ?? "",
      transmittedBy: s.transmitted_by ?? myName,
      transmittedByCompany: s.transmitted_by_company ?? proj?.gc_name ?? "",
    })
    setCoverSelectedId(s.send_to_type ? "__manual__" : "")
    setFileModalStep("form")
    if (pid) loadCoverContacts(pid)
  }

  async function handleGenerateCover(e: React.FormEvent) {
    e.preventDefault()
    if (!coverForm || !openFileCtx) return
    setGeneratingCover(true)
    try {
      const res = await fetch("/api/generate-cover", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ submittalId: openFileCtx.file.id, projectId: modalProjectId || null, existingId: coverEditId || null, ...coverForm }) })
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}))
        throw new Error(errJson.error ?? `Server error ${res.status}`)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = openFileCtx.file.file_name.replace(/\.[^.]+$/, "") + "_transmittal.pdf"
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      const pid = modalProjectId
      closeFileModal()
      if (pid) loadSubmittals(pid)
    } catch (err) {
      alert("Failed to generate transmittal: " + (err instanceof Error ? err.message : "Unknown error"))
    } finally { setGeneratingCover(false) }
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

  function loadRfis(pid = globalProjectId) {
    setRfisLoading(true)
    const qs = pid ? `?project_id=${encodeURIComponent(pid)}` : ""
    fetch(`/api/rfis${qs}`)
      .then(r => r.json())
      .then(d => setRfis(d.rfis ?? []))
      .catch(() => setRfis([]))
      .finally(() => setRfisLoading(false))
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (activeModule === "rfis") loadRfis() }, [activeModule, globalProjectId])

  function loadChangeOrders(pid = globalProjectId) {
    setCoLoading(true)
    const qs = pid ? `?project_id=${encodeURIComponent(pid)}` : ""
    fetch(`/api/change-orders${qs}`)
      .then(r => r.json())
      .then(d => setChangeOrders(d.changeOrders ?? []))
      .catch(() => setChangeOrders([]))
      .finally(() => setCoLoading(false))
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (activeModule === "changeorders") loadChangeOrders() }, [activeModule, globalProjectId])

  function loadPunch(pid = globalProjectId) {
    setPunchLoading(true)
    const qs = pid ? `?project_id=${encodeURIComponent(pid)}` : ""
    fetch(`/api/punch${qs}`)
      .then(r => r.json())
      .then(d => setPunchItems(d.items ?? []))
      .catch(() => setPunchItems([]))
      .finally(() => setPunchLoading(false))
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (activeModule === "punch") loadPunch() }, [activeModule, globalProjectId])

  function loadDaily(pid = globalProjectId) {
    setDailyLoading(true)
    const qs = pid ? `?project_id=${encodeURIComponent(pid)}` : ""
    fetch(`/api/daily-reports${qs}`)
      .then(r => r.json())
      .then(d => setDailyReports(d.reports ?? []))
      .catch(() => setDailyReports([]))
      .finally(() => setDailyLoading(false))
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (activeModule === "daily") loadDaily() }, [activeModule, globalProjectId])

  function loadDrawings(pid = globalProjectId) {
    setDrawingsLoading(true)
    const qs = pid ? `?project_id=${encodeURIComponent(pid)}` : ""
    fetch(`/api/drawings${qs}`)
      .then(r => r.json())
      .then(d => setDrawings(d.drawings ?? []))
      .catch(() => setDrawings([]))
      .finally(() => setDrawingsLoading(false))
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (activeModule === "drawings") loadDrawings() }, [activeModule, globalProjectId])

  function loadCloseout() {
    if (!globalProjectId) {
      setCloseoutItems([]); setCloseoutPunch([]); setCloseoutSubmittals([])
      setCloseoutRFIs([]); setCloseoutCOs([]); setCloseoutDrawings([])
      setCloseoutAllSubmittals([]); setCloseoutAllRFIs([]); setCloseoutAllCOs([])
      setCloseoutAllDrawings([]); setCloseoutAllPunch([]); setCloseoutTeam([])
      return
    }
    setCloseoutLoading(true)
    fetch(`/api/closeout?project_id=${encodeURIComponent(globalProjectId)}`)
      .then(r => r.json())
      .then(d => {
        setCloseoutItems(d.items ?? [])
        setCloseoutAllPunch(d.all_punch ?? [])
        setCloseoutAllSubmittals(d.all_submittals ?? [])
        setCloseoutAllRFIs(d.all_rfis ?? [])
        setCloseoutAllCOs(d.all_cos ?? [])
        setCloseoutAllDrawings(d.all_drawings ?? [])
        setCloseoutSubmittals(d.pending_submittals ?? [])
        setCloseoutRFIs(d.pending_rfis ?? [])
        setCloseoutCOs(d.pending_cos ?? [])
        setCloseoutDrawings(d.pending_drawings ?? [])
        setCloseoutPunch(d.all_punch?.filter((p: PunchItem) => p.status !== "Completed") ?? [])
        setCloseoutTeam(d.team_members ?? [])
      })
      .catch(() => {})
      .finally(() => setCloseoutLoading(false))
  }

  async function updateCloseoutItem(id: string, updates: Record<string, unknown>) {
    await fetch(`/api/closeout/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(updates) })
    loadCloseout()
  }

  async function deleteCloseoutItem(id: string) {
    await fetch(`/api/closeout/${id}`, { method: "DELETE" })
    loadCloseout()
  }

  async function addCloseoutFolder() {
    if (!newFolderName.trim() || !globalProjectId) return
    const folderItems = newFolderType === "subcontractors"
      ? [
          { title: "Workmanship Warranty",       item_type: "workmanship_warranty" },
          { title: "Conditional Lien Waiver",    item_type: "lien_waiver_conditional" },
          { title: "Unconditional Lien Waiver",  item_type: "lien_waiver_unconditional" },
          { title: "Final Pay Application",      item_type: "final_pay_app" },
          { title: "Insurance Certificate",      item_type: "insurance_cert" },
          { title: "Subcontractor Contact Sheet", item_type: "contact_sheet" },
        ]
      : [
          { title: "Material Warranty",    item_type: "material_warranty" },
          { title: "O&M Manual",           item_type: "om_manual" },
          { title: "Product Data Sheets",  item_type: "product_data_sheets" },
          { title: "Supplier Contact Sheet", item_type: "contact_sheet" },
        ]
    const maxOrder = closeoutItems.filter(i => i.category === newFolderType).reduce((m, i) => Math.max(m, i.sort_order), 0)
    let idx = maxOrder + 1
    for (const item of folderItems) {
      await fetch("/api/closeout", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: globalProjectId, category: newFolderType, item_type: item.item_type, title: item.title, folder_name: newFolderName.trim(), sort_order: idx++, status: "incomplete" }),
      })
    }
    setShowAddFolder(false); setNewFolderName(""); setNewFolderType("subcontractors")
    loadCloseout()
  }

  async function addCloseoutItem() {
    if (!newCloseoutTitle.trim() || !globalProjectId) return
    const maxOrder = closeoutItems.filter(i => i.category === newCloseoutCategory && (!newCloseoutFolder || i.folder_name === newCloseoutFolder)).reduce((m, i) => Math.max(m, i.sort_order), 0)
    await fetch("/api/closeout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: globalProjectId,
        category: newCloseoutCategory,
        folder_name: newCloseoutFolder || null,
        item_type: "custom",
        title: newCloseoutTitle.trim(),
        assigned_to: newCloseoutAssigned || null,
        due_date: newCloseoutDue || null,
        sort_order: maxOrder + 10,
      }),
    })
    setShowNewCloseout(false)
    setNewCloseoutTitle("")
    setNewCloseoutAssigned("")
    setNewCloseoutDue("")
    setNewCloseoutFolder("")
    loadCloseout()
  }

  async function uploadCloseoutFile(itemId: string, file: File) {
    setCloseoutUploadingId(itemId)
    const fd = new FormData()
    fd.append("file", file)
    fd.append("item_id", itemId)
    const res = await fetch("/api/closeout/upload", { method: "POST", body: fd })
    const d = await res.json()
    if (d.file_url) {
      await fetch(`/api/closeout/${itemId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file_url: d.file_url, file_name: d.file_name }) })
      loadCloseout()
    }
    setCloseoutUploadingId(null)
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (activeModule === "closeout") loadCloseout() }, [activeModule, globalProjectId])

  useEffect(() => {
    if (viewPunch) { setPunchPhotos([]); loadPunchPhotos(viewPunch.id) }
  }, [viewPunch?.id])

  useEffect(() => {
    if (viewDaily) { setDailyPhotos([]); loadDailyPhotos(viewDaily.id) }
  }, [viewDaily?.id])

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
      const dwgFd = new FormData()
      const dwgFields: Record<string, string> = { drawing_number: dwgNumber, sheet_title: dwgTitle, discipline: dwgDiscipline, revision: dwgRevision, revision_date: dwgRevDate, status: dwgStatus, scale: dwgScale, notes: dwgNotes, project_id: dwgProjectId }
      Object.entries(dwgFields).forEach(([k, v]) => { if (v) dwgFd.append(k, v) })
      if (dwgFileRef.current?.files?.[0]) dwgFd.append("file", dwgFileRef.current.files[0])
      const res = await fetch("/api/drawings", { method: "POST", body: dwgFd })
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
      // Optimistically remove from all local caches
      setLogSubmittals(prev => prev.filter(x => x.id !== s.id))
      setSectionFiles(prev => {
        const next = { ...prev }
        // Clear the section cache entirely so next toggle re-fetches fresh from DB
        if (s.csi_section) delete next[s.csi_section]
        return next
      })
      loadTree()
      loadSubmittals()
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
      const receivedFrom = rfiReceivedFrom === "__other__" ? rfiReceivedFromCustom : rfiReceivedFrom
      const fd = new FormData()
      fd.append("subject", rfiSubject)
      fd.append("question", rfiQuestion)
      fd.append("received_from", receivedFrom)
      fd.append("specification_section", rfiSpecSection)
      fd.append("location", rfiLocation)
      fd.append("schedule_impact", rfiScheduleImpact)
      fd.append("cost_impact", rfiCostImpact)
      fd.append("assigned_to", rfiAssignedTo)
      fd.append("date_issued", rfiDateIssued)
      fd.append("due_date", rfiDueDate)
      fd.append("project_id", rfiProjectId)
      if (rfiFile) fd.append("file", rfiFile)
      const res = await fetch("/api/rfis", { method: "POST", body: fd })
      if (res.ok) {
        setShowNewRfi(false)
        setRfiSubject(""); setRfiQuestion(""); setRfiReceivedFrom(""); setRfiReceivedFromCustom("")
        setRfiSpecSection(""); setRfiLocation(""); setRfiScheduleImpact("TBD"); setRfiCostImpact("TBD")
        setRfiAssignedTo(""); setRfiDueDate(""); setRfiProjectId(""); setRfiFile(null)
        setRfiDateIssued(new Date().toISOString().slice(0, 10))
        loadRfis()
      }
    } finally { setRfiSaving(false) }
  }

  async function createCo(e: React.FormEvent) {
    e.preventDefault()
    setCoSaving(true)
    try {
      const fd = new FormData()
      fd.append("project_id", coProjectId)
      fd.append("date", coDate)
      fd.append("proposal", coProposal)
      fd.append("qualifications", coQualifications)
      fd.append("pricing_sum", coPricingSum)
      fd.append("schedule_impact", coScheduleImpact)
      fd.append("schedule_impact_days", coScheduleDays)
      fd.append("submitted_by", coSubmittedBy)
      fd.append("assigned_to", coAssignedTo)
      fd.append("status", coStatus)
      if (coFile) fd.append("file", coFile)
      const res = await fetch("/api/change-orders", { method: "POST", body: fd })
      if (res.ok) {
        setShowNewCo(false)
        setCoProjectId(""); setCoProposal(""); setCoQualifications(""); setCoPricingSum("")
        setCoScheduleImpact("TBD"); setCoScheduleDays(""); setCoSubmittedBy(""); setCoAssignedTo("")
        setCoStatus("Draft"); setCoFile(null)
        setCoDate(new Date().toISOString().slice(0, 10))
        loadChangeOrders()
      }
    } finally { setCoSaving(false) }
  }

  async function deleteRfi(rfiId: string) {
    if (!confirm("Delete this RFI? This cannot be undone.")) return
    await fetch(`/api/rfis/${rfiId}`, { method: "DELETE" })
    setViewRfi(null)
    loadRfis()
  }

  async function generateRfiPdf(rfiId: string) {
    setRfiGeneratingPdf(true)
    try {
      const res  = await fetch(`/api/rfis/${rfiId}/pdf`, { method: "POST" })
      const data = await res.json()
      if (res.ok && data.url) {
        window.open(data.url, "_blank")
        loadRfis()
      }
    } finally { setRfiGeneratingPdf(false) }
  }

  async function deleteCo(coId: string) {
    if (!confirm("Delete this change order? This cannot be undone.")) return
    await fetch(`/api/change-orders/${coId}`, { method: "DELETE" })
    setViewCo(null)
    loadChangeOrders()
  }

  async function deletePunchItem(itemId: string) {
    if (!confirm("Delete this punch item? This cannot be undone.")) return
    await fetch(`/api/punch/${itemId}`, { method: "DELETE" })
    setViewPunch(null)
    loadPunch()
  }

  async function deleteDaily(reportId: string) {
    if (!confirm("Delete this daily report? This cannot be undone.")) return
    await fetch(`/api/daily-reports/${reportId}`, { method: "DELETE" })
    setViewDaily(null)
    loadDaily()
  }

  async function deleteDrawing(drawingId: string) {
    if (!confirm("Delete this drawing and all its revisions? This cannot be undone.")) return
    await fetch(`/api/drawings/${drawingId}`, { method: "DELETE" })
    loadDrawings()
  }

  async function generateCoPdf(coId: string) {
    setCoGeneratingPdf(true)
    try {
      const res  = await fetch(`/api/change-orders/${coId}/pdf`, { method: "POST" })
      const data = await res.json()
      if (res.ok && data.url) {
        window.open(data.url, "_blank")
        loadChangeOrders()
      }
    } finally { setCoGeneratingPdf(false) }
  }

  async function generatePunchPdf(itemId: string) {
    setPunchGeneratingPdf(true)
    try {
      const res = await fetch(`/api/punch/${itemId}/pdf`, { method: "POST" })
      const data = await res.json()
      if (res.ok && data.url) { window.open(data.url, "_blank"); loadPunch() }
    } finally { setPunchGeneratingPdf(false) }
  }

  async function generateDailyPdf(reportId: string) {
    setDailyGeneratingPdf(true)
    try {
      const res = await fetch(`/api/daily-reports/${reportId}/pdf`, { method: "POST" })
      const data = await res.json()
      if (res.ok && data.url) { window.open(data.url, "_blank"); loadDaily() }
    } finally { setDailyGeneratingPdf(false) }
  }

  async function generateDrawingPdf(drawingId: string) {
    setDrawingGeneratingPdf(true)
    try {
      const res = await fetch(`/api/drawings/${drawingId}/pdf`, { method: "POST" })
      const data = await res.json()
      if (res.ok && data.url) { window.open(data.url, "_blank"); loadDrawings() }
    } finally { setDrawingGeneratingPdf(false) }
  }

  async function loadPunchPhotos(id: string) {
    setPunchPhotosLoading(true)
    const res = await fetch(`/api/photos?entity_type=punch_item&entity_id=${id}`)
    if (res.ok) setPunchPhotos(await res.json())
    setPunchPhotosLoading(false)
  }

  async function uploadPunchPhoto(file: File) {
    if (!viewPunch) return
    setPunchPhotoUploading(true)
    const fd = new FormData()
    fd.append("entity_type", "punch_item")
    fd.append("entity_id", viewPunch.id)
    fd.append("file", file)
    const res = await fetch("/api/photos", { method: "POST", body: fd })
    if (res.ok) await loadPunchPhotos(viewPunch.id)
    setPunchPhotoUploading(false)
  }

  async function deletePunchPhoto(photoId: string) {
    await fetch(`/api/photos?id=${photoId}`, { method: "DELETE" })
    if (viewPunch) await loadPunchPhotos(viewPunch.id)
  }

  async function loadDailyPhotos(id: string) {
    setDailyPhotosLoading(true)
    const res = await fetch(`/api/photos?entity_type=daily_report&entity_id=${id}`)
    if (res.ok) setDailyPhotos(await res.json())
    setDailyPhotosLoading(false)
  }

  async function uploadDailyPhoto(file: File) {
    if (!viewDaily) return
    setDailyPhotoUploading(true)
    const fd = new FormData()
    fd.append("entity_type", "daily_report")
    fd.append("entity_id", viewDaily.id)
    fd.append("file", file)
    const res = await fetch("/api/photos", { method: "POST", body: fd })
    if (res.ok) await loadDailyPhotos(viewDaily.id)
    setDailyPhotoUploading(false)
  }

  async function deleteDailyPhoto(photoId: string) {
    await fetch(`/api/photos?id=${photoId}`, { method: "DELETE" })
    if (viewDaily) await loadDailyPhotos(viewDaily.id)
  }

  async function saveCoStatus() {
    if (!viewCo) return
    setCoRespondSaving(true)
    try {
      const res = await fetch(`/api/change-orders/${viewCo.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: coResponseStatus, assigned_to: coAssignedTo }),
      })
      if (res.ok) { setViewCo(null); loadChangeOrders() }
    } finally { setCoRespondSaving(false) }
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
    setDailySaveError("")
    try {
      const dailyFd = new FormData()
      const dailyFields: Record<string, string> = { report_date: dailyDate, project_id: dailyProjectId, prepared_by: dailyPreparedBy, weather_conditions: dailyWeather, temperature: dailyTemp, manpower_count: dailyManpower, work_performed: dailyWorkPerformed, equipment: dailyEquipment, materials_delivered: dailyMaterials, visitors: dailyVisitors, issues_delays: dailyIssues, safety_notes: dailySafety }
      Object.entries(dailyFields).forEach(([k, v]) => { if (v) dailyFd.append(k, v) })
      if (dailyFileRef.current?.files?.[0]) dailyFd.append("file", dailyFileRef.current.files[0])
      const res = await fetch("/api/daily-reports", { method: "POST", body: dailyFd })
      if (res.ok) {
        setShowNewDaily(false)
        setDailyDate(new Date().toISOString().slice(0, 10)); setDailyProjectId(""); setDailyPreparedBy(""); setDailyWeather(""); setDailyTemp(""); setDailyManpower(""); setDailyWorkPerformed(""); setDailyEquipment(""); setDailyMaterials(""); setDailyVisitors(""); setDailyIssues(""); setDailySafety("")
        loadDaily()
      } else {
        const data = await res.json().catch(() => ({}))
        setDailySaveError(data.error ?? "Failed to create report. Please try again.")
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
      const punchFd = new FormData()
      const punchFields: Record<string, string> = { description: punchDesc, location: punchLocation, assigned_to: punchAssignedTo, due_date: punchDueDate, priority: punchPriority, project_id: punchProjectId, notes: punchNotes }
      Object.entries(punchFields).forEach(([k, v]) => { if (v) punchFd.append(k, v) })
      if (punchFileRef.current?.files?.[0]) punchFd.append("file", punchFileRef.current.files[0])
      const res = await fetch("/api/punch", { method: "POST", body: punchFd })
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
      nameMatl: "", nameMfr: "", nameDims: "", customName: file.name.replace(/\.[^.]+$/, ""), expanded: false,
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
          const nameMatl = data.material_name ?? ""
          const nameMfr  = data.manufacturer  ?? ""
          const nameDims = data.dimensions     ?? ""
          const composed = [nameMatl, nameMfr, nameDims].filter(Boolean).join(" — ")
          updateBatchItem(item.id, {
            status: "ready",
            divNum: data.division_num, divName: data.division_name,
            secCode: data.section_code, secName: data.section_name,
            nameMatl, nameMfr, nameDims,
            customName: composed || item.file.name.replace(/\.[^.]+$/, ""),
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
        if (item.nameMatl)    fd.append("material_name", item.nameMatl)
        if (item.nameMfr)     fd.append("manufacturer",  item.nameMfr)
        if (item.nameDims)    fd.append("dimensions",    item.nameDims)
        if (item.customName)  fd.append("display_name",  item.customName)
        if (globalProjectId)  fd.append("project_id",   globalProjectId)
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
    if (globalProjectId)                 fd.append("project_id",   globalProjectId)
    if (aiResult?.confidence != null)    fd.append("ai_confidence", String(aiResult.confidence))
    if (aiResult?.reasoning)             fd.append("ai_reasoning",  aiResult.reasoning)

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
      closeModal()

      // If uploaded directly to a project, immediately prompt for cover sheet
      if (globalProjectId && data.record) {
        const rec = data.record
        const proj = appProjects.find(p => p.id === globalProjectId)
        const today = new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" })
        setOpenFileCtx({ file: { id: rec.id, file_name: rec.file_name, file_url: "", mime_type: rec.mime_type, file_size: rec.file_size, created_at: rec.created_at }, divNum: rec.csi_division ?? uploadDiv, divName: rec.division_name ?? uploadDivName, secCode: rec.csi_section ?? uploadSec, secName: rec.section_name ?? uploadSecName })
        setModalProjectId(globalProjectId)
        setCoverEditId(rec.id)
        const myName = teamMembers.find(m => m.email === userEmail)?.name ?? userEmail ?? ""
        setCoverForm({ projectName: proj?.name ?? "", projectNumber: proj?.number ?? "", projectLocation: proj?.location ?? "", gcName: proj?.gc_name ?? "", architect: proj?.architect ?? "", specSectionNo: rec.csi_section ?? uploadSec, specSectionTitle: rec.section_name ?? uploadSecName, description: rec.file_name.replace(/\.[^.]+$/, ""), dateSubmitted: today, submittalNo: "1", reviewedBy: "", certifiedBy: "", notes: "", sendToType: "", sendToCompany: "", sendToContact: "", sendToEmail: "", sendToPhone: "", sendToAddress: "", transmittedBy: myName, transmittedByCompany: proj?.gc_name ?? "" })
        loadCoverContacts(globalProjectId)
        setFileModalStep("form")
      } else {
        loadSubmittals()
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed")
    } finally {
      setUploading(false)
    }
  }

  const isSearchMode = searchResults !== null || searching

  const inputCls = "w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[14px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 focus:border-[#7B9BB5]/50 placeholder:text-[#64748B] transition-all"
  const labelCls = "block text-[11px] font-semibold text-[#64748B] uppercase tracking-[0.08em] mb-1.5"

  return (
    <div className="flex min-h-screen bg-[#F4F5F7] overflow-x-hidden w-full">

      {/* ── Sidebar ───────────────────────────────────────────────────────── */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-30" onClick={() => { setSidebarOpen(false); sessionStorage.setItem("sidebarOpen", "false") }} />
      )}
      <aside className={`fixed left-0 top-0 h-screen z-40 bg-[#0A1628] border-r border-white/10 hidden sm:flex flex-col overflow-hidden transition-[width] duration-200 ease-in-out ${sidebarOpen ? "w-80" : "w-12"}`}>

        {/* Rail header — always visible */}
        <div className="flex-shrink-0 flex items-center justify-between h-12 px-3 border-b border-white/10">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-6 h-6 rounded-md bg-[#7B9BB5]/10 border border-[#7B9BB5]/30 flex items-center justify-center flex-shrink-0">
              <svg className="w-3.5 h-3.5 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            {sidebarOpen && <span className="text-[14px] font-bold text-[#F8FAFC] tracking-tight truncate">TuttoHQ</span>}
          </div>
          <button
            onClick={() => { const next = !sidebarOpen; setSidebarOpen(next); sessionStorage.setItem("sidebarOpen", String(next)) }}
            className="w-5 h-5 flex items-center justify-center text-[#94A3B8] hover:text-[#94A3B8] transition-colors flex-shrink-0 rounded hover:bg-white/[0.08]"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={sidebarOpen ? "M15 19l-7-7 7-7" : "M9 5l7 7-7 7"} />
            </svg>
          </button>
        </div>

        {/* Expanded sidebar body */}
        {sidebarOpen && <><p className="text-[11px] text-[#94A3B8] px-5 pt-2 pb-1">Construction Documents</p>

        {/* Search */}
        <div className="flex-shrink-0 px-3 pb-2">
          <form onSubmit={handleSearch}>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 flex items-center pl-2.5 pointer-events-none text-[#94A3B8]">
                <SearchIcon />
              </div>
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => e.key === "Escape" && clearSearch()}
                placeholder="Search submittals…"
                className="w-full h-8 pl-8 pr-6 rounded-md text-[13px] bg-white/[0.08] border border-white/20 text-[#F8FAFC] placeholder-[#94A3B8] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 focus:border-[#7B9BB5]/50 transition-all"
              />
              {query && (
                <button
                  type="button"
                  onClick={clearSearch}
                  className="absolute inset-y-0 right-0 flex items-center pr-2 text-[#94A3B8] hover:text-[#94A3B8] transition-colors"
                >
                  <XIcon />
                </button>
              )}
            </div>
          </form>
        </div>

        <div className="flex-shrink-0 border-t border-white/10 mx-3 mt-0.5 mb-1.5" />

        {/* Section label + upload button */}
        <div className="flex-shrink-0 px-4 pb-1">
          {isSearchMode && searchAiSummary && !searching && (
            <p className="text-[11px] text-[#7B9BB5] mb-1 flex items-center gap-1">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm1 14.93V17a1 1 0 0 1-2 0v-.07A8 8 0 0 1 4.07 9H5a1 1 0 0 1 0 2 6 6 0 0 0 6 6zm-1-6.93A2 2 0 1 1 14 12a2 2 0 0 1-2-1.93z"/></svg>
              AI: {searchAiSummary}
            </p>
          )}
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-bold text-[#94A3B8] uppercase tracking-widest">
            {isSearchMode
              ? (searching ? "Searching…" : `${searchResults?.length ?? 0} results`)
              : "Divisions"}
          </span>
          <div className="flex items-center gap-2">
            {isSearchMode && !searching && (
              <button
                onClick={clearSearch}
                className="text-[11px] text-[#94A3B8] hover:text-[#F8FAFC] transition-colors"
              >
                Clear
              </button>
            )}
            {!isSearchMode && (
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setShowManage(true)}
                  title="Manage divisions"
                  className="text-[#94A3B8] hover:text-[#94A3B8] transition-colors"
                >
                  <SlidersIcon />
                </button>
                <button
                  onClick={() => { setShowBatch(true); setBatchPhase("select"); setBatchItems([]) }}
                  title="Batch upload"
                  className="text-[#94A3B8] hover:text-[#94A3B8] transition-colors"
                >
                  <LayersIcon />
                </button>
                <button
                  onClick={() => setShowUpload(true)}
                  title="Upload submittal"
                  className="text-[#94A3B8] hover:text-[#94A3B8] transition-colors"
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
            <div className="flex items-center gap-2 px-3 py-2 text-[13px] text-[#94A3B8]">
              <SpinnerIcon /> Loading…
            </div>
          )}

          {treeError && !isSearchMode && (
            <p className="px-3 py-1 text-[12px] text-red-400">{treeError}</p>
          )}

          {searching && (
            <div className="flex items-center gap-2 px-3 py-2 text-[13px] text-[#94A3B8]">
              <SpinnerIcon /> Searching…
            </div>
          )}

          {/* Search results */}
          {!searching && isSearchMode && (
            <>
              {searchError && <p className="px-3 py-1 text-[12px] text-red-400">{searchError}</p>}
              {searchResults?.length === 0 && (
                <p className="px-3 py-2 text-[13px] text-[#94A3B8]">No results for &ldquo;{query}&rdquo;</p>
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
                  className="w-full flex items-center gap-1.5 h-8 px-2 rounded-md hover:bg-white/[0.08] transition-colors text-left group"
                >
                  <span className="w-4 flex items-center justify-center flex-shrink-0">
                    <ToggleIcon open={isOpen} />
                  </span>
                  <span className="text-[11px] font-mono text-[#94A3B8] w-5 text-right flex-shrink-0">{div.num}</span>
                  <span className="flex-1 text-[13px] font-semibold text-[#F8FAFC] truncate">{div.name}</span>
                  {div.file_count > 0 && (
                    <span className="text-[10px] text-[#94A3B8] flex-shrink-0 tabular-nums bg-white/[0.12] px-1.5 py-0.5 rounded">{div.file_count}</span>
                  )}
                </button>

                <div className={`grid transition-all duration-150 ${isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
                  <div className="overflow-hidden">
                    <div className="ml-[20px] border-l border-white/10 pl-1">
                      {div.sections.map(sec => {
                        const secOpen    = openSections.has(sec.code)
                        const secLoading = loadingSections.has(sec.code)
                        const files      = sectionFiles[sec.code] ?? []
                        return (
                          <div key={sec.code}>
                            <button
                              onClick={() => toggleSection(sec.code)}
                              className="w-full flex items-center gap-1.5 h-7 px-1.5 rounded-md hover:bg-white/[0.08] transition-colors text-left group"
                            >
                              <span className="w-3.5 flex items-center justify-center flex-shrink-0">
                                {secLoading
                                  ? <SpinnerIcon className="h-2.5 w-2.5" />
                                  : <ToggleIcon open={secOpen} />
                                }
                              </span>
                              <span className="flex-1 text-[12px] text-[#94A3B8] truncate">
                                <span className="font-mono text-[#94A3B8] mr-1.5">{sec.code}</span>{sec.name}
                              </span>
                              {(sec.file_count ?? 0) > 0 && (
                                <span className="text-[10px] text-[#94A3B8] flex-shrink-0 tabular-nums bg-white/[0.12] px-1.5 py-0.5 rounded">{sec.file_count}</span>
                              )}
                            </button>

                            <div className={`grid transition-all duration-150 ${secOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
                              <div className="overflow-hidden">
                                <div className="ml-[14px] border-l border-white/10 pl-1">
                                  {secLoading && (
                                    <div className="flex items-center gap-1.5 h-7 px-2 text-[12px] text-[#94A3B8]">
                                      <SpinnerIcon className="h-2.5 w-2.5" /> Loading…
                                    </div>
                                  )}
                                  {!secLoading && sectionFiles[sec.code] !== undefined && files.length === 0 && (
                                    <p className="px-2 h-7 flex items-center text-[12px] text-[#94A3B8]">Empty</p>
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
        <div className="flex-shrink-0 border-t border-white/10">
          <div className="px-2 pt-1.5">
            <Link
              href="/settings"
              className="flex items-center gap-2 h-8 px-2 rounded-md text-[12px] text-[#94A3B8] hover:bg-white/[0.08] hover:text-[#F8FAFC] transition-colors"
            >
              <svg className="h-3.5 w-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              Settings
            </Link>
          </div>
          <div className="flex items-center justify-between px-3 py-2.5">
            <span className="text-[11px] text-[#94A3B8] truncate min-w-0">{userEmail}</span>
            <button
              onClick={signOut}
              className="text-[11px] text-[#94A3B8] hover:text-[#F8FAFC] transition-colors flex-shrink-0 ml-2"
            >
              Sign out
            </button>
          </div>
        </div>
        </>}
      </aside>

      {/* ── Main content area ─────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-h-0 ml-0 sm:ml-12">

        {/* Logo bar */}
        {logoUrl && (
          <div className="flex-shrink-0 flex items-center justify-end px-6 py-2 bg-[#0A1628]">
            <img src={logoUrl} alt="Company logo" className="h-7 max-w-[160px] object-contain" />
          </div>
        )}

        {/* Module navigation */}
        <div className="flex-shrink-0 border-b border-white/[0.12] bg-[#0A1628] relative">
          {/* Desktop tabs row */}
          <div className="hidden sm:flex items-center px-4 gap-0.5">
            {(["submittals","rfis","changeorders","punch","daily","drawings","closeout"] as const).map(mod => {
              const labels: Record<string, string> = { submittals: "Submittals", rfis: "RFIs", changeorders: "Change Orders", punch: "Punch List", daily: "Daily Reports", drawings: "Drawing Log", closeout: "Closeout" }
              const isActive = activeModule === mod
              return (
                <button key={mod} onClick={() => setActiveModule(mod)}
                  className={`px-3 py-3 text-[13px] font-medium border-b-2 transition-colors whitespace-nowrap ${isActive ? "border-white text-white font-semibold" : "border-transparent text-[#94A3B8] hover:text-white"}`}>
                  {labels[mod]}
                  {mod === "closeout" && globalProjectId && closeoutItems.length > 0 && (() => {
                    const pct = Math.round(closeoutItems.filter(i => i.status === "complete").length / closeoutItems.length * 100)
                    return <span className={`ml-1.5 text-[10px] font-bold px-1.5 py-0.5 rounded-full ${pct === 100 ? "bg-emerald-500/20 text-emerald-400" : pct >= 50 ? "bg-amber-500/20 text-amber-400" : "bg-red-500/20 text-red-400"}`}>{pct}%</span>
                  })()}
                </button>
              )
            })}
            {/* Global project filter — right side (desktop) */}
            {appProjects.length > 0 && (
              <div className="ml-auto flex items-center gap-2 py-1.5 flex-shrink-0">
                <span className="text-[11px] text-white whitespace-nowrap">Project:</span>
                <div className="relative">
                  <select
                    value={globalProjectId}
                    onChange={e => setGlobalProjectId(e.target.value)}
                    className="h-7 pl-3 pr-7 rounded-md border border-white/30 bg-[#1E3A5F] text-[12px] text-white appearance-none cursor-pointer hover:bg-[#1E3A5F]/80 transition-colors focus:outline-none focus:border-white backdrop-blur-sm"
                  >
                    <option value="">All Projects</option>
                    {appProjects.map(p => (
                      <option key={p.id} value={p.id}>{p.name}{p.number ? ` — ${p.number}` : ""}</option>
                    ))}
                  </select>
                  <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[#64748B]">
                    <svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </span>
                </div>
                {globalProjectId && (
                  <button onClick={() => setGlobalProjectId("")} className="text-[11px] text-white/70 hover:text-white transition-colors px-1" title="Clear filter">✕</button>
                )}
              </div>
            )}
          </div>

          {/* Mobile nav bar */}
          <div className="flex sm:hidden items-center justify-between px-4 py-2.5">
            <span className="text-[14px] font-semibold text-white">
              {{ submittals: "Submittals", rfis: "RFIs", changeorders: "Change Orders", punch: "Punch List", daily: "Daily Reports", drawings: "Drawing Log", closeout: "Closeout" }[activeModule]}
            </span>
            <button
              onClick={() => setMobileNavOpen(prev => !prev)}
              className="text-[#94A3B8] hover:text-white transition-colors p-1"
              aria-label="Open navigation menu"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={mobileNavOpen ? "M6 18L18 6M6 6l12 12" : "M4 6h16M4 12h16M4 18h16"} />
              </svg>
            </button>
          </div>

          {/* Mobile dropdown menu */}
          {mobileNavOpen && (
            <div className="sm:hidden absolute top-full left-0 right-0 bg-[#0A1628] border-b border-white/[0.12] z-50 shadow-lg">
              {(["submittals","rfis","changeorders","punch","daily","drawings","closeout"] as const).map(mod => {
                const labels: Record<string, string> = { submittals: "Submittals", rfis: "RFIs", changeorders: "Change Orders", punch: "Punch List", daily: "Daily Reports", drawings: "Drawing Log", closeout: "Closeout" }
                const isActive = activeModule === mod
                return (
                  <button key={mod}
                    onClick={() => { setActiveModule(mod); setMobileNavOpen(false) }}
                    className={`w-full text-left px-4 py-3 text-[13px] font-medium border-l-2 transition-colors ${isActive ? "border-white text-white bg-white/[0.06]" : "border-transparent text-[#94A3B8] hover:text-white hover:bg-white/[0.04]"}`}>
                    {labels[mod]}
                  </button>
                )
              })}
              {/* Settings link — mobile */}
              <a href="/settings"
                className="w-full text-left px-4 py-3 text-[13px] font-medium border-l-2 border-transparent text-[#94A3B8] hover:text-white hover:bg-white/[0.04] transition-colors flex items-center gap-2">
                Settings
              </a>
              {/* Global project filter — mobile */}
              {appProjects.length > 0 && (
                <div className="px-4 py-3 border-t border-white/[0.12] flex items-center gap-2">
                  <span className="text-[11px] text-white whitespace-nowrap">Project:</span>
                  <select
                    value={globalProjectId}
                    onChange={e => setGlobalProjectId(e.target.value)}
                    className="flex-1 h-7 pl-3 pr-2 rounded-md border border-white/30 bg-[#1E3A5F] text-[12px] text-white cursor-pointer focus:outline-none"
                  >
                    <option value="">All Projects</option>
                    {appProjects.map(p => (
                      <option key={p.id} value={p.id}>{p.name}{p.number ? ` — ${p.number}` : ""}</option>
                    ))}
                  </select>
                  {globalProjectId && (
                    <button onClick={() => setGlobalProjectId("")} className="text-[11px] text-white/70 hover:text-white transition-colors" title="Clear filter">✕</button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Submittal action bar */}
        {activeModule === "submittals" && (
        <div className="flex-shrink-0 border-b border-[#E2E8F0] bg-white flex items-center justify-between px-4 py-2.5 gap-2 min-w-0">
          <p className="text-[13px] font-semibold text-[#0F172A] truncate min-w-0">Submittal Log <span className="text-[#64748B] font-normal ml-1">({logSubmittals.length})</span></p>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={() => { setShowBatch(true); setBatchPhase("select"); setBatchItems([]) }}
              className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[12px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors flex items-center gap-1.5 whitespace-nowrap"
            >
              <LayersIcon /> Batch
            </button>
            <button
              onClick={() => setShowUpload(true)}
              className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors flex items-center gap-1.5 whitespace-nowrap"
            >
              <PlusIcon /> Upload
            </button>
          </div>
        </div>
        )}

        {/* RFI action bar */}
        {activeModule === "rfis" && (
          <div className="flex-shrink-0 border-b border-[#E2E8F0] bg-white flex items-center justify-between px-4 py-2.5 gap-2 min-w-0">
            <p className="text-[13px] font-semibold text-[#0F172A] truncate min-w-0">RFI Log <span className="text-[#64748B] font-normal ml-1">({rfis.length})</span></p>
            <button onClick={() => setShowNewRfi(true)} className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors flex items-center gap-1.5 flex-shrink-0 whitespace-nowrap">
              <PlusIcon /> New RFI
            </button>
          </div>
        )}

        {/* Change Orders action bar */}
        {activeModule === "changeorders" && (
          <div className="flex-shrink-0 border-b border-[#E2E8F0] bg-white flex items-center justify-between px-4 py-2.5 gap-2 min-w-0">
            <p className="text-[13px] font-semibold text-[#0F172A] truncate min-w-0">Change Orders <span className="text-[#64748B] font-normal ml-1">({changeOrders.length})</span></p>
            <button onClick={() => setShowNewCo(true)} className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors flex items-center gap-1.5 flex-shrink-0 whitespace-nowrap">
              <PlusIcon /> New CO
            </button>
          </div>
        )}

        {/* Punch list action bar */}
        {activeModule === "punch" && (
          <div className="flex-shrink-0 border-b border-[#E2E8F0] bg-white flex items-center justify-between px-4 py-2.5 gap-2 min-w-0">
            <div className="flex items-center gap-2 min-w-0 truncate">
              <p className="text-[13px] font-semibold text-[#0F172A] truncate">Punch List <span className="text-[#64748B] font-normal ml-1">({punchItems.filter(p => p.status !== "Void").length})</span></p>
            </div>
            <button onClick={() => setShowNewPunch(true)} className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors flex items-center gap-1.5 flex-shrink-0 whitespace-nowrap">
              <PlusIcon /> New Item
            </button>
          </div>
        )}

        {/* Daily reports action bar */}
        {activeModule === "daily" && (
          <div className="flex-shrink-0 border-b border-[#E2E8F0] bg-white flex items-center justify-between px-4 py-2.5">
            <p className="text-[13px] font-semibold text-[#0F172A]">Daily Reports <span className="text-[#64748B] font-normal ml-1">({dailyReports.length})</span></p>
            <button onClick={() => setShowNewDaily(true)} className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors flex items-center gap-1.5">
              <PlusIcon /> New Report
            </button>
          </div>
        )}

        {/* Drawing log action bar */}
        {activeModule === "drawings" && (
          <div className="flex-shrink-0 border-b border-[#E2E8F0] bg-white flex items-center justify-between px-4 py-2.5">
            <p className="text-[13px] font-semibold text-[#0F172A]">Drawing Log <span className="text-[#64748B] font-normal ml-1">({drawings.filter(d => d.is_current).length} sheets)</span></p>
            <button onClick={() => { setShowNewDrawing(true); setAddRevisionFor(null); resetDwgForm() }} className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors flex items-center gap-1.5">
              <PlusIcon /> Add Drawing
            </button>
          </div>
        )}

        {/* Closeout action bar */}
        {activeModule === "closeout" && (
          <div className="flex-shrink-0 border-b border-[#E2E8F0] bg-white flex items-center justify-between px-4 py-2.5">
            <div className="flex items-center gap-3">
              <p className="text-[13px] font-semibold text-[#0F172A]">Project Closeout</p>
              {globalProjectId && closeoutItems.length > 0 && (() => {
                const total   = closeoutItems.length + closeoutPunch.length + closeoutSubmittals.length + closeoutRFIs.length + closeoutCOs.length + closeoutDrawings.length
                const complete = closeoutItems.filter(i => i.status === "complete").length
                const pct = total > 0 ? Math.round((complete / total) * 100) : 0
                return <span className="text-[11px] text-[#64748B]">{pct}% complete</span>
              })()}
            </div>
            <div className="flex items-center gap-2">
              {globalProjectId && closeoutItems.length > 0 && (
                <button
                  onClick={() => setShowNewCloseout(true)}
                  className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[#64748B] text-[12px] font-semibold hover:border-[#E2E8F0] hover:text-[#0F172A] transition-colors flex items-center gap-1.5"
                >
                  <PlusIcon /> Add Item
                </button>
              )}
              {globalProjectId && closeoutItems.length > 0 && (
                <button
                  onClick={() => setShowAddFolder(true)}
                  className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[#64748B] text-[12px] font-semibold hover:border-[#E2E8F0] hover:text-[#0F172A] transition-colors flex items-center gap-1.5"
                >
                  <PlusIcon /> Add Folder
                </button>
              )}
              {globalProjectId && closeoutItems.length > 0 && (
                <button
                  disabled={closeoutGenerating}
                  onClick={async () => {
                    setCloseoutGenerating(true)
                    const res = await fetch("/api/closeout/pdf", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project_id: globalProjectId }) })
                    const d = await res.json()
                    if (d.url) window.open(d.url, "_blank")
                    setCloseoutGenerating(false)
                  }}
                  className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors flex items-center gap-1.5 disabled:opacity-50"
                >
                  {closeoutGenerating ? <><SpinnerIcon className="h-3.5 w-3.5" /> Generating…</> : "Generate Package"}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto min-h-0">

          {/* Submittal log */}
          {activeModule === "submittals" && (<>
          {logLoading ? (
            <div className="flex items-center justify-center h-40 gap-2 text-[13px] text-[#64748B]">
              <SpinnerIcon className="h-4 w-4" /> Loading…
            </div>
          ) : logSubmittals.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full py-24 text-center">
              <div className="w-14 h-14 rounded-2xl bg-[#7B9BB5]/10 border border-[#7B9BB5]/20 flex items-center justify-center mb-4">
                <svg className="w-7 h-7 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </div>
              <p className="text-[15px] font-bold text-[#0F172A]">No submittals yet</p>
              <p className="text-[13px] text-[#64748B] mt-1.5">Upload your first submittal to get started.</p>
              <button onClick={() => setShowUpload(true)} className="mt-5 h-9 px-5 rounded-lg bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors inline-flex items-center gap-2">
                <PlusIcon /> Upload submittal
              </button>
            </div>
          ) : (
            <>
            {/* Desktop table */}
            <div className="hidden sm:block mx-4 my-4 rounded-xl border border-[#E2E8F0] overflow-clip bg-white">
            <table className="w-full text-[13px] border-collapse">
              <thead className="sticky top-0 bg-[#F8F9FA] z-10">
                <tr className="border-b border-[#E2E8F0]">
                  <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-10">#</th>
                  <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest">Title</th>
                  <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-32">Division</th>
                  <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-48">Section</th>
                  <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-24">Date</th>
                  <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-36">Status</th>
                  <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-40">Actions</th>
                </tr>
              </thead>
              <tbody>
                {logSubmittals.map((s, i) => (
                  <tr key={s.id} className="border-b border-[#E2E8F0]/60 hover:bg-[#F8F9FA] transition-colors group">
                    <td className="px-4 py-2.5 text-[#64748B] tabular-nums text-[12px]">{logSubmittals.length - i}</td>
                    <td className="px-4 py-2.5 max-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="text-[#0F172A] font-medium truncate" title={s.file_name}>{s.file_name}</p>
                        {s.sender_email && (
                          <span title={`Received from ${s.sender_email}`} className="flex-shrink-0 text-[#64748B] hover:text-[#64748B] transition-colors">
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
                          <span className="text-[10px] text-[#7B9BB5]">✎ Overridden</span>
                        )}
                        {s.send_to_company && (
                          <span className="text-[10px] text-emerald-600" title={`Transmitted to: ${s.send_to_company}${s.send_to_contact ? ` — ${s.send_to_contact}` : ""}${s.send_to_email ? ` · ${s.send_to_email}` : ""}`}>
                            ↗ {s.send_to_company}{s.send_to_contact ? ` (${s.send_to_contact})` : ""}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-[#64748B] text-[12px] whitespace-nowrap">
                      {s.csi_division && <span className="font-mono text-[#64748B] mr-1">{s.csi_division}</span>}
                      {s.division_name}
                    </td>
                    <td className="px-4 py-2.5 text-[#64748B] text-[12px]">{s.section_name ?? s.csi_section ?? "—"}</td>
                    <td className="px-4 py-2.5 text-[#64748B] text-[12px] whitespace-nowrap">{fmtDate(s.received_at ?? s.created_at)}</td>
                    <td className="px-4 py-2.5"><StatusBadge status={s.review_status ?? "Received"} /></td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => window.open(`/api/download/${s.id}`, "_blank")}
                          className="text-[11px] text-[#64748B] hover:text-[#0F172A] px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors"
                        >Open</button>
                        <button
                          onClick={() => openEditModal(s)}
                          className="text-[11px] text-[#64748B] hover:text-[#0F172A] px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors"
                        >Edit</button>
                        {s.project_id ? (
                          <button
                            onClick={() => openEditCoverSheet(s)}
                            className="text-[11px] text-[#7B9BB5] hover:text-[#7B9BB5] px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors"
                          >Cover Sheet</button>
                        ) : (
                          <button
                            onClick={() => openTransmittal(s)}
                            className="text-[11px] text-[#7B9BB5] hover:text-[#7B9BB5] px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors"
                          >Transmittal</button>
                        )}
                        <button
                          onClick={() => deleteSubmittal(s)}
                          className="text-[11px] text-[#64748B] hover:text-red-400 px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors"
                          title="Delete submittal"
                        >Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            {/* Mobile card list */}
            <div className="sm:hidden px-3 py-3 space-y-2">
              {logSubmittals.map((s, i) => (
                <div key={s.id} className="bg-white rounded-xl border border-[#E2E8F0] p-3 shadow-sm">
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <p className="text-[13px] font-medium text-[#0F172A] leading-tight flex-1 min-w-0 truncate" title={s.file_name}>{s.file_name}</p>
                    <StatusBadge status={s.review_status ?? "Received"} />
                  </div>
                  <p className="text-[11px] text-[#64748B] mb-1">{s.section_name ?? s.csi_section ?? "—"} {s.division_name ? `· ${s.division_name}` : ""}</p>
                  <p className="text-[11px] text-[#64748B] mb-2">{fmtDate(s.received_at ?? s.created_at)}</p>
                  <div className="flex items-center gap-1 flex-wrap">
                    <button onClick={() => window.open(`/api/download/${s.id}`, "_blank")} className="text-[11px] text-[#64748B] hover:text-[#0F172A] px-2 py-1 rounded border border-[#E2E8F0] bg-[#F8F9FA] transition-colors">Open</button>
                    <button onClick={() => openEditModal(s)} className="text-[11px] text-[#64748B] hover:text-[#0F172A] px-2 py-1 rounded border border-[#E2E8F0] bg-[#F8F9FA] transition-colors">Edit</button>
                    {s.project_id ? (
                      <button onClick={() => openEditCoverSheet(s)} className="text-[11px] text-[#7B9BB5] px-2 py-1 rounded border border-[#E2E8F0] bg-[#F8F9FA] transition-colors">Cover</button>
                    ) : (
                      <button onClick={() => openTransmittal(s)} className="text-[11px] text-[#7B9BB5] px-2 py-1 rounded border border-[#E2E8F0] bg-[#F8F9FA] transition-colors">Transmittal</button>
                    )}
                    <button onClick={() => deleteSubmittal(s)} className="text-[11px] text-red-400 px-2 py-1 rounded border border-[#E2E8F0] bg-[#F8F9FA] transition-colors">Delete</button>
                  </div>
                </div>
              ))}
            </div>
            </>
          )}
          </>)}

          {/* RFI log */}
          {activeModule === "rfis" && (
            rfisLoading ? (
              <div className="flex items-center justify-center h-40 gap-2 text-[13px] text-[#64748B]">
                <SpinnerIcon className="h-4 w-4" /> Loading…
              </div>
            ) : rfis.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full py-24 text-center">
                <div className="w-14 h-14 rounded-2xl bg-[#7B9BB5]/10 border border-[#7B9BB5]/20 flex items-center justify-center mb-4">
                  <svg className="w-7 h-7 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <p className="text-[15px] font-bold text-[#0F172A]">No RFIs yet</p>
                <p className="text-[13px] text-[#64748B] mt-1.5">Create your first RFI to track questions and responses.</p>
                <button onClick={() => setShowNewRfi(true)} className="mt-5 h-9 px-5 rounded-lg bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors inline-flex items-center gap-2">
                  <PlusIcon /> New RFI
                </button>
              </div>
            ) : (
              <>
              {/* Desktop table */}
              <div className="hidden sm:block mx-4 my-4 rounded-xl border border-[#E2E8F0] overflow-clip bg-white">
            <table className="w-full text-[13px] border-collapse">
                <thead className="sticky top-0 bg-[#F8F9FA] z-10">
                  <tr className="border-b border-[#E2E8F0]">
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-24">RFI #</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest">Subject</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-32">Received From</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-28">Spec Section</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-20">Sched.</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-20">Cost</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-24">Due</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-28">Status</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-28">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rfis.map(r => {
                    const isOverdue = r.due_date && new Date(r.due_date) < new Date() && r.status !== "Closed" && r.status !== "Answered" && r.status !== "Void"
                    return (
                      <tr key={r.id} className="border-b border-[#E2E8F0]/60 hover:bg-[#F8F9FA] transition-colors">
                        <td className="px-4 py-2.5 text-[12px] font-mono text-[#7B9BB5]">{r.rfi_number}</td>
                        <td className="px-4 py-2.5 max-w-0">
                          <p className="text-[#0F172A] font-medium truncate" title={r.subject}>{r.subject}</p>
                          {r.description && <p className="text-[11px] text-[#64748B] truncate">{r.description}</p>}
                        </td>
                        <td className="px-4 py-2.5 text-[#64748B] text-[12px] truncate">{r.received_from ?? r.submitted_by ?? "—"}</td>
                        <td className="px-4 py-2.5 text-[#64748B] text-[12px] font-mono">{r.specification_section ?? "—"}</td>
                        <td className="px-4 py-2.5 text-[12px]">
                          <span className={r.schedule_impact === "Yes" ? "text-amber-400" : r.schedule_impact === "No" ? "text-green-400" : "text-[#64748B]"}>{r.schedule_impact ?? "TBD"}</span>
                        </td>
                        <td className="px-4 py-2.5 text-[12px]">
                          <span className="text-[#64748B]">{r.cost_impact ?? "TBD"}</span>
                        </td>
                        <td className="px-4 py-2.5 text-[12px] whitespace-nowrap">
                          {r.due_date ? <span className={isOverdue ? "text-red-400 font-medium" : "text-[#64748B]"}>{fmtDateOnly(r.due_date)}{isOverdue ? " ⚠" : ""}</span> : <span className="text-[#64748B]">—</span>}
                        </td>
                        <td className="px-4 py-2.5"><RfiStatusBadge status={r.status} /></td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-1">
                            <button onClick={() => { setViewRfi(r); setRfiResponse(r.response ?? ""); setRfiResponseStatus(r.status) }}
                              className="text-[11px] text-[#64748B] hover:text-[#0F172A] px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">View</button>
                            <button onClick={() => generateRfiPdf(r.id)} disabled={rfiGeneratingPdf}
                              className="text-[11px] text-[#7B9BB5] hover:text-[#7B9BB5] px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50">PDF</button>
                            <button onClick={() => deleteRfi(r.id)}
                              className="text-[11px] text-red-400/60 hover:text-red-400 px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">Del</button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              </div>
              {/* Mobile card list */}
              <div className="sm:hidden px-3 py-3 space-y-2">
                {rfis.map(r => {
                  const isOverdue = r.due_date && new Date(r.due_date) < new Date() && r.status !== "Closed" && r.status !== "Answered" && r.status !== "Void"
                  return (
                    <div key={r.id} className="bg-white rounded-xl border border-[#E2E8F0] p-3 shadow-sm">
                      <div className="flex items-start justify-between gap-2 mb-1">
                        <span className="text-[11px] font-mono text-[#7B9BB5] flex-shrink-0">{r.rfi_number}</span>
                        <RfiStatusBadge status={r.status} />
                      </div>
                      <p className="text-[13px] font-medium text-[#0F172A] mb-1">{r.subject}</p>
                      <p className="text-[11px] text-[#64748B] mb-1">From: {r.received_from ?? r.submitted_by ?? "—"}</p>
                      {r.due_date && <p className="text-[11px] mb-2"><span className={isOverdue ? "text-red-400 font-medium" : "text-[#64748B]"}>Due: {fmtDateOnly(r.due_date)}{isOverdue ? " ⚠" : ""}</span></p>}
                      <div className="flex items-center gap-1">
                        <button onClick={() => { setViewRfi(r); setRfiResponse(r.response ?? ""); setRfiResponseStatus(r.status) }} className="text-[11px] text-[#64748B] px-2 py-1 rounded border border-[#E2E8F0] bg-[#F8F9FA]">View</button>
                        <button onClick={() => generateRfiPdf(r.id)} disabled={rfiGeneratingPdf} className="text-[11px] text-[#7B9BB5] px-2 py-1 rounded border border-[#E2E8F0] bg-[#F8F9FA] disabled:opacity-50">PDF</button>
                        <button onClick={() => deleteRfi(r.id)} className="text-[11px] text-red-400 px-2 py-1 rounded border border-[#E2E8F0] bg-[#F8F9FA]">Del</button>
                      </div>
                    </div>
                  )
                })}
              </div>
              </>
            )
          )}

          {/* Change Orders */}
          {activeModule === "changeorders" && (
            coLoading ? (
              <div className="flex items-center justify-center h-40 gap-2 text-[13px] text-[#64748B]">
                <SpinnerIcon className="h-4 w-4" /> Loading…
              </div>
            ) : (
              <div className="flex flex-col min-h-full">
                {/* Running totals */}
                {changeOrders.length > 0 && (() => {
                  const approved = changeOrders.filter(c => c.status === "Approved")
                  const pending  = changeOrders.filter(c => ["Draft","Submitted","Under Review"].includes(c.status))
                  const open     = changeOrders.filter(c => !["Approved","Rejected","Void"].includes(c.status))
                  const sumApproved = approved.reduce((s, c) => s + (c.pricing_sum ?? 0), 0)
                  const sumPending  = pending.reduce((s,  c) => s + (c.pricing_sum ?? 0), 0)
                  const fmt = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)
                  return (
                    <div className="flex items-stretch gap-3 px-4 py-3 border-b border-[#E2E8F0] flex-shrink-0">
                      {[
                        { label: "Total COs", value: String(changeOrders.length), muted: false },
                        { label: "Approved", value: fmt(sumApproved), muted: false, green: true },
                        { label: "Pending", value: fmt(sumPending), muted: true },
                        { label: "Open", value: String(open.length), muted: open.length > 0 },
                      ].map(({ label, value, green }) => (
                        <div key={label} className="flex-1 rounded-lg bg-[#F4F5F7] border border-[#E2E8F0] px-3 py-2">
                          <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-1">{label}</p>
                          <p className={`text-[15px] font-bold tabular-nums ${green ? "text-green-400" : "text-[#0F172A]"}`}>{value}</p>
                        </div>
                      ))}
                    </div>
                  )
                })()}
                {changeOrders.length === 0 ? (
                  <div className="flex flex-col items-center justify-center flex-1 py-24 text-center">
                    <div className="w-14 h-14 rounded-2xl bg-[#7B9BB5]/10 border border-[#7B9BB5]/20 flex items-center justify-center mb-4">
                      <svg className="w-7 h-7 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z" />
                      </svg>
                    </div>
                    <p className="text-[15px] font-bold text-[#0F172A]">No change orders yet</p>
                    <p className="text-[13px] text-[#64748B] mt-1.5">Create your first change order to track scope changes.</p>
                    <button onClick={() => setShowNewCo(true)} className="mt-5 h-9 px-5 rounded-lg bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors inline-flex items-center gap-2">
                      <PlusIcon /> New CO
                    </button>
                  </div>
                ) : (
                  <>
                  {/* Desktop table */}
                  <div className="hidden sm:block mx-4 my-4 rounded-xl border border-[#E2E8F0] overflow-clip bg-white">
            <table className="w-full text-[13px] border-collapse">
                    <thead className="sticky top-0 bg-[#F8F9FA] z-10">
                      <tr className="border-b border-[#E2E8F0]">
                        <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-20">CO #</th>
                        <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-32">Project</th>
                        <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest">Proposal</th>
                        <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-28">Pricing</th>
                        <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-20">Sched.</th>
                        <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-24">Date</th>
                        <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-28">Status</th>
                        <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-28">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {changeOrders.map(c => {
                        const proj = appProjects.find(p => p.id === c.project_id)
                        const statusColor: Record<string, string> = {
                          Draft:          "bg-gray-100 text-gray-500",
                          Submitted:      "bg-blue-100 text-blue-700",
                          "Under Review": "bg-amber-100 text-amber-700",
                          Approved:       "bg-green-100 text-green-700",
                          Rejected:       "bg-red-100 text-red-700",
                          Void:           "bg-gray-100 text-gray-500",
                        }
                        const badgeCls = statusColor[c.status] ?? "bg-gray-100 text-gray-500"
                        return (
                          <tr key={c.id} className="border-b border-[#E2E8F0]/60 hover:bg-[#F8F9FA] transition-colors">
                            <td className="px-4 py-2.5 text-[12px] font-mono text-[#7B9BB5]">{c.co_number}</td>
                            <td className="px-4 py-2.5 text-[#64748B] text-[12px] truncate">{proj?.name ?? "—"}</td>
                            <td className="px-4 py-2.5 max-w-0"><p className="text-[#0F172A] truncate">{c.proposal ?? "—"}</p></td>
                            <td className="px-4 py-2.5 text-[#0F172A] text-[12px] tabular-nums font-medium">
                              {c.pricing_sum != null ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(c.pricing_sum) : "—"}
                            </td>
                            <td className="px-4 py-2.5 text-[12px]">
                              <span className={c.schedule_impact === "Yes" ? "text-amber-400" : c.schedule_impact === "No" ? "text-green-400" : "text-[#64748B]"}>{c.schedule_impact ?? "TBD"}</span>
                            </td>
                            <td className="px-4 py-2.5 text-[#64748B] text-[12px] whitespace-nowrap">{c.date ? fmtDateOnly(c.date) : "—"}</td>
                            <td className="px-4 py-2.5">
                              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${badgeCls}`}>{c.status}</span>
                            </td>
                            <td className="px-4 py-2.5">
                              <div className="flex items-center gap-1">
                                <button onClick={() => { setViewCo(c); setCoResponseStatus(c.status); setCoAssignedTo(c.assigned_to ?? "") }}
                                  className="text-[11px] text-[#64748B] hover:text-[#0F172A] px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">View</button>
                                <button onClick={() => generateCoPdf(c.id)} disabled={coGeneratingPdf}
                                  className="text-[11px] text-[#7B9BB5] hover:text-[#7B9BB5] px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50">PDF</button>
                                <button onClick={() => deleteCo(c.id)}
                                  className="text-[11px] text-red-400/60 hover:text-red-400 px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">Del</button>
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                  </div>
                  {/* Mobile card list */}
                  <div className="sm:hidden px-3 py-3 space-y-2">
                    {changeOrders.map(c => {
                      const proj = appProjects.find(p => p.id === c.project_id)
                      const statusColor: Record<string, string> = { Draft: "bg-gray-100 text-gray-500", Submitted: "bg-blue-100 text-blue-700", "Under Review": "bg-amber-100 text-amber-700", Approved: "bg-green-100 text-green-700", Rejected: "bg-red-100 text-red-700", Void: "bg-gray-100 text-gray-500" }
                      const badgeCls = statusColor[c.status] ?? "bg-gray-100 text-gray-500"
                      return (
                        <div key={c.id} className="bg-white rounded-xl border border-[#E2E8F0] p-3 shadow-sm">
                          <div className="flex items-start justify-between gap-2 mb-1">
                            <span className="text-[11px] font-mono text-[#7B9BB5]">{c.co_number}</span>
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${badgeCls}`}>{c.status}</span>
                          </div>
                          <p className="text-[13px] font-medium text-[#0F172A] mb-1 truncate">{c.proposal ?? "—"}</p>
                          {proj && <p className="text-[11px] text-[#64748B] mb-1">{proj.name}</p>}
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-[12px] font-semibold text-[#0F172A]">{c.pricing_sum != null ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(c.pricing_sum) : "—"}</span>
                            <span className="text-[11px] text-[#64748B]">{c.date ? fmtDateOnly(c.date) : ""}</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <button onClick={() => { setViewCo(c); setCoResponseStatus(c.status); setCoAssignedTo(c.assigned_to ?? "") }} className="text-[11px] text-[#64748B] px-2 py-1 rounded border border-[#E2E8F0] bg-[#F8F9FA]">View</button>
                            <button onClick={() => generateCoPdf(c.id)} disabled={coGeneratingPdf} className="text-[11px] text-[#7B9BB5] px-2 py-1 rounded border border-[#E2E8F0] bg-[#F8F9FA] disabled:opacity-50">PDF</button>
                            <button onClick={() => deleteCo(c.id)} className="text-[11px] text-red-400 px-2 py-1 rounded border border-[#E2E8F0] bg-[#F8F9FA]">Del</button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                  </>
                )}
              </div>
            )
          )}

          {/* Punch list */}
          {activeModule === "punch" && (
            punchLoading ? (
              <div className="flex items-center justify-center h-40 gap-2 text-[13px] text-[#64748B]">
                <SpinnerIcon className="h-4 w-4" /> Loading…
              </div>
            ) : punchItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full py-24 text-center">
                <div className="w-14 h-14 rounded-2xl bg-[#7B9BB5]/10 border border-[#7B9BB5]/20 flex items-center justify-center mb-4">
                  <svg className="w-7 h-7 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                  </svg>
                </div>
                <p className="text-[15px] font-bold text-[#0F172A]">No punch items yet</p>
                <p className="text-[13px] text-[#64748B] mt-1.5">Add items to track deficiencies and corrections.</p>
                <button onClick={() => setShowNewPunch(true)} className="mt-5 h-9 px-5 rounded-lg bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors inline-flex items-center gap-2">
                  <PlusIcon /> New Item
                </button>
              </div>
            ) : (
              <>
              {/* Desktop table */}
              <div className="hidden sm:block mx-4 my-4 rounded-xl border border-[#E2E8F0] overflow-clip bg-white">
            <table className="w-full text-[13px] border-collapse">
                <thead className="sticky top-0 bg-[#F8F9FA] z-10">
                  <tr className="border-b border-[#E2E8F0]">
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-10">#</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-20">Item</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest">Description</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-32">Location</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-32">Assigned To</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-24">Due</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-24">Priority</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-28">Status</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-16">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {punchItems.map((p, i) => {
                    const isOverdue = p.due_date && new Date(p.due_date) < new Date() && p.status !== "Completed" && p.status !== "Void"
                    const isStruck  = p.status === "Completed" || p.status === "Void"
                    return (
                      <tr key={p.id} className={`border-b border-[#E2E8F0]/60 hover:bg-[#F8F9FA] transition-colors ${isStruck ? "opacity-50" : ""}`}>
                        <td className="px-4 py-2.5 text-[#64748B] tabular-nums text-[12px]">{punchItems.length - i}</td>
                        <td className="px-4 py-2.5 text-[12px] font-mono text-[#7B9BB5]">{p.item_number}</td>
                        <td className="px-4 py-2.5 max-w-0">
                          <p className={`font-medium truncate ${isStruck ? "line-through text-[#64748B]" : "text-[#0F172A]"}`} title={p.description}>{p.description}</p>
                        </td>
                        <td className="px-4 py-2.5 text-[#64748B] text-[12px]">{p.location ?? "—"}</td>
                        <td className="px-4 py-2.5 text-[#64748B] text-[12px]">{p.assigned_to ?? "—"}</td>
                        <td className="px-4 py-2.5 text-[12px] whitespace-nowrap">
                          {p.due_date
                            ? <span className={isOverdue ? "text-red-400 font-medium" : "text-[#64748B]"}>{fmtDateOnly(p.due_date)}{isOverdue ? " ⚠" : ""}</span>
                            : <span className="text-[#64748B]">—</span>}
                        </td>
                        <td className="px-4 py-2.5"><PunchPriorityBadge priority={p.priority} /></td>
                        <td className="px-4 py-2.5"><PunchStatusBadge status={p.status} /></td>
                        <td className="px-4 py-2.5">
                          <button onClick={() => { setViewPunch(p); setPunchEditStatus(p.status); setPunchEditNotes(p.notes ?? "") }}
                            className="text-[11px] text-[#64748B] hover:text-[#0F172A] px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">
                            Edit
                          </button>
                          <button onClick={() => generatePunchPdf(p.id)} disabled={punchGeneratingPdf}
                            className="text-[11px] text-[#7B9BB5] hover:text-[#7B9BB5] px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50">PDF</button>
                          <button onClick={e => { e.stopPropagation(); deletePunchItem(p.id) }}
                            className="text-[11px] text-red-400 hover:text-red-300 px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">Del</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              </div>
              {/* Mobile card list */}
              <div className="sm:hidden px-3 py-3 space-y-2">
                {punchItems.map(p => {
                  const isOverdue = p.due_date && new Date(p.due_date) < new Date() && p.status !== "Completed" && p.status !== "Void"
                  const isStruck = p.status === "Completed" || p.status === "Void"
                  return (
                    <div key={p.id} className={`bg-white rounded-xl border border-[#E2E8F0] p-3 shadow-sm ${isStruck ? "opacity-50" : ""}`}>
                      <div className="flex items-start justify-between gap-2 mb-1">
                        <span className="text-[11px] font-mono text-[#7B9BB5]">{p.item_number}</span>
                        <div className="flex items-center gap-1">
                          <PunchPriorityBadge priority={p.priority} />
                          <PunchStatusBadge status={p.status} />
                        </div>
                      </div>
                      <p className={`text-[13px] font-medium mb-1 ${isStruck ? "line-through text-[#64748B]" : "text-[#0F172A]"}`}>{p.description}</p>
                      {p.location && <p className="text-[11px] text-[#64748B] mb-0.5">Location: {p.location}</p>}
                      {p.assigned_to && <p className="text-[11px] text-[#64748B] mb-1">Assigned: {p.assigned_to}</p>}
                      {p.due_date && <p className="text-[11px] mb-2"><span className={isOverdue ? "text-red-400 font-medium" : "text-[#64748B]"}>Due: {fmtDateOnly(p.due_date)}{isOverdue ? " ⚠" : ""}</span></p>}
                      <div className="flex items-center gap-1">
                        <button onClick={() => { setViewPunch(p); setPunchEditStatus(p.status); setPunchEditNotes(p.notes ?? "") }} className="text-[11px] text-[#64748B] px-2 py-1 rounded border border-[#E2E8F0] bg-[#F8F9FA]">Edit</button>
                        <button onClick={() => generatePunchPdf(p.id)} disabled={punchGeneratingPdf} className="text-[11px] text-[#7B9BB5] px-2 py-1 rounded border border-[#E2E8F0] bg-[#F8F9FA] disabled:opacity-50">PDF</button>
                        <button onClick={e => { e.stopPropagation(); deletePunchItem(p.id) }} className="text-[11px] text-red-400 px-2 py-1 rounded border border-[#E2E8F0] bg-[#F8F9FA]">Del</button>
                      </div>
                    </div>
                  )
                })}
              </div>
              </>
            )
          )}
          {/* Daily reports */}
          {activeModule === "daily" && (
            dailyLoading ? (
              <div className="flex items-center justify-center h-40 gap-2 text-[13px] text-[#64748B]">
                <SpinnerIcon className="h-4 w-4" /> Loading…
              </div>
            ) : dailyReports.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full py-24 text-center">
                <div className="w-14 h-14 rounded-2xl bg-[#7B9BB5]/10 border border-[#7B9BB5]/20 flex items-center justify-center mb-4">
                  <svg className="w-7 h-7 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                </div>
                <p className="text-[15px] font-bold text-[#0F172A]">No daily reports yet</p>
                <p className="text-[13px] text-[#64748B] mt-1.5">Log daily site activity, weather, and manpower.</p>
                <button onClick={() => setShowNewDaily(true)} className="mt-5 h-9 px-5 rounded-lg bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors inline-flex items-center gap-2">
                  <PlusIcon /> New Report
                </button>
              </div>
            ) : (
              <>
              {/* Desktop table */}
              <div className="hidden sm:block mx-4 my-4 rounded-xl border border-[#E2E8F0] overflow-clip bg-white">
            <table className="w-full text-[13px] border-collapse">
                <thead className="sticky top-0 bg-[#F8F9FA] z-10">
                  <tr className="border-b border-[#E2E8F0]">
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-10">#</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-28">Date</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest">Work Performed</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-28">Prepared By</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-28">Weather</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-20">Manpower</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-20">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {dailyReports.map((r, i) => (
                    <tr key={r.id} className="border-b border-[#E2E8F0]/60 hover:bg-[#F8F9FA] transition-colors cursor-pointer" onClick={() => { setViewDaily(r); setDailyEditing(false) }}>
                      <td className="px-4 py-2.5 text-[#64748B] tabular-nums text-[12px]">{dailyReports.length - i}</td>
                      <td className="px-4 py-2.5 text-[#0F172A] font-medium text-[12px] whitespace-nowrap">{fmtDateOnly(r.report_date)}</td>
                      <td className="px-4 py-2.5 max-w-0">
                        <p className="text-[#64748B] text-[12px] truncate">{r.work_performed ?? <span className="text-[#64748B] italic">No description</span>}</p>
                      </td>
                      <td className="px-4 py-2.5 text-[#64748B] text-[12px]">{r.prepared_by ?? "—"}</td>
                      <td className="px-4 py-2.5 text-[#64748B] text-[12px]">{r.weather_conditions ?? "—"}{r.temperature ? ` · ${r.temperature}` : ""}</td>
                      <td className="px-4 py-2.5 text-[#64748B] text-[12px] text-center">{r.manpower_count ?? "—"}</td>
                      <td className="px-4 py-2.5">
                        <button onClick={e => { e.stopPropagation(); openDailyForEdit(r) }}
                          className="text-[11px] text-[#64748B] hover:text-[#0F172A] px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">
                          Edit
                        </button>
                        <button onClick={e => { e.stopPropagation(); generateDailyPdf(r.id) }} disabled={dailyGeneratingPdf}
                          className="text-[11px] text-[#7B9BB5] hover:text-[#7B9BB5] px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50">PDF</button>
                        <button onClick={e => { e.stopPropagation(); deleteDaily(r.id) }}
                          className="text-[11px] text-red-400 hover:text-red-300 px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">Del</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
              {/* Mobile card list */}
              <div className="sm:hidden px-3 py-3 space-y-2">
                {dailyReports.map(r => (
                  <div key={r.id} className="bg-white rounded-xl border border-[#E2E8F0] p-3 shadow-sm cursor-pointer" onClick={() => { setViewDaily(r); setDailyEditing(false) }}>
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <p className="text-[13px] font-semibold text-[#0F172A]">{fmtDateOnly(r.report_date)}</p>
                      {r.manpower_count != null && <span className="text-[11px] text-[#64748B]">{r.manpower_count} workers</span>}
                    </div>
                    {r.work_performed && <p className="text-[12px] text-[#64748B] mb-1 line-clamp-2">{r.work_performed}</p>}
                    <div className="flex items-center gap-3 text-[11px] text-[#64748B] mb-2">
                      {r.prepared_by && <span>{r.prepared_by}</span>}
                      {r.weather_conditions && <span>{r.weather_conditions}{r.temperature ? ` · ${r.temperature}` : ""}</span>}
                    </div>
                    <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                      <button onClick={() => openDailyForEdit(r)} className="text-[11px] text-[#64748B] px-2 py-1 rounded border border-[#E2E8F0] bg-[#F8F9FA]">Edit</button>
                      <button onClick={() => generateDailyPdf(r.id)} disabled={dailyGeneratingPdf} className="text-[11px] text-[#7B9BB5] px-2 py-1 rounded border border-[#E2E8F0] bg-[#F8F9FA] disabled:opacity-50">PDF</button>
                      <button onClick={() => deleteDaily(r.id)} className="text-[11px] text-red-400 px-2 py-1 rounded border border-[#E2E8F0] bg-[#F8F9FA]">Del</button>
                    </div>
                  </div>
                ))}
              </div>
              </>
            )
          )}
          {/* Drawing log */}
          {activeModule === "drawings" && (() => {
            const currentDrawings = drawings.filter(d => d.is_current)
            const allSuperseded   = drawings.filter(d => !d.is_current)
            return drawingsLoading ? (
              <div className="flex items-center justify-center h-40 gap-2 text-[13px] text-[#64748B]">
                <SpinnerIcon className="h-4 w-4" /> Loading…
              </div>
            ) : currentDrawings.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full py-24 text-center">
                <div className="w-14 h-14 rounded-2xl bg-[#7B9BB5]/10 border border-[#7B9BB5]/20 flex items-center justify-center mb-4">
                  <svg className="w-7 h-7 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                </div>
                <p className="text-[15px] font-bold text-[#0F172A]">No drawings yet</p>
                <p className="text-[13px] text-[#64748B] mt-1.5">Add drawings to track revisions and status.</p>
                <button onClick={() => { setShowNewDrawing(true); setAddRevisionFor(null); resetDwgForm() }} className="mt-5 h-9 px-5 rounded-lg bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors inline-flex items-center gap-2">
                  <PlusIcon /> Add Drawing
                </button>
              </div>
            ) : (
              <div className="px-4 py-4">
                <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
                  {currentDrawings.map(d => {
                    const history = allSuperseded.filter(s => s.drawing_number === d.drawing_number)
                    const isExpanded = expandedDrawings.has(d.drawing_number)
                    const isImg = /\.(png|jpg|jpeg|gif|webp)$/i.test(d.file_name ?? "")
                    const isPdf = /\.pdf$/i.test(d.file_name ?? "")
                    return (
                      <div key={d.id} className="bg-white rounded-xl border border-[#E2E8F0] overflow-hidden flex flex-col shadow-sm">
                        {/* Preview */}
                        <div className="relative bg-[#F1F3F5] overflow-hidden" style={{ height: 180 }}>
                          {d.file_url && isImg && (
                            <img src={d.file_url} alt={d.sheet_title} className="w-full h-full object-contain" />
                          )}
                          {d.file_url && isPdf && (
                            <div className="w-full h-full overflow-hidden">
                              <iframe
                                src={`${d.file_url}#toolbar=0&navpanes=0&scrollbar=0&view=Fit`}
                                title={d.sheet_title}
                                style={{ width: "200%", height: "200%", transform: "scale(0.5)", transformOrigin: "0 0", border: "none", pointerEvents: "none" }}
                              />
                            </div>
                          )}
                          {(!d.file_url || (!isImg && !isPdf)) && (
                            <div className="flex flex-col items-center justify-center h-full gap-2">
                              <svg className="w-8 h-8 text-[#94A3B8]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                              </svg>
                              <span className="text-[11px] text-[#94A3B8]">No file attached</span>
                            </div>
                          )}
                          {/* Revision history toggle */}
                          {history.length > 0 && (
                            <button
                              onClick={() => setExpandedDrawings(prev => { const n = new Set(prev); isExpanded ? n.delete(d.drawing_number) : n.add(d.drawing_number); return n })}
                              className="absolute top-1.5 left-1.5 bg-black/50 hover:bg-black/70 text-white text-[9px] font-bold px-1.5 py-0.5 rounded transition-colors"
                            >{history.length} rev</button>
                          )}
                        </div>

                        {/* Info */}
                        <div className="p-2.5 flex flex-col gap-1 flex-1">
                          <div className="flex items-center justify-between gap-1">
                            <span className="text-[11px] font-mono font-bold text-[#7B9BB5] truncate">{d.drawing_number}</span>
                            <span className="text-[10px] text-[#64748B] flex-shrink-0">Rev {d.revision}</span>
                          </div>
                          <p className="text-[12px] font-medium text-[#0F172A] leading-tight line-clamp-2">{d.sheet_title}</p>
                          <div className="mt-auto pt-1">
                            <DrawingStatusBadge status={d.status} />
                          </div>
                          <div className="flex items-center gap-1 pt-1 border-t border-[#E2E8F0] mt-1">
                            <button onClick={() => openAddRevision(d)} className="flex-1 text-[10px] text-[#7B9BB5] hover:text-[#5A7A94] font-semibold py-1 hover:bg-[#F8F9FA] rounded transition-colors text-center">+ Rev</button>
                            <button onClick={() => generateDrawingPdf(d.id)} disabled={drawingGeneratingPdf} className="flex-1 text-[10px] text-[#7B9BB5] hover:text-[#5A7A94] font-semibold py-1 hover:bg-[#F8F9FA] rounded transition-colors disabled:opacity-40 text-center">PDF</button>
                            {d.file_url && (
                              <a href={d.file_url} target="_blank" rel="noopener noreferrer" className="flex-1 text-[10px] text-[#7B9BB5] hover:text-[#5A7A94] font-semibold py-1 hover:bg-[#F8F9FA] rounded transition-colors text-center">Open</a>
                            )}
                            <button onClick={e => { e.stopPropagation(); deleteDrawing(d.id) }} className="flex-1 text-[10px] text-red-400 hover:text-red-500 font-semibold py-1 hover:bg-red-50 rounded transition-colors text-center">Del</button>
                          </div>
                        </div>

                        {/* Revision history */}
                        {isExpanded && history.length > 0 && (
                          <div className="border-t border-[#E2E8F0] bg-[#F8F9FA] px-2.5 py-2 space-y-1">
                            {history.map(h => (
                              <div key={h.id} className="flex items-center justify-between text-[10px] text-[#64748B]">
                                <span className="font-mono">Rev {h.revision}</span>
                                <span>Superseded {h.superseded_at ? fmtDate(h.superseded_at) : ""}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })()}

          {/* ── Closeout module ───────────────────────────────────────────── */}
          {activeModule === "closeout" && (() => {
            const cycleStatus  = (s: string) => s === "incomplete" ? "in_progress" : s === "in_progress" ? "complete" : "incomplete"
            const dotColor     = (s: string) => s === "complete" ? "#10b981" : s === "in_progress" ? "#f59e0b" : "#ef4444"
            const labelColor   = (s: string) => s === "complete" ? "text-emerald-400" : s === "in_progress" ? "text-amber-400" : "text-red-400"
            const statusLabel  = (s: string) => s === "complete" ? "Complete" : s === "in_progress" ? "In Progress" : "Incomplete"
            // Dynamic document counts
            const approvedSubs  = closeoutAllSubmittals.filter(s => s.review_status === "Approved").length
            const resolvedRFIs  = closeoutAllRFIs.filter(r => r.status === "Closed").length
            const approvedCOs   = closeoutAllCOs.filter(c => c.status === "Approved").length
            const asBuiltDwgs   = closeoutAllDrawings.filter(d => d.status === "As-Built").length
            const openPunchCount = closeoutAllPunch.filter(p => p.status !== "Completed").length
            const docStoredItems = closeoutItems.filter(i => i.category === "documents")
            const docStoredDone  = docStoredItems.filter(i => i.status === "complete").length
            const docTotal = docStoredItems.length + closeoutAllSubmittals.length + closeoutAllRFIs.length + closeoutAllCOs.length + closeoutAllDrawings.length
            const docDone  = docStoredDone + approvedSubs + resolvedRFIs + approvedCOs + asBuiltDwgs
            const subItems  = closeoutItems.filter(i => i.category === "subcontractors")
            const supplItems = closeoutItems.filter(i => i.category === "suppliers")
            const CATS = [
              { key: "documents",      label: "Documents",      total: docTotal, done: docDone },
              { key: "inspections",    label: "Inspections",    total: closeoutItems.filter(i=>i.category==="inspections").length,    done: closeoutItems.filter(i=>i.category==="inspections"&&i.status==="complete").length },
              { key: "warranties",     label: "Warranties",     total: closeoutItems.filter(i=>i.category==="warranties").length,     done: closeoutItems.filter(i=>i.category==="warranties"&&i.status==="complete").length },
              { key: "handover",       label: "Handover",       total: closeoutItems.filter(i=>i.category==="handover").length,       done: closeoutItems.filter(i=>i.category==="handover"&&i.status==="complete").length },
              { key: "subcontractors", label: "Subcontractors", total: subItems.length,  done: subItems.filter(i=>i.status==="complete").length },
              { key: "suppliers",      label: "Suppliers",      total: supplItems.length, done: supplItems.filter(i=>i.status==="complete").length },
              { key: "training",       label: "Training",       total: closeoutItems.filter(i=>i.category==="training").length,       done: closeoutItems.filter(i=>i.category==="training"&&i.status==="complete").length },
            ]
            return (
              <>
                <input ref={closeoutFileRef} type="file" className="hidden"
                  accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.xlsx,.xls"
                  onChange={async e => {
                    const file = e.target.files?.[0]
                    if (file && closeoutUploadingId) await uploadCloseoutFile(closeoutUploadingId, file)
                    if (closeoutFileRef.current) closeoutFileRef.current.value = ""
                  }}
                />

                {/* No project selected */}
                {!globalProjectId ? (
                  <div className="flex flex-col items-center justify-center h-full py-24 text-center">
                    <div className="w-14 h-14 rounded-2xl bg-[#7B9BB5]/10 border border-[#7B9BB5]/20 flex items-center justify-center mb-4">
                      <svg className="w-7 h-7 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>
                    </div>
                    <p className="text-[15px] font-bold text-[#0F172A]">Select a project to view closeout</p>
                    <p className="text-[13px] text-[#64748B] mt-1.5">Use the Project filter above to choose a project.</p>
                  </div>
                ) : closeoutLoading ? (
                  <div className="flex items-center justify-center h-40 gap-2 text-[13px] text-[#64748B]">
                    <SpinnerIcon className="h-4 w-4" /> Loading closeout data…
                  </div>
                ) : closeoutItems.length === 0 ? (
                  /* Not initialized */
                  <div className="flex flex-col items-center justify-center h-full py-24 text-center">
                    <div className="w-14 h-14 rounded-2xl bg-[#7B9BB5]/10 border border-[#7B9BB5]/20 flex items-center justify-center mb-4">
                      <svg className="w-7 h-7 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>
                    </div>
                    <p className="text-[15px] font-bold text-[#0F172A]">Closeout not started</p>
                    <p className="text-[13px] text-[#64748B] mt-1.5 max-w-xs">Initialize the closeout checklist to start tracking documents, inspections, and handover items for this project.</p>
                    <button
                      disabled={closeoutIniting}
                      onClick={async () => {
                        setCloseoutIniting(true)
                        await fetch("/api/closeout/init", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project_id: globalProjectId }) })
                        loadCloseout()
                        setCloseoutIniting(false)
                      }}
                      className="mt-6 h-9 px-5 rounded-lg bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors inline-flex items-center gap-2 disabled:opacity-50"
                    >
                      {closeoutIniting ? <><SpinnerIcon className="h-3.5 w-3.5" /> Initializing…</> : "Initialize Closeout Checklist"}
                    </button>
                  </div>
                ) : (
                  /* Main closeout dashboard */
                  <div className="p-4 space-y-4">

                    {/* Punch list banner — blocks 100% if open items */}
                    {openPunchCount > 0 && (
                      <div className="flex items-center gap-3 px-4 py-2.5 rounded-lg bg-red-500/10 border border-red-500/30">
                        <div className="w-2 h-2 rounded-full bg-red-400 flex-shrink-0" />
                        <span className="text-[12px] text-red-400 font-medium flex-1">{openPunchCount} open punch list item{openPunchCount !== 1 ? "s" : ""} — closeout cannot reach 100% until all punch items are closed.</span>
                        <button onClick={() => setActiveModule("punch")} className="text-[11px] text-[#7B9BB5] hover:text-[#7B9BB5] transition-colors flex-shrink-0">Go to Punch →</button>
                      </div>
                    )}

                    {/* Progress cards */}
                    <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                      {CATS.map(cat => {
                        const pct   = cat.total > 0 ? Math.round((cat.done / cat.total) * 100) : 100
                        const color = pct >= 80 ? "#10b981" : pct >= 50 ? "#f59e0b" : "#ef4444"
                        return (
                          <div key={cat.key} className="bg-white rounded-xl border border-[#E2E8F0] p-3">
                            <div className="text-[10px] font-bold text-[#64748B] uppercase tracking-wide mb-2">{cat.label}</div>
                            <div className="text-[26px] font-extrabold leading-none mb-1" style={{ color }}>{pct}%</div>
                            <div className="text-[10px] text-[#64748B] mb-2">{cat.done}/{cat.total}</div>
                            <div className="h-1 rounded-full bg-[#E2E8F0] overflow-hidden">
                              <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, backgroundColor: color }} />
                            </div>
                          </div>
                        )
                      })}
                    </div>

                    {/* ── DOCUMENTS ─────────────────────────────────────────── */}
                    {(() => {
                      const storedDocs = closeoutItems.filter(i => i.category === "documents")
                      return (
                        <div className="bg-white rounded-xl border border-[#E2E8F0] overflow-hidden">
                          <div className="flex items-center justify-between px-4 py-3 border-b border-[#E2E8F0]">
                            <div className="flex items-center gap-2">
                              <span className="text-[13px] font-bold text-[#0F172A]">Documents</span>
                              <span className="text-[11px] text-[#64748B]">{docDone}/{docTotal} complete</span>
                            </div>
                            <button onClick={() => { setNewCloseoutCategory("documents"); setShowNewCloseout(true) }} className="text-[11px] text-white/70 hover:text-white transition-colors flex items-center gap-1"><PlusIcon /> Add</button>
                          </div>

                          {/* Submittals sub-section */}
                          {closeoutAllSubmittals.length > 0 && (
                            <div className="border-b border-[#E2E8F0]/40">
                              <div className="flex items-center justify-between px-4 py-2 bg-white/30">
                                <span className="text-[11px] font-bold text-[#64748B] uppercase tracking-wider">Submittals ({approvedSubs}/{closeoutAllSubmittals.length} Approved)</span>
                                <button onClick={() => setActiveModule("submittals")} className="text-[10px] text-[#7B9BB5] hover:text-[#7B9BB5]">View all →</button>
                              </div>
                              {closeoutAllSubmittals.map(s => {
                                const done = s.review_status === "Approved"
                                return (
                                  <div key={s.id} className="flex items-center gap-3 px-4 py-2 border-b border-[#E2E8F0]/20 last:border-0 hover:bg-[#0F172A]/[0.02]">
                                    <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: done ? "#10b981" : "#ef4444" }} />
                                    <span className="text-[11px] text-[#64748B] font-mono flex-shrink-0 w-16 truncate">{s.csi_section ?? s.csi_division ?? "—"}</span>
                                    <span className={`flex-1 text-[12px] truncate ${done ? "text-[#64748B] line-through" : "text-[#0F172A]"}`}>{s.file_name}</span>
                                    <span className={`text-[11px] font-semibold flex-shrink-0 ${done ? "text-emerald-400" : "text-amber-400"}`}>{s.review_status ?? "Pending"}</span>
                                  </div>
                                )
                              })}
                            </div>
                          )}

                          {/* RFIs sub-section */}
                          {closeoutAllRFIs.length > 0 && (
                            <div className="border-b border-[#E2E8F0]/40">
                              <div className="flex items-center justify-between px-4 py-2 bg-white/30">
                                <span className="text-[11px] font-bold text-[#64748B] uppercase tracking-wider">RFIs ({resolvedRFIs}/{closeoutAllRFIs.length} Resolved)</span>
                                <button onClick={() => setActiveModule("rfis")} className="text-[10px] text-[#7B9BB5] hover:text-[#7B9BB5]">View all →</button>
                              </div>
                              {closeoutAllRFIs.map(r => {
                                const done = r.status === "Closed"
                                return (
                                  <div key={r.id} className="flex items-center gap-3 px-4 py-2 border-b border-[#E2E8F0]/20 last:border-0 hover:bg-[#0F172A]/[0.02]">
                                    <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: done ? "#10b981" : "#f59e0b" }} />
                                    <span className="text-[11px] text-[#64748B] font-mono flex-shrink-0">{r.rfi_number}</span>
                                    <span className={`flex-1 text-[12px] truncate ${done ? "text-[#64748B] line-through" : "text-[#0F172A]"}`}>{r.subject}</span>
                                    <span className={`text-[11px] font-semibold flex-shrink-0 ${done ? "text-emerald-400" : "text-amber-400"}`}>{r.status}</span>
                                  </div>
                                )
                              })}
                            </div>
                          )}

                          {/* Change Orders sub-section */}
                          {closeoutAllCOs.length > 0 && (
                            <div className="border-b border-[#E2E8F0]/40">
                              <div className="flex items-center justify-between px-4 py-2 bg-white/30">
                                <span className="text-[11px] font-bold text-[#64748B] uppercase tracking-wider">Change Orders ({approvedCOs}/{closeoutAllCOs.length} Signed)</span>
                                <button onClick={() => setActiveModule("changeorders")} className="text-[10px] text-[#7B9BB5] hover:text-[#7B9BB5]">View all →</button>
                              </div>
                              {closeoutAllCOs.map(c => {
                                const done = c.status === "Approved"
                                return (
                                  <div key={c.id} className="flex items-center gap-3 px-4 py-2 border-b border-[#E2E8F0]/20 last:border-0 hover:bg-[#0F172A]/[0.02]">
                                    <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: done ? "#10b981" : "#ef4444" }} />
                                    <span className="text-[11px] text-[#64748B] font-mono flex-shrink-0">CO-{c.co_number}</span>
                                    <span className={`flex-1 text-[12px] truncate ${done ? "text-[#64748B] line-through" : "text-[#0F172A]"}`}>{c.proposal ?? "—"}</span>
                                    <span className={`text-[11px] font-semibold flex-shrink-0 ${done ? "text-emerald-400" : "text-red-400"}`}>{c.status}</span>
                                  </div>
                                )
                              })}
                            </div>
                          )}

                          {/* Drawings sub-section */}
                          {closeoutAllDrawings.length > 0 && (
                            <div className="border-b border-[#E2E8F0]/40">
                              <div className="flex items-center justify-between px-4 py-2 bg-white/30">
                                <span className="text-[11px] font-bold text-[#64748B] uppercase tracking-wider">Drawings — As-Built ({asBuiltDwgs}/{closeoutAllDrawings.length} Confirmed)</span>
                                <button onClick={() => setActiveModule("drawings")} className="text-[10px] text-[#7B9BB5] hover:text-[#7B9BB5]">View all →</button>
                              </div>
                              {closeoutAllDrawings.map(d => {
                                const done = d.status === "As-Built"
                                return (
                                  <div key={d.id} className="flex items-center gap-3 px-4 py-2 border-b border-[#E2E8F0]/20 last:border-0 hover:bg-[#0F172A]/[0.02]">
                                    <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: done ? "#10b981" : "#f59e0b" }} />
                                    <span className="text-[11px] text-[#64748B] font-mono flex-shrink-0 w-16 truncate">{d.drawing_number}</span>
                                    <span className={`flex-1 text-[12px] truncate ${done ? "text-[#64748B] line-through" : "text-[#0F172A]"}`}>{d.sheet_title}</span>
                                    <span className={`text-[11px] font-semibold flex-shrink-0 ${done ? "text-emerald-400" : "text-amber-400"}`}>{d.status}</span>
                                  </div>
                                )
                              })}
                            </div>
                          )}

                          {/* Stored doc items (O&M, startup, commissioning) */}
                          {storedDocs.map(item => {
                            const isEditing = closeoutEditId === item.id
                            const typeLabel = item.item_type === "om_manual" ? "O&M" : item.item_type === "startup" ? "Start-Up" : item.item_type === "commissioning" ? "Commission" : ""
                            return (
                              <div key={item.id} className="border-b border-[#E2E8F0]/40 last:border-0">
                                <div className={`flex items-center gap-3 px-4 py-3 hover:bg-[#0F172A]/[0.02] transition-colors ${isEditing ? "bg-[#0F172A]/[0.02]" : ""}`}>
                                  <button title={`Click to mark ${cycleStatus(item.status)}`} onClick={() => updateCloseoutItem(item.id, { status: cycleStatus(item.status) })}
                                    className="flex-shrink-0 w-5 h-5 rounded-full border-2 transition-all hover:scale-110"
                                    style={{ borderColor: dotColor(item.status), backgroundColor: item.status === "complete" ? dotColor(item.status) : "transparent" }} />
                                  {typeLabel && <span className="text-[10px] font-bold text-[#64748B] bg-[#F4F5F7] px-1.5 py-0.5 rounded flex-shrink-0">{typeLabel}</span>}
                                  <span className={`flex-1 text-[13px] font-medium truncate ${item.status === "complete" ? "text-[#64748B] line-through" : "text-[#0F172A]"}`}>{item.title}</span>
                                  <span className={`text-[11px] font-semibold flex-shrink-0 ${labelColor(item.status)}`}>{statusLabel(item.status)}</span>
                                  {item.file_name ? (
                                    <span className="text-[11px] text-emerald-400 flex-shrink-0 hidden lg:block truncate max-w-[100px]">attached</span>
                                  ) : (
                                    <button onClick={() => { setCloseoutUploadingId(item.id); closeoutFileRef.current?.click() }} disabled={closeoutUploadingId === item.id}
                                      className="text-[11px] text-[#64748B] hover:text-[#7B9BB5] flex-shrink-0 hidden lg:block disabled:opacity-50">
                                      {closeoutUploadingId === item.id ? "Uploading…" : "+ Doc"}
                                    </button>
                                  )}
                                  <div className="flex items-center gap-1 flex-shrink-0">
                                    <button onClick={() => { if (isEditing) { setCloseoutEditId(null); return } setCloseoutEditId(item.id); setCloseoutEditTitle(item.title); setCloseoutEditAssigned(item.assigned_to ?? ""); setCloseoutEditDue(item.due_date ?? ""); setCloseoutEditNotes(item.notes ?? "") }}
                                      className={`text-[11px] px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors ${isEditing ? "text-[#7B9BB5]" : "text-[#64748B] hover:text-[#64748B]"}`}>
                                      {isEditing ? "Close" : "Edit"}
                                    </button>
                                    <button onClick={() => deleteCloseoutItem(item.id)} className="text-[11px] text-[#64748B] hover:text-red-400 px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">Del</button>
                                  </div>
                                </div>
                                {isEditing && (
                                  <div className="px-4 pb-4 pt-2 border-t border-[#E2E8F0]/40 bg-white/30 space-y-3">
                                    <div className="grid grid-cols-2 gap-3">
                                      <div><label className="block text-[11px] font-medium text-[#64748B] mb-1">Title</label>
                                        <input value={closeoutEditTitle} onChange={e => setCloseoutEditTitle(e.target.value)} className="w-full h-8 px-2 rounded border border-[#E2E8F0] bg-white text-[12px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" /></div>
                                      <div><label className="block text-[11px] font-medium text-[#64748B] mb-1">Status</label>
                                        <select value={item.status} onChange={e => updateCloseoutItem(item.id, { status: e.target.value })} className="w-full h-8 px-2 rounded border border-[#E2E8F0] bg-white text-[12px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                                          <option value="incomplete">Incomplete</option><option value="in_progress">In Progress</option><option value="complete">Complete</option>
                                        </select></div>
                                      <div><label className="block text-[11px] font-medium text-[#64748B] mb-1">Due Date</label>
                                        <input type="date" value={closeoutEditDue} onChange={e => setCloseoutEditDue(e.target.value)} className="w-full h-8 px-2 rounded border border-[#E2E8F0] bg-white text-[12px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" /></div>
                                      <div><label className="block text-[11px] font-medium text-[#64748B] mb-1">Notes</label>
                                        <input value={closeoutEditNotes} onChange={e => setCloseoutEditNotes(e.target.value)} className="w-full h-8 px-2 rounded border border-[#E2E8F0] bg-white text-[12px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" /></div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <button onClick={() => { setCloseoutUploadingId(item.id); closeoutFileRef.current?.click() }} className="text-[11px] text-[#64748B] hover:text-[#7B9BB5] px-2 py-1 border border-[#E2E8F0] rounded hover:border-[#E2E8F0] transition-colors">
                                        {item.file_name ? `attached: ${item.file_name.slice(0,25)}` : "+ Upload Document"}
                                      </button>
                                      <div className="flex-1" />
                                      <button onClick={() => setCloseoutEditId(null)} className="text-[12px] text-[#64748B] hover:text-[#64748B] px-3 py-1.5 rounded">Cancel</button>
                                      <button onClick={async () => { await updateCloseoutItem(item.id, { title: closeoutEditTitle, due_date: closeoutEditDue || null, notes: closeoutEditNotes || null }); setCloseoutEditId(null) }}
                                        className="text-[12px] font-semibold text-[#0F172A] bg-[#7B9BB5] hover:bg-[#6A8AA4] px-4 py-1.5 rounded">Save</button>
                                    </div>
                                  </div>
                                )}
                              </div>
                            )
                          })}
                          {storedDocs.length === 0 && closeoutAllSubmittals.length === 0 && closeoutAllRFIs.length === 0 && closeoutAllCOs.length === 0 && closeoutAllDrawings.length === 0 && (
                            <div className="px-4 py-3 text-[12px] text-[#64748B] italic">No documents yet. Initialize the checklist or add project data.</div>
                          )}
                        </div>
                      )
                    })()}

                    {/* ── STANDARD CHECKLIST CATEGORIES (Inspections, Warranties, Training, Handover) ── */}
                    {CATS.filter(c => c.key !== "documents" && c.key !== "subcontractors" && c.key !== "suppliers").map(cat => {
                      const items = closeoutItems.filter(i => i.category === cat.key)
                      return (
                        <div key={cat.key} className="bg-white rounded-xl border border-[#E2E8F0] overflow-hidden">
                          <div className="flex items-center justify-between px-4 py-3 border-b border-[#E2E8F0]">
                            <div className="flex items-center gap-2">
                              <span className="text-[13px] font-bold text-[#0F172A]">{cat.label}</span>
                              <span className="text-[11px] text-[#64748B]">{cat.done}/{cat.total} complete</span>
                            </div>
                            <button onClick={() => { setNewCloseoutCategory(cat.key); setShowNewCloseout(true) }} className="text-[11px] text-white/70 hover:text-white transition-colors flex items-center gap-1"><PlusIcon /> Add</button>
                          </div>

                          {items.length === 0 && (
                            <div className="px-4 py-3 text-[12px] text-[#64748B] italic">No items. Reinitialize or add manually.</div>
                          )}
                          {items.map(item => {
                            const isEditing = closeoutEditId === item.id
                            const isLienConditional = item.item_type === "lien_waiver_conditional"
                            const isLienUnconditional = item.item_type === "lien_waiver_unconditional"
                            const isWarranty = cat.key === "warranties"
                            const isTraining = cat.key === "training"
                            return (
                              <div key={item.id} className="border-b border-[#E2E8F0]/40 last:border-0">
                                <div className={`flex items-center gap-3 px-4 py-3 hover:bg-[#0F172A]/[0.02] transition-colors ${isEditing ? "bg-[#0F172A]/[0.02]" : ""}`}>
                                  <button title={`Click to mark ${cycleStatus(item.status)}`} onClick={() => updateCloseoutItem(item.id, { status: cycleStatus(item.status) })}
                                    className="flex-shrink-0 w-5 h-5 rounded-full border-2 transition-all hover:scale-110"
                                    style={{ borderColor: dotColor(item.status), backgroundColor: item.status === "complete" ? dotColor(item.status) : "transparent" }} />
                                  {/* Type badge for lien waivers */}
                                  {(isLienConditional || isLienUnconditional) && (
                                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded flex-shrink-0 ${isLienConditional ? "bg-amber-500/20 text-amber-400" : "bg-emerald-500/20 text-emerald-400"}`}>
                                      {isLienConditional ? "CONDITIONAL" : "UNCONDITIONAL"}
                                    </span>
                                  )}
                                  {isWarranty && item.notes && (
                                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded flex-shrink-0 bg-[#7B9BB5]/20 text-[#7B9BB5]">{item.notes}</span>
                                  )}
                                  <span className={`flex-1 text-[13px] font-medium truncate ${item.status === "complete" ? "text-[#64748B] line-through" : "text-[#0F172A]"}`}>{item.title}</span>
                                  {/* Trainer / date for training items */}
                                  {isTraining && item.assigned_to && (
                                    <span className="text-[11px] text-[#64748B] hidden md:block flex-shrink-0">{item.assigned_to}</span>
                                  )}
                                  {/* Expiry date for warranties */}
                                  {isWarranty && item.due_date && (
                                    <span className={`text-[11px] flex-shrink-0 hidden md:block ${new Date(item.due_date+"T00:00:00") < new Date() ? "text-red-400" : "text-[#64748B]"}`}>
                                      exp {new Date(item.due_date+"T00:00:00").toLocaleDateString("en-US",{month:"short",year:"numeric"})}
                                    </span>
                                  )}
                                  <span className={`text-[11px] font-semibold flex-shrink-0 hidden sm:block ${labelColor(item.status)}`}>{statusLabel(item.status)}</span>
                                  {item.file_name ? (
                                    <span className="text-[11px] text-emerald-400 flex-shrink-0 hidden lg:block">attached</span>
                                  ) : (
                                    <button onClick={() => { setCloseoutUploadingId(item.id); closeoutFileRef.current?.click() }} disabled={closeoutUploadingId === item.id}
                                      className="text-[11px] text-[#64748B] hover:text-[#7B9BB5] flex-shrink-0 hidden lg:block disabled:opacity-50">
                                      {closeoutUploadingId === item.id ? "Uploading…" : "+ Doc"}
                                    </button>
                                  )}
                                  <div className="flex items-center gap-1 flex-shrink-0">
                                    <button onClick={() => { if (isEditing) { setCloseoutEditId(null); return } setCloseoutEditId(item.id); setCloseoutEditTitle(item.title); setCloseoutEditAssigned(item.assigned_to ?? ""); setCloseoutEditDue(item.due_date ?? ""); setCloseoutEditNotes(item.notes ?? "") }}
                                      className={`text-[11px] px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors ${isEditing ? "text-[#7B9BB5]" : "text-[#64748B] hover:text-[#64748B]"}`}>
                                      {isEditing ? "Close" : "Edit"}
                                    </button>
                                    <button onClick={() => deleteCloseoutItem(item.id)} className="text-[11px] text-[#64748B] hover:text-red-400 px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">Del</button>
                                  </div>
                                </div>
                                {isEditing && (
                                  <div className="px-4 pb-4 pt-2 border-t border-[#E2E8F0]/40 bg-white/30 space-y-3">
                                    <div className="grid grid-cols-2 gap-3">
                                      <div><label className="block text-[11px] font-medium text-[#64748B] mb-1">Title</label>
                                        <input value={closeoutEditTitle} onChange={e => setCloseoutEditTitle(e.target.value)} className="w-full h-8 px-2 rounded border border-[#E2E8F0] bg-white text-[12px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" /></div>
                                      <div><label className="block text-[11px] font-medium text-[#64748B] mb-1">Status</label>
                                        <select value={item.status} onChange={e => updateCloseoutItem(item.id, { status: e.target.value })} className="w-full h-8 px-2 rounded border border-[#E2E8F0] bg-white text-[12px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                                          <option value="incomplete">Incomplete</option><option value="in_progress">In Progress</option><option value="complete">Complete</option>
                                        </select></div>
                                      <div><label className="block text-[11px] font-medium text-[#64748B] mb-1">{isTraining ? "Trainer Name" : isWarranty ? "Warrantor" : "Assigned To"}</label>
                                        <input value={closeoutEditAssigned} onChange={e => setCloseoutEditAssigned(e.target.value)} className="w-full h-8 px-2 rounded border border-[#E2E8F0] bg-white text-[12px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" /></div>
                                      <div><label className="block text-[11px] font-medium text-[#64748B] mb-1">{isTraining ? "Training Date" : isWarranty ? "Expiration Date" : "Due Date"}</label>
                                        <input type="date" value={closeoutEditDue} onChange={e => setCloseoutEditDue(e.target.value)} className="w-full h-8 px-2 rounded border border-[#E2E8F0] bg-white text-[12px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" /></div>
                                    </div>
                                    <div><label className="block text-[11px] font-medium text-[#64748B] mb-1">Notes</label>
                                      <input value={closeoutEditNotes} onChange={e => setCloseoutEditNotes(e.target.value)} placeholder="Add notes…" className="w-full h-8 px-2 rounded border border-[#E2E8F0] bg-white text-[12px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 placeholder:text-[#64748B]" /></div>
                                    <div className="flex items-center gap-2">
                                      <button onClick={() => { setCloseoutUploadingId(item.id); closeoutFileRef.current?.click() }} className="text-[11px] text-[#64748B] hover:text-[#7B9BB5] px-2 py-1 border border-[#E2E8F0] rounded hover:border-[#E2E8F0] transition-colors">
                                        {item.file_name ? `attached: ${item.file_name.slice(0,25)}` : "+ Upload Document"}
                                      </button>
                                      <div className="flex-1" />
                                      <button onClick={() => setCloseoutEditId(null)} className="text-[12px] text-[#64748B] hover:text-[#64748B] px-3 py-1.5 rounded">Cancel</button>
                                      <button onClick={async () => { await updateCloseoutItem(item.id, { title: closeoutEditTitle, assigned_to: closeoutEditAssigned || null, due_date: closeoutEditDue || null, notes: closeoutEditNotes || null }); setCloseoutEditId(null) }}
                                        className="text-[12px] font-semibold text-[#0F172A] bg-[#7B9BB5] hover:bg-[#6A8AA4] px-4 py-1.5 rounded">Save</button>
                                    </div>
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      )
                    })}

                    {/* ── SUBCONTRACTOR FOLDERS ─────────────────────────────── */}
                    {subItems.length > 0 && (() => {
                      const folders = [...new Set(subItems.map(i => i.folder_name).filter(Boolean))] as string[]
                      const unfolderedItems = subItems.filter(i => !i.folder_name)
                      return (
                        <div className="bg-white rounded-xl border border-[#E2E8F0] overflow-hidden">
                          <div className="flex items-center justify-between px-4 py-3 border-b border-[#E2E8F0]">
                            <div className="flex items-center gap-2">
                              <span className="text-[13px] font-bold text-[#0F172A]">Subcontractors</span>
                              <span className="text-[11px] text-[#64748B]">{subItems.filter(i=>i.status==="complete").length}/{subItems.length} complete</span>
                            </div>
                            <button onClick={() => { setNewFolderType("subcontractors"); setShowAddFolder(true) }} className="text-[11px] text-[#64748B] hover:text-[#0F172A] transition-colors flex items-center gap-1"><PlusIcon /> Add Folder</button>
                          </div>
                          {folders.map(folder => {
                            const folderItems = subItems.filter(i => i.folder_name === folder)
                            const folderDone = folderItems.filter(i => i.status === "complete").length
                            return (
                              <div key={folder} className="border-b border-[#E2E8F0]/40 last:border-0">
                                <div className="flex items-center justify-between px-4 py-2 bg-[#F8F9FA]">
                                  <div className="flex items-center gap-2">
                                    <svg className="w-3.5 h-3.5 text-[#64748B] flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" /></svg>
                                    <span className="text-[12px] font-bold text-[#0F172A]">{folder}</span>
                                  </div>
                                  <span className="text-[10px] text-[#64748B]">{folderDone}/{folderItems.length}</span>
                                </div>
                                {folderItems.map(item => {
                                  const isEditing = closeoutEditId === item.id
                                  return (
                                    <div key={item.id} className="border-b border-[#E2E8F0]/20 last:border-0">
                                      <div className={`flex items-center gap-3 px-4 pl-10 py-2.5 hover:bg-[#0F172A]/[0.02] transition-colors ${isEditing ? "bg-[#0F172A]/[0.02]" : ""}`}>
                                        <button title={`Click to mark ${cycleStatus(item.status)}`} onClick={() => updateCloseoutItem(item.id, { status: cycleStatus(item.status) })}
                                          className="flex-shrink-0 w-4 h-4 rounded-full border-2 transition-all hover:scale-110"
                                          style={{ borderColor: dotColor(item.status), backgroundColor: item.status === "complete" ? dotColor(item.status) : "transparent" }} />
                                        <span className={`flex-1 text-[12px] font-medium truncate ${item.status === "complete" ? "text-[#64748B] line-through" : "text-[#0F172A]"}`}>{item.title}</span>
                                        <span className={`text-[11px] font-semibold flex-shrink-0 hidden sm:block ${labelColor(item.status)}`}>{statusLabel(item.status)}</span>
                                        {item.file_name ? (
                                          <span className="text-[11px] text-emerald-400 flex-shrink-0 hidden lg:block">attached</span>
                                        ) : (
                                          <button onClick={() => { setCloseoutUploadingId(item.id); closeoutFileRef.current?.click() }} disabled={closeoutUploadingId === item.id}
                                            className="text-[11px] text-[#64748B] hover:text-[#7B9BB5] flex-shrink-0 hidden lg:block disabled:opacity-50">
                                            {closeoutUploadingId === item.id ? "Uploading…" : "+ Doc"}
                                          </button>
                                        )}
                                        <div className="flex items-center gap-1 flex-shrink-0">
                                          <button onClick={() => { if (isEditing) { setCloseoutEditId(null); return } setCloseoutEditId(item.id); setCloseoutEditTitle(item.title); setCloseoutEditAssigned(item.assigned_to ?? ""); setCloseoutEditDue(item.due_date ?? ""); setCloseoutEditNotes(item.notes ?? "") }}
                                            className={`text-[11px] px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors ${isEditing ? "text-[#7B9BB5]" : "text-[#64748B]"}`}>
                                            {isEditing ? "Close" : "Edit"}
                                          </button>
                                          <button onClick={() => deleteCloseoutItem(item.id)} className="text-[11px] text-[#64748B] hover:text-red-400 px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">Del</button>
                                        </div>
                                      </div>
                                      {isEditing && (
                                        <div className="px-4 pl-10 pb-4 pt-2 border-t border-[#E2E8F0]/40 bg-white/30 space-y-3">
                                          <div className="grid grid-cols-2 gap-3">
                                            <div><label className="block text-[11px] font-medium text-[#64748B] mb-1">Title</label>
                                              <input value={closeoutEditTitle} onChange={e => setCloseoutEditTitle(e.target.value)} className="w-full h-8 px-2 rounded border border-[#E2E8F0] bg-white text-[12px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" /></div>
                                            <div><label className="block text-[11px] font-medium text-[#64748B] mb-1">Status</label>
                                              <select value={item.status} onChange={e => updateCloseoutItem(item.id, { status: e.target.value })} className="w-full h-8 px-2 rounded border border-[#E2E8F0] bg-white text-[12px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                                                <option value="incomplete">Incomplete</option><option value="in_progress">In Progress</option><option value="complete">Complete</option>
                                              </select></div>
                                            <div><label className="block text-[11px] font-medium text-[#64748B] mb-1">Notes</label>
                                              <input value={closeoutEditNotes} onChange={e => setCloseoutEditNotes(e.target.value)} className="w-full h-8 px-2 rounded border border-[#E2E8F0] bg-white text-[12px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" /></div>
                                            <div><label className="block text-[11px] font-medium text-[#64748B] mb-1">Due Date</label>
                                              <input type="date" value={closeoutEditDue} onChange={e => setCloseoutEditDue(e.target.value)} className="w-full h-8 px-2 rounded border border-[#E2E8F0] bg-white text-[12px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" /></div>
                                          </div>
                                          <div className="flex items-center gap-2">
                                            <button onClick={() => { setCloseoutUploadingId(item.id); closeoutFileRef.current?.click() }} className="text-[11px] text-[#64748B] hover:text-[#7B9BB5] px-2 py-1 border border-[#E2E8F0] rounded transition-colors">
                                              {item.file_name ? `attached: ${item.file_name.slice(0,25)}` : "+ Upload Document"}
                                            </button>
                                            <div className="flex-1" />
                                            <button onClick={() => setCloseoutEditId(null)} className="text-[12px] text-[#64748B] px-3 py-1.5 rounded">Cancel</button>
                                            <button onClick={async () => { await updateCloseoutItem(item.id, { title: closeoutEditTitle, due_date: closeoutEditDue || null, notes: closeoutEditNotes || null }); setCloseoutEditId(null) }}
                                              className="text-[12px] font-semibold text-white bg-[#7B9BB5] hover:bg-[#6A8AA4] px-4 py-1.5 rounded">Save</button>
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  )
                                })}
                                <div className="px-4 pl-10 py-1.5">
                                  <button onClick={() => { setNewCloseoutCategory("subcontractors"); setNewCloseoutFolder(folder); setShowNewCloseout(true) }}
                                    className="text-[11px] text-[#64748B] hover:text-[#7B9BB5] transition-colors flex items-center gap-1">
                                    <PlusIcon /> Add item to {folder}
                                  </button>
                                </div>
                              </div>
                            )
                          })}
                          {unfolderedItems.map(item => {
                            const isEditing = closeoutEditId === item.id
                            return (
                              <div key={item.id} className="border-b border-[#E2E8F0]/40 last:border-0">
                                <div className={`flex items-center gap-3 px-4 py-3 hover:bg-[#0F172A]/[0.02] transition-colors ${isEditing ? "bg-[#0F172A]/[0.02]" : ""}`}>
                                  <button onClick={() => updateCloseoutItem(item.id, { status: cycleStatus(item.status) })}
                                    className="flex-shrink-0 w-5 h-5 rounded-full border-2 transition-all hover:scale-110"
                                    style={{ borderColor: dotColor(item.status), backgroundColor: item.status === "complete" ? dotColor(item.status) : "transparent" }} />
                                  <span className={`flex-1 text-[13px] font-medium truncate ${item.status === "complete" ? "text-[#64748B] line-through" : "text-[#0F172A]"}`}>{item.title}</span>
                                  <span className={`text-[11px] font-semibold flex-shrink-0 hidden sm:block ${labelColor(item.status)}`}>{statusLabel(item.status)}</span>
                                  <button onClick={() => deleteCloseoutItem(item.id)} className="text-[11px] text-[#64748B] hover:text-red-400 px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">Del</button>
                                </div>
                              </div>
                            )
                          })}
                          {folders.length === 0 && unfolderedItems.length === 0 && (
                            <div className="px-4 py-3 text-[12px] text-[#64748B] italic">No subcontractor folders. Use + Add Folder to create one.</div>
                          )}
                        </div>
                      )
                    })()}

                    {/* ── SUPPLIER FOLDERS ──────────────────────────────────── */}
                    {supplItems.length > 0 && (() => {
                      const folders = [...new Set(supplItems.map(i => i.folder_name).filter(Boolean))] as string[]
                      const unfolderedItems = supplItems.filter(i => !i.folder_name)
                      return (
                        <div className="bg-white rounded-xl border border-[#E2E8F0] overflow-hidden">
                          <div className="flex items-center justify-between px-4 py-3 border-b border-[#E2E8F0]">
                            <div className="flex items-center gap-2">
                              <span className="text-[13px] font-bold text-[#0F172A]">Suppliers</span>
                              <span className="text-[11px] text-[#64748B]">{supplItems.filter(i=>i.status==="complete").length}/{supplItems.length} complete</span>
                            </div>
                            <button onClick={() => { setNewFolderType("suppliers"); setShowAddFolder(true) }} className="text-[11px] text-[#64748B] hover:text-[#0F172A] transition-colors flex items-center gap-1"><PlusIcon /> Add Folder</button>
                          </div>
                          {folders.map(folder => {
                            const folderItems = supplItems.filter(i => i.folder_name === folder)
                            const folderDone = folderItems.filter(i => i.status === "complete").length
                            return (
                              <div key={folder} className="border-b border-[#E2E8F0]/40 last:border-0">
                                <div className="flex items-center justify-between px-4 py-2 bg-[#F8F9FA]">
                                  <div className="flex items-center gap-2">
                                    <svg className="w-3.5 h-3.5 text-[#64748B] flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" /></svg>
                                    <span className="text-[12px] font-bold text-[#0F172A]">{folder}</span>
                                  </div>
                                  <span className="text-[10px] text-[#64748B]">{folderDone}/{folderItems.length}</span>
                                </div>
                                {folderItems.map(item => {
                                  const isEditing = closeoutEditId === item.id
                                  return (
                                    <div key={item.id} className="border-b border-[#E2E8F0]/20 last:border-0">
                                      <div className={`flex items-center gap-3 px-4 pl-10 py-2.5 hover:bg-[#0F172A]/[0.02] transition-colors ${isEditing ? "bg-[#0F172A]/[0.02]" : ""}`}>
                                        <button title={`Click to mark ${cycleStatus(item.status)}`} onClick={() => updateCloseoutItem(item.id, { status: cycleStatus(item.status) })}
                                          className="flex-shrink-0 w-4 h-4 rounded-full border-2 transition-all hover:scale-110"
                                          style={{ borderColor: dotColor(item.status), backgroundColor: item.status === "complete" ? dotColor(item.status) : "transparent" }} />
                                        <span className={`flex-1 text-[12px] font-medium truncate ${item.status === "complete" ? "text-[#64748B] line-through" : "text-[#0F172A]"}`}>{item.title}</span>
                                        <span className={`text-[11px] font-semibold flex-shrink-0 hidden sm:block ${labelColor(item.status)}`}>{statusLabel(item.status)}</span>
                                        {item.file_name ? (
                                          <span className="text-[11px] text-emerald-400 flex-shrink-0 hidden lg:block">attached</span>
                                        ) : (
                                          <button onClick={() => { setCloseoutUploadingId(item.id); closeoutFileRef.current?.click() }} disabled={closeoutUploadingId === item.id}
                                            className="text-[11px] text-[#64748B] hover:text-[#7B9BB5] flex-shrink-0 hidden lg:block disabled:opacity-50">
                                            {closeoutUploadingId === item.id ? "Uploading…" : "+ Doc"}
                                          </button>
                                        )}
                                        <div className="flex items-center gap-1 flex-shrink-0">
                                          <button onClick={() => { if (isEditing) { setCloseoutEditId(null); return } setCloseoutEditId(item.id); setCloseoutEditTitle(item.title); setCloseoutEditAssigned(item.assigned_to ?? ""); setCloseoutEditDue(item.due_date ?? ""); setCloseoutEditNotes(item.notes ?? "") }}
                                            className={`text-[11px] px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors ${isEditing ? "text-[#7B9BB5]" : "text-[#64748B]"}`}>
                                            {isEditing ? "Close" : "Edit"}
                                          </button>
                                          <button onClick={() => deleteCloseoutItem(item.id)} className="text-[11px] text-[#64748B] hover:text-red-400 px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">Del</button>
                                        </div>
                                      </div>
                                      {isEditing && (
                                        <div className="px-4 pl-10 pb-4 pt-2 border-t border-[#E2E8F0]/40 bg-white/30 space-y-3">
                                          <div className="grid grid-cols-2 gap-3">
                                            <div><label className="block text-[11px] font-medium text-[#64748B] mb-1">Title</label>
                                              <input value={closeoutEditTitle} onChange={e => setCloseoutEditTitle(e.target.value)} className="w-full h-8 px-2 rounded border border-[#E2E8F0] bg-white text-[12px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" /></div>
                                            <div><label className="block text-[11px] font-medium text-[#64748B] mb-1">Status</label>
                                              <select value={item.status} onChange={e => updateCloseoutItem(item.id, { status: e.target.value })} className="w-full h-8 px-2 rounded border border-[#E2E8F0] bg-white text-[12px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                                                <option value="incomplete">Incomplete</option><option value="in_progress">In Progress</option><option value="complete">Complete</option>
                                              </select></div>
                                            <div><label className="block text-[11px] font-medium text-[#64748B] mb-1">Notes</label>
                                              <input value={closeoutEditNotes} onChange={e => setCloseoutEditNotes(e.target.value)} className="w-full h-8 px-2 rounded border border-[#E2E8F0] bg-white text-[12px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" /></div>
                                            <div><label className="block text-[11px] font-medium text-[#64748B] mb-1">Due Date</label>
                                              <input type="date" value={closeoutEditDue} onChange={e => setCloseoutEditDue(e.target.value)} className="w-full h-8 px-2 rounded border border-[#E2E8F0] bg-white text-[12px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" /></div>
                                          </div>
                                          <div className="flex items-center gap-2">
                                            <button onClick={() => { setCloseoutUploadingId(item.id); closeoutFileRef.current?.click() }} className="text-[11px] text-[#64748B] hover:text-[#7B9BB5] px-2 py-1 border border-[#E2E8F0] rounded transition-colors">
                                              {item.file_name ? `attached: ${item.file_name.slice(0,25)}` : "+ Upload Document"}
                                            </button>
                                            <div className="flex-1" />
                                            <button onClick={() => setCloseoutEditId(null)} className="text-[12px] text-[#64748B] px-3 py-1.5 rounded">Cancel</button>
                                            <button onClick={async () => { await updateCloseoutItem(item.id, { title: closeoutEditTitle, due_date: closeoutEditDue || null, notes: closeoutEditNotes || null }); setCloseoutEditId(null) }}
                                              className="text-[12px] font-semibold text-white bg-[#7B9BB5] hover:bg-[#6A8AA4] px-4 py-1.5 rounded">Save</button>
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  )
                                })}
                                <div className="px-4 pl-10 py-1.5">
                                  <button onClick={() => { setNewCloseoutCategory("suppliers"); setNewCloseoutFolder(folder); setShowNewCloseout(true) }}
                                    className="text-[11px] text-[#64748B] hover:text-[#7B9BB5] transition-colors flex items-center gap-1">
                                    <PlusIcon /> Add item to {folder}
                                  </button>
                                </div>
                              </div>
                            )
                          })}
                          {unfolderedItems.map(item => {
                            const isEditing = closeoutEditId === item.id
                            return (
                              <div key={item.id} className="border-b border-[#E2E8F0]/40 last:border-0">
                                <div className={`flex items-center gap-3 px-4 py-3 hover:bg-[#0F172A]/[0.02] transition-colors ${isEditing ? "bg-[#0F172A]/[0.02]" : ""}`}>
                                  <button onClick={() => updateCloseoutItem(item.id, { status: cycleStatus(item.status) })}
                                    className="flex-shrink-0 w-5 h-5 rounded-full border-2 transition-all hover:scale-110"
                                    style={{ borderColor: dotColor(item.status), backgroundColor: item.status === "complete" ? dotColor(item.status) : "transparent" }} />
                                  <span className={`flex-1 text-[13px] font-medium truncate ${item.status === "complete" ? "text-[#64748B] line-through" : "text-[#0F172A]"}`}>{item.title}</span>
                                  <span className={`text-[11px] font-semibold flex-shrink-0 hidden sm:block ${labelColor(item.status)}`}>{statusLabel(item.status)}</span>
                                  <button onClick={() => deleteCloseoutItem(item.id)} className="text-[11px] text-[#64748B] hover:text-red-400 px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">Del</button>
                                </div>
                              </div>
                            )
                          })}
                          {folders.length === 0 && unfolderedItems.length === 0 && (
                            <div className="px-4 py-3 text-[12px] text-[#64748B] italic">No supplier folders. Use + Add Folder to create one.</div>
                          )}
                        </div>
                      )
                    })()}

                    {/* All clear */}
                    {openPunchCount === 0 && closeoutSubmittals.length === 0 && closeoutRFIs.length === 0 && closeoutCOs.length === 0 && closeoutDrawings.length === 0 && closeoutItems.every(i => i.status === "complete") && (
                      <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-6 text-center">
                        <p className="text-[15px] font-bold text-emerald-400">Project is ready for closeout</p>
                        <p className="text-[13px] text-[#64748B] mt-1">All checklist items complete and no flagged items.</p>
                        <button disabled={closeoutGenerating}
                          onClick={async () => { setCloseoutGenerating(true); const res = await fetch("/api/closeout/pdf", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project_id: globalProjectId }) }); const d = await res.json(); if (d.url) window.open(d.url, "_blank"); setCloseoutGenerating(false) }}
                          className="mt-4 h-9 px-5 rounded-lg bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors inline-flex items-center gap-2 disabled:opacity-50">
                          {closeoutGenerating ? <><SpinnerIcon className="h-3.5 w-3.5" /> Generating…</> : "Generate Final Closeout Package"}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </>
            )
          })()}
        </div>
      </div>

      {/* ── Add Closeout Item modal ───────────────────────────────────────── */}
      {showNewCloseout && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center" onClick={e => { if (e.target === e.currentTarget) setShowNewCloseout(false) }}>
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[480px] mx-4 sm:mx-0 p-6">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-[15px] font-bold text-[#0F172A]">Add Closeout Item</h2>
              <button onClick={() => setShowNewCloseout(false)} className="text-[#64748B] hover:text-[#64748B] transition-colors"><XIcon className="h-4 w-4" /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className={labelCls}>Category</label>
                <select value={newCloseoutCategory} onChange={e => { setNewCloseoutCategory(e.target.value); setNewCloseoutFolder("") }} className={inputCls}>
                  <option value="documents">Documents</option>
                  <option value="inspections">Inspections</option>
                  <option value="training">Training</option>
                  <option value="handover">Handover</option>
                  <option value="warranties">Warranties</option>
                  <option value="subcontractors">Subcontractors</option>
                  <option value="suppliers">Suppliers</option>
                </select>
              </div>
              {(newCloseoutCategory === "subcontractors" || newCloseoutCategory === "suppliers") && (() => {
                const folderOptions = [...new Set(closeoutItems.filter(i => i.category === newCloseoutCategory && i.folder_name).map(i => i.folder_name))] as string[]
                return (
                  <div>
                    <label className={labelCls}>Folder (Company)</label>
                    <select value={newCloseoutFolder} onChange={e => setNewCloseoutFolder(e.target.value)} className={inputCls}>
                      <option value="">No folder</option>
                      {folderOptions.map(f => <option key={f} value={f}>{f}</option>)}
                    </select>
                  </div>
                )
              })()}
              <div>
                <label className={labelCls}>Title <span className="text-red-400">*</span></label>
                <input value={newCloseoutTitle} onChange={e => setNewCloseoutTitle(e.target.value)} placeholder="e.g. O&M Manual — Elevator" className={inputCls} autoFocus />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Assign To</label>
                  <select value={newCloseoutAssigned} onChange={e => setNewCloseoutAssigned(e.target.value)} className={inputCls}>
                    <option value="">Unassigned</option>
                    {teamMembers.map(m => <option key={m.id} value={m.name}>{m.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Due Date</label>
                  <input type="date" value={newCloseoutDue} onChange={e => setNewCloseoutDue(e.target.value)} className={inputCls} />
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button onClick={() => { setShowNewCloseout(false); setNewCloseoutFolder("") }} className="h-9 px-4 rounded-md text-[13px] text-[#64748B] hover:text-[#64748B] transition-colors">Cancel</button>
                <button onClick={addCloseoutItem} disabled={!newCloseoutTitle.trim()} className="h-9 px-5 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50">Add Item</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Add Closeout Folder modal ────────────────────────────────────── */}
      {showAddFolder && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center" onClick={e => { if (e.target === e.currentTarget) setShowAddFolder(false) }}>
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[420px] mx-4 sm:mx-0 p-6">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-[15px] font-bold text-[#0F172A]">Add Folder</h2>
              <button onClick={() => setShowAddFolder(false)} className="text-[#64748B] hover:text-[#64748B] transition-colors"><XIcon className="h-4 w-4" /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className={labelCls}>Type</label>
                <select value={newFolderType} onChange={e => setNewFolderType(e.target.value as "subcontractors"|"suppliers")} className={inputCls}>
                  <option value="subcontractors">Subcontractor</option>
                  <option value="suppliers">Supplier</option>
                </select>
              </div>
              <div>
                <label className={labelCls}>Company Name <span className="text-red-400">*</span></label>
                <input value={newFolderName} onChange={e => setNewFolderName(e.target.value)} placeholder="e.g. ABC Electrical" className={inputCls} autoFocus />
              </div>
              <p className="text-[11px] text-[#64748B]">Default line items will be created automatically for this folder.</p>
              <div className="flex justify-end gap-2 pt-2">
                <button onClick={() => { setShowAddFolder(false); setNewFolderName("") }} className="h-9 px-4 rounded-md text-[13px] text-[#64748B] hover:text-[#64748B] transition-colors">Cancel</button>
                <button onClick={addCloseoutFolder} disabled={!newFolderName.trim()} className="h-9 px-5 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50">Create Folder</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── New / Edit Daily Report modal ────────────────────────────────── */}
      {(showNewDaily || (viewDaily && dailyEditing)) && (() => {
        const isEdit = !!(viewDaily && dailyEditing)
        const onClose = () => { setShowNewDaily(false); setViewDaily(null); setDailyEditing(false) }
        const tareaClass = "w-full px-3 py-2 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 resize-none placeholder:text-[#64748B]"
        return (
          <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
            onClick={e => { if (e.target === e.currentTarget) onClose() }}>
            <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[680px] mx-4 sm:mx-0 max-h-[90vh] flex flex-col">
              <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E2E8F0] flex-shrink-0">
                <h2 className="text-[15px] font-bold text-[#0F172A]">{isEdit ? "Edit Daily Report" : "New Daily Report"}</h2>
                <button onClick={onClose} className="text-[#64748B] hover:text-[#64748B] transition-colors"><XIcon className="h-4 w-4" /></button>
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
                        className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                        <option value="">None</option>
                        {appProjects.map(p => <option key={p.id} value={p.id}>{p.name}{p.number ? ` — ${p.number}` : ""}</option>)}
                      </select>
                    </div>
                    <div className="flex-1">
                      <label className={labelCls}>Prepared By</label>
                      <select value={dailyPreparedBy} onChange={e => setDailyPreparedBy(e.target.value)}
                        className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
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
                        className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
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
                  {!isEdit && (
                    <div>
                      <label className={labelCls}>Attachment <span className="text-[#64748B] font-normal">(optional)</span></label>
                      <input ref={dailyFileRef} type="file" className="w-full text-[12px] text-[#64748B] file:mr-3 file:py-1 file:px-3 file:rounded file:border file:border-[#E2E8F0] file:bg-[#F4F5F7] file:text-[#64748B] file:text-[11px] file:cursor-pointer hover:file:bg-white/[0.05]" />
                    </div>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2 px-6 py-4 border-t border-[#E2E8F0] flex-shrink-0">
                  {!isEdit && dailySaveError ? (
                    <p className="text-[12px] text-red-500 flex-1 mr-2">{dailySaveError}</p>
                  ) : <span />}
                  <div className="flex gap-2 flex-shrink-0">
                    <button type="button" onClick={onClose}
                      className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors">
                      Cancel
                    </button>
                    <button type="submit" disabled={isEdit ? dailyEditSaving : dailySaving}
                      className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 flex items-center gap-2">
                      {(isEdit ? dailyEditSaving : dailySaving) && <SpinnerIcon className="h-3 w-3" />}
                      {isEdit ? (dailyEditSaving ? "Saving…" : "Save Changes") : (dailySaving ? "Creating…" : "Create Report")}
                    </button>
                  </div>
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
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[620px] mx-4 sm:mx-0 max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E2E8F0] flex-shrink-0">
              <div>
                <p className="text-[11px] text-[#64748B] uppercase tracking-widest font-bold">Daily Report</p>
                <h2 className="text-[16px] font-bold text-[#0F172A] mt-0.5">{fmtDateOnly(viewDaily.report_date)}</h2>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => openDailyForEdit(viewDaily)}
                  className="h-7 px-3 rounded-md border border-[#E2E8F0] text-[12px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors">
                  Edit
                </button>
                <button onClick={() => generateDailyPdf(viewDaily.id)} disabled={dailyGeneratingPdf}
                  className="h-7 px-3 rounded-md border border-[#E2E8F0] text-[12px] text-[#7B9BB5] hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50 flex items-center gap-1.5">
                  {dailyGeneratingPdf ? <><SpinnerIcon className="h-3 w-3" />Generating…</> : "PDF"}
                </button>
                <button onClick={() => deleteDaily(viewDaily.id)}
                  className="h-7 px-3 rounded-md border border-red-900/50 text-[12px] text-red-400 hover:bg-red-900/20 transition-colors">
                  Delete
                </button>
                <button onClick={() => setViewDaily(null)} className="text-[#64748B] hover:text-[#64748B] transition-colors">
                  <XIcon className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="px-6 py-4 space-y-4 overflow-y-auto flex-1 min-h-0">
              {/* Meta row */}
              <div className="flex flex-wrap gap-4 text-[12px]">
                {viewDaily.prepared_by && <span><span className="text-[#64748B]">Prepared by: </span><span className="text-[#0F172A]">{viewDaily.prepared_by}</span></span>}
                {viewDaily.weather_conditions && <span><span className="text-[#64748B]">Weather: </span><span className="text-[#0F172A]">{viewDaily.weather_conditions}{viewDaily.temperature ? ` · ${viewDaily.temperature}` : ""}</span></span>}
                {viewDaily.manpower_count != null && <span><span className="text-[#64748B]">Manpower: </span><span className="text-[#0F172A]">{viewDaily.manpower_count} workers</span></span>}
              </div>
              {[
                { label: "Work Performed", value: viewDaily.work_performed },
                { label: "Equipment on Site", value: viewDaily.equipment },
                { label: "Materials Delivered", value: viewDaily.materials_delivered },
                { label: "Visitors / Inspections", value: viewDaily.visitors },
                { label: "Issues / Delays", value: viewDaily.issues_delays },
                { label: "Safety Notes", value: viewDaily.safety_notes },
              ].filter(f => f.value).map(f => (
                <div key={f.label} className="rounded-md bg-[#F4F5F7] border border-[#E2E8F0] px-4 py-3">
                  <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-1.5">{f.label}</p>
                  <p className="text-[13px] text-[#0F172A] whitespace-pre-wrap">{f.value}</p>
                </div>
              ))}
              {viewDaily.file_name && (
                <div className="flex items-center gap-2 text-[12px] text-[#64748B] px-1">
                  <svg className="h-3.5 w-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                  <span>{viewDaily.file_name}</span>
                </div>
              )}

              {/* Photo section */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-bold text-[#64748B] uppercase tracking-widest">Photos</span>
                  <button type="button" onClick={() => dailyPhotoRef.current?.click()} disabled={dailyPhotoUploading}
                    className="h-7 px-3 rounded-md border border-[#E2E8F0] text-[12px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50 flex items-center gap-1.5">
                    {dailyPhotoUploading ? <><SpinnerIcon className="h-3 w-3" /> Uploading…</> : "+ Add Photo"}
                  </button>
                  <input ref={dailyPhotoRef} type="file" accept="image/*" capture="environment" className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; if (f) uploadDailyPhoto(f); e.target.value = "" }} />
                </div>
                {dailyPhotosLoading ? (
                  <div className="flex justify-center py-3"><SpinnerIcon className="h-4 w-4 text-[#64748B]" /></div>
                ) : dailyPhotos.length > 0 ? (
                  <div className="grid grid-cols-3 gap-2">
                    {dailyPhotos.map(ph => (
                      <div key={ph.id} className="relative group aspect-square rounded-md overflow-hidden border border-[#E2E8F0] bg-[#F4F5F7]">
                        <img src={ph.url} alt={ph.file_name ?? ""} className="w-full h-full object-cover cursor-pointer"
                          onClick={() => window.open(ph.url, "_blank")} />
                        <button onClick={() => deleteDailyPhoto(ph.id)}
                          className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity h-6 w-6 rounded-full bg-red-500 text-white text-[11px] flex items-center justify-center shadow">
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-[12px] text-[#64748B] italic">No photos yet — tap "+ Add Photo" to capture or upload</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── New Drawing / Add Revision modal ─────────────────────────────── */}
      {(showNewDrawing || addRevisionFor) && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
          onClick={e => { if (e.target === e.currentTarget) { setShowNewDrawing(false); setAddRevisionFor(null) } }}>
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[560px] mx-4 sm:mx-0">
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E2E8F0]">
              <div>
                <h2 className="text-[15px] font-bold text-[#0F172A]">{addRevisionFor ? "Add Revision" : "Add Drawing"}</h2>
                {addRevisionFor && <p className="text-[12px] text-[#64748B] mt-0.5">Supersedes {addRevisionFor.drawing_number} Rev {addRevisionFor.revision}</p>}
              </div>
              <button onClick={() => { setShowNewDrawing(false); setAddRevisionFor(null) }} className="text-[#64748B] hover:text-[#64748B] transition-colors">
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
                      className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                      <option value="">Select…</option>
                      {["Architectural","Structural","Mechanical","Electrical","Plumbing","Civil","Landscape","Fire Protection","Low Voltage","General"].map(d => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </div>
                  <div className="flex-1">
                    <label className={labelCls}>Status</label>
                    <select value={dwgStatus} onChange={e => setDwgStatus(e.target.value)}
                      className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
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
                      className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                      <option value="">None</option>
                      {appProjects.map(p => <option key={p.id} value={p.id}>{p.name}{p.number ? ` — ${p.number}` : ""}</option>)}
                    </select>
                  </div>
                )}
                <div>
                  <label className={labelCls}>Notes</label>
                  <textarea rows={2} value={dwgNotes} onChange={e => setDwgNotes(e.target.value)}
                    placeholder="Revision notes, changes from previous…"
                    className="w-full px-3 py-2 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 resize-none placeholder:text-[#64748B]" />
                </div>
                <div>
                  <label className={labelCls}>Attachment <span className="text-[#64748B] font-normal">(optional)</span></label>
                  <input ref={dwgFileRef} type="file" className="w-full text-[12px] text-[#64748B] file:mr-3 file:py-1 file:px-3 file:rounded file:border file:border-[#E2E8F0] file:bg-[#F4F5F7] file:text-[#64748B] file:text-[11px] file:cursor-pointer hover:file:bg-white/[0.05]" />
                </div>
              </div>
              <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#E2E8F0]">
                <button type="button" onClick={() => { setShowNewDrawing(false); setAddRevisionFor(null) }}
                  className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors">
                  Cancel
                </button>
                <button type="submit" disabled={dwgSaving}
                  className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 flex items-center gap-2">
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
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[520px] mx-4 sm:mx-0">
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E2E8F0]">
              <h2 className="text-[15px] font-bold text-[#0F172A]">New Punch Item</h2>
              <button onClick={() => setShowNewPunch(false)} className="text-[#64748B] hover:text-[#64748B] transition-colors">
                <XIcon className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={createPunch}>
              <div className="px-6 py-4 space-y-3">
                <div>
                  <label className={labelCls}>Description <span className="text-red-400">*</span></label>
                  <textarea required rows={2} value={punchDesc} onChange={e => setPunchDesc(e.target.value)} autoFocus
                    placeholder="Describe the deficiency, item to correct, or work to complete"
                    className="w-full px-3 py-2 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 resize-none placeholder:text-[#64748B]" />
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
                      className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
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
                      className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                      <option value="">None</option>
                      {appProjects.map(p => <option key={p.id} value={p.id}>{p.name}{p.number ? ` — ${p.number}` : ""}</option>)}
                    </select>
                  </div>
                )}
                <div>
                  <label className={labelCls}>Notes</label>
                  <textarea rows={2} value={punchNotes} onChange={e => setPunchNotes(e.target.value)}
                    placeholder="Additional context, spec references, etc."
                    className="w-full px-3 py-2 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 resize-none placeholder:text-[#64748B]" />
                </div>
                <div>
                  <label className={labelCls}>Attachment <span className="text-[#64748B] font-normal">(optional)</span></label>
                  <input ref={punchFileRef} type="file" className="w-full text-[12px] text-[#64748B] file:mr-3 file:py-1 file:px-3 file:rounded file:border file:border-[#E2E8F0] file:bg-[#F4F5F7] file:text-[#64748B] file:text-[11px] file:cursor-pointer hover:file:bg-white/[0.05]" />
                </div>
              </div>
              <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#E2E8F0]">
                <button type="button" onClick={() => setShowNewPunch(false)}
                  className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors">
                  Cancel
                </button>
                <button type="submit" disabled={punchSaving || !punchDesc.trim()}
                  className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 flex items-center gap-2">
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
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[500px] mx-4 sm:mx-0">
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E2E8F0]">
              <div>
                <span className="text-[11px] font-mono text-[#7B9BB5]">{viewPunch.item_number}</span>
                <h2 className="text-[15px] font-bold text-[#0F172A] mt-0.5">{viewPunch.description}</h2>
              </div>
              <button onClick={() => setViewPunch(null)} className="text-[#64748B] hover:text-[#64748B] transition-colors ml-4 flex-shrink-0">
                <XIcon className="h-4 w-4" />
              </button>
            </div>
            <div className="px-6 py-4 space-y-4">
              <div className="grid grid-cols-2 gap-3 text-[12px]">
                {viewPunch.location && <div><span className="text-[#64748B]">Location: </span><span className="text-[#0F172A]">{viewPunch.location}</span></div>}
                {viewPunch.assigned_to && <div><span className="text-[#64748B]">Assigned to: </span><span className="text-[#0F172A]">{viewPunch.assigned_to}</span></div>}
                {viewPunch.due_date && <div><span className="text-[#64748B]">Due: </span><span className={new Date(viewPunch.due_date) < new Date() && viewPunch.status !== "Completed" ? "text-red-400 font-medium" : "text-[#0F172A]"}>{fmtDateOnly(viewPunch.due_date)}</span></div>}
                <div className="flex items-center gap-1.5"><span className="text-[#64748B]">Priority: </span><PunchPriorityBadge priority={viewPunch.priority} /></div>
              </div>
              {viewPunch.notes && (
                <div className="rounded-md bg-[#F4F5F7] px-3 py-2">
                  <p className="text-[11px] font-bold text-[#64748B] uppercase tracking-widest mb-1">Notes</p>
                  <p className="text-[13px] text-[#0F172A]">{viewPunch.notes}</p>
                </div>
              )}
              {viewPunch.file_name && (
                <div className="flex items-center gap-2 text-[12px] text-[#64748B]">
                  <svg className="h-3.5 w-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                  <span>{viewPunch.file_name}</span>
                </div>
              )}

              {/* Photo section */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className={labelCls}>Photos</span>
                  <button type="button" onClick={() => punchPhotoRef.current?.click()} disabled={punchPhotoUploading}
                    className="h-7 px-3 rounded-md border border-[#E2E8F0] text-[12px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50 flex items-center gap-1.5">
                    {punchPhotoUploading ? <><SpinnerIcon className="h-3 w-3" /> Uploading…</> : "+ Add Photo"}
                  </button>
                  <input ref={punchPhotoRef} type="file" accept="image/*" capture="environment" className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; if (f) uploadPunchPhoto(f); e.target.value = "" }} />
                </div>
                {punchPhotosLoading ? (
                  <div className="flex justify-center py-3"><SpinnerIcon className="h-4 w-4 text-[#64748B]" /></div>
                ) : punchPhotos.length > 0 ? (
                  <div className="grid grid-cols-3 gap-2">
                    {punchPhotos.map(ph => (
                      <div key={ph.id} className="relative group aspect-square rounded-md overflow-hidden border border-[#E2E8F0] bg-[#F4F5F7]">
                        <img src={ph.url} alt={ph.file_name ?? ""} className="w-full h-full object-cover cursor-pointer"
                          onClick={() => window.open(ph.url, "_blank")} />
                        <button onClick={() => deletePunchPhoto(ph.id)}
                          className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity h-6 w-6 rounded-full bg-red-500 text-white text-[11px] flex items-center justify-center shadow">
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-[12px] text-[#64748B] italic">No photos yet — tap "+ Add Photo" to capture or upload</p>
                )}
              </div>

              <div className="border-t border-[#E2E8F0] pt-4 space-y-3">
                <div>
                  <label className={labelCls}>Update Notes</label>
                  <textarea value={punchEditNotes} onChange={e => setPunchEditNotes(e.target.value)} rows={3}
                    placeholder="Add resolution notes, corrective action taken, etc."
                    className="w-full px-3 py-2 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 resize-none placeholder:text-[#64748B]" />
                </div>
                <div>
                  <label className={labelCls}>Status</label>
                  <select value={punchEditStatus} onChange={e => setPunchEditStatus(e.target.value)}
                    className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                    {["Open", "In Progress", "Completed", "Void"].map(s => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
            <div className="flex justify-between px-6 py-4 border-t border-[#E2E8F0]">
              <div className="flex gap-2">
                <button onClick={() => generatePunchPdf(viewPunch.id)} disabled={punchGeneratingPdf}
                  className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50 flex items-center gap-2">
                  {punchGeneratingPdf ? <><SpinnerIcon className="h-3 w-3" /> Generating…</> : "Generate PDF"}
                </button>
                <button onClick={() => deletePunchItem(viewPunch.id)}
                  className="h-8 px-4 rounded-md border border-red-900/50 text-[13px] text-red-400 hover:bg-red-900/20 transition-colors">
                  Delete
                </button>
              </div>
              <div className="flex gap-2">
                <button onClick={() => setViewPunch(null)}
                  className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors">
                  Close
                </button>
                <button onClick={updatePunch} disabled={punchEditSaving}
                  className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 flex items-center gap-2">
                  {punchEditSaving && <SpinnerIcon className="h-3 w-3" />}
                  {punchEditSaving ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── New RFI modal ────────────────────────────────────────────────── */}
      {showNewRfi && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
          onClick={e => { if (e.target === e.currentTarget) setShowNewRfi(false) }}>
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[580px] mx-4 sm:mx-0 flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E2E8F0] flex-shrink-0">
              <h2 className="text-[15px] font-bold text-[#0F172A]">New RFI</h2>
              <button onClick={() => setShowNewRfi(false)} className="text-[#64748B] hover:text-[#64748B] transition-colors">
                <XIcon className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={createRfi} className="flex flex-col min-h-0">
              <div className="px-6 py-4 space-y-3 overflow-y-auto">
                {appProjects.length > 0 && (
                  <div>
                    <label className={labelCls}>Project</label>
                    <select value={rfiProjectId} onChange={e => setRfiProjectId(e.target.value)}
                      className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                      <option value="">None</option>
                      {appProjects.map(p => <option key={p.id} value={p.id}>{p.name}{p.number ? ` — ${p.number}` : ""}</option>)}
                    </select>
                  </div>
                )}
                <div>
                  <label className={labelCls}>Subject <span className="text-red-400">*</span></label>
                  <input type="text" required value={rfiSubject} onChange={e => setRfiSubject(e.target.value)}
                    placeholder="Brief description of the question" autoFocus className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Question</label>
                  <textarea value={rfiQuestion} onChange={e => setRfiQuestion(e.target.value)} rows={4}
                    placeholder="Detailed question — reference specs, drawings, field conditions…"
                    className="w-full px-3 py-2 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 resize-none placeholder:text-[#64748B]" />
                </div>
                <div>
                  <label className={labelCls}>Received From</label>
                  <select value={rfiReceivedFrom} onChange={e => setRfiReceivedFrom(e.target.value)}
                    className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                    <option value="">Select or type below…</option>
                    {teamMembers.map(m => <option key={m.id} value={m.name}>{m.name}</option>)}
                    <option value="__other__">Other (type name)…</option>
                  </select>
                  {rfiReceivedFrom === "__other__" && (
                    <input type="text" value={rfiReceivedFromCustom} onChange={e => setRfiReceivedFromCustom(e.target.value)}
                      placeholder="Name of subcontractor, vendor, etc." className={`${inputCls} mt-1.5`} />
                  )}
                </div>
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className={labelCls}>Specification Section</label>
                    <input type="text" value={rfiSpecSection} onChange={e => setRfiSpecSection(e.target.value)}
                      placeholder="e.g. 09 22 16" className={inputCls} />
                  </div>
                  <div className="flex-1">
                    <label className={labelCls}>Location</label>
                    <input type="text" value={rfiLocation} onChange={e => setRfiLocation(e.target.value)}
                      placeholder="Area or room" className={inputCls} />
                  </div>
                </div>
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className={labelCls}>Schedule Impact</label>
                    <select value={rfiScheduleImpact} onChange={e => setRfiScheduleImpact(e.target.value)}
                      className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                      {["Yes","No","TBD"].map(v => <option key={v} value={v}>{v}</option>)}
                    </select>
                  </div>
                  <div className="flex-1">
                    <label className={labelCls}>Cost Impact</label>
                    <input value={rfiCostImpact === "TBD" ? "" : rfiCostImpact} onChange={e => setRfiCostImpact(e.target.value)} placeholder="e.g. $2,500"
                      className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" />
                  </div>
                </div>
                <div>
                  <label className={labelCls}>Assigned To</label>
                  <select value={rfiAssignedTo} onChange={e => setRfiAssignedTo(e.target.value)}
                    className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                    <option value="">Select…</option>
                    {teamMembers.map(m => <option key={m.id} value={m.name}>{m.name}</option>)}
                  </select>
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
                <div>
                  <label className={labelCls}>Attach File</label>
                  <input type="file" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"
                    onChange={e => setRfiFile(e.target.files?.[0] ?? null)}
                    className="w-full text-[13px] text-[#64748B] file:mr-3 file:py-1 file:px-3 file:rounded file:border-0 file:text-[12px] file:bg-[#E2E8F0] file:text-[#0F172A] hover:file:bg-[#CBD5E1]" />
                </div>
              </div>
              <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#E2E8F0] flex-shrink-0">
                <button type="button" onClick={() => setShowNewRfi(false)}
                  className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors">Cancel</button>
                <button type="submit" disabled={rfiSaving || !rfiSubject.trim()}
                  className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 flex items-center gap-2">
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
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
          onClick={e => { if (e.target === e.currentTarget) setViewRfi(null) }}>
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[680px] mx-4 sm:mx-0 flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E2E8F0] flex-shrink-0">
              <div className="flex items-center gap-3">
                <span className="text-[12px] font-mono text-[#7B9BB5] flex-shrink-0">{viewRfi.rfi_number}</span>
                <h2 className="text-[15px] font-bold text-[#0F172A]">{viewRfi.subject}</h2>
                <RfiStatusBadge status={viewRfi.status} />
              </div>
              <button onClick={() => setViewRfi(null)} className="text-[#64748B] hover:text-[#64748B] transition-colors ml-4 flex-shrink-0">
                <XIcon className="h-4 w-4" />
              </button>
            </div>
            <div className="px-6 py-4 space-y-4 overflow-y-auto">
              {/* Meta grid */}
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: "Received From", value: viewRfi.received_from ?? viewRfi.submitted_by ?? "—" },
                  { label: "Assigned To",   value: viewRfi.assigned_to ?? "—" },
                  { label: "Spec Section",  value: viewRfi.specification_section ?? "—" },
                  { label: "Location",      value: viewRfi.location ?? "—" },
                  { label: "Schedule Impact", value: viewRfi.schedule_impact ?? "TBD" },
                  { label: "Cost Impact",   value: viewRfi.cost_impact ?? "TBD" },
                  { label: "Date Issued",   value: viewRfi.date_issued ? fmtDateOnly(viewRfi.date_issued) : "—" },
                  { label: "Due Date",      value: viewRfi.due_date ? fmtDateOnly(viewRfi.due_date) : "—" },
                ].map(({ label, value }) => (
                  <div key={label} className="rounded-md bg-[#F4F5F7] px-3 py-2">
                    <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-0.5">{label}</p>
                    <p className="text-[12px] text-[#0F172A]">{value}</p>
                  </div>
                ))}
              </div>
              {/* Question */}
              {viewRfi.description && (
                <div className="rounded-md bg-[#F4F5F7] px-3 py-2.5">
                  <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-1.5">Question</p>
                  <p className="text-[13px] text-[#0F172A] whitespace-pre-wrap">{viewRfi.description}</p>
                </div>
              )}
              {/* Attachment */}
              {viewRfi.file_name && (
                <div className="flex items-center gap-2 text-[12px]">
                  <svg className="w-4 h-4 text-[#64748B]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                  <span className="text-[#64748B]">{viewRfi.file_name}</span>
                </div>
              )}
              {viewRfi.generated_pdf_path && (
                <div className="flex items-center gap-2 text-[12px]">
                  <svg className="w-4 h-4 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
                  <button onClick={() => generateRfiPdf(viewRfi.id)} className="text-[#7B9BB5] hover:text-[#7B9BB5] transition-colors">View / Regenerate PDF</button>
                </div>
              )}
              {/* Response */}
              <div className="border-t border-[#E2E8F0] pt-4 space-y-3">
                <p className="text-[11px] font-bold text-[#64748B] uppercase tracking-widest">Response</p>
                <textarea value={rfiResponse} onChange={e => setRfiResponse(e.target.value)} rows={4}
                  placeholder="Enter response here…"
                  className="w-full px-3 py-2 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 resize-none placeholder:text-[#64748B]" />
                <div>
                  <label className={labelCls}>Status</label>
                  <select value={rfiResponseStatus} onChange={e => setRfiResponseStatus(e.target.value)}
                    className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                    {["Open","In Review","Answered","Closed","Void"].map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              </div>
            </div>
            <div className="flex justify-between px-6 py-4 border-t border-[#E2E8F0] flex-shrink-0">
              <div className="flex gap-2">
                <button onClick={() => generateRfiPdf(viewRfi.id)} disabled={rfiGeneratingPdf}
                  className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50 flex items-center gap-2">
                  {rfiGeneratingPdf ? <><SpinnerIcon className="h-3 w-3" /> Generating…</> : "Generate PDF"}
                </button>
                <button onClick={() => deleteRfi(viewRfi.id)}
                  className="h-8 px-4 rounded-md border border-red-500/30 text-[13px] text-red-400 hover:bg-red-500/10 transition-colors">Delete</button>
              </div>
              <div className="flex gap-2">
                <button onClick={() => setViewRfi(null)}
                  className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors">Close</button>
                <button onClick={respondRfi} disabled={rfiRespondSaving}
                  className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 flex items-center gap-2">
                  {rfiRespondSaving && <SpinnerIcon className="h-3 w-3" />}
                  {rfiRespondSaving ? "Saving…" : "Save Response"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── New Change Order modal ────────────────────────────────────────── */}
      {showNewCo && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
          onClick={e => { if (e.target === e.currentTarget) setShowNewCo(false) }}>
          <div className="bg-white border border-[#E2E8F0] rounded-xl w-full max-w-2xl mx-4 sm:mx-0 flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2E8F0] flex-shrink-0">
              <h2 className="text-[16px] font-bold text-[#0F172A]">New Change Order</h2>
              <button onClick={() => setShowNewCo(false)} className="text-[#64748B] hover:text-[#0F172A] transition-colors">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <form onSubmit={createCo} className="overflow-y-auto flex-1 px-6 py-4 space-y-4">
              {(() => {
                const labelCls2 = "block text-[11px] font-semibold text-[#64748B] uppercase tracking-widest mb-1"
                const inputCls2 = "w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 placeholder:text-[#64748B]"
                const selCls2   = "w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40"
                const coProj = appProjects.find(p => p.id === coProjectId)
                return (<>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className={labelCls2}>Project</label>
                      <select value={coProjectId} onChange={e => setCoProjectId(e.target.value)} className={selCls2}>
                        <option value="">— Select project —</option>
                        {appProjects.map(p => <option key={p.id} value={p.id}>{p.name}{p.number ? ` (${p.number})` : ""}</option>)}
                      </select>
                      {coProj && (
                        <p className="text-[11px] text-[#64748B] mt-1">{[coProj.gc_name, coProj.location].filter(Boolean).join(" · ")}</p>
                      )}
                    </div>
                    <div>
                      <label className={labelCls2}>Date</label>
                      <input type="date" value={coDate} onChange={e => setCoDate(e.target.value)} className={inputCls2} />
                    </div>
                  </div>
                  <div>
                    <label className={labelCls2}>Proposal <span className="text-red-400">*</span></label>
                    <textarea required value={coProposal} onChange={e => setCoProposal(e.target.value)} rows={4}
                      placeholder="Describe the scope of work for this change order…"
                      className="w-full px-3 py-2 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 resize-none placeholder:text-[#64748B]" />
                  </div>
                  <div>
                    <label className={labelCls2}>Qualifications / Exclusions</label>
                    <textarea value={coQualifications} onChange={e => setCoQualifications(e.target.value)} rows={3}
                      placeholder="List any qualifications or exclusions…"
                      className="w-full px-3 py-2 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 resize-none placeholder:text-[#64748B]" />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className={labelCls2}>Pricing Sum ($)</label>
                      <input type="number" step="0.01" min="0" value={coPricingSum} onChange={e => setCoPricingSum(e.target.value)}
                        placeholder="0.00" className={inputCls2} />
                    </div>
                    <div>
                      <label className={labelCls2}>Status</label>
                      <select value={coStatus} onChange={e => setCoStatus(e.target.value)} className={selCls2}>
                        {["Draft","Submitted","Under Review","Approved","Rejected","Void"].map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className={labelCls2}>Schedule Impact</label>
                      <select value={coScheduleImpact} onChange={e => setCoScheduleImpact(e.target.value)} className={selCls2}>
                        {["TBD","Yes","No"].map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                    {coScheduleImpact === "Yes" && (
                      <div>
                        <label className={labelCls2}>Days Impact</label>
                        <input type="number" min="0" value={coScheduleDays} onChange={e => setCoScheduleDays(e.target.value)}
                          placeholder="0" className={inputCls2} />
                      </div>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className={labelCls2}>Submitted By</label>
                      <input type="text" value={coSubmittedBy} onChange={e => setCoSubmittedBy(e.target.value)}
                        placeholder="Name or company" className={inputCls2} />
                    </div>
                    <div>
                      <label className={labelCls2}>Assigned To</label>
                      <input type="text" value={coAssignedTo} onChange={e => setCoAssignedTo(e.target.value)}
                        placeholder="Reviewer name" className={inputCls2} />
                    </div>
                  </div>
                  <div>
                    <label className={labelCls2}>Attach File</label>
                    <input type="file" accept=".pdf,.doc,.docx,.xlsx,.xls,.png,.jpg,.jpeg"
                      onChange={e => setCoFile(e.target.files?.[0] ?? null)}
                      className="w-full text-[13px] text-[#64748B] file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:bg-[#E2E8F0] file:text-[#0F172A] file:text-[12px] file:cursor-pointer hover:file:bg-[#CBD5E1] cursor-pointer" />
                  </div>
                </>)
              })()}
            </form>
            <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#E2E8F0] flex-shrink-0">
              <button type="button" onClick={() => setShowNewCo(false)}
                className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors">Cancel</button>
              <button type="submit" form="" onClick={createCo} disabled={coSaving || !coProposal.trim()}
                className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 flex items-center gap-2">
                {coSaving && <SpinnerIcon className="h-3 w-3" />}
                {coSaving ? "Creating…" : "Create CO"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── View Change Order modal ───────────────────────────────────────── */}
      {viewCo && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
          onClick={e => { if (e.target === e.currentTarget) setViewCo(null) }}>
          <div className="bg-white border border-[#E2E8F0] rounded-xl w-full max-w-2xl mx-4 sm:mx-0 flex flex-col max-h-[90vh]">
            {/* Header */}
            <div className="flex items-start justify-between px-6 py-4 border-b border-[#E2E8F0] flex-shrink-0">
              <div>
                <div className="flex items-center gap-3">
                  <h2 className="text-[16px] font-bold text-[#0F172A]">{viewCo.co_number}</h2>
                  {(() => {
                    const statusColor: Record<string, string> = {
                      Draft:          "bg-gray-100 text-gray-500",
                      Submitted:      "bg-blue-100 text-blue-700",
                      "Under Review": "bg-amber-100 text-amber-700",
                      Approved:       "bg-green-100 text-green-700",
                      Rejected:       "bg-red-100 text-red-700",
                      Void:           "bg-gray-100 text-gray-500",
                    }
                    return <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold ${statusColor[viewCo.status] ?? "bg-gray-100 text-gray-500"}`}>{viewCo.status}</span>
                  })()}
                </div>
                <p className="text-[12px] text-[#64748B] mt-0.5">{viewCo.date ? fmtDateOnly(viewCo.date) : "No date"}</p>
              </div>
              <button onClick={() => setViewCo(null)} className="text-[#64748B] hover:text-[#0F172A] transition-colors mt-0.5">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            <div className="overflow-y-auto flex-1 px-6 py-4 space-y-5">
              {/* Project info */}
              {viewCo.project_id && (() => {
                const proj = appProjects.find(p => p.id === viewCo.project_id)
                if (!proj) return null
                return (
                  <div className="rounded-lg bg-[#F4F5F7] border border-[#E2E8F0] px-4 py-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-[12px]">
                    {proj.name    && <div><span className="text-[#64748B]">Project: </span><span className="text-[#0F172A] font-medium">{proj.name}</span></div>}
                    {proj.number  && <div><span className="text-[#64748B]">No.: </span><span className="text-[#0F172A]">{proj.number}</span></div>}
                    {proj.gc_name && <div><span className="text-[#64748B]">GC: </span><span className="text-[#0F172A]">{proj.gc_name}</span></div>}
                    {proj.architect && <div><span className="text-[#64748B]">Architect: </span><span className="text-[#0F172A]">{proj.architect}</span></div>}
                    {proj.location && <div className="col-span-2"><span className="text-[#64748B]">Location: </span><span className="text-[#0F172A]">{proj.location}</span></div>}
                  </div>
                )
              })()}

              {/* Meta grid */}
              <div className="grid grid-cols-3 gap-3 text-[12px]">
                {[
                  { label: "Submitted By", value: viewCo.submitted_by ?? "—" },
                  { label: "Assigned To",  value: viewCo.assigned_to  ?? "—" },
                  { label: "Schedule Impact", value: viewCo.schedule_impact ?? "TBD" },
                  { label: "Days Impact", value: viewCo.schedule_impact_days != null ? String(viewCo.schedule_impact_days) : "—" },
                  { label: "Approved At", value: viewCo.approved_at ? fmtDateOnly(viewCo.approved_at) : "—" },
                  { label: "Created",     value: fmtDateOnly(viewCo.created_at) },
                ].map(({ label, value }) => (
                  <div key={label}>
                    <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-0.5">{label}</p>
                    <p className="text-[#0F172A]">{value}</p>
                  </div>
                ))}
              </div>

              {/* Pricing */}
              <div className="rounded-lg bg-[#F4F5F7] border border-[#E2E8F0] px-4 py-3">
                <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-1">Total Change Order Amount</p>
                <p className={`text-[22px] font-bold tabular-nums ${viewCo.status === "Approved" ? "text-green-400" : "text-[#0F172A]"}`}>
                  {viewCo.pricing_sum != null
                    ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(viewCo.pricing_sum)
                    : "—"}
                </p>
              </div>

              {/* Proposal */}
              {viewCo.proposal && (
                <div>
                  <p className="text-[11px] font-bold text-[#64748B] uppercase tracking-widest mb-2">Proposal</p>
                  <p className="text-[13px] text-[#0F172A] whitespace-pre-wrap leading-relaxed">{viewCo.proposal}</p>
                </div>
              )}

              {/* Qualifications */}
              {viewCo.qualifications && (
                <div>
                  <p className="text-[11px] font-bold text-[#64748B] uppercase tracking-widest mb-2">Qualifications / Exclusions</p>
                  <p className="text-[13px] text-[#0F172A] whitespace-pre-wrap leading-relaxed">{viewCo.qualifications}</p>
                </div>
              )}

              {/* Attachment + PDF */}
              {viewCo.file_name && (
                <div className="flex items-center gap-2 text-[12px]">
                  <svg className="w-4 h-4 text-[#64748B]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                  <span className="text-[#64748B]">{viewCo.file_name}</span>
                </div>
              )}
              {viewCo.generated_pdf_path && (
                <div className="flex items-center gap-2 text-[12px]">
                  <svg className="w-4 h-4 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
                  <button onClick={() => generateCoPdf(viewCo.id)} className="text-[#7B9BB5] hover:text-[#7B9BB5] transition-colors">View / Regenerate PDF</button>
                </div>
              )}

              {/* Status update */}
              <div className="border-t border-[#E2E8F0] pt-4 space-y-3">
                <p className="text-[11px] font-bold text-[#64748B] uppercase tracking-widest">Update</p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold text-[#64748B] uppercase tracking-widest mb-1">Status</label>
                    <select value={coResponseStatus} onChange={e => setCoResponseStatus(e.target.value)}
                      className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                      {["Draft","Submitted","Under Review","Approved","Rejected","Void"].map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-[#64748B] uppercase tracking-widest mb-1">Assigned To</label>
                    <input type="text" value={coAssignedTo} onChange={e => setCoAssignedTo(e.target.value)}
                      placeholder="Reviewer name"
                      className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 placeholder:text-[#64748B]" />
                  </div>
                </div>
              </div>
            </div>

            <div className="flex justify-between px-6 py-4 border-t border-[#E2E8F0] flex-shrink-0">
              <div className="flex gap-2">
                <button onClick={() => generateCoPdf(viewCo.id)} disabled={coGeneratingPdf}
                  className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50 flex items-center gap-2">
                  {coGeneratingPdf ? <><SpinnerIcon className="h-3 w-3" /> Generating…</> : "Generate PDF"}
                </button>
                <button onClick={() => deleteCo(viewCo.id)}
                  className="h-8 px-4 rounded-md border border-red-500/30 text-[13px] text-red-400 hover:bg-red-500/10 transition-colors">Delete</button>
              </div>
              <div className="flex gap-2">
                <button onClick={() => setViewCo(null)}
                  className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors">Close</button>
                <button onClick={saveCoStatus} disabled={coRespondSaving}
                  className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 flex items-center gap-2">
                  {coRespondSaving && <SpinnerIcon className="h-3 w-3" />}
                  {coRespondSaving ? "Saving…" : "Save Changes"}
                </button>
              </div>
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
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[460px] mx-4 sm:mx-0 p-6">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-[15px] font-bold text-[#0F172A]">Open Submittal</h2>
              <button onClick={closeFileModal} className="text-[#64748B] hover:text-[#64748B] transition-colors">
                <XIcon className="h-4 w-4" />
              </button>
            </div>
            <p className="text-[12px] text-[#64748B] mb-4 truncate">{openFileCtx.file.file_name}</p>

            <div className="mb-4">
              <label className="block text-[12px] font-medium text-[#64748B] mb-1">Which project is this for?</label>
              <select
                value={modalProjectId}
                onChange={e => setModalProjectId(e.target.value)}
                className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40"
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
                className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors"
              >
                Cancel
              </button>
              <div className="flex gap-2">
                <button
                  onClick={openFileDirectly}
                  className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors"
                >
                  Skip &amp; Open
                </button>
                <button
                  onClick={() => setFileModalStep("coversheet")}
                  className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors"
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
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[460px] mx-4 sm:mx-0 p-6">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-[15px] font-bold text-[#0F172A]">Add Cover Sheet?</h2>
              <button onClick={closeFileModal} className="text-[#64748B] hover:text-[#64748B] transition-colors">
                <XIcon className="h-4 w-4" />
              </button>
            </div>
            <p className="text-[12px] font-semibold text-[#0F172A] mb-1">
              {modalProjectId ? (appProjects.find(p => p.id === modalProjectId)?.name ?? "Project") : "No project selected"}
            </p>
            <p className="text-[13px] text-[#64748B] mb-5">
              Generate a submittal transmittal cover sheet and merge it with this document.
            </p>
            <div className="flex flex-col gap-2">
              <button
                onClick={initCoverForm}
                className="h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors"
              >
                Yes, add cover sheet
              </button>
              <button
                onClick={openFileDirectly}
                className="h-9 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors"
              >
                No, just open
              </button>
              <button
                onClick={closeFileModal}
                className="h-9 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors"
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
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[680px] mx-4 sm:mx-0">
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E2E8F0]">
              <h2 className="text-[15px] font-bold text-[#0F172A]">Submittal Transmittal</h2>
              <button onClick={closeFileModal} className="text-[#64748B] hover:text-[#64748B] transition-colors">
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
                    <select value={coverForm.reviewedBy} onChange={e => setCoverForm(prev => ({ ...prev!, reviewedBy: e.target.value }))} className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                      <option value="">Select…</option>
                      {teamMembers.map(m => <option key={m.id} value={m.name}>{m.name}{m.title ? ` — ${m.title}` : ""}</option>)}
                    </select>
                  </div>
                  <div className="flex-1">
                    <label className={labelCls}>Certified by CQM</label>
                    <select value={coverForm.certifiedBy} onChange={e => setCoverForm(prev => ({ ...prev!, certifiedBy: e.target.value }))} className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                      <option value="">Select…</option>
                      {teamMembers.map(m => <option key={m.id} value={m.name}>{m.name}{m.title ? ` — ${m.title}` : ""}</option>)}
                    </select>
                  </div>
                </div>

                {/* ── SEND TO ── */}
                <div className="border border-[#E2E8F0] rounded-lg overflow-hidden">
                  <div className="px-3 py-2 bg-[#F8F9FA] border-b border-[#E2E8F0] flex items-center justify-between">
                    <span className="text-[11px] font-bold text-[#0F172A] uppercase tracking-wide">Send To</span>
                    {coverForm.sendToType && <button type="button" onClick={() => { setCoverSelectedId(""); setCoverForm(prev => ({ ...prev!, sendToType: "", sendToCompany: "", sendToContact: "", sendToEmail: "", sendToPhone: "", sendToAddress: "" })) }} className="text-[10px] text-[#64748B] hover:text-red-400">Clear</button>}
                  </div>
                  <div className="p-3 space-y-3">
                    <div className="flex flex-wrap gap-2">
                      {([["cm", "Construction Manager"], ["subcontractor", "Subcontractor"], ["supplier", "Supplier"]] as const).map(([key, label]) => (
                        <button key={key} type="button"
                          onClick={() => { setCoverSelectedId(""); setCoverForm(prev => ({ ...prev!, sendToType: key, sendToCompany: "", sendToContact: "", sendToEmail: "", sendToPhone: "", sendToAddress: "" })) }}
                          className={`h-7 px-3 rounded text-[11px] font-semibold transition-colors ${coverForm.sendToType === key ? "bg-[#7B9BB5] text-white" : "border border-[#E2E8F0] text-[#64748B] hover:border-[#7B9BB5] hover:text-[#7B9BB5]"}`}
                        >{label}</button>
                      ))}
                    </div>
                    {coverForm.sendToType !== "" && (() => {
                      const list = coverForm.sendToType === "cm" ? coverProjectCms : coverForm.sendToType === "subcontractor" ? coverProjectSubs : coverProjectSuppliers
                      const typeLabel = coverForm.sendToType === "cm" ? "Construction Manager" : coverForm.sendToType === "subcontractor" ? "Subcontractor" : "Supplier"
                      return (
                        <div className="space-y-3">
                          <div>
                            <label className={labelCls}>Select {typeLabel}</label>
                            <select
                              value={coverSelectedId}
                              onChange={e => {
                                const val = e.target.value
                                setCoverSelectedId(val)
                                if (val === "" || val === "__manual__") {
                                  setCoverForm(prev => ({ ...prev!, sendToCompany: "", sendToContact: "", sendToEmail: "", sendToPhone: "", sendToAddress: "" }))
                                } else {
                                  const sel = list.find(x => x.id === val)
                                  if (sel) setCoverForm(prev => ({ ...prev!, sendToCompany: sel.company_name, sendToContact: sel.contact_name ?? "", sendToEmail: sel.email ?? "", sendToPhone: sel.phone ?? "", sendToAddress: sel.address ?? "" }))
                                }
                              }}
                              className={inputCls}
                            >
                              <option value="">— Select a {typeLabel} —</option>
                              {list.map(x => <option key={x.id} value={x.id}>{x.company_name}{x.contact_name ? ` — ${x.contact_name}` : ""}</option>)}
                              <option value="__manual__">Enter manually</option>
                            </select>
                          </div>
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <label className={labelCls}>Company Name</label>
                              <input value={coverForm.sendToCompany} onChange={e => setCoverForm(prev => ({ ...prev!, sendToCompany: e.target.value }))} placeholder="Company name" className={inputCls} />
                            </div>
                            <div>
                              <label className={labelCls}>Contact Name</label>
                              <input value={coverForm.sendToContact} onChange={e => setCoverForm(prev => ({ ...prev!, sendToContact: e.target.value }))} placeholder="Contact name" className={inputCls} />
                            </div>
                            <div>
                              <label className={labelCls}>Email</label>
                              <input type="email" value={coverForm.sendToEmail} onChange={e => setCoverForm(prev => ({ ...prev!, sendToEmail: e.target.value }))} placeholder="email@company.com" className={inputCls} />
                            </div>
                            <div>
                              <label className={labelCls}>Phone</label>
                              <input value={coverForm.sendToPhone} onChange={e => setCoverForm(prev => ({ ...prev!, sendToPhone: e.target.value }))} placeholder="(555) 555-5555" className={inputCls} />
                            </div>
                          </div>
                          {(coverForm.sendToType === "cm" || coverForm.sendToAddress) && (
                            <div>
                              <label className={labelCls}>Address</label>
                              <input value={coverForm.sendToAddress} onChange={e => setCoverForm(prev => ({ ...prev!, sendToAddress: e.target.value }))} placeholder="123 Main St, City, State 00000" className={inputCls} />
                            </div>
                          )}
                        </div>
                      )
                    })()}
                  </div>
                </div>

                {/* ── TRANSMITTED BY ── */}
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className={labelCls}>Transmitted By</label>
                    <input value={coverForm.transmittedBy} onChange={e => setCoverForm(prev => ({ ...prev!, transmittedBy: e.target.value }))} placeholder="Your name" className={inputCls} />
                  </div>
                  <div className="flex-1">
                    <label className={labelCls}>Company</label>
                    <input value={coverForm.transmittedByCompany} onChange={e => setCoverForm(prev => ({ ...prev!, transmittedByCompany: e.target.value }))} placeholder="Your company" className={inputCls} />
                  </div>
                </div>

                <div>
                  <label className={labelCls}>Notes</label>
                  <textarea
                    value={coverForm.notes}
                    onChange={e => setCoverForm(prev => ({ ...prev!, notes: e.target.value }))}
                    rows={3}
                    placeholder="Additional notes or instructions…"
                    className="w-full px-3 py-2 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 resize-none placeholder:text-[#64748B]"
                  />
                </div>

              </div>

              <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#E2E8F0]">
                <button
                  type="button"
                  onClick={closeFileModal}
                  className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={generatingCover}
                  className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 flex items-center gap-2"
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
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[440px] mx-4 sm:mx-0 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-[15px] font-bold text-[#0F172A]">Upload Submittal</h2>
              <button onClick={closeModal} className="text-[#64748B] hover:text-[#64748B] transition-colors">
                <XIcon className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleUpload} className="space-y-3">
              {/* File */}
              <div>
                <label className="block text-[12px] font-medium text-[#64748B] mb-1">File</label>
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
                  className="w-full text-[13px] text-[#0F172A] file:mr-3 file:text-[12px] file:bg-[#E2E8F0] file:border-0 file:rounded-md file:px-3 file:py-1.5 file:text-[#0F172A] file:cursor-pointer cursor-pointer disabled:opacity-50"
                />
              </div>

              {/* Classifying spinner */}
              {uploadStep === "classifying" && (
                <div className="flex items-center gap-2 py-1 text-[13px] text-[#64748B]">
                  <SpinnerIcon className="h-4 w-4" /> Analyzing document…
                </div>
              )}

              {/* AI suggestion card */}
              {uploadStep === "suggested" && aiResult && (
                <div className="rounded-lg border border-[#7B9BB5]/30 bg-[#7B9BB5]/10 p-3 space-y-2">
                  <p className="text-[11px] font-bold text-[#7B9BB5] uppercase tracking-widest">✦ AI Suggestion</p>
                  <div>
                    <p className="text-[13px] font-semibold text-[#0F172A]">{aiResult.division_num} — {aiResult.division_name}</p>
                    <p className="text-[12px] text-[#64748B] mt-0.5">{aiResult.section_code} — {aiResult.section_name}</p>
                  </div>
                  {(aiResult.material_name || aiResult.manufacturer || aiResult.dimensions) && (
                    <div className="border-t border-[#7B9BB5]/20 pt-2 space-y-0.5">
                      {aiResult.material_name && <p className="text-[12px] text-[#0F172A]"><span className="text-[#64748B]">Material:</span> {aiResult.material_name}</p>}
                      {aiResult.manufacturer  && <p className="text-[12px] text-[#0F172A]"><span className="text-[#64748B]">Mfr:</span> {aiResult.manufacturer}</p>}
                      {aiResult.dimensions    && <p className="text-[12px] text-[#0F172A]"><span className="text-[#64748B]">Dims:</span> {aiResult.dimensions}</p>}
                    </div>
                  )}
                  {aiResult.confidence != null && (
                    <div className="border-t border-[#7B9BB5]/20 pt-2 flex items-center gap-2">
                      <div className="flex-1 h-1 rounded-full bg-[#E2E8F0] overflow-hidden">
                        <div className={`h-full rounded-full transition-all ${aiResult.confidence >= 70 ? "bg-emerald-400" : "bg-amber-400"}`} style={{ width: `${aiResult.confidence}%` }} />
                      </div>
                      <span className={`text-[11px] font-medium ${aiResult.confidence >= 70 ? "text-emerald-400" : "text-amber-400"}`}>{aiResult.confidence}% confident</span>
                    </div>
                  )}
                  {aiResult.confidence != null && aiResult.confidence < 70 && (
                    <p className="text-[11px] text-amber-300 bg-amber-400/10 rounded px-2 py-1">Low confidence — verify the classification before uploading</p>
                  )}
                  {aiResult.reasoning && <p className="text-[11px] text-[#64748B] italic">{aiResult.reasoning}</p>}
                  <div className="flex gap-2 pt-0.5">
                    <button type="button" onClick={acceptSuggestion}
                      className="h-7 px-3 rounded-md bg-[#7B9BB5] text-white text-[12px] font-semibold hover:bg-[#6A8AA4] transition-colors">
                      Use this →
                    </button>
                    <button type="button" onClick={() => { setUploadDiv(""); setUploadDivName(""); setUploadSec(""); setUploadSecName(""); setUploadStep("manual") }}
                      className="h-7 px-3 rounded-md border border-[#E2E8F0] text-[12px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors">
                      Classify manually
                    </button>
                  </div>
                </div>
              )}

              {/* Manual classification */}
              {uploadStep === "manual" && (
                <>
                  <div>
                    <label className="block text-[12px] font-medium text-[#64748B] mb-1">Division</label>
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
                      className="w-full h-9 px-2 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40"
                    >
                      <option value="">Select a division…</option>
                      {CSI_DIVISIONS.map(d => (
                        <option key={d.num} value={d.num}>{d.num} — {d.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[12px] font-medium text-[#64748B] mb-1">Section</label>
                    <select
                      value={uploadSec}
                      onChange={e => {
                        const picked = (CSI_SECTIONS[uploadDiv] ?? []).find(s => s.code === e.target.value)
                        setUploadSec(e.target.value)
                        setUploadSecName(picked?.name ?? "")
                      }}
                      disabled={!uploadDiv}
                      className="w-full h-9 px-2 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 disabled:opacity-50 disabled:cursor-not-allowed"
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
                  <div className="h-px bg-[#E2E8F0]" />
                  <p className="text-[11px] font-bold text-[#64748B] uppercase tracking-widest">Submittal Name</p>

                  <div>
                    <label className="block text-[12px] font-medium text-[#64748B] mb-1">Material</label>
                    <Combobox value={nameMatl} onChange={setNameMatl} options={nameOpts.materials} placeholder="e.g. Gypsum Board" autoFocus />
                  </div>

                  <div>
                    <label className="block text-[12px] font-medium text-[#64748B] mb-1">Manufacturer</label>
                    <Combobox value={nameMfr} onChange={setNameMfr} options={nameOpts.manufacturers} placeholder="e.g. Georgia-Pacific" />
                  </div>

                  <div>
                    <label className="block text-[12px] font-medium text-[#64748B] mb-1">Dimensions</label>
                    <Combobox value={nameDims} onChange={setNameDims} options={nameOpts.dimensions} placeholder='e.g. 5/8" x 4&apos; x 8&apos;' />
                  </div>

                  {(nameMatl || nameMfr || nameDims) && (
                    <div className="rounded-md bg-[#7B9BB5]/10 border border-[#7B9BB5]/20 px-3 py-2">
                      <p className="text-[10px] font-bold text-[#7B9BB5] uppercase tracking-widest mb-0.5">Name preview</p>
                      <p className="text-[13px] font-medium text-[#0F172A] truncate">
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
                    className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors"
                  >
                    Cancel
                  </button>
                  {uploadStep === "naming" && (
                    <button
                      type="button"
                      onClick={() => setUploadStep(aiResult ? "suggested" : "manual")}
                      className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors"
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
                    className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50"
                  >
                    Next →
                  </button>
                )}
                {uploadStep === "naming" && (
                  <button
                    type="submit"
                    disabled={uploading}
                    className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 flex items-center gap-2"
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
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[460px] mx-4 sm:mx-0 p-6">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-[15px] font-bold text-[#0F172A]">Edit Submittal</h2>
              <button onClick={() => setEditSubmittal(null)} className="text-[#64748B] hover:text-[#64748B] transition-colors"><XIcon className="h-4 w-4" /></button>
            </div>
            <p className="text-[12px] text-[#64748B] mb-4 truncate">{editSubmittal.file_name}</p>

            <div className="space-y-3">
              <div>
                <label className="block text-[12px] font-medium text-[#64748B] mb-1">Status</label>
                <select value={editStatus} onChange={e => setEditStatus(e.target.value)}
                  className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                  {["Received","Under Review","Approved","Approved with Comments","Rejected","Revise and Resubmit","Needs Review"].map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[12px] font-medium text-[#64748B] mb-1">Division</label>
                <select value={editDiv} onChange={e => {
                  const d = CSI_DIVISIONS.find(d => d.num === e.target.value)
                  setEditDiv(e.target.value); setEditDivName(d?.name ?? ""); setEditSec(""); setEditSecName("")
                }} className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                  <option value="">Select division…</option>
                  {CSI_DIVISIONS.map(d => <option key={d.num} value={d.num}>{d.num} — {d.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[12px] font-medium text-[#64748B] mb-1">Section</label>
                <select value={editSec} disabled={!editDiv} onChange={e => {
                  const s = (CSI_SECTIONS[editDiv] ?? []).find(s => s.code === e.target.value)
                  setEditSec(e.target.value); setEditSecName(s?.name ?? "")
                }} className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 disabled:opacity-50">
                  <option value="">{editDiv ? "Select section…" : "Select a division first"}</option>
                  {(CSI_SECTIONS[editDiv] ?? []).map(s => <option key={s.code} value={s.code}>{s.code} — {s.name}</option>)}
                </select>
              </div>
              {editSubmittal.ai_reasoning && (
                <div className="rounded-md bg-[#F4F5F7] px-3 py-2">
                  <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-0.5">AI Reasoning</p>
                  <p className="text-[12px] text-[#64748B] italic">{editSubmittal.ai_reasoning}</p>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setEditSubmittal(null)}
                className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors">
                Cancel
              </button>
              <button onClick={saveEdit} disabled={editSaving}
                className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 flex items-center gap-2">
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
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[700px] mx-4 sm:mx-0 max-h-[85vh] flex flex-col">

            {/* Header */}
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E2E8F0] flex-shrink-0">
              <div>
                <h2 className="text-[15px] font-bold text-[#0F172A]">Batch Upload</h2>
                <p className="text-[12px] text-[#64748B] mt-0.5">AI will classify each file — review before uploading</p>
              </div>
              <button onClick={closeBatch} className="text-[#64748B] hover:text-[#64748B] transition-colors">
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
                  className={`border-2 border-dashed rounded-xl p-10 text-center transition-colors ${batchDragOver ? "border-[#7B9BB5]/60 bg-[#7B9BB5]/5" : "border-[#E2E8F0]"}`}
                >
                  <div className="w-12 h-12 rounded-xl bg-[#7B9BB5]/10 flex items-center justify-center mx-auto mb-3">
                    <LayersIcon />
                  </div>
                  <p className="text-[14px] font-semibold text-[#0F172A] mb-1">Drop files here</p>
                  <p className="text-[12px] text-[#64748B] mb-4">PDF, DOC, DOCX, XLS, XLSX, DWG, RVT</p>
                  <label className="cursor-pointer h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors inline-flex items-center gap-2">
                    <PlusIcon /> Choose files
                    <input type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.dwg,.rvt" className="hidden"
                      onChange={e => { if (e.target.files) initBatchFiles(Array.from(e.target.files)) }} />
                  </label>
                  {batchItems.length > 0 && (
                    <p className="mt-4 text-[13px] text-[#7B9BB5]">{batchItems.length} file{batchItems.length !== 1 ? "s" : ""} selected</p>
                  )}
                </div>
              )}

              {/* ── Classifying + review phase ── */}
              {(batchPhase === "classifying" || batchPhase === "review" || batchPhase === "uploading" || batchPhase === "done") && (
                <div className="space-y-1.5">
                  {/* Column headers */}
                  <div className="grid gap-2 px-2 pb-1" style={{ gridTemplateColumns: "1fr 155px 195px 20px 20px 20px" }}>
                    <span className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest">File</span>
                    <span className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest">Division</span>
                    <span className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest">Section</span>
                    <span /><span /><span />
                  </div>
                  {batchItems.map(item => {
                    const isEditable = batchPhase === "review" || batchPhase === "classifying"
                    const hasName = item.nameMatl || item.nameMfr || item.nameDims
                    return (
                      <div key={item.id} className="bg-[#F4F5F7] rounded-lg overflow-hidden mb-1">
                        {/* Main row */}
                        <div className="grid gap-2 items-center px-2 py-1.5" style={{ gridTemplateColumns: "1fr 155px 195px 20px 20px 20px" }}>
                          <div className="min-w-0 flex flex-col gap-0.5">
                            {isEditable ? (
                              <input
                                type="text"
                                value={item.customName}
                                onChange={e => updateBatchItem(item.id, { customName: e.target.value })}
                                placeholder={item.file.name.replace(/\.[^.]+$/, "")}
                                title={`Original file: ${item.file.name}`}
                                className="h-6 px-1.5 rounded border border-[#E2E8F0] text-[11px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 w-full placeholder:text-[#64748B]"
                              />
                            ) : (
                              <span className="text-[12px] text-[#0F172A] truncate" title={item.file.name}>{item.customName || item.file.name}</span>
                            )}
                            <span className="text-[10px] text-[#64748B] truncate" title={item.file.name}>{item.file.name}</span>
                          </div>

                          <select value={item.divNum} disabled={!isEditable}
                            onChange={e => {
                              const d = CSI_DIVISIONS.find(d => d.num === e.target.value)
                              updateBatchItem(item.id, { divNum: e.target.value, divName: d?.name ?? "", secCode: "", secName: "", status: "ready" })
                            }}
                            className="h-7 px-1.5 rounded-md border border-[#E2E8F0] text-[11px] text-[#0F172A] bg-white focus:outline-none disabled:opacity-60 w-full">
                            <option value="">Division…</option>
                            {CSI_DIVISIONS.map(d => <option key={d.num} value={d.num}>{d.num} — {d.name}</option>)}
                          </select>

                          <select value={item.secCode} disabled={!isEditable || !item.divNum}
                            onChange={e => {
                              const s = (CSI_SECTIONS[item.divNum] ?? []).find(s => s.code === e.target.value)
                              updateBatchItem(item.id, { secCode: e.target.value, secName: s?.name ?? "", status: "ready" })
                            }}
                            className="h-7 px-1.5 rounded-md border border-[#E2E8F0] text-[11px] text-[#0F172A] bg-white focus:outline-none disabled:opacity-60 w-full">
                            <option value="">{item.divNum ? "Section…" : "—"}</option>
                            {(CSI_SECTIONS[item.divNum] ?? []).map(s => <option key={s.code} value={s.code}>{s.code} — {s.name}</option>)}
                          </select>

                          {/* Status */}
                          <div className="flex items-center justify-center">
                            {(item.status === "classifying" || item.status === "uploading") && <SpinnerIcon className="h-3.5 w-3.5" />}
                            {item.status === "pending"      && <span className="w-2 h-2 rounded-full bg-[#E2E8F0]" />}
                            {item.status === "ready"        && <span className="w-2 h-2 rounded-full bg-emerald-400" />}
                            {item.status === "error"        && <span className="w-2 h-2 rounded-full bg-amber-400" title={item.errorMsg} />}
                            {item.status === "done"         && <span className="w-2 h-2 rounded-full bg-emerald-400" />}
                            {item.status === "upload-error" && <span className="w-2 h-2 rounded-full bg-red-400" title={item.errorMsg} />}
                          </div>

                          {/* Expand naming */}
                          {isEditable && (
                            <button type="button" onClick={() => updateBatchItem(item.id, { expanded: !item.expanded })}
                              title="Edit name (Material / Manufacturer / Dimensions)"
                              className={`flex items-center justify-center transition-colors ${item.expanded || hasName ? "text-[#7B9BB5]" : "text-[#64748B] hover:text-[#64748B]"}`}>
                              <svg className={`h-3 w-3 transition-transform ${item.expanded ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                              </svg>
                            </button>
                          )}

                          {/* Remove */}
                          {isEditable && (
                            <button type="button" onClick={() => setBatchItems(prev => prev.filter(it => it.id !== item.id))}
                              className="text-[#64748B] hover:text-red-400 transition-colors flex items-center justify-center">
                              <XIcon className="h-3 w-3" />
                            </button>
                          )}
                        </div>

                        {/* Expanded naming row */}
                        {item.expanded && isEditable && (
                          <div className="border-t border-[#E2E8F0] px-2 pb-2 pt-2 grid grid-cols-3 gap-2">
                            <div>
                              <label className="block text-[10px] font-medium text-[#64748B] mb-1">Material</label>
                              <Combobox value={item.nameMatl} onChange={v => updateBatchItem(item.id, { nameMatl: v })} options={nameOpts.materials} placeholder="e.g. Gypsum Board" />
                            </div>
                            <div>
                              <label className="block text-[10px] font-medium text-[#64748B] mb-1">Manufacturer</label>
                              <Combobox value={item.nameMfr} onChange={v => updateBatchItem(item.id, { nameMfr: v })} options={nameOpts.manufacturers} placeholder="e.g. USG" />
                            </div>
                            <div>
                              <label className="block text-[10px] font-medium text-[#64748B] mb-1">Dimensions</label>
                              <Combobox value={item.nameDims} onChange={v => updateBatchItem(item.id, { nameDims: v })} options={nameOpts.dimensions} placeholder='e.g. 5/8"' />
                            </div>
                            {hasName && (
                              <div className="col-span-3 text-[11px] text-[#7B9BB5] truncate">
                                {[item.nameMatl, item.nameMfr, item.nameDims].filter(Boolean).join(" — ")}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}

                  {batchPhase === "classifying" && (
                    <p className="text-[12px] text-[#64748B] pt-2 text-center">
                      Analyzing {batchItems.filter(it => it.status === "classifying").length > 0
                        ? `"${batchItems.find(it => it.status === "classifying")?.file.name ?? ""}"`
                        : "files"}…
                    </p>
                  )}

                  {batchPhase === "done" && (() => {
                    const done = batchItems.filter(it => it.status === "done").length
                    const errs = batchItems.filter(it => it.status === "upload-error").length
                    return (
                      <div className="mt-3 rounded-lg border border-[#E2E8F0] bg-[#F4F5F7] px-4 py-3 text-center">
                        <p className="text-[13px] font-semibold text-[#0F172A]">
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
            <div className="flex-shrink-0 border-t border-[#E2E8F0] px-6 py-4 flex justify-between items-center">
              <button onClick={closeBatch} className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors">
                {batchPhase === "done" ? "Close" : "Cancel"}
              </button>
              <div className="flex items-center gap-3">
                {batchPhase === "review" && (
                  <p className="text-[12px] text-[#64748B]">
                    {batchItems.filter(it => it.status === "ready").length} ready ·{" "}
                    {batchItems.filter(it => it.status === "error" && it.divNum && it.secCode).length} manual ·{" "}
                    {batchItems.filter(it => it.status === "error" && (!it.divNum || !it.secCode)).length} unassigned
                  </p>
                )}
                {batchPhase === "select" && (
                  <button
                    disabled={batchItems.length === 0}
                    onClick={classifyBatch}
                    className="h-8 px-5 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-40 flex items-center gap-2"
                  >
                    <SpinnerIcon className="h-3 w-3 hidden" />
                    Analyze {batchItems.length > 0 ? `${batchItems.length} files` : "files"}
                  </button>
                )}
                {batchPhase === "review" && (
                  <button
                    disabled={!batchItems.some(it => it.divNum && it.secCode)}
                    onClick={uploadBatch}
                    className="h-8 px-5 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-40"
                  >
                    Upload {batchItems.filter(it => it.divNum && it.secCode).length} files
                  </button>
                )}
                {batchPhase === "uploading" && (
                  <div className="flex items-center gap-2 text-[13px] text-[#64748B]">
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
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[360px] mx-4 sm:mx-0 p-5">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-[15px] font-bold text-[#0F172A]">Manage Divisions</h2>
              <button onClick={() => setShowManage(false)} className="text-[#64748B] hover:text-[#64748B] transition-colors">
                <XIcon className="h-4 w-4" />
              </button>
            </div>
            <p className="text-[12px] text-[#64748B] mb-3">Uncheck divisions to hide them from the sidebar.</p>
            <div className="space-y-0.5 max-h-[420px] overflow-y-auto">
              {CSI_DIVISIONS.map(d => {
                const hidden = hiddenDivisions.has(d.num)
                return (
                  <button
                    key={d.num}
                    onClick={() => toggleDivisionVisibility(d.num)}
                    className="w-full flex items-center gap-2.5 h-8 px-2 rounded-md hover:bg-[#0F172A]/[0.04] transition-colors text-left"
                  >
                    <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${hidden ? "border-[#E2E8F0] bg-transparent" : "border-[#7B9BB5] bg-[#7B9BB5]"}`}>
                      {!hidden && <CheckIcon />}
                    </span>
                    <span className="text-[11px] font-mono text-[#64748B] w-5 text-right flex-shrink-0">{d.num}</span>
                    <span className={`text-[13px] truncate transition-colors ${hidden ? "text-[#64748B]" : "text-[#0F172A]"}`}>{d.name}</span>
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


