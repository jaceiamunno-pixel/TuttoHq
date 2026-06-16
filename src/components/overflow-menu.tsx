"use client"

import { useEffect, useRef, useState } from "react"

// Reusable toolbar overflow ("More") menu. Collapses secondary actions behind a
// single ⋯ button so module toolbars stay decluttered. Pure presentation — each
// item just calls the handler it's given; it owns no business logic. Built to be
// dropped into any module toolbar (wired for the Submittal Log first).
export interface OverflowItem {
  key: string
  label: string
  description?: string
  icon?: React.ReactNode
  onClick: () => void
  /** Shows a check on the right — for toggle items (e.g. "Group by section"). */
  checked?: boolean
  danger?: boolean
  disabled?: boolean
  /** Keep the menu open after click (toggles). Defaults to false (close). */
  keepOpen?: boolean
}

export type OverflowEntry = OverflowItem | "separator"

export default function OverflowMenu({
  items,
  align = "right",
  buttonLabel = "More",
}: {
  items: OverflowEntry[]
  align?: "left" | "right"
  buttonLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [])

  const actionable = items.filter((i): i is OverflowItem => i !== "separator")
  if (actionable.length === 0) return null

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-label={buttonLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        title={buttonLabel}
        className={`h-8 px-2.5 rounded-md border text-[12px] font-semibold transition-colors flex items-center gap-1.5 whitespace-nowrap ${open ? "border-[#7B9BB5] bg-[#7B9BB5]/10 text-[#0F172A]" : "border-[#E2E8F0] text-[#64748B] hover:bg-[#0F172A]/[0.04]"}`}
      >
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
        </svg>
        <span className="hidden sm:inline">{buttonLabel}</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            role="menu"
            className={`absolute ${align === "right" ? "right-0" : "left-0"} top-full mt-1 z-50 w-64 bg-white border border-[#E2E8F0] rounded-lg shadow-xl overflow-hidden py-1`}
          >
            {items.map((it, i) =>
              it === "separator" ? (
                <div key={`sep-${i}`} className="my-1 border-t border-[#E2E8F0]" />
              ) : (
                <button
                  key={it.key}
                  type="button"
                  role="menuitem"
                  disabled={it.disabled}
                  onClick={() => { it.onClick(); if (!it.keepOpen) setOpen(false) }}
                  className={`w-full text-left px-3 py-2 flex items-start gap-2.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${it.danger ? "hover:bg-red-50" : "hover:bg-[#F8F9FA]"}`}
                >
                  {it.icon && <span className={`mt-0.5 flex-shrink-0 ${it.danger ? "text-red-600" : "text-[#64748B]"}`}>{it.icon}</span>}
                  <span className="min-w-0 flex-1">
                    <span className={`block text-[12px] font-semibold ${it.danger ? "text-red-600" : "text-[#0F172A]"}`}>{it.label}</span>
                    {it.description && <span className={`block text-[11px] ${it.danger ? "text-red-400" : "text-[#64748B]"}`}>{it.description}</span>}
                  </span>
                  {it.checked && (
                    <svg className="w-4 h-4 mt-0.5 flex-shrink-0 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </button>
              ),
            )}
          </div>
        </>
      )}
    </div>
  )
}
