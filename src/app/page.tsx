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
interface AiResult { division_num: string; division_name: string; section_code: string; section_name: string }

interface Project { id: string; name: string; number: string | null; location: string | null; gc_name: string | null; architect: string | null }
interface TeamMember { id: string; name: string; title: string | null; email: string | null }
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
    if (showUpload) {
      fetch("/api/submittal-names")
        .then(r => r.json())
        .then(d => setNameOpts(d))
        .catch(() => {})
    }
  }, [showUpload])

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
    setUploadStep("naming")
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
    try {
      const res  = await fetch(`/api/search?q=${encodeURIComponent(q)}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Search failed")
      setSearchResults(data.files)
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

    try {
      const res  = await fetch("/api/upload", { method: "POST", body: fd })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Upload failed")

      // Open the division + section and immediately fetch the files
      setOpenDivisions(prev => new Set([...prev, uploadDiv]))
      setOpenSections(prev => new Set([...prev, uploadSec]))
      setSectionFiles(prev => { const n = { ...prev }; delete n[uploadSec]; return n })
      refetchSection(uploadSec)
      loadTree()
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
      <aside className="w-[252px] flex-shrink-0 bg-[#161b27] border-r border-[#2a3347] flex flex-col h-screen sticky top-0 overflow-hidden">

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
        <div className="flex-shrink-0 flex items-center justify-between px-4 pb-1">
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
                      {(CSI_SECTIONS[div.num] ?? div.sections).map(sec => {
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
                              <span className="flex-1 text-[12px] text-[#8b9ab5] truncate">{sec.name}</span>
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
      <div className="flex-1 flex flex-col">
        {logoUrl && (
          <div className="flex-shrink-0 h-13 border-b border-[#2a3347] flex items-center justify-end px-6 bg-[#161b27]">
            <img src={logoUrl} alt="Company logo" className="h-8 max-w-[180px] object-contain" />
          </div>
        )}
      <main className="flex-1 flex items-center justify-center select-none">
        <div className="text-center">
          <div className="w-16 h-16 rounded-2xl bg-[#2563eb]/10 border border-[#2563eb]/20 flex items-center justify-center mx-auto mb-5">
            <svg className="w-8 h-8 text-[#3b82f6]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <p className="text-[17px] font-bold text-[#c8d3e6] tracking-tight">Submittal Library</p>
          <p className="text-[13px] text-[#4f617a] mt-1.5">
            Expand a division to browse,<br />or search in the sidebar.
          </p>
          <button
            onClick={() => setShowUpload(true)}
            className="mt-6 h-9 px-5 rounded-lg bg-[#2563eb] text-white text-[13px] font-semibold hover:bg-[#1d4ed8] transition-colors inline-flex items-center gap-2"
          >
            <PlusIcon /> Upload submittal
          </button>
        </div>
      </main>
      </div>

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
                  <div className="flex gap-2 pt-0.5">
                    <button type="button" onClick={acceptSuggestion}
                      className="h-7 px-3 rounded-md bg-[#2563eb] text-white text-[12px] font-semibold hover:bg-[#1d4ed8] transition-colors">
                      Use this
                    </button>
                    <button type="button" onClick={() => { setUploadDiv(""); setUploadSec(""); setUploadStep("manual") }}
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
                    <input
                      type="text"
                      list="matl-opts"
                      value={nameMatl}
                      onChange={e => setNameMatl(e.target.value)}
                      placeholder="e.g. Gypsum Board"
                      autoFocus
                      className="w-full h-9 px-3 rounded-md border border-[#2a3347] text-[13px] text-[#e8edf5] bg-[#0d1117] focus:outline-none focus:ring-1 focus:ring-[#2563eb]/40 focus:border-[#2563eb]/50 placeholder:text-[#4f617a] transition-all"
                    />
                    <datalist id="matl-opts">
                      {nameOpts.materials.map(m => <option key={m} value={m} />)}
                    </datalist>
                  </div>

                  <div>
                    <label className="block text-[12px] font-medium text-[#8b9ab5] mb-1">Manufacturer</label>
                    <input
                      type="text"
                      list="mfr-opts"
                      value={nameMfr}
                      onChange={e => setNameMfr(e.target.value)}
                      placeholder="e.g. Georgia-Pacific"
                      className="w-full h-9 px-3 rounded-md border border-[#2a3347] text-[13px] text-[#e8edf5] bg-[#0d1117] focus:outline-none focus:ring-1 focus:ring-[#2563eb]/40 focus:border-[#2563eb]/50 placeholder:text-[#4f617a] transition-all"
                    />
                    <datalist id="mfr-opts">
                      {nameOpts.manufacturers.map(m => <option key={m} value={m} />)}
                    </datalist>
                  </div>

                  <div>
                    <label className="block text-[12px] font-medium text-[#8b9ab5] mb-1">Dimensions</label>
                    <input
                      type="text"
                      list="dims-opts"
                      value={nameDims}
                      onChange={e => setNameDims(e.target.value)}
                      placeholder='e.g. 5/8" x 4&apos; x 8&apos;'
                      className="w-full h-9 px-3 rounded-md border border-[#2a3347] text-[13px] text-[#e8edf5] bg-[#0d1117] focus:outline-none focus:ring-1 focus:ring-[#2563eb]/40 focus:border-[#2563eb]/50 placeholder:text-[#4f617a] transition-all"
                    />
                    <datalist id="dims-opts">
                      {nameOpts.dimensions.map(d => <option key={d} value={d} />)}
                    </datalist>
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
