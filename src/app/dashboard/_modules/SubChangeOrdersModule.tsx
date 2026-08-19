"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { RowActions } from "@/components/RowActions"
import { VendorPicker } from "../_shared/vendor-picker"
import type { Project, SubChangeOrder, Vendor } from "../_shared/types"

// Subcontractor Change Orders — downstream COs the GC issues TO a sub.
// Sits directly below Change Orders (upstream, GC→CM) in the project nav.
// All money shown here is server-computed (list `total` / snap_* on the PDF);
// the module never sums prices itself.

interface CommitmentOption {
  id: string
  vendor_id?: string | null
  to_company_name: string
  contract_value: number | null
  type: string
}

// Editor line row — `key` is a client-only stable id; `id` is the server row.
interface LineRow {
  key: string
  id?: string
  owner: string
  gc: string
  description: string
  costCode: string
  price: string
}

// The CO recap, exactly as the server computes it (GET .../recap). Never
// recomputed here — the client only re-derives rows 4 and 6 for the preview.
interface Recap {
  originalContractAmount: number
  computedPreviousAdditions: number
  computedPreviousDeductions: number
  previousAdditions: number
  previousDeductions: number
  previousAdditionsIsOverride: boolean
  previousDeductionsIsOverride: boolean
  thisOrder: number
  previousTotal: number
  presentContractAmount: number
}

let lineSeq = 0
const newLineKey = () => `line-${++lineSeq}`
const emptyLine = (): LineRow => ({ key: newLineKey(), owner: "", gc: "", description: "", costCode: "", price: "" })

function usd(n: number | null | undefined): string {
  if (n == null) return "—"
  const abs = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${n < 0 ? "-" : ""}$${abs}`
}

// Local-render a date-only string (no Date() TZ math — the #109 rule).
function fmtDateOnly(iso: string | null): string {
  if (!iso) return "—"
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  return m ? `${m[2]}/${m[3]}/${m[1]}` : iso
}

const STATUS_BADGE: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700",
  sent: "bg-amber-100 text-amber-800",
  accepted: "bg-green-100 text-green-800",
}

export default function SubChangeOrdersModule({
  globalProjectId,
  appProjects,
}: {
  globalProjectId: string
  appProjects: Project[]
}) {
  const projectName = appProjects.find(p => p.id === globalProjectId)?.name ?? ""

  const [scos, setScos] = useState<SubChangeOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [pdfBusyId, setPdfBusyId] = useState<string | null>(null)
  const [sendNote, setSendNote] = useState<string | null>(null)
  const [listErr, setListErr] = useState<string | null>(null)

  // Editor state
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<SubChangeOrder | null>(null) // null = new
  const [vendor, setVendor] = useState<Vendor | null>(null)
  const [coNumber, setCoNumber] = useState("")
  const [originalContractNo, setOriginalContractNo] = useState("")
  const [coDate, setCoDate] = useState("")
  const [costCode, setCostCode] = useState("")
  const [originalAmount, setOriginalAmount] = useState("")
  // Prior contract history typed by hand ("" = auto-compute from earlier COs).
  const [priorAdditions, setPriorAdditions] = useState("")
  const [priorDeductions, setPriorDeductions] = useState("")
  // True when the loaded row already carried an override — lets a cleared field
  // be sent as null. Also keeps the payload byte-identical to today's for rows
  // that have never had one (so the module is inert until 0053 is applied).
  const [hadPriorOverrides, setHadPriorOverrides] = useState(false)
  const [recap, setRecap] = useState<Recap | null>(null)
  // Which CO the recap block currently belongs to. A /recap response is
  // applied ONLY if this still matches — so a late response can never land on
  // a closed editor or a different CO.
  const recapScoIdRef = useRef<string | null>(null)
  const [status, setStatus] = useState("draft")
  const [signerName, setSignerName] = useState("")
  const [signerTitle, setSignerTitle] = useState("")
  const [commitmentId, setCommitmentId] = useState("")
  const [commitments, setCommitments] = useState<CommitmentOption[]>([])
  const [lines, setLines] = useState<LineRow[]>([emptyLine()])
  const [removedLineIds, setRemovedLineIds] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [editorErr, setEditorErr] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    fetch(`/api/sub-change-orders?project_id=${encodeURIComponent(globalProjectId)}`)
      .then(r => r.json())
      .then(d => {
        if (d.error) { setListErr(d.error); setScos([]) }
        else { setListErr(null); setScos(d.subChangeOrders ?? []) }
      })
      .catch(() => setScos([]))
      .finally(() => setLoading(false))
  }, [globalProjectId])

  useEffect(() => { load() }, [load])

  // Commitment options for the picker — filtered to the chosen vendor below.
  useEffect(() => {
    if (!editorOpen) return
    fetch(`/api/commitments?project_id=${encodeURIComponent(globalProjectId)}`)
      .then(r => r.json())
      .then(d => setCommitments(d.commitments ?? []))
      .catch(() => setCommitments([]))
  }, [editorOpen, globalProjectId])

  const vendorCommitments = commitments.filter(c => vendor && c.vendor_id === vendor.id)

  // Refresh the recap block from the server (the same computeSubCoRecap the
  // PDF uses). While the fetch is in flight the previous values keep showing;
  // on ANY failure the last good values stay — a failed preview refresh never
  // surfaces an error, blanks the block, or blocks a save that already
  // succeeded. Fire-and-forget by design.
  function refreshRecap(scoId: string) {
    fetch(`/api/sub-change-orders/${scoId}/recap`)
      .then(r => r.json())
      .then(d => {
        if (d.recap && recapScoIdRef.current === scoId) setRecap(d.recap)
      })
      .catch(() => {})
  }

  // Display-only preview of the PDF's right-hand recap. Rows 1/2/3/5 come from
  // the server (/recap); only rows 4 and 6 are re-derived here so a typed
  // override shows its effect immediately. Nothing here is ever stored — the
  // authoritative numbers are whatever generate-pdf freezes into snap_*.
  const previewRecap = (() => {
    if (!recap) return null
    const typed = (s: string, fallback: number) => {
      if (s.trim() === "") return fallback
      const n = Number(s.replace(/[$,\s]/g, ""))
      return Number.isFinite(n) ? n : fallback
    }
    const round2 = (n: number) => Math.round(n * 100) / 100
    const previousAdditions = typed(priorAdditions, recap.computedPreviousAdditions)
    const previousDeductions = typed(priorDeductions, recap.computedPreviousDeductions)
    const previousTotal = round2(recap.originalContractAmount + previousAdditions - previousDeductions)
    return {
      previousAdditions,
      previousDeductions,
      previousTotal,
      presentContractAmount: round2(previousTotal + recap.thisOrder),
    }
  })()

  function resetEditor() {
    setEditing(null)
    setVendor(null)
    setCoNumber("")
    setOriginalContractNo("")
    setCoDate(new Date().toISOString().slice(0, 10))
    setCostCode("")
    setOriginalAmount("")
    setPriorAdditions("")
    setPriorDeductions("")
    setHadPriorOverrides(false)
    setRecap(null)
    recapScoIdRef.current = null
    setStatus("draft")
    setSignerName("")
    setSignerTitle("")
    setCommitmentId("")
    setLines([emptyLine()])
    setRemovedLineIds([])
    setEditorErr(null)
  }

  function openNew() {
    resetEditor()
    setEditorOpen(true)
  }

  async function openEdit(sco: SubChangeOrder) {
    resetEditor()
    const res = await fetch(`/api/sub-change-orders/${sco.id}`)
    const d = await res.json()
    if (!res.ok || !d.subChangeOrder) { setListErr(d.error ?? "Could not load change order"); return }
    const full: SubChangeOrder = d.subChangeOrder
    setEditing(full)
    setVendor(full.vendor ? {
      id: full.vendor.id, vendor_no: full.vendor.vendor_no, company_name: full.vendor.company_name,
      street_address: full.vendor.street_address, city: full.vendor.city, state: full.vendor.state,
      zip_code: full.vendor.zip_code, phone: full.vendor.phone,
    } : null)
    setCoNumber(full.co_number)
    setOriginalContractNo(full.original_contract_no ?? "")
    setCoDate(full.co_date ?? "")
    setCostCode(full.cost_code ?? "")
    setOriginalAmount(full.original_contract_amount != null ? String(full.original_contract_amount) : "")
    setPriorAdditions(full.prior_additions_override != null ? String(full.prior_additions_override) : "")
    setPriorDeductions(full.prior_deductions_override != null ? String(full.prior_deductions_override) : "")
    setHadPriorOverrides(full.prior_additions_override != null || full.prior_deductions_override != null)
    setStatus(full.status)
    setSignerName(full.signer_name ?? "")
    setSignerTitle(full.signer_title ?? "")
    setCommitmentId(full.commitment_id ?? "")
    setLines((full.lines ?? []).length
      ? (full.lines ?? []).map(l => ({
          key: newLineKey(), id: l.id,
          owner: l.owner_co_number ?? "", gc: l.gc_co_number ?? "",
          description: l.description, costCode: l.cost_code ?? "",
          price: String(l.price ?? 0),
        }))
      : [emptyLine()])
    setEditorOpen(true)

    // Server-produced recap for the preview block — same helper the PDF uses.
    recapScoIdRef.current = sco.id
    refreshRecap(sco.id)
  }

  function setLineField(key: string, field: keyof Omit<LineRow, "key" | "id">, value: string) {
    setLines(prev => prev.map(r => (r.key === key ? { ...r, [field]: value } : r)))
  }
  function removeLine(row: LineRow) {
    if (row.id) setRemovedLineIds(prev => [...prev, row.id!])
    setLines(prev => prev.filter(r => r.key !== row.key))
  }
  function moveLine(index: number, dir: -1 | 1) {
    setLines(prev => {
      const to = index + dir
      if (to < 0 || to >= prev.length) return prev
      const next = [...prev]
      ;[next[index], next[to]] = [next[to], next[index]]
      return next
    })
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!vendor) { setEditorErr("Pick a subcontractor first"); return }
    setSaving(true)
    setEditorErr(null)
    try {
      // The override keys are sent only once they are actually in play (typed,
      // or already stored on this row) — an untouched CO posts exactly the
      // payload it posts today.
      const touchedPriors =
        hadPriorOverrides || priorAdditions.trim() !== "" || priorDeductions.trim() !== ""
      const priorFields = touchedPriors
        ? {
            prior_additions_override: priorAdditions.trim() === "" ? null : priorAdditions,
            prior_deductions_override: priorDeductions.trim() === "" ? null : priorDeductions,
          }
        : {}
      const headerFields = {
        co_number: coNumber.trim(),
        original_contract_no: originalContractNo,
        co_date: coDate,
        cost_code: costCode,
        original_contract_amount: originalAmount.trim() === "" ? null : originalAmount,
        ...priorFields,
        signer_name: signerName,
        signer_title: signerTitle,
        commitment_id: commitmentId || null,
        vendor_id: vendor.id,
      }
      let scoId: string
      if (!editing) {
        const res = await fetch("/api/sub-change-orders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...headerFields, project_id: globalProjectId }),
        })
        const d = await res.json()
        if (!res.ok) { setEditorErr(d.error ?? "Could not create change order"); return }
        scoId = d.subChangeOrder.id
      } else {
        const res = await fetch(`/api/sub-change-orders/${editing.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...headerFields, status }),
        })
        const d = await res.json().catch(() => ({}))
        if (!res.ok) { setEditorErr(d.error ?? "Could not save change order"); return }
        scoId = editing.id
      }

      // Line sync — deletes first, then upsert in display order.
      for (const lineId of removedLineIds) {
        await fetch(`/api/sub-change-orders/${scoId}/lines/${lineId}`, { method: "DELETE" })
      }
      const realLines = lines.filter(l => l.description.trim() !== "")
      for (let i = 0; i < realLines.length; i++) {
        const l = realLines[i]
        const payload = {
          owner_co_number: l.owner,
          gc_co_number: l.gc,
          description: l.description,
          cost_code: l.costCode,
          price: l.price.trim() === "" ? 0 : l.price,
          sort_order: i,
        }
        const res = l.id
          ? await fetch(`/api/sub-change-orders/${scoId}/lines/${l.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            })
          : await fetch(`/api/sub-change-orders/${scoId}/lines`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            })
        if (!res.ok) {
          const d = await res.json().catch(() => ({}))
          setEditorErr(d.error ?? `Could not save line ${i + 1}`)
          return
        }
      }

      // Header + all lines are saved — refresh the preview from the server so
      // rows 5/6 can never contradict the saved state while the editor is
      // open. Fire-and-forget: the recapScoIdRef guard drops the response once
      // the editor closes (as it does just below today) or moves to another
      // CO, and a failed refresh never blocks the save, which has already
      // succeeded.
      if (editing) refreshRecap(editing.id)

      setEditorOpen(false)
      resetEditor()
      load()
    } finally {
      setSaving(false)
    }
  }

  async function generatePdf(scoId: string) {
    setPdfBusyId(scoId)
    try {
      const res = await fetch(`/api/sub-change-orders/${scoId}/generate-pdf`, { method: "POST" })
      const d = await res.json()
      if (res.ok && d.url) {
        window.open(d.url, "_blank")
        // The snap_* freeze can move the effective numbers — refresh the
        // preview if this CO's editor happens to be open (same keep-last-good
        // failure behavior as everywhere else).
        if (recapScoIdRef.current === scoId) refreshRecap(scoId)
        load()
      } else {
        setListErr(d.error ?? "Could not generate PDF")
      }
    } finally {
      setPdfBusyId(null)
    }
  }

  function sendViaEmail(sco: SubChangeOrder) {
    // Mail client FIRST — synchronous, in-gesture; nothing awaited before it
    // (the RFQ v1a user-activation rule). Clipboard copy is an additive
    // fallback AFTER, for users with no mailto handler.
    const to = sco.vendor?.email ?? ""
    const subject = `Change Order ${sco.co_number}${projectName ? ` — ${projectName}` : ""}`
    const body =
      `Please find Change Order ${sco.co_number}` +
      (projectName ? ` for ${projectName}` : "") +
      (sco.total != null ? ` in the amount of ${usd(sco.total)}` : "") +
      ".\n\nPlease indicate your acceptance by signing and returning the acceptance copy to our office as soon as possible.\n"
    const mailto = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`

    window.location.href = mailto

    const who = to || sco.vendor?.company_name || "the subcontractor"
    const clip = typeof navigator !== "undefined" ? navigator.clipboard : undefined
    if (clip?.writeText) {
      clip.writeText(`Subject: ${subject}\n\n${body}`).catch(() => {})
      setSendNote(`Opening your email app… if nothing opens, the message has been copied to your clipboard — paste it into a new email to ${who}.`)
    } else {
      setSendNote(`Opening your email app… if nothing opens, copy the message text and email it to ${who}.`)
    }
  }

  async function del(sco: SubChangeOrder) {
    if (!confirm(`Delete Change Order ${sco.co_number} to ${sco.vendor?.company_name ?? "this subcontractor"}? Its number is retired and will not be reused.`)) return
    const res = await fetch(`/api/sub-change-orders/${sco.id}`, { method: "DELETE" })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      setListErr(d.error ?? "Could not delete change order")
      return
    }
    load()
  }

  return (
    <div className="p-4 md:p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Subcontractor Change Orders</h2>
          <p className="text-sm text-gray-500">Change orders issued to your subcontractors on this project</p>
        </div>
        <button
          onClick={openNew}
          className="px-3 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700"
        >
          New Sub CO
        </button>
      </div>

      {sendNote && (
        <div className="mb-3 px-3 py-2 text-sm rounded-lg bg-blue-50 text-blue-800 flex items-start justify-between gap-3">
          <span>{sendNote}</span>
          <button className="shrink-0 text-blue-500 hover:text-blue-700" onClick={() => setSendNote(null)}>×</button>
        </div>
      )}
      {listErr && (
        <div className="mb-3 px-3 py-2 text-sm rounded-lg bg-red-50 text-red-700 flex items-start justify-between gap-3">
          <span>{listErr}</span>
          <button className="shrink-0 text-red-500 hover:text-red-700" onClick={() => setListErr(null)}>×</button>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <th className="px-3 py-2">CO #</th>
              <th className="px-3 py-2">Vendor</th>
              <th className="px-3 py-2">Date</th>
              <th className="px-3 py-2">Description</th>
              <th className="px-3 py-2 text-right">Total</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-gray-400">Loading…</td></tr>
            ) : scos.length === 0 ? (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-gray-400">No subcontractor change orders yet</td></tr>
            ) : scos.map(sco => (
              <tr key={sco.id} className="hover:bg-gray-50">
                <td className="px-3 py-2 font-medium text-gray-900 whitespace-nowrap">{sco.co_number}</td>
                <td className="px-3 py-2 text-gray-700">{sco.vendor?.company_name ?? "—"}</td>
                <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{fmtDateOnly(sco.co_date)}</td>
                <td className="px-3 py-2 text-gray-700 max-w-[320px] truncate">{sco.first_description ?? "—"}</td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-900">{usd(sco.total)}</td>
                <td className="px-3 py-2">
                  <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium capitalize ${STATUS_BADGE[sco.status] ?? "bg-gray-100 text-gray-700"}`}>
                    {sco.status}
                  </span>
                </td>
                <td className="px-3 py-2 text-right">
                  <RowActions actions={[
                    { label: "Edit", onClick: () => openEdit(sco) },
                    { label: pdfBusyId === sco.id ? "Generating…" : "Generate PDF", onClick: () => generatePdf(sco.id), disabled: pdfBusyId === sco.id },
                    { label: "Send via Email", onClick: () => sendViaEmail(sco) },
                    { label: "Delete", onClick: () => del(sco), variant: "danger" },
                  ]} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editorOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 overflow-y-auto p-4">
          <form
            onSubmit={save}
            className="w-full max-w-3xl bg-white rounded-xl shadow-xl p-5 my-6"
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold text-gray-900">
                {editing ? `Edit Change Order ${editing.co_number}` : "New Subcontractor Change Order"}
              </h3>
              <button type="button" className="text-gray-400 hover:text-gray-600" onClick={() => { setEditorOpen(false); resetEditor() }}>×</button>
            </div>

            {editorErr && (
              <div className="mb-3 px-3 py-2 text-sm rounded-lg bg-red-50 text-red-700">{editorErr}</div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Subcontractor *</label>
                <VendorPicker vendor={vendor} onChange={v => { setVendor(v); setCommitmentId("") }} role="subcontractor" placeholder="Pick a subcontractor…" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Subcontract (optional)</label>
                <select
                  className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm"
                  value={commitmentId}
                  disabled={!vendor}
                  onChange={e => {
                    setCommitmentId(e.target.value)
                    const c = vendorCommitments.find(x => x.id === e.target.value)
                    // Prefill only when the amount is still blank — stays editable.
                    if (c && originalAmount.trim() === "" && c.contract_value != null) {
                      setOriginalAmount(String(c.contract_value))
                    }
                  }}
                >
                  <option value="">— none —</option>
                  {vendorCommitments.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.to_company_name} · {c.type} · {usd(c.contract_value)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">
                  Change Order No.{editing ? "" : " (blank = auto)"}
                </label>
                <input className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm" value={coNumber} onChange={e => setCoNumber(e.target.value)} placeholder={editing ? "" : "auto"} />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Original Contract No.</label>
                <input className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm" value={originalContractNo} onChange={e => setOriginalContractNo(e.target.value)} />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Date</label>
                <input type="date" className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm" value={coDate} onChange={e => setCoDate(e.target.value)} />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Cost Code</label>
                <input className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm" value={costCode} onChange={e => setCostCode(e.target.value)} placeholder="e.g. 09-700-S" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Original Contract Amount</label>
                <input className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm" value={originalAmount} onChange={e => setOriginalAmount(e.target.value)} placeholder="$0.00" />
              </div>
              <div className="md:col-span-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">Prior contract history</div>
                <p className="text-xs text-gray-400 mt-0.5">
                  Leave blank to total prior change orders in TuttoHQ automatically.
                </p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Previous Additions</label>
                <input
                  className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm"
                  value={priorAdditions}
                  onChange={e => setPriorAdditions(e.target.value)}
                  placeholder={usd(recap?.computedPreviousAdditions ?? 0)}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Previous Deductions</label>
                <input
                  className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm"
                  value={priorDeductions}
                  onChange={e => setPriorDeductions(e.target.value)}
                  placeholder={usd(recap?.computedPreviousDeductions ?? 0)}
                />
              </div>
              {editing && (
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Status</label>
                  <select className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm" value={status} onChange={e => setStatus(e.target.value)}>
                    <option value="draft">Draft</option>
                    <option value="sent">Sent</option>
                    <option value="accepted">Accepted</option>
                  </select>
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Signer Name</label>
                <input className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm" value={signerName} onChange={e => setSignerName(e.target.value)} />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Signer Title</label>
                <input className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm" value={signerTitle} onChange={e => setSignerTitle(e.target.value)} />
              </div>
            </div>

            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Authorized changes</span>
              <button
                type="button"
                className="text-sm text-blue-600 hover:underline"
                onClick={() => setLines(prev => [...prev, emptyLine()])}
              >
                + Add line
              </button>
            </div>
            <div className="overflow-x-auto rounded-lg border border-gray-200 mb-4">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 text-left text-[11px] uppercase tracking-wide text-gray-500">
                    <th className="px-2 py-1.5 w-24">Owner C.O.#</th>
                    <th className="px-2 py-1.5 w-24">GC C.O.#</th>
                    <th className="px-2 py-1.5">Description</th>
                    <th className="px-2 py-1.5 w-28">Cost Code</th>
                    <th className="px-2 py-1.5 w-28">Price</th>
                    <th className="px-2 py-1.5 w-20"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {lines.map((l, i) => (
                    <tr key={l.key}>
                      <td className="px-2 py-1"><input className="w-full border border-gray-200 rounded px-1.5 py-1 text-sm" value={l.owner} onChange={e => setLineField(l.key, "owner", e.target.value)} /></td>
                      <td className="px-2 py-1"><input className="w-full border border-gray-200 rounded px-1.5 py-1 text-sm" value={l.gc} onChange={e => setLineField(l.key, "gc", e.target.value)} /></td>
                      <td className="px-2 py-1"><input className="w-full border border-gray-200 rounded px-1.5 py-1 text-sm" value={l.description} onChange={e => setLineField(l.key, "description", e.target.value)} placeholder="Description of change" /></td>
                      <td className="px-2 py-1"><input className="w-full border border-gray-200 rounded px-1.5 py-1 text-sm" value={l.costCode} onChange={e => setLineField(l.key, "costCode", e.target.value)} /></td>
                      <td className="px-2 py-1"><input className="w-full border border-gray-200 rounded px-1.5 py-1 text-sm text-right" value={l.price} onChange={e => setLineField(l.key, "price", e.target.value)} placeholder="0.00" /></td>
                      <td className="px-2 py-1">
                        <div className="flex items-center gap-1 text-gray-400">
                          <button type="button" title="Move up" disabled={i === 0} className="hover:text-gray-700 disabled:opacity-30" onClick={() => moveLine(i, -1)}>↑</button>
                          <button type="button" title="Move down" disabled={i === lines.length - 1} className="hover:text-gray-700 disabled:opacity-30" onClick={() => moveLine(i, 1)}>↓</button>
                          <button type="button" title="Remove line" className="hover:text-red-600" onClick={() => removeLine(l)}>×</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {recap && previewRecap && (
              <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 p-3">
                <div className="flex items-baseline justify-between mb-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Preview</span>
                  <span className="text-xs text-gray-400">Final figures are frozen when the PDF is generated</span>
                </div>
                <dl className="text-sm max-w-sm ml-auto">
                  {[
                    { label: "1. Original Contract Amt", value: recap.originalContractAmount },
                    { label: "2. Previous Additions", value: previewRecap.previousAdditions },
                    { label: "3. Previous Deductions", value: previewRecap.previousDeductions },
                    { label: "4. Previous Total", value: previewRecap.previousTotal },
                    { label: "5. This Order", value: recap.thisOrder },
                    { label: "6. Present Contract Amount", value: previewRecap.presentContractAmount, strong: true },
                  ].map(row => (
                    <div key={row.label} className="flex items-center justify-between gap-4 py-0.5">
                      <dt className={row.strong ? "font-semibold text-gray-900" : "text-gray-600"}>{row.label}</dt>
                      <dd className={`tabular-nums ${row.strong ? "font-semibold text-gray-900" : "text-gray-700"}`}>
                        {usd(row.value)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                className="px-3 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
                onClick={() => { setEditorOpen(false); resetEditor() }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-3 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? "Saving…" : editing ? "Save Changes" : "Create Change Order"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
