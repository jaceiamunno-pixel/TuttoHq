"use client"

import { useState, useEffect, useCallback } from "react"
import type { SubmittalPackage, SubmittalPackageDetail, SubmittalRecord } from "@/app/dashboard/_shared/types"
import GenerationFiles, { type GenFile } from "./GenerationFiles"
import { downloadFilesAsZip } from "@/lib/zip"
import { formatSectionNumber, padSectionSeq } from "@/lib/section-number"

// ─── Packages tab ───────────────────────────────────────────────────────────
// Lists a project's transmittal packages and a detail panel showing the
// packaged items + download / delete. There is no dispatch/send action — a
// package is assembled and downloaded; the PM sends it from their own email.

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
  draft: "Draft", dispatched: "Sent", partial_received: "Partial", complete: "Complete",
}

const RECIPIENT_LABEL: Record<string, string> = { cm: "CM", ae: "A/E", subcontractor: "Subcontractor" }

// "Sent to" label — a transmittal (recipient_type set) shows the recipient
// type; a legacy solicitation package falls back to its stored vendor name.
function sentToLabel(p: SubmittalPackage): string {
  return p.recipient_type ? (RECIPIENT_LABEL[p.recipient_type] ?? p.recipient_type) : (p.vendor_name_snapshot || "—")
}

// The date the package was sent — transmittals use send_date, legacy packages
// their dispatched_at.
function sentDate(p: SubmittalPackage): string | null {
  return p.recipient_type ? p.send_date : p.dispatched_at
}

// State badge — a transmittal is Sent once it has a send_date, else Draft; a
// legacy package uses its solicitation status.
function PkgBadge({ p }: { p: SubmittalPackage }) {
  const { label, style } = p.recipient_type
    ? (p.send_date ? { label: "Sent", style: STATUS_STYLE.dispatched } : { label: "Draft", style: STATUS_STYLE.draft })
    : { label: STATUS_LABEL[p.status] ?? p.status, style: STATUS_STYLE[p.status] ?? STATUS_STYLE.draft }
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${style}`}>
      {label}
    </span>
  )
}

export default function PackagesView({ projectId }: { projectId: string }) {
  const [packages, setPackages] = useState<SubmittalPackage[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const loadPackages = useCallback(() => {
    if (!projectId) { setPackages([]); setLoading(false); return }
    setLoading(true)
    fetch(`/api/submittal-packages?project_id=${encodeURIComponent(projectId)}`)
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
        <p className="text-[15px] font-bold text-[#0F172A]">No transmittal packages yet</p>
        <p className="text-[13px] text-[#64748B] mt-1.5 max-w-sm">
          In the Submittal Log, turn on Select mode, pick the rows to send, and assemble a transmittal package to download.
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
              {["Package #", "Sent To", "Status", "Items", "Sent"].map(h => (
                <th key={h} className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-wider whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {packages.map(p => (
              <tr key={p.id} onClick={() => setSelectedId(p.id)}
                className="border-b border-[#E2E8F0]/60 last:border-0 hover:bg-[#F8F9FA] cursor-pointer transition-colors">
                <td className="px-4 py-2.5 font-mono text-[12px] font-semibold text-[#0F172A] whitespace-nowrap">{p.package_number}</td>
                <td className="px-4 py-2.5 text-[#0F172A] max-w-[200px] truncate" title={sentToLabel(p)}>{sentToLabel(p)}</td>
                <td className="px-4 py-2.5"><PkgBadge p={p} /></td>
                <td className="px-4 py-2.5 tabular-nums text-[#64748B]">{p.item_count ?? 0}</td>
                <td className="px-4 py-2.5 text-[#64748B] whitespace-nowrap">{fmtDate(sentDate(p))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Detail panel ───────────────────────────────────────────────────────────

interface Generation {
  generationId: string
  generatedAt: string
  coversheetMode: "per_item" | "package"
  files: GenFile[]
}

function PackageDetail({ packageId, onBack, onChanged }: {
  packageId: string
  onBack: () => void
  onChanged: () => void
}) {
  const [pkg, setPkg] = useState<SubmittalPackageDetail | null>(null)
  const [gens, setGens] = useState<Generation[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    fetch(`/api/submittal-packages/${packageId}`)
      .then(r => r.json())
      .then(d => setPkg(d.package ?? null))
      .catch(() => setPkg(null))
      .finally(() => setLoading(false))
  }, [packageId])

  // Append-only generation history for the "Past generations" list.
  const loadGens = useCallback(() => {
    fetch(`/api/submittal-packages/${packageId}/files`)
      .then(r => r.json())
      .then(d => setGens(Array.isArray(d.generations) ? d.generations : []))
      .catch(() => setGens([]))
  }, [packageId])

  useEffect(() => { load(); loadGens() }, [load, loadGens])

  // Download the LATEST generation — a pure READ. Re-fetches /files so the
  // signed URLs are fresh, then opens (package) or zips (per_item). It appends
  // NOTHING. Distinct from "Generate again", which is the only write.
  async function downloadLatest() {
    setBusy("dl"); setError(null)
    try {
      const res = await fetch(`/api/submittal-packages/${packageId}/files`)
      const d = await res.json().catch(() => ({}))
      const latest = d.generations?.[0]
      const ready: GenFile[] = (latest?.files ?? []).filter((f: GenFile) => f.url)
      if (ready.length === 0) { setError("No generated files yet — use Generate again."); return }
      if (latest.coversheetMode === "package") {
        window.open(ready[0].url!, "_blank")
      } else {
        await downloadFilesAsZip(ready.map(f => ({ name: f.fileName, url: f.url! })), `${pkg?.package_number ?? "package"}.zip`)
      }
    } catch {
      setError("Could not download the latest generation.")
    } finally { setBusy(null) }
  }

  // Re-generate: append a NEW generation (the only write), then refresh the list.
  async function regenerate() {
    setBusy("gen"); setError(null)
    try {
      const res = await fetch(`/api/submittal-packages/${packageId}/pdf`, { method: "POST" })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d.error ?? "Could not generate"); return }
      loadGens()
    } finally { setBusy(null) }
  }

  async function remove() {
    if (!window.confirm("Delete this package? This cannot be undone.")) return
    setBusy("delete"); setError(null)
    try {
      const res = await fetch(`/api/submittal-packages/${packageId}`, { method: "DELETE" })
      if (res.ok) { onChanged(); onBack() }
      else setError("Delete failed")
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

      {/* Header card */}
      <div className="rounded-xl border border-[#E2E8F0] bg-white p-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-[15px] font-bold text-[#0F172A] font-mono">{pkg.package_number}</h2>
              <PkgBadge p={pkg} />
            </div>
            <p className="text-[13px] text-[#0F172A] mt-1">Sending to {sentToLabel(pkg)}</p>
            <p className="text-[12px] text-[#64748B]">
              {sentDate(pkg) ? `Sent ${fmtDate(sentDate(pkg))}` : "Draft — not sent"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {pkg.recipient_type && (
              <>
                <button onClick={downloadLatest} disabled={!!busy || gens.length === 0}
                  className="h-8 px-3 rounded-md bg-emerald-600 text-white text-[12px] font-semibold hover:bg-emerald-700 transition-colors disabled:opacity-50">
                  {busy === "dl" ? "Preparing…" : "Download latest"}
                </button>
                <button onClick={regenerate} disabled={!!busy}
                  className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[12px] font-semibold text-[#0F172A] hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50">
                  {busy === "gen" ? "Generating…" : "Generate again"}
                </button>
              </>
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
            ["Sent To", sentToLabel(pkg)],
            ["Sent", fmtDate(sentDate(pkg))],
            ["Items", String(pkg.item_count ?? 0)],
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

      {/* Past generations — every prior assembly, newest first (append-only) */}
      {pkg.recipient_type && (
        <div className="rounded-xl border border-[#E2E8F0] bg-white overflow-clip">
          <div className="px-4 py-2.5 border-b border-[#E2E8F0] bg-[#F8F9FA]">
            <p className="text-[12px] font-bold text-[#0F172A]">
              Generations <span className="font-normal text-[#64748B]">({gens.length})</span>
            </p>
          </div>
          {gens.length === 0 ? (
            <p className="px-4 py-3 text-[12px] text-[#64748B]">No generated files yet. Use “Generate again” to build the package.</p>
          ) : (
            <div className="divide-y divide-[#E2E8F0]">
              {gens.map((g, i) => (
                <div key={g.generationId} className="px-4 py-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] font-semibold text-[#0F172A]">
                      {i === 0 ? "Latest" : `Generation ${gens.length - i}`}
                    </span>
                    <span className="text-[11px] text-[#64748B]">{fmtDate(g.generatedAt)}</span>
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-[#F1F5F9] text-[#64748B]">
                      {g.coversheetMode === "per_item" ? "Per item" : "One cover"}
                    </span>
                  </div>
                  <GenerationFiles
                    packageNumber={pkg.package_number}
                    coversheetMode={g.coversheetMode}
                    files={g.files}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Needs-review inbound replies (legacy solicitation packages only) */}
      {pkg.needs_review.length > 0 && (
        <div className="rounded-xl border border-red-200 bg-red-50/50 overflow-clip">
          <div className="px-4 py-2.5 border-b border-red-200 bg-red-50">
            <p className="text-[12px] font-bold text-red-700">
              {pkg.needs_review.length} inbound {pkg.needs_review.length === 1 ? "reply" : "replies"} need review
            </p>
            <p className="text-[11px] text-red-600/80">
              These submissions matched this package&apos;s tracking tag but could not be auto-linked to a single item. Open each and place it manually.
            </p>
          </div>
          <div className="divide-y divide-red-200/60">
            {pkg.needs_review.map(s => (
              <div key={s.id} className="flex items-center gap-2 px-4 py-2">
                <span className="flex-1 min-w-0 text-[12px] text-[#0F172A] truncate" title={s.received_file_name ?? s.file_name}>
                  {s.received_file_name ?? s.file_name}
                </span>
                {s.sender_email && <span className="text-[11px] text-[#64748B] hidden sm:inline">{s.sender_email}</span>}
                <span className="text-[11px] text-[#64748B] whitespace-nowrap">{fmtDate(s.received_at)}</span>
                {s.storage_path && (
                  <button onClick={() => window.open(`/api/download/${s.id}`, "_blank")}
                    className="text-[11px] font-semibold text-[#7B9BB5] hover:text-[#5A7A94] px-2 py-1 rounded hover:bg-white transition-colors">
                    Open
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Expected items */}
      <div className="rounded-xl border border-[#E2E8F0] overflow-clip bg-white">
        <div className="px-4 py-2.5 border-b border-[#E2E8F0] bg-[#F8F9FA]">
          <p className="text-[12px] font-bold text-[#0F172A]">Items <span className="font-normal text-[#64748B]">({pkg.items.length})</span></p>
        </div>
        <table className="w-full text-[12px] border-collapse">
          <thead>
            <tr className="border-b border-[#E2E8F0]">
              {["#", "Spec", "Description", "Type", "Sent to Sub", "Received", "Status"].map(h => (
                <th key={h} className="text-left px-3 py-2 text-[10px] font-bold text-[#64748B] uppercase tracking-wider whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pkg.items.map((s: SubmittalRecord) => (
              <tr key={s.id} className="border-b border-[#E2E8F0]/60 last:border-0">
                <td className="px-3 py-2 tabular-nums text-[#64748B]" title={formatSectionNumber(s.csi_section, s.section_seq)}>{padSectionSeq(s.section_seq)}</td>
                <td className="px-3 py-2 font-mono text-[11px] text-[#0F172A]">{s.csi_section ?? "—"}</td>
                <td className="px-3 py-2 text-[#0F172A] max-w-[280px] truncate" title={s.file_name}>{s.file_name}</td>
                <td className="px-3 py-2 text-[#64748B]">{s.submittal_type ?? "—"}</td>
                <td className="px-3 py-2 text-[#64748B] whitespace-nowrap">{fmtDate(s.sent_to_sub_date)}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {s.received_date
                    ? <span className="text-green-700 font-medium">{fmtDate(s.received_date)}</span>
                    : <span className="text-[#94A3B8]">Awaiting</span>}
                </td>
                <td className="px-3 py-2 text-[#64748B]">{s.review_status ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
