"use client"

import { useState, useEffect, useCallback, useRef, useMemo } from "react"
import type { Rfq, RfqRecipient, Project, Vendor } from "../_shared/types"
import { fmtDateOnly } from "../_shared/format"
import { PlusIcon, SpinnerIcon, XIcon } from "../_shared/icons"
import { RfqStatusBadge } from "../_shared/badges"
import { inputCls, labelCls } from "../_shared/ui"
import { VendorPicker } from "../_shared/vendor-picker"
import { presignAndUpload } from "@/lib/storage-upload"
import { SkeletonTable } from "@/components/skeleton"

// RFQ (Bid Requests) module — ADR-016 v1a (manual). Package spec sections +
// drawings for a scope, pick sub/supplier recipients, hand off the send via the
// estimator's own mail client (mailto + downloadable package), then drag-drop
// the returned quote PDF back in. No Gmail connect, no tokens, no inbound capture.

function fmtMoney(n: number | null | undefined): string {
  if (n == null) return "—"
  return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function RfqModule({ globalProjectId, appProjects }: {
  globalProjectId: string
  appProjects: Project[]
}) {
  const [rfqs, setRfqs]           = useState<Rfq[]>([])
  const [loading, setLoading]     = useState(false)
  const [showNew, setShowNew]     = useState(false)
  const [openId, setOpenId]       = useState<string | null>(null)

  // Create form
  const [name, setName]           = useState("")
  const [scope, setScope]         = useState("")
  const [csiDivision, setCsi]     = useState("")
  const [dueDate, setDueDate]     = useState("")
  const [saving, setSaving]       = useState(false)

  const load = useCallback((pid = globalProjectId) => {
    if (!pid) { setRfqs([]); return }
    setLoading(true)
    fetch(`/api/rfq?project_id=${encodeURIComponent(pid)}`)
      .then(r => r.json())
      .then(d => setRfqs(d.rfqs ?? []))
      .catch(() => setRfqs([]))
      .finally(() => setLoading(false))
  }, [globalProjectId])

  useEffect(() => { load() }, [load])

  async function createRfq(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !globalProjectId) return
    setSaving(true)
    try {
      const res = await fetch("/api/rfq", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name, scope_description: scope, division_code: csiDivision,
          due_date: dueDate, project_id: globalProjectId,
        }),
      })
      if (res.ok) {
        const { id } = await res.json()
        setShowNew(false)
        setName(""); setScope(""); setCsi(""); setDueDate("")
        load()
        if (id) setOpenId(id)
      }
    } finally { setSaving(false) }
  }

  async function deleteRfq(id: string) {
    if (!confirm("Delete this bid request? This cannot be undone.")) return
    await fetch(`/api/rfq/${id}`, { method: "DELETE" })
    setOpenId(null)
    load()
  }

  if (!globalProjectId) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center min-h-0 py-24 text-center">
        <p className="text-[15px] font-bold text-[#0F172A]">Select a project to view Bid Requests</p>
        <p className="text-[13px] text-[#64748B] mt-1.5">Choose a project from the selector in the sidebar.</p>
      </div>
    )
  }

  return (
    <>
      {/* Action bar */}
      <div className="flex-shrink-0 border-b border-[#E2E8F0] bg-white flex items-center justify-between px-4 py-2.5 gap-2 min-w-0">
        <p className="text-[13px] font-semibold text-[#0F172A] truncate min-w-0">Bid Requests <span className="text-[#64748B] font-normal ml-1">({rfqs.length})</span></p>
        <button onClick={() => setShowNew(true)} className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors flex items-center gap-1.5 flex-shrink-0 whitespace-nowrap">
          <PlusIcon /> New Bid Request
        </button>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {loading ? (
          <div className="mx-4 my-4"><SkeletonTable rows={6} cols={6} /></div>
        ) : rfqs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full py-24 text-center">
            <div className="w-14 h-14 rounded-2xl bg-[#7B9BB5]/10 border border-[#7B9BB5]/20 flex items-center justify-center mb-4">
              <svg className="w-7 h-7 text-[#7B9BB5]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
            </div>
            <p className="text-[15px] font-bold text-[#0F172A]">No bid requests yet</p>
            <p className="text-[13px] text-[#64748B] mt-1.5">Package specs + drawings for a scope and send it out for quotes.</p>
            <button onClick={() => setShowNew(true)} className="mt-5 h-9 px-5 rounded-lg bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors inline-flex items-center gap-2">
              <PlusIcon /> New Bid Request
            </button>
          </div>
        ) : (
          <div className="mx-4 my-4 rounded-xl border border-[#E2E8F0] overflow-clip bg-white">
            <table className="w-full text-[13px] border-collapse">
              <thead className="sticky top-0 bg-[#F8F9FA] z-10">
                <tr className="border-b border-[#E2E8F0]">
                  <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest">Bid Request</th>
                  <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-24">Division</th>
                  <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-28">Due</th>
                  <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-40">Recipients</th>
                  <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-24">Status</th>
                  <th className="text-left px-4 py-2.5 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-20">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rfqs.map(r => {
                  const isOverdue = r.due_date && new Date(r.due_date) < new Date() && r.status !== "closed"
                  return (
                    <tr key={r.id} className="border-b border-[#E2E8F0]/60 hover:bg-[#F8F9FA] transition-colors cursor-pointer" onClick={() => setOpenId(r.id)}>
                      <td className="px-4 py-2.5 max-w-0">
                        <p className="text-[#0F172A] font-medium truncate" title={r.name}>{r.name}</p>
                        {r.scope_description && <p className="text-[11px] text-[#64748B] truncate">{r.scope_description}</p>}
                      </td>
                      <td className="px-4 py-2.5 text-[#64748B] text-[12px] font-mono">{r.division_code ?? "—"}</td>
                      <td className="px-4 py-2.5 text-[12px] whitespace-nowrap">
                        {r.due_date ? <span className={isOverdue ? "text-red-400 font-medium" : "text-[#64748B]"}>{fmtDateOnly(r.due_date)}{isOverdue ? " ⚠" : ""}</span> : <span className="text-[#64748B]">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-[12px] text-[#64748B]">
                        {(r.recipient_count ?? 0) === 0 ? "—" : (
                          <span>{r.recipient_count} sent · <span className="text-green-600 font-medium">{r.quote_received_count ?? 0} quoted</span></span>
                        )}
                      </td>
                      <td className="px-4 py-2.5"><RfqStatusBadge status={r.status} /></td>
                      <td className="px-4 py-2.5" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center gap-1">
                          <button onClick={() => setOpenId(r.id)} className="text-[11px] text-[#64748B] hover:text-[#0F172A] px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">Open</button>
                          <button onClick={() => deleteRfq(r.id)} className="text-[11px] text-red-400/60 hover:text-red-400 px-2 py-1 rounded hover:bg-[#0F172A]/[0.04] transition-colors">Del</button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* New RFQ modal */}
      {showNew && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={e => { if (e.target === e.currentTarget) setShowNew(false) }}>
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[560px] mx-4 sm:mx-0 flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E2E8F0] flex-shrink-0">
              <h2 className="text-[15px] font-bold text-[#0F172A]">New Bid Request</h2>
              <button onClick={() => setShowNew(false)} className="text-[#64748B] hover:text-[#64748B] transition-colors"><XIcon className="h-4 w-4" /></button>
            </div>
            <form onSubmit={createRfq} className="flex flex-col min-h-0">
              <div className="px-6 py-4 space-y-3 overflow-y-auto">
                <div>
                  <label className={labelCls}>Name <span className="text-red-400">*</span></label>
                  <input type="text" required value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Structural Steel — Bid Package 3" autoFocus className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Scope Description</label>
                  <textarea value={scope} onChange={e => setScope(e.target.value)} rows={4} placeholder="Describe the scope of work you're requesting quotes for…" className="w-full px-3 py-2 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 resize-none placeholder:text-[#64748B]" />
                </div>
                <div className="flex flex-col sm:flex-row gap-3">
                  <div className="flex-1">
                    <label className={labelCls}>CSI Division</label>
                    <input type="text" value={csiDivision} onChange={e => setCsi(e.target.value)} placeholder="e.g. 05" className={inputCls} />
                  </div>
                  <div className="flex-1">
                    <label className={labelCls}>Quote Due Date</label>
                    <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} className={inputCls} />
                  </div>
                </div>
              </div>
              <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#E2E8F0] flex-shrink-0">
                <button type="button" onClick={() => setShowNew(false)} className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors">Cancel</button>
                <button type="submit" disabled={saving || !name.trim()} className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 flex items-center gap-2">
                  {saving && <SpinnerIcon className="h-3 w-3" />}{saving ? "Creating…" : "Create"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Detail */}
      {openId && (
        <RfqDetail
          key={openId}
          rfqId={openId}
          projectId={globalProjectId}
          project={appProjects.find(p => p.id === globalProjectId) ?? null}
          onClose={() => { setOpenId(null); load() }}
          onDelete={() => deleteRfq(openId)}
        />
      )}
    </>
  )
}

// ─── Detail modal: package builder + recipients + send handoff + status log ──
interface ScopeSection { spec_number: string; spec_title: string; in_scope: boolean }
interface SheetRow { id: string; sheet_number: string; title: string | null; file_url: string | null }
// Flat estimate-line index (Wire 2) — powers the "link quote to estimate line"
// picker + the linked-line label on a recipient row.
interface EstLineLite { id: string; cost_code: string | null; description: string | null; category: string; estimate_id: string; estimate_name: string }

function RfqDetail({ rfqId, projectId, project, onClose, onDelete }: {
  rfqId: string
  projectId: string
  project: Project | null
  onClose: () => void
  onDelete: () => void
}) {
  const [rfq, setRfq]                 = useState<Rfq | null>(null)
  const [recipients, setRecipients]   = useState<RfqRecipient[]>([])
  const [loading, setLoading]         = useState(true)

  // Package builder
  const [sections, setSections]       = useState<ScopeSection[]>([])
  const [sheets, setSheets]           = useState<SheetRow[]>([])
  const [selSpecs, setSelSpecs]       = useState<Set<string>>(new Set())
  const [selSheets, setSelSheets]     = useState<Set<string>>(new Set())
  const [building, setBuilding]       = useState(false)
  const [packageUrl, setPackageUrl]   = useState<string | null>(null)

  // Recipient add
  const [pickVendor, setPickVendor]   = useState<Vendor | null>(null)
  const [adding, setAdding]           = useState(false)

  // Estimate-line linking (Wire 2). Optional — an RFQ works fine with no link
  // (v1a behavior unchanged). estLines indexes the project's estimate lines;
  // linkingRid holds the recipient whose picker is open.
  const [estLines, setEstLines]       = useState<EstLineLite[]>([])
  const [linkingRid, setLinkingRid]   = useState<string | null>(null)

  // Rehydrate the package selection from the persisted columns exactly once, on
  // open — later reloads (after a recipient/status change) must not clobber
  // in-progress checkbox picks the user hasn't generated yet.
  const hydratedRef = useRef(false)

  const loadDetail = useCallback(() => {
    setLoading(true)
    fetch(`/api/rfq/${rfqId}`)
      .then(r => r.json())
      .then(d => {
        setRfq(d.rfq ?? null); setRecipients(d.recipients ?? [])
        if (!hydratedRef.current && d.rfq) {
          setSelSpecs(new Set<string>((d.rfq.pkg_spec_numbers ?? []) as string[]))
          setSelSheets(new Set<string>((d.rfq.pkg_sheet_ids ?? []) as string[]))
          hydratedRef.current = true
        }
      })
      .finally(() => setLoading(false))
  }, [rfqId])

  useEffect(() => { loadDetail() }, [loadDetail])

  // Load the source lists for the package builder.
  useEffect(() => {
    fetch(`/api/projects/${projectId}/scope`).then(r => r.json())
      .then(d => setSections((d.scope ?? []).filter((s: ScopeSection) => s.in_scope !== false)))
      .catch(() => setSections([]))
    fetch(`/api/drawings/sheets?project_id=${encodeURIComponent(projectId)}`).then(r => r.json())
      .then(d => setSheets((d.sheets ?? []).filter((s: SheetRow) => !!s.file_url)))
      .catch(() => setSheets([]))
  }, [projectId])

  // Flatten the project's estimate lines (estimates → their lines) for the link
  // picker + linked-line labels. Best-effort + N is small (a handful of estimates
  // per project); a failure just leaves linking unavailable, never blocks the RFQ.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const er = await fetch(`/api/estimate?project_id=${encodeURIComponent(projectId)}`).then(r => r.json())
        const ests: { id: string; name: string }[] = er.estimates ?? []
        const all: EstLineLite[] = []
        for (const e of ests) {
          const d = await fetch(`/api/estimate/${e.id}`).then(r => r.json()).catch(() => null)
          for (const l of (d?.lines ?? [])) {
            all.push({ id: l.id, cost_code: l.cost_code, description: l.description, category: l.category, estimate_id: e.id, estimate_name: e.name })
          }
        }
        if (!cancelled) setEstLines(all)
      } catch { if (!cancelled) setEstLines([]) }
    })()
    return () => { cancelled = true }
  }, [projectId])

  function toggle(set: Set<string>, setter: (s: Set<string>) => void, key: string) {
    const next = new Set(set)
    if (next.has(key)) next.delete(key); else next.add(key)
    setter(next)
  }

  async function patchRfq(updates: Record<string, unknown>) {
    await fetch(`/api/rfq/${rfqId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(updates) })
    loadDetail()
  }

  async function buildPackage() {
    if (selSpecs.size === 0 && selSheets.size === 0) return
    setBuilding(true)
    try {
      const res = await fetch(`/api/rfq/${rfqId}/package`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ specNumbers: [...selSpecs], sheetIds: [...selSheets] }),
      })
      const d = await res.json()
      if (res.ok) { setPackageUrl(d.url ?? null); loadDetail() }
      else alert(d.error ?? "Could not build package")
    } finally { setBuilding(false) }
  }

  async function addRecipient() {
    if (!pickVendor) return
    setAdding(true)
    try {
      await fetch(`/api/rfq/${rfqId}/recipients`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipients: [{ vendor_id: pickVendor.id }] }),
      })
      setPickVendor(null)
      loadDetail()
    } finally { setAdding(false) }
  }

  async function patchRecipient(rid: string, updates: Record<string, unknown>) {
    await fetch(`/api/rfq/${rfqId}/recipients/${rid}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(updates) })
    loadDetail()
  }

  async function removeRecipient(rid: string) {
    await fetch(`/api/rfq/${rfqId}/recipients/${rid}`, { method: "DELETE" })
    loadDetail()
  }

  async function attachQuote(rid: string, file: File) {
    const { path } = await presignAndUpload("submittals", `rfq/${rfqId}/quotes`, file)
    await patchRecipient(rid, { quote_file_path: path }) // route auto-sets state=quote_received
  }

  async function viewQuote(rid: string) {
    const res = await fetch(`/api/rfq/${rfqId}/recipients/${rid}/quote`)
    const d = await res.json()
    if (d.url) window.open(d.url, "_blank")
  }

  // Send handoff — NO Gmail. Fire the estimator's OWN mail client with a
  // prefilled draft, then hand off the package for them to attach. The app never
  // sends. The mailto MUST fire synchronously inside the click gesture — an
  // `await` before it lets the browser drop the navigation — and it opens even
  // with an empty To: (estimator mails themselves / types the sub's address).
  function sendRfq() {
    const emails = recipients.map(r => r.person_email || r.vendor_email).filter(Boolean)
    const subject = `Bid Request — ${project?.name ?? ""} — ${rfq?.name ?? ""}`.trim()
    const bodyLines = [
      `You're invited to submit a quote for the following scope${project?.name ? ` on ${project.name}` : ""}:`,
      "",
      `Scope: ${rfq?.name ?? ""}`,
      rfq?.scope_description ? `\n${rfq.scope_description}\n` : "",
      rfq?.division_code ? `CSI Division: ${rfq.division_code}` : "",
      rfq?.due_date ? `Quotes due: ${fmtDateOnly(rfq.due_date)}` : "",
      "",
      rfq?.package_pdf_path ? "The bid package (specs + drawings) is attached." : "",
      "",
      "Please reply with your quote. Thank you.",
    ].filter(l => l !== "")
    // Empty `emails` → `mailto:?subject=…&body=…`, still a valid mailto the OS opens.
    const mailto = `mailto:${emails.join(",")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(bodyLines.join("\n"))}`

    // 1) Mail client first — synchronous, in-gesture, always fires.
    window.location.href = mailto

    // 2) Hand off the package to attach. A cached signed URL opens in-gesture;
    //    otherwise re-sign async (best-effort — the "View current package" button
    //    is the fallback if a popup blocker eats the async open).
    if (packageUrl) {
      window.open(packageUrl, "_blank")
    } else if (rfq?.package_pdf_path) {
      fetch(`/api/rfq/${rfqId}/package`)
        .then(r => r.json())
        .then(d => { if (d?.url) window.open(d.url, "_blank") })
        .catch(() => {})
    }

    // 3) Mark sent — fire-and-forget so it never blocks the handoff.
    if (rfq?.status === "draft") patchRfq({ status: "sent" })
  }

  const quoteCount = recipients.filter(r => r.state === "quote_received").length
  const missingEmailCount = recipients.filter(r => !(r.person_email || r.vendor_email)).length
  const lineById = useMemo(() => new Map(estLines.map(l => [l.id, l])), [estLines])

  return (
    <>
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[860px] mx-4 sm:mx-0 flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E2E8F0] flex-shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <h2 className="text-[15px] font-bold text-[#0F172A] truncate">{rfq?.name ?? "Bid Request"}</h2>
            {rfq && <RfqStatusBadge status={rfq.status} />}
          </div>
          <button onClick={onClose} className="text-[#64748B] hover:text-[#64748B] transition-colors ml-4 flex-shrink-0"><XIcon className="h-4 w-4" /></button>
        </div>

        {loading || !rfq ? (
          <div className="p-8"><SkeletonTable rows={5} cols={4} /></div>
        ) : (
          <div className="px-6 py-4 space-y-5 overflow-y-auto">
            {/* Meta + status */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="rounded-md bg-[#F4F5F7] px-3 py-2">
                <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-0.5">Division</p>
                <p className="text-[12px] text-[#0F172A] font-mono">{rfq.division_code ?? "—"}</p>
              </div>
              <div className="rounded-md bg-[#F4F5F7] px-3 py-2">
                <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-0.5">Quote Due</p>
                <p className="text-[12px] text-[#0F172A]">{rfq.due_date ? fmtDateOnly(rfq.due_date) : "—"}</p>
              </div>
              <div className="rounded-md bg-[#F4F5F7] px-3 py-2">
                <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-0.5">Quotes In</p>
                <p className="text-[12px] text-[#0F172A]">{quoteCount} / {recipients.length}</p>
              </div>
              <div>
                <label className={labelCls}>Status</label>
                <select value={rfq.status} onChange={e => patchRfq({ status: e.target.value })}
                  className="w-full h-9 px-3 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                  {["draft", "sent", "closed"].map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
                </select>
              </div>
            </div>
            {rfq.scope_description && (
              <div className="rounded-md bg-[#F4F5F7] px-3 py-2.5">
                <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-1.5">Scope</p>
                <p className="text-[13px] text-[#0F172A] whitespace-pre-wrap">{rfq.scope_description}</p>
              </div>
            )}

            {/* ── Package builder ─────────────────────────────────────────── */}
            <div className="border border-[#E2E8F0] rounded-lg overflow-clip">
              <div className="flex items-center justify-between px-4 py-2.5 bg-[#F8F9FA] border-b border-[#E2E8F0]">
                <p className="text-[12px] font-bold text-[#0F172A]">Package</p>
                <div className="flex items-center gap-2">
                  {(packageUrl || rfq.package_pdf_path) && (
                    <button onClick={async () => {
                      let u = packageUrl
                      if (!u) { const res = await fetch(`/api/rfq/${rfqId}/package`); u = (await res.json()).url }
                      if (u) window.open(u, "_blank")
                    }} className="text-[12px] text-[#7B9BB5] font-medium hover:underline">View current package</button>
                  )}
                  <button onClick={buildPackage} disabled={building || (selSpecs.size === 0 && selSheets.size === 0)}
                    className="h-7 px-3 rounded-md bg-[#7B9BB5] text-white text-[12px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 flex items-center gap-1.5">
                    {building && <SpinnerIcon className="h-3 w-3" />}{building ? "Building…" : "Generate Package"}
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-[#E2E8F0]">
                {/* Spec sections */}
                <div className="p-3">
                  <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-2">Spec Sections ({selSpecs.size})</p>
                  <div className="max-h-44 overflow-y-auto space-y-0.5">
                    {sections.length === 0 ? <p className="text-[12px] text-[#94A3B8]">No scoped spec sections.</p> : sections.map(s => (
                      <label key={s.spec_number} className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-[#F8F9FA] cursor-pointer">
                        <input type="checkbox" checked={selSpecs.has(s.spec_number)} onChange={() => toggle(selSpecs, setSelSpecs, s.spec_number)} className="accent-[#7B9BB5]" />
                        <span className="text-[12px] text-[#0F172A] truncate"><span className="font-mono text-[#64748B]">{s.spec_number}</span> {s.spec_title}</span>
                      </label>
                    ))}
                  </div>
                </div>
                {/* Drawings */}
                <div className="p-3">
                  <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-2">Drawing Sheets ({selSheets.size})</p>
                  <div className="max-h-44 overflow-y-auto space-y-0.5">
                    {sheets.length === 0 ? <p className="text-[12px] text-[#94A3B8]">No drawing sheets.</p> : sheets.map(s => (
                      <label key={s.id} className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-[#F8F9FA] cursor-pointer">
                        <input type="checkbox" checked={selSheets.has(s.id)} onChange={() => toggle(selSheets, setSelSheets, s.id)} className="accent-[#7B9BB5]" />
                        <span className="text-[12px] text-[#0F172A] truncate"><span className="font-mono text-[#64748B]">{s.sheet_number}</span> {s.title ?? ""}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* ── Recipients + status log ─────────────────────────────────── */}
            <div className="border border-[#E2E8F0] rounded-lg overflow-clip">
              <div className="flex items-center justify-between px-4 py-2.5 bg-[#F8F9FA] border-b border-[#E2E8F0] gap-2">
                <p className="text-[12px] font-bold text-[#0F172A]">Recipients ({recipients.length})</p>
                <div className="flex items-center gap-2 flex-shrink-0" style={{ minWidth: 260 }}>
                  <div className="flex-1"><VendorPicker vendor={pickVendor} onChange={setPickVendor} role="supplier_or_subcontractor" placeholder="Add a sub/supplier…" /></div>
                  <button onClick={addRecipient} disabled={!pickVendor || adding} className="h-9 px-3 rounded-md border border-[#7B9BB5] text-[#7B9BB5] text-[12px] font-semibold hover:bg-[#7B9BB5]/5 transition-colors disabled:opacity-50 whitespace-nowrap">Add</button>
                </div>
              </div>
              {recipients.length === 0 ? (
                <p className="px-4 py-6 text-[12px] text-[#94A3B8] text-center">No recipients yet. Add the subs/suppliers you're sending this to.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px] border-collapse min-w-[880px]">
                    <thead className="bg-white border-b border-[#E2E8F0]">
                      <tr>
                        <th className="text-left px-3 py-2 text-[10px] font-bold text-[#64748B] uppercase tracking-widest">Vendor</th>
                        <th className="text-left px-3 py-2 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-36">State</th>
                        <th className="text-left px-3 py-2 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-32">Quote $</th>
                        <th className="text-left px-3 py-2 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-28">Quote PDF</th>
                        <th className="text-left px-3 py-2 text-[10px] font-bold text-[#64748B] uppercase tracking-widest w-40">Est. Line</th>
                        <th className="px-3 py-2 w-10"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {recipients.map(r => (
                        <tr key={r.id} className="border-b border-[#E2E8F0]/60">
                          <td className="px-3 py-2">
                            <p className="text-[#0F172A] font-medium truncate">{r.vendor_company_name ?? "—"}</p>
                            {(r.person_email || r.vendor_email)
                              ? <p className="text-[11px] text-[#64748B] truncate">{r.person_email || r.vendor_email}</p>
                              : <p className="text-[11px] text-amber-600 truncate">no email on file · won't pre-fill</p>}
                          </td>
                          <td className="px-3 py-2">
                            <select value={r.state} onChange={e => patchRecipient(r.id, { state: e.target.value })}
                              className="w-full h-8 px-2 rounded border border-[#E2E8F0] text-[12px] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40">
                              <option value="sent">Sent</option>
                              <option value="quote_received">Quote Received</option>
                              <option value="no_response">No Response</option>
                              <option value="declined">Declined</option>
                            </select>
                          </td>
                          <td className="px-3 py-2">
                            <input type="number" step="0.01" min="0" placeholder="—" defaultValue={r.quoted_amount ?? ""} key={`amt-${r.id}-${r.quoted_amount}`}
                              onBlur={e => { const v = e.target.value; if (v !== String(r.quoted_amount ?? "")) patchRecipient(r.id, { quoted_amount: v }) }}
                              className="w-full h-8 px-2 rounded border border-[#E2E8F0] text-[12px] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" />
                          </td>
                          <td className="px-3 py-2">
                            {r.quote_file_path ? (
                              <button onClick={() => viewQuote(r.id)} className="text-[12px] text-[#7B9BB5] font-medium hover:underline">View</button>
                            ) : (
                              <label className="text-[12px] text-[#64748B] hover:text-[#0F172A] cursor-pointer underline decoration-dotted">
                                Attach
                                <input type="file" accept=".pdf" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) attachQuote(r.id, f) }} />
                              </label>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            {r.linked_estimate_line_id ? (() => {
                              const l = lineById.get(r.linked_estimate_line_id)
                              const label = l ? `${l.cost_code ? l.cost_code + " " : ""}${l.description ?? "line"}` : "linked line"
                              return (
                                <div className="flex items-center gap-1 min-w-0">
                                  <button onClick={() => setLinkingRid(r.id)} title="Change linked line"
                                    className="text-[11px] text-[#0F172A] hover:text-[#7B9BB5] truncate max-w-[130px] text-left">{label}</button>
                                  <button onClick={() => patchRecipient(r.id, { linked_estimate_line_id: null })} title="Unlink"
                                    className="text-[11px] text-[#94A3B8] hover:text-red-400 flex-shrink-0">✕</button>
                                </div>
                              )
                            })() : (
                              <button onClick={() => setLinkingRid(r.id)} disabled={estLines.length === 0}
                                title={estLines.length === 0 ? "No estimate lines on this project yet" : "Link this quote to an estimate line"}
                                className="text-[12px] text-[#7B9BB5] font-medium hover:underline disabled:text-[#94A3B8] disabled:no-underline disabled:cursor-default">
                                Link
                              </button>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <button onClick={() => removeRecipient(r.id)} className="text-[11px] text-red-400/60 hover:text-red-400" title="Remove">✕</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Footer: send handoff + delete */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-[#E2E8F0] flex-shrink-0">
          <button onClick={onDelete} className="h-8 px-4 rounded-md border border-red-500/30 text-[13px] text-red-400 hover:bg-red-500/10 transition-colors">Delete</button>
          <div className="flex gap-2 items-center">
            <div className="text-[11px] hidden sm:flex flex-col items-end leading-tight">
              <span className="text-[#94A3B8]">Opens your mail client · app doesn&apos;t send</span>
              {missingEmailCount > 0 && (
                <span className="text-amber-600">{missingEmailCount} recipient{missingEmailCount > 1 ? "s" : ""} with no email — add in your mail client</span>
              )}
            </div>
            <button onClick={onClose} className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors">Close</button>
            <button onClick={sendRfq} disabled={loading || recipients.length === 0}
              className="h-8 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 flex items-center gap-2">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
              Send RFQ
            </button>
          </div>
        </div>
      </div>
    </div>

      {linkingRid && (() => {
        const rid = linkingRid
        return (
          <EstimateLineLinkPicker
            lines={estLines}
            currentId={recipients.find(r => r.id === rid)?.linked_estimate_line_id ?? null}
            onPick={lineId => { patchRecipient(rid, { linked_estimate_line_id: lineId }); setLinkingRid(null) }}
            onClose={() => setLinkingRid(null)}
          />
        )
      })()}
    </>
  )
}

// Wire 2 — pick an estimate line to link a returned quote to. Grouped by estimate;
// defaults to subcontractor lines (RFQs are sub bids) with a toggle to show all.
// Persist happens in the caller via the existing recipient PATCH; this is pure UI.
function EstimateLineLinkPicker({ lines, currentId, onPick, onClose }: {
  lines: EstLineLite[]
  currentId: string | null
  onPick: (lineId: string) => void
  onClose: () => void
}) {
  const [subsOnly, setSubsOnly] = useState(true)
  const [q, setQ] = useState("")

  const filtered = lines.filter(l => {
    if (subsOnly && l.category !== "subcontractor") return false
    if (q.trim()) {
      const hay = `${l.cost_code ?? ""} ${l.description ?? ""} ${l.estimate_name}`.toLowerCase()
      if (!hay.includes(q.toLowerCase())) return false
    }
    return true
  })
  const byEst = new Map<string, { name: string; rows: EstLineLite[] }>()
  for (const l of filtered) {
    if (!byEst.has(l.estimate_id)) byEst.set(l.estimate_id, { name: l.estimate_name, rows: [] })
    byEst.get(l.estimate_id)!.rows.push(l)
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-2xl w-full sm:w-[520px] flex flex-col max-h-[80vh]">
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-[#E2E8F0] flex-shrink-0">
          <h3 className="text-[14px] font-bold text-[#0F172A]">Link to estimate line</h3>
          <button onClick={onClose} className="text-[#64748B] hover:text-[#0F172A] transition-colors"><XIcon className="h-4 w-4" /></button>
        </div>
        <div className="px-5 py-3 border-b border-[#E2E8F0] flex items-center gap-3 flex-shrink-0">
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search cost code / description…"
            className="flex-1 h-8 px-2.5 rounded-md border border-[#E2E8F0] text-[12px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40" />
          <label className="flex items-center gap-1.5 text-[12px] text-[#64748B] whitespace-nowrap">
            <input type="checkbox" checked={subsOnly} onChange={e => setSubsOnly(e.target.checked)} className="accent-[#7B9BB5]" /> Subs only
          </label>
        </div>
        <div className="overflow-y-auto px-2 py-2 min-h-0">
          {filtered.length === 0 ? (
            <p className="text-[12px] text-[#94A3B8] text-center py-8">
              {lines.length === 0 ? "No estimate lines on this project." : "No matching lines. Try turning off “Subs only.”"}
            </p>
          ) : [...byEst.entries()].map(([eid, g]) => (
            <div key={eid} className="mb-2">
              <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest px-2 py-1">{g.name}</p>
              {g.rows.map(l => (
                <button key={l.id} onClick={() => onPick(l.id)}
                  className={`w-full text-left px-2.5 py-1.5 rounded-md hover:bg-[#F4F5F7] flex items-center gap-2 ${currentId === l.id ? "bg-[#7B9BB5]/10" : ""}`}>
                  <span className="text-[11px] font-mono text-[#64748B] w-14 flex-shrink-0 truncate">{l.cost_code ?? "—"}</span>
                  <span className="text-[12px] text-[#0F172A] flex-1 truncate">{l.description ?? "—"}</span>
                  <span className="text-[10px] text-[#94A3B8] flex-shrink-0 capitalize">{l.category}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
