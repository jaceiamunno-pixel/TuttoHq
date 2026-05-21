"use client"

import { useState, useEffect, useRef } from "react"
import type { SubmittalFile } from "./types"
import { getDot, fmtDate } from "./format"
import { XIcon } from "./icons"

// Shared form-control class strings + reusable UI components,
// lifted verbatim from dashboard/page.tsx during the module split (Step 0).

export const inputCls = "w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[14px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 focus:border-[#7B9BB5]/50 placeholder:text-[#64748B] transition-all"
export const labelCls = "block text-[11px] font-semibold text-[#64748B] uppercase tracking-[0.08em] mb-1.5"

export function Combobox({ value, onChange, options, placeholder, autoFocus }: {
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

// Full-area empty state shown by the shell when a project-scoped module is
// opened with no project selected. Library is the only cross-project module,
// so every other module routes through this instead of "All Projects" data.
export function SelectProjectEmptyState({ label }: { label: string }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center min-h-0 py-24 text-center">
      <div className="w-14 h-14 rounded-2xl bg-[#7B9BB5]/10 border border-[#7B9BB5]/20 flex items-center justify-center mb-4">
        <svg className="w-7 h-7 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
        </svg>
      </div>
      <p className="text-[15px] font-bold text-[#0F172A]">Select a project to view {label}</p>
      <p className="text-[13px] text-[#64748B] mt-1.5">Choose a project from the selector in the sidebar.</p>
    </div>
  )
}

export function SidebarFileRow({ file, indent, onDelete, onOpen }: { file: SubmittalFile; indent: number; onDelete?: () => void; onOpen: () => void }) {
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
