"use client"

import { useState } from "react"
import type { TocEntry, TocDivision } from "@/lib/scope-types"

// Presentational scope-selection UI. Kept free of page-specific state and data
// fetching so it can be lifted into a shared module when the dashboard
// "upload spec book later" flow reuses it.

/**
 * Whether a CSI division is checked by default in the project scope wizard.
 * Divisions 01–12 and 14 are typically GC-owned; 13 (Special Construction) is
 * highly variable and usually carried by specialty subs as primes; 15+ (MEP,
 * sitework, process equipment) start unchecked.
 */
export function isDefaultInScopeDivision(code: string): boolean {
  const n = parseInt(code, 10)
  return (n >= 1 && n <= 12) || n === 14
}

// ─── Division checklist (wizard step: divisions) ─────────────────────────────

interface DivisionChecklistProps {
  divisions: TocDivision[]
  checked: Set<string>
  onToggle: (code: string) => void
}

export function DivisionChecklist({ divisions, checked, onToggle }: DivisionChecklistProps) {
  if (divisions.length === 0) {
    return <p className="text-[13px] text-[#64748B]">No divisions were found in this spec book&apos;s table of contents.</p>
  }
  return (
    <div className="space-y-0.5 max-h-[420px] overflow-y-auto">
      {divisions.map(d => {
        const isChecked = checked.has(d.code)
        return (
          <button
            key={d.code}
            type="button"
            onClick={() => onToggle(d.code)}
            className="w-full flex items-center gap-2.5 h-9 px-2 rounded-md hover:bg-[#0F172A]/[0.04] transition-colors text-left"
          >
            <input
              type="checkbox"
              checked={isChecked}
              readOnly
              className="accent-[#7B9BB5] pointer-events-none"
            />
            <span className="text-[11px] font-mono text-[#64748B] w-6 text-right flex-shrink-0">{d.code}</span>
            <span className={`text-[13px] truncate flex-1 ${isChecked ? "text-[#0F172A]" : "text-[#64748B]"}`}>{d.name}</span>
            <span className="text-[11px] text-[#64748B] flex-shrink-0">{d.sectionCount} section{d.sectionCount === 1 ? "" : "s"}</span>
          </button>
        )
      })}
    </div>
  )
}

// ─── Section accordion (wizard step: section refinement) ─────────────────────

interface SectionAccordionProps {
  divisions: TocDivision[]            // only the divisions selected in the prior step
  sections: TocEntry[]                // all TOC sections
  checkedSections: Set<string>        // spec_numbers currently in scope
  onToggleSection: (specNumber: string) => void
  onSetDivision: (specNumbers: string[], checked: boolean) => void
}

export function SectionAccordion({
  divisions,
  sections,
  checkedSections,
  onToggleSection,
  onSetDivision,
}: SectionAccordionProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  if (divisions.length === 0) {
    return <p className="text-[13px] text-[#64748B]">No divisions selected. Go back and choose at least one division.</p>
  }

  function toggleExpanded(code: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(code)) next.delete(code)
      else next.add(code)
      return next
    })
  }

  return (
    <div className="space-y-1.5 max-h-[460px] overflow-y-auto">
      {divisions.map(d => {
        const divSections = sections.filter(s => s.divisionCode === d.code)
        const specNumbers = divSections.map(s => s.specNumber)
        const selectedCount = specNumbers.filter(n => checkedSections.has(n)).length
        const allSelected = selectedCount === specNumbers.length && specNumbers.length > 0
        const isOpen = expanded.has(d.code)
        return (
          <div key={d.code} className="rounded-md border border-[#E2E8F0] overflow-hidden">
            <div className="flex items-center gap-2 px-2 h-9 bg-[#F8F9FA]">
              <button
                type="button"
                onClick={() => toggleExpanded(d.code)}
                className="text-[#64748B] hover:text-[#0F172A] transition-colors flex-shrink-0"
                aria-label={isOpen ? "Collapse" : "Expand"}
              >
                <svg className={`w-3.5 h-3.5 transition-transform ${isOpen ? "rotate-90" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
              <input
                type="checkbox"
                checked={allSelected}
                onChange={() => onSetDivision(specNumbers, !allSelected)}
                className="accent-[#7B9BB5]"
              />
              <span className="text-[11px] font-mono text-[#64748B] w-6 text-right flex-shrink-0">{d.code}</span>
              <button
                type="button"
                onClick={() => toggleExpanded(d.code)}
                className="text-[13px] text-[#0F172A] truncate flex-1 text-left"
              >
                {d.name}
              </button>
              <span className="text-[11px] text-[#64748B] flex-shrink-0">{selectedCount} / {specNumbers.length}</span>
            </div>
            {isOpen && (
              <div className="divide-y divide-[#E2E8F0]/60">
                {divSections.map(s => {
                  const isChecked = checkedSections.has(s.specNumber)
                  return (
                    <label
                      key={s.specNumber}
                      className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-[#F8F9FA] transition-colors cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => onToggleSection(s.specNumber)}
                        className="accent-[#7B9BB5]"
                      />
                      <span className="text-[11px] font-mono text-[#64748B] w-16 flex-shrink-0">{s.specNumber}</span>
                      <span className={`text-[12px] truncate ${isChecked ? "text-[#0F172A]" : "text-[#64748B]"}`}>{s.specTitle}</span>
                    </label>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
