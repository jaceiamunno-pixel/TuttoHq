"use client"

import { apiFetch } from "@/lib/api-client"
import { useState, useEffect, useRef } from "react"
import type { Vendor } from "./types"
import { SpinnerIcon } from "./icons"

// Searchable single-step vendor picker — anchored fixed-position dropdown with
// typeahead search against the unified vendors master. Results are
// server-filtered (the master is 1,400+ rows). Extracted from the PO module so
// the supplier-contract form can reuse it; the optional `role` prop narrows the
// /api/vendors query (PO callers pass nothing → unchanged behavior).
export type VendorRole = "supplier" | "subcontractor" | "supplier_or_subcontractor"

export function VendorPicker({ vendor, onChange, role, placeholder }: {
  vendor: Vendor | null
  onChange: (v: Vendor) => void
  role?: VendorRole
  placeholder?: string
}) {
  const [open, setOpen]   = useState(false)
  const [q, setQ]         = useState("")
  const [rows, setRows]   = useState<Vendor[]>([])
  const [loading, setLoading] = useState(false)
  const [pos, setPos]     = useState<{ top: number; left: number; width: number } | null>(null)
  const ref    = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [open])

  // Debounced server search whenever the dropdown is open and the query changes.
  useEffect(() => {
    if (!open) return
    setLoading(true)
    const t = setTimeout(() => {
      const params = new URLSearchParams()
      if (q.trim()) params.set("q", q.trim())
      if (role) params.set("role", role)
      apiFetch(`/api/vendors?${params.toString()}`)
        .then(r => r.json())
        .then(d => setRows(d.vendors ?? []))
        .catch(() => setRows([]))
        .finally(() => setLoading(false))
    }, 200)
    return () => clearTimeout(t)
  }, [q, open, role])

  function toggle() {
    if (open) { setOpen(false); return }
    const r = btnRef.current?.getBoundingClientRect()
    if (r) setPos({ top: r.bottom + 4, left: r.left, width: r.width })
    setQ("")
    setOpen(true)
  }

  return (
    <div ref={ref}>
      <button ref={btnRef} type="button" onClick={toggle}
        className={`w-full h-9 px-3 rounded-md border text-[14px] text-left truncate bg-white transition-colors hover:border-[#7B9BB5]/60 ${open ? "border-[#7B9BB5]" : "border-[#E2E8F0]"} ${vendor ? "text-[#0F172A]" : "text-[#64748B]"}`}>
        {vendor?.company_name ?? placeholder ?? "Select a vendor…"}
      </button>
      {open && pos && (
        <div style={{ position: "fixed", top: pos.top, left: pos.left, width: Math.max(pos.width, 280) }}
          className="z-50 bg-white border border-[#E2E8F0] rounded-lg shadow-xl">
          <div className="p-1.5 border-b border-[#E2E8F0]">
            <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search vendors…"
              className="w-full h-8 px-2 rounded border border-[#E2E8F0] text-[13px] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" />
          </div>
          <div className="max-h-72 overflow-y-auto py-1">
            {loading ? (
              <p className="px-3 py-2 text-[12px] text-[#94A3B8] flex items-center gap-2"><SpinnerIcon className="h-3 w-3" /> Searching…</p>
            ) : rows.length === 0 ? (
              <p className="px-3 py-2 text-[12px] text-[#94A3B8]">No vendors match.</p>
            ) : rows.map(v => (
              <button key={v.id} type="button" onClick={() => { onChange(v); setOpen(false) }}
                className={`w-full text-left px-3 py-1.5 hover:bg-[#F8F9FA] ${v.id === vendor?.id ? "bg-[#7B9BB5]/5" : ""}`}>
                <p className={`text-[13px] truncate ${v.id === vendor?.id ? "text-[#7B9BB5] font-semibold" : "text-[#0F172A]"}`}>{v.company_name}</p>
                <p className="text-[11px] text-[#94A3B8] truncate">{[v.vendor_no, [v.city, v.state].filter(Boolean).join(", ")].filter(Boolean).join(" · ") || " "}</p>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
