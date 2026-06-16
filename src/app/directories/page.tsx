"use client"

import Link from "next/link"
import AppChrome from "@/components/app-chrome"

// Top-level Directories — the company-scoped global lists (Subcontractors,
// Suppliers, Construction Managers). They are cross-project by nature, so they
// live at root, not inside a project.
//
// Scope note (ADR-006): this shell pass establishes Directories as a top-level
// destination. The CRUD itself still lives in Settings today; per ADR-006
// "Settings links into [Directories] rather than duplicating", so until the
// generic directory component is lifted out of Settings (queued separately),
// each list links to its existing management surface. No data layer is
// duplicated here.
const LISTS = [
  { label: "Subcontractors",       desc: "Global list of subcontractors reusable across all projects.", href: "/settings?tab=subcontractors" },
  { label: "Suppliers",            desc: "Global list of material suppliers reusable across all projects.", href: "/settings?tab=suppliers" },
  { label: "Construction Managers", desc: "Global list of CMs reusable across all projects.", href: "/settings?tab=cms" },
]

export default function DirectoriesPage() {
  return (
    <AppChrome>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-[1100px] mx-auto px-4 sm:px-6 py-8 sm:py-10">
          <h1 className="text-[20px] sm:text-[22px] font-bold text-[#0F172A] tracking-tight">Directories</h1>
          <p className="text-[13px] text-[#64748B] mt-0.5 mb-6">Company-wide contact lists, reusable across every project.</p>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {LISTS.map(l => (
              <Link
                key={l.label}
                href={l.href}
                className="group bg-white rounded-xl border border-[#E2E8F0] p-4 hover:border-[#7B9BB5]/60 hover:shadow-sm transition-all"
              >
                <h2 className="text-[14px] font-semibold text-[#0F172A] group-hover:text-[#456A88] transition-colors">{l.label}</h2>
                <p className="text-[12px] text-[#64748B] mt-1">{l.desc}</p>
                <div className="mt-3 text-[12px] font-semibold text-[#7B9BB5] flex items-center gap-1">
                  Manage
                  <svg className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </AppChrome>
  )
}
