"use client"

import { apiFetch } from "@/lib/api-client"
import { useState, useEffect, useCallback } from "react"
import type { CloseoutItem, CloseoutPackage, CloseoutPackageDetail, CloseoutPackageInbound } from "@/app/dashboard/_shared/types"
import ReminderSettingsPanel from "@/components/reminders/ReminderSettingsPanel"

// ─── Closeout Packages tab (Session K1) ─────────────────────────────────────
// Lists dispatched + draft closeout packages and a detail panel with expected
// items + pending inbound replies. Inbound replies are always orphans (the
// match-back policy is conservative — never auto-link). The PM "places" each
// reply onto an expected closeout_item or dismisses it.

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—"
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso)
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

const STATUS_STYLE: Record<string, string> = {
  draft:            "bg-[#F1F5F9] text-[#64748B]",
  dispatched:       "bg-blue-100 text-blue-700",
  partial_received: "bg-amber-100 text-amber-700",
  complete:         "bg-green-100 text-green-700",
}
const STATUS_LABEL: Record<string, string> = {
  draft: "Draft", dispatched: "Dispatched", partial_received: "Partial", complete: "Complete",
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${STATUS_STYLE[status] ?? STATUS_STYLE.draft}`}>
      {STATUS_LABEL[status] ?? status}
    </span>
  )
}

const CATEGORY_LABEL: Record<string, string> = {
  documents: "Documents",
  inspections: "Inspections",
  warranties: "Warranties",
  handover: "Handover",
  training: "Training",
  subcontractors: "Subcontractor",
  suppliers: "Supplier",
}

export default function CloseoutPackagesView({ projectId }: { projectId: string }) {
  const [packages, setPackages] = useState<CloseoutPackage[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const loadPackages = useCallback(() => {
    if (!projectId) { setPackages([]); setLoading(false); return }
    setLoading(true)
    apiFetch(`/api/closeout-packages?project_id=${encodeURIComponent(projectId)}`)
      .then(r => r.json())
      .then(d => setPackages(d.packages ?? []))
      .catch(() => setPackages([]))
      .finally(() => setLoading(false))
  }, [projectId])

  useEffect(() => { loadPackages() }, [loadPackages])

  if (selectedId) {
    return <PackageDetail
      packageId={selectedId}
      onBack={() => { setSelectedId(null); loadPackages() }}
      onChanged={loadPackages}
    />
  }

  if (loading) {
    return <div className="flex items-center justify-center h-40 text-[13px] text-[#64748B]">Loading packages…</div>
  }

  if (packages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-24 text-center">
        <div className="w-14 h-14 rounded-2xl bg-[#7B9BB5]/10 border border-[#7B9BB5]/20 flex items-center justify-center mb-4">
          <svg className="w-7 h-7 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
          </svg>
        </div>
        <p className="text-[15px] font-bold text-[#0F172A]">No closeout packages yet</p>
        <p className="text-[13px] text-[#64748B] mt-1.5 max-w-sm">
          On the Items tab, turn on Select mode, choose closeout items, and create a package to dispatch.
        </p>
      </div>
    )
  }

  return (
    <div className="px-4 py-4">
      <div className="rounded-xl border border-[#E2E8F0] overflow-clip bg-white">
        <table className="w-full text-[13px] border-collapse">
          <thead className="bg-[#F8F9FA]">
            <tr className="border-b border-[#E2E8F0]">
              {["Package #", "Vendor", "Status", "Items", "Complete", "Due", "Dispatched"].map(h => (
                <th key={h} className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-wider whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {packages.map(p => (
              <tr key={p.id} onClick={() => setSelectedId(p.id)}
                className="border-b border-[#E2E8F0]/60 last:border-0 hover:bg-[#F8F9FA] cursor-pointer transition-colors">
                <td className="px-4 py-2.5 font-mono text-[12px] font-semibold text-[#0F172A] whitespace-nowrap">{p.package_number}</td>
                <td className="px-4 py-2.5 text-[#0F172A] max-w-[200px] truncate" title={p.vendor_name_snapshot}>{p.vendor_name_snapshot}</td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-1.5">
                    <StatusBadge status={p.status} />
                    {(p.needs_review_count ?? 0) > 0 && (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-red-100 text-red-700"
                        title="Inbound replies need review">
                        {p.needs_review_count} to review
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-2.5 tabular-nums text-[#64748B]">{p.item_count ?? 0}</td>
                <td className="px-4 py-2.5 tabular-nums text-[#64748B]">{p.received_count ?? 0} / {p.item_count ?? 0}</td>
                <td className="px-4 py-2.5 text-[#64748B] whitespace-nowrap">{fmtDate(p.due_date)}</td>
                <td className="px-4 py-2.5 text-[#64748B] whitespace-nowrap">{fmtDate(p.dispatched_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Detail panel ───────────────────────────────────────────────────────────

function PackageDetail({ packageId, onBack, onChanged }: {
  packageId: string
  onBack: () => void
  onChanged: () => void
}) {
  const [pkg, setPkg] = useState<CloseoutPackageDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    apiFetch(`/api/closeout-packages/${packageId}`)
      .then(r => r.json())
      .then(d => setPkg(d.package ?? null))
      .catch(() => setPkg(null))
      .finally(() => setLoading(false))
  }, [packageId])

  useEffect(() => { load() }, [load])

  async function previewPdf() {
    setBusy("pdf"); setError(null)
    try {
      const res = await apiFetch(`/api/closeout-packages/${packageId}/pdf`, { method: "POST" })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || !d.url) { setError(d.error ?? "Could not generate the PDF"); return }
      window.open(d.url, "_blank")
    } finally { setBusy(null) }
  }

  async function dispatch() {
    setBusy("dispatch"); setError(null)
    try {
      const res = await apiFetch(`/api/closeout-packages/${packageId}/dispatch`, { method: "POST" })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d.error ?? "Dispatch failed"); return }
      load(); onChanged()
    } finally { setBusy(null) }
  }

  async function remove() {
    if (!window.confirm("Delete this package? This cannot be undone.")) return
    setBusy("delete"); setError(null)
    try {
      const res = await apiFetch(`/api/closeout-packages/${packageId}`, { method: "DELETE" })
      if (res.ok) { onChanged(); onBack() }
      else setError("Delete failed")
    } finally { setBusy(null) }
  }

  async function placeInbound(inboundId: string, closeoutItemId: string) {
    setBusy(`place-${inboundId}`); setError(null)
    try {
      const res = await apiFetch(`/api/closeout-packages/${packageId}/inbound/${inboundId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ closeout_item_id: closeoutItemId }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d.error ?? "Could not place reply"); return }
      load(); onChanged()
    } finally { setBusy(null) }
  }

  async function dismissInbound(inboundId: string) {
    if (!window.confirm("Dismiss this reply? It will be removed from the needs-review list.")) return
    setBusy(`dismiss-${inboundId}`); setError(null)
    try {
      const res = await apiFetch(`/api/closeout-packages/${packageId}/inbound/${inboundId}`, { method: "DELETE" })
      if (!res.ok) { setError("Dismiss failed"); return }
      load(); onChanged()
    } finally { setBusy(null) }
  }

  if (loading) {
    return <div className="flex items-center justify-center h-40 text-[13px] text-[#64748B]">Loading package…</div>
  }
  if (!pkg) {
    return (
      <div className="px-4 py-4">
        <button onClick={onBack} className="text-[13px] text-[#7B9BB5] hover:underline">← Back to packages</button>
        <p className="mt-4 text-[13px] text-red-500">Package not found.</p>
      </div>
    )
  }

  return (
    <div className="px-4 py-4 space-y-4">
      <button onClick={onBack} className="text-[13px] text-[#7B9BB5] hover:underline">← Back to packages</button>

      <div className="rounded-xl border border-[#E2E8F0] bg-white p-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-[15px] font-bold text-[#0F172A] font-mono">{pkg.package_number}</h2>
              <StatusBadge status={pkg.status} />
            </div>
            <p className="text-[13px] text-[#0F172A] mt-1">{pkg.vendor_name_snapshot}</p>
            <p className="text-[12px] text-[#64748B]">{pkg.sent_to_email}</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={previewPdf} disabled={!!busy}
              className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[12px] font-semibold text-[#0F172A] hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50">
              {busy === "pdf" ? "Generating…" : "Preview PDF"}
            </button>
            {pkg.status === "draft" && (
              <button onClick={dispatch} disabled={!!busy}
                className="h-8 px-3 rounded-md bg-emerald-600 text-white text-[12px] font-semibold hover:bg-emerald-700 transition-colors disabled:opacity-50">
                {busy === "dispatch" ? "Dispatching…" : "Dispatch"}
              </button>
            )}
            <button onClick={remove} disabled={!!busy}
              className="h-8 px-3 rounded-md border border-red-200 text-[12px] font-semibold text-red-500 hover:bg-red-50 transition-colors disabled:opacity-50">
              Delete
            </button>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
          {[
            ["Tracking Ref", `[${pkg.package_number}]`],
            ["Due Date", fmtDate(pkg.due_date)],
            ["Dispatched", fmtDate(pkg.dispatched_at)],
            ["Complete", `${pkg.received_count ?? 0} / ${pkg.item_count ?? 0}`],
          ].map(([label, value]) => (
            <div key={label}>
              <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-0.5">{label}</p>
              <p className="text-[13px] text-[#0F172A]">{value}</p>
            </div>
          ))}
        </div>
        {pkg.notes && <p className="text-[12px] text-[#64748B] mt-3 whitespace-pre-wrap">{pkg.notes}</p>}
        {error && <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-[12px] text-red-600 mt-3">{error}</div>}
      </div>

      {/* Reminder settings */}
      <ReminderSettingsPanel
        pkg={pkg}
        reminderSettings={pkg.reminder_settings}
        saveEndpoint={`/api/closeout-packages/${packageId}/settings`}
        onSaved={load}
      />

      {/* Needs-review inbound replies — orphans awaiting PM placement */}
      {pkg.needs_review.length > 0 && (
        <div className="rounded-xl border border-red-200 bg-red-50/50 overflow-clip">
          <div className="px-4 py-2.5 border-b border-red-200 bg-red-50">
            <p className="text-[12px] font-bold text-red-700">
              {pkg.needs_review.length} inbound {pkg.needs_review.length === 1 ? "reply" : "replies"} need review
            </p>
            <p className="text-[11px] text-red-600/80">
              These submissions matched this package&apos;s tracking tag. Place each one onto the expected closeout item it fulfills, or dismiss it.
            </p>
          </div>
          <div className="divide-y divide-red-200/60">
            {pkg.needs_review.map((s: CloseoutPackageInbound) => (
              <InboundRow key={s.id} inbound={s} items={pkg.items} busy={busy}
                onPlace={placeInbound} onDismiss={dismissInbound} />
            ))}
          </div>
        </div>
      )}

      {/* Expected items */}
      <div className="rounded-xl border border-[#E2E8F0] overflow-clip bg-white">
        <div className="px-4 py-2.5 border-b border-[#E2E8F0] bg-[#F8F9FA]">
          <p className="text-[12px] font-bold text-[#0F172A]">Expected Items <span className="font-normal text-[#64748B]">({pkg.items.length})</span></p>
        </div>
        <table className="w-full text-[12px] border-collapse">
          <thead>
            <tr className="border-b border-[#E2E8F0]">
              {["Item", "Category", "Assigned", "Due", "Status", "Doc"].map(h => (
                <th key={h} className="text-left px-3 py-2 text-[10px] font-bold text-[#64748B] uppercase tracking-wider whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pkg.items.map((c: CloseoutItem) => (
              <tr key={c.id} className="border-b border-[#E2E8F0]/60 last:border-0">
                <td className="px-3 py-2 text-[#0F172A] max-w-[280px] truncate" title={c.title}>{c.title}</td>
                <td className="px-3 py-2 text-[#64748B]">
                  {c.folder_name ? `${CATEGORY_LABEL[c.category] ?? c.category} · ${c.folder_name}` : (CATEGORY_LABEL[c.category] ?? c.category)}
                </td>
                <td className="px-3 py-2 text-[#64748B]">{c.assigned_to ?? "—"}</td>
                <td className="px-3 py-2 text-[#64748B] whitespace-nowrap">{fmtDate(c.due_date)}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {c.status === "complete"
                    ? <span className="text-green-700 font-medium">Complete</span>
                    : c.status === "in_progress"
                      ? <span className="text-amber-700">In Progress</span>
                      : <span className="text-[#94A3B8]">Incomplete</span>}
                </td>
                <td className="px-3 py-2 text-[#64748B] truncate max-w-[140px]" title={c.file_name ?? ""}>{c.file_name ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function InboundRow({ inbound, items, busy, onPlace, onDismiss }: {
  inbound: CloseoutPackageInbound
  items: CloseoutItem[]
  busy: string | null
  onPlace: (inboundId: string, closeoutItemId: string) => void
  onDismiss: (inboundId: string) => void
}) {
  const [target, setTarget] = useState<string>("")
  const isBusy = busy === `place-${inbound.id}` || busy === `dismiss-${inbound.id}`

  return (
    <div className="flex items-center gap-2 px-4 py-2 flex-wrap">
      <span className="flex-1 min-w-[160px] text-[12px] text-[#0F172A] truncate" title={inbound.file_name}>
        {inbound.file_name}
      </span>
      {inbound.sender_email && <span className="text-[11px] text-[#64748B] hidden sm:inline">{inbound.sender_email}</span>}
      <span className="text-[11px] text-[#64748B] whitespace-nowrap">
        {inbound.received_at
          ? new Date(inbound.received_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
          : "—"}
      </span>
      <select value={target} onChange={e => setTarget(e.target.value)}
        className="h-7 px-2 rounded border border-red-200 bg-white text-[11px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-red-300">
        <option value="">Place on item…</option>
        {items.map(c => (
          <option key={c.id} value={c.id}>{c.title}</option>
        ))}
      </select>
      <button disabled={isBusy || !target} onClick={() => onPlace(inbound.id, target)}
        className="text-[11px] font-semibold text-white bg-emerald-600 hover:bg-emerald-700 px-2 py-1 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
        Place
      </button>
      <button disabled={isBusy} onClick={() => onDismiss(inbound.id)}
        className="text-[11px] font-semibold text-red-500 hover:bg-red-100 px-2 py-1 rounded transition-colors disabled:opacity-50">
        Dismiss
      </button>
    </div>
  )
}
