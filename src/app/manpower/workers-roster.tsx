"use client"

import { useEffect, useMemo, useState } from "react"
import ManpowerCalendar from "@/components/manpower-calendar"

// ── Workers roster (Manpower Phase 2) ───────────────────────────────────────
// Company-scoped CRUD over the workers table. All reads/writes go through the
// RLS-scoped /api/workers routes. "trade" is the worker's title — labelled
// "Title" throughout the UI (carpenter / laborer / foreman / …).
//
// Recently-deleted note: the workers SELECT policy hides deleted_at rows and
// there is no list-deleted RPC, so soft-deleted workers can't be read back from
// the server. The "Recently deleted" affordance is therefore an in-SESSION
// buffer — it holds workers deleted during this visit and offers Restore on
// them; a page reload clears it (the row still exists in the DB and can be
// restored later by re-deleting/restoring, but this v1 doesn't re-list it).

interface Worker {
  id: string
  full_name: string
  trade: string | null
  phone: string | null
  email: string | null
  active: boolean
  notes: string | null
  created_at: string
}

type Tab = "workers" | "schedule"

interface FormState {
  full_name: string
  trade: string
  phone: string
  email: string
  notes: string
}

const EMPTY_FORM: FormState = { full_name: "", trade: "", phone: "", email: "", notes: "" }

// Parse the bulk paste box: one worker per line, "Name" or "Name, Title".
function parseBulk(text: string): { full_name: string; trade: string | null }[] {
  return text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .map(line => {
      const ci = line.indexOf(",")
      if (ci === -1) return { full_name: line, trade: null }
      return { full_name: line.slice(0, ci).trim(), trade: line.slice(ci + 1).trim() || null }
    })
    .filter(r => r.full_name.length > 0)
}

export default function WorkersRoster() {
  const [tab, setTab]           = useState<Tab>("workers")
  const [workers, setWorkers]   = useState<Worker[]>([])
  const [loading, setLoading]   = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery]       = useState("")

  // In-session "Recently deleted" buffer (see file header).
  const [recentlyDeleted, setRecentlyDeleted] = useState<Worker[]>([])

  // Add / edit modal. editing === null → add; otherwise edit that worker.
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing]   = useState<Worker | null>(null)

  // Bulk-add modal.
  const [bulkOpen, setBulkOpen] = useState(false)

  function load() {
    setLoading(true)
    setLoadError(null)
    fetch("/api/workers")
      .then(async r => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? "Failed to load")
        return r.json()
      })
      .then(d => setWorkers(d.workers ?? []))
      .catch(e => setLoadError(e.message ?? "Failed to load workers"))
      .finally(() => setLoading(false))
  }
  useEffect(load, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return workers
    return workers.filter(w =>
      `${w.full_name} ${w.trade ?? ""} ${w.phone ?? ""} ${w.email ?? ""}`.toLowerCase().includes(q),
    )
  }, [workers, query])

  const activeCount = workers.filter(w => w.active).length

  // ── Mutations ─────────────────────────────────────────────────────────────
  async function toggleActive(w: Worker) {
    // Optimistic flip, rolled back on failure.
    const next = !w.active
    setWorkers(ws => ws.map(x => (x.id === w.id ? { ...x, active: next } : x)))
    const res = await fetch(`/api/workers/${w.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: next }),
    })
    if (!res.ok) {
      setWorkers(ws => ws.map(x => (x.id === w.id ? { ...x, active: w.active } : x)))
      const d = await res.json().catch(() => ({}))
      alert(d?.error ?? "Failed to update worker")
    }
  }

  async function deleteWorker(w: Worker) {
    if (!confirm(`Remove ${w.full_name} from the roster? They move to "Recently deleted" and can be restored this session.`)) return
    const res = await fetch(`/api/workers/${w.id}`, { method: "DELETE" })
    if (res.ok) {
      setWorkers(ws => ws.filter(x => x.id !== w.id))
      setRecentlyDeleted(rd => [w, ...rd.filter(x => x.id !== w.id)])
    } else {
      const d = await res.json().catch(() => ({}))
      alert(d?.error ?? "Failed to remove worker")
    }
  }

  async function restoreWorker(w: Worker) {
    const res = await fetch(`/api/workers/${w.id}/restore`, { method: "POST" })
    if (res.ok) {
      setRecentlyDeleted(rd => rd.filter(x => x.id !== w.id))
      load()
    } else {
      const d = await res.json().catch(() => ({}))
      alert(d?.error ?? "Failed to restore worker")
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="max-w-[1100px] mx-auto px-4 sm:px-6 py-8 sm:py-10">
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-5">
          <div>
            <h1 className="text-[20px] sm:text-[22px] font-bold text-[#0F172A] tracking-tight">Manpower</h1>
            <p className="text-[13px] text-[#64748B] mt-0.5">Your company-wide crew roster, reusable across every project.</p>
          </div>
        </div>

        {/* Phase tabs — Workers is live; Schedule is the next phase. */}
        <div className="flex items-center gap-1 mb-5 border-b border-[#E2E8F0]">
          <button
            onClick={() => setTab("workers")}
            className={`h-9 px-3 text-[13px] font-semibold border-b-2 -mb-px transition-colors ${tab === "workers" ? "border-[#7B9BB5] text-[#0F172A]" : "border-transparent text-[#64748B] hover:text-[#0F172A]"}`}
          >
            Workers
          </button>
          <button
            onClick={() => setTab("schedule")}
            className={`h-9 px-3 text-[13px] font-semibold border-b-2 -mb-px transition-colors ${tab === "schedule" ? "border-[#7B9BB5] text-[#0F172A]" : "border-transparent text-[#64748B] hover:text-[#0F172A]"}`}
          >
            Schedule
          </button>
        </div>

        {tab === "schedule" ? (
          <ManpowerCalendar />
        ) : (
          <>
            {/* Toolbar */}
            <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-4">
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search by name, title, phone…"
                className="w-full sm:flex-1 h-9 px-3 rounded-lg border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 placeholder:text-[#94A3B8]"
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setBulkOpen(true)}
                  className="h-9 px-3 rounded-md border border-[#E2E8F0] bg-white text-[13px] font-semibold text-[#0F172A] hover:bg-[#F8FAFC] transition-colors whitespace-nowrap"
                >
                  Bulk add
                </button>
                <button
                  onClick={() => { setEditing(null); setFormOpen(true) }}
                  className="h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors whitespace-nowrap"
                >
                  Add worker
                </button>
              </div>
            </div>

            {loadError ? (
              <div className="bg-white rounded-xl border border-red-200 px-6 py-8 text-center">
                <p className="text-[13px] text-red-600">{loadError}</p>
                <button onClick={load} className="mt-3 h-8 px-3 rounded-md border border-[#E2E8F0] text-[13px] font-semibold text-[#0F172A] hover:bg-[#F8FAFC]">Retry</button>
              </div>
            ) : loading ? (
              <p className="text-[13px] text-[#64748B]">Loading…</p>
            ) : workers.length === 0 ? (
              <div className="bg-white rounded-xl border border-[#E2E8F0] px-6 py-12 text-center">
                <p className="text-[14px] font-semibold text-[#0F172A]">No workers yet</p>
                <p className="text-[13px] text-[#64748B] mt-1 mb-4">Add your crew one at a time, or paste a whole list at once.</p>
                <div className="flex items-center justify-center gap-2">
                  <button onClick={() => setBulkOpen(true)} className="h-9 px-3 rounded-md border border-[#E2E8F0] bg-white text-[13px] font-semibold text-[#0F172A] hover:bg-[#F8FAFC]">Bulk add</button>
                  <button onClick={() => { setEditing(null); setFormOpen(true) }} className="h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4]">Add worker</button>
                </div>
              </div>
            ) : (
              <>
                <p className="text-[12px] text-[#64748B] mb-2">{workers.length} worker{workers.length === 1 ? "" : "s"} · {activeCount} active</p>
                <div className="bg-white rounded-xl border border-[#E2E8F0] overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-[13px]">
                      <thead>
                        <tr className="border-b border-[#E2E8F0] text-left text-[11px] uppercase tracking-wide text-[#64748B]">
                          <th className="font-semibold px-4 py-2.5">Name</th>
                          <th className="font-semibold px-4 py-2.5">Title</th>
                          <th className="font-semibold px-4 py-2.5">Phone</th>
                          <th className="font-semibold px-4 py-2.5">Email</th>
                          <th className="font-semibold px-4 py-2.5">Active</th>
                          <th className="font-semibold px-4 py-2.5 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.map(w => (
                          <tr key={w.id} className={`border-b border-[#F1F5F9] last:border-0 ${w.active ? "" : "bg-[#FAFBFC]"}`}>
                            <td className="px-4 py-2.5">
                              <span className={`font-semibold ${w.active ? "text-[#0F172A]" : "text-[#94A3B8]"}`}>{w.full_name}</span>
                              {!w.active && <span className="ml-2 text-[10px] font-semibold uppercase tracking-wide text-[#94A3B8] bg-[#F1F5F9] border border-[#E2E8F0] rounded px-1.5 py-0.5">Inactive</span>}
                            </td>
                            <td className="px-4 py-2.5 text-[#475569]">{w.trade ?? <span className="text-[#CBD5E1]">—</span>}</td>
                            <td className="px-4 py-2.5 text-[#475569]">{w.phone ?? <span className="text-[#CBD5E1]">—</span>}</td>
                            <td className="px-4 py-2.5 text-[#475569]">{w.email ?? <span className="text-[#CBD5E1]">—</span>}</td>
                            <td className="px-4 py-2.5">
                              <button
                                onClick={() => toggleActive(w)}
                                role="switch"
                                aria-checked={w.active}
                                title={w.active ? "Mark inactive" : "Mark active"}
                                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${w.active ? "bg-[#7B9BB5]" : "bg-[#CBD5E1]"}`}
                              >
                                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${w.active ? "translate-x-4" : "translate-x-0.5"}`} />
                              </button>
                            </td>
                            <td className="px-4 py-2.5 text-right whitespace-nowrap">
                              <button onClick={() => { setEditing(w); setFormOpen(true) }} className="text-[12px] font-semibold text-[#456A88] hover:text-[#2F4D66] mr-3">Edit</button>
                              <button onClick={() => deleteWorker(w)} className="text-[12px] font-semibold text-red-500 hover:text-red-600">Remove</button>
                            </td>
                          </tr>
                        ))}
                        {filtered.length === 0 && (
                          <tr><td colSpan={6} className="px-4 py-6 text-center text-[13px] text-[#64748B]">No workers match “{query}”.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}

            {/* Recently deleted (in-session) */}
            {recentlyDeleted.length > 0 && (
              <div className="mt-6 bg-white rounded-xl border border-[#E2E8F0] overflow-hidden">
                <div className="px-4 py-2.5 border-b border-[#E2E8F0] bg-[#FAFBFC]">
                  <p className="text-[12px] font-semibold text-[#0F172A]">Recently deleted <span className="font-normal text-[#94A3B8]">(this session)</span></p>
                </div>
                <ul>
                  {recentlyDeleted.map(w => (
                    <li key={w.id} className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-[#F1F5F9] last:border-0">
                      <span className="text-[13px] text-[#64748B] truncate">{w.full_name}{w.trade ? ` · ${w.trade}` : ""}</span>
                      <button onClick={() => restoreWorker(w)} className="text-[12px] font-semibold text-[#456A88] hover:text-[#2F4D66] whitespace-nowrap">Restore</button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>

      {formOpen && (
        <WorkerFormModal
          worker={editing}
          onClose={() => setFormOpen(false)}
          onSaved={(w, mode) => {
            setFormOpen(false)
            if (mode === "edit") setWorkers(ws => ws.map(x => (x.id === w.id ? w : x)))
            else setWorkers(ws => [...ws, w].sort((a, b) => a.full_name.localeCompare(b.full_name)))
          }}
        />
      )}

      {bulkOpen && (
        <BulkAddModal
          onClose={() => setBulkOpen(false)}
          onSaved={created => {
            setBulkOpen(false)
            setWorkers(ws => [...ws, ...created].sort((a, b) => a.full_name.localeCompare(b.full_name)))
          }}
        />
      )}
    </div>
  )
}

// ── Add / edit modal ─────────────────────────────────────────────────────────
function WorkerFormModal({ worker, onClose, onSaved }: {
  worker: Worker | null
  onClose: () => void
  onSaved: (w: Worker, mode: "add" | "edit") => void
}) {
  const isEdit = !!worker
  const [form, setForm] = useState<FormState>(
    worker
      ? { full_name: worker.full_name, trade: worker.trade ?? "", phone: worker.phone ?? "", email: worker.email ?? "", notes: worker.notes ?? "" }
      : EMPTY_FORM,
  )
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const set = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  async function save() {
    if (!form.full_name.trim()) { setErr("Name is required."); return }
    setSaving(true)
    setErr(null)
    const payload = {
      full_name: form.full_name.trim(),
      trade: form.trade.trim() || null,
      phone: form.phone.trim() || null,
      email: form.email.trim() || null,
      notes: form.notes.trim() || null,
    }
    const res = isEdit
      ? await fetch(`/api/workers/${worker!.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
      : await fetch(`/api/workers`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
    const d = await res.json().catch(() => ({}))
    setSaving(false)
    if (!res.ok) { setErr(d?.error ?? "Save failed"); return }
    onSaved(d.worker as Worker, isEdit ? "edit" : "add")
  }

  return (
    <ModalShell title={isEdit ? "Edit worker" : "Add worker"} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Name" required>
          <input autoFocus value={form.full_name} onChange={set("full_name")} className={inputCls} placeholder="Jane Carpenter" />
        </Field>
        <Field label="Title">
          <input value={form.trade} onChange={set("trade")} className={inputCls} placeholder="Carpenter / Laborer / Foreman" />
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Phone">
            <input value={form.phone} onChange={set("phone")} className={inputCls} placeholder="(555) 123-4567" />
          </Field>
          <Field label="Email">
            <input value={form.email} onChange={set("email")} className={inputCls} placeholder="jane@example.com" />
          </Field>
        </div>
        <Field label="Notes">
          <textarea value={form.notes} onChange={set("notes")} rows={2} className={`${inputCls} resize-none`} placeholder="Optional" />
        </Field>
        {err && <p className="text-[12px] text-red-600">{err}</p>}
      </div>
      <ModalFooter>
        <button onClick={onClose} className="h-9 px-4 rounded-md border border-[#E2E8F0] bg-white text-[13px] font-semibold text-[#0F172A] hover:bg-[#F8FAFC]">Cancel</button>
        <button onClick={save} disabled={saving || !form.full_name.trim()} className="h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] disabled:opacity-50">
          {saving ? "Saving…" : isEdit ? "Save changes" : "Add worker"}
        </button>
      </ModalFooter>
    </ModalShell>
  )
}

// ── Bulk add modal ───────────────────────────────────────────────────────────
function BulkAddModal({ onClose, onSaved }: {
  onClose: () => void
  onSaved: (created: Worker[]) => void
}) {
  const [text, setText]     = useState("")
  const [saving, setSaving] = useState(false)
  const [err, setErr]       = useState<string | null>(null)
  // Two-step: type → confirm the parsed preview → save.
  const [confirming, setConfirming] = useState(false)

  const parsed = useMemo(() => parseBulk(text), [text])

  async function save() {
    if (parsed.length === 0) return
    setSaving(true)
    setErr(null)
    const res = await fetch(`/api/workers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workers: parsed }),
    })
    const d = await res.json().catch(() => ({}))
    setSaving(false)
    if (!res.ok) { setErr(d?.error ?? "Bulk add failed"); setConfirming(false); return }
    onSaved((d.workers ?? []) as Worker[])
  }

  return (
    <ModalShell title="Bulk add workers" onClose={onClose}>
      {!confirming ? (
        <div className="space-y-2">
          <p className="text-[12px] text-[#64748B]">One worker per line. Add a title after a comma — e.g. <span className="font-mono text-[#475569]">Jane Carpenter, Foreman</span>.</p>
          <textarea
            autoFocus
            value={text}
            onChange={e => setText(e.target.value)}
            rows={9}
            className={`${inputCls} resize-none font-mono`}
            placeholder={"Jane Carpenter, Foreman\nMike Laborer\nSam Smith, Carpenter"}
          />
          <p className="text-[12px] text-[#64748B]">{parsed.length} worker{parsed.length === 1 ? "" : "s"} detected.</p>
          {err && <p className="text-[12px] text-red-600">{err}</p>}
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-[12px] text-[#64748B]">Confirm the {parsed.length} worker{parsed.length === 1 ? "" : "s"} below will be added to your roster.</p>
          <div className="max-h-[40vh] overflow-y-auto rounded-lg border border-[#E2E8F0]">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-[#E2E8F0] text-left text-[11px] uppercase tracking-wide text-[#64748B] sticky top-0 bg-white">
                  <th className="font-semibold px-3 py-2">Name</th>
                  <th className="font-semibold px-3 py-2">Title</th>
                </tr>
              </thead>
              <tbody>
                {parsed.map((r, i) => (
                  <tr key={i} className="border-b border-[#F1F5F9] last:border-0">
                    <td className="px-3 py-1.5 text-[#0F172A] font-medium">{r.full_name}</td>
                    <td className="px-3 py-1.5 text-[#475569]">{r.trade ?? <span className="text-[#CBD5E1]">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {err && <p className="text-[12px] text-red-600">{err}</p>}
        </div>
      )}
      <ModalFooter>
        {!confirming ? (
          <>
            <button onClick={onClose} className="h-9 px-4 rounded-md border border-[#E2E8F0] bg-white text-[13px] font-semibold text-[#0F172A] hover:bg-[#F8FAFC]">Cancel</button>
            <button onClick={() => setConfirming(true)} disabled={parsed.length === 0} className="h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] disabled:opacity-50">
              Preview {parsed.length > 0 ? `(${parsed.length})` : ""}
            </button>
          </>
        ) : (
          <>
            <button onClick={() => setConfirming(false)} disabled={saving} className="h-9 px-4 rounded-md border border-[#E2E8F0] bg-white text-[13px] font-semibold text-[#0F172A] hover:bg-[#F8FAFC] disabled:opacity-50">Back</button>
            <button onClick={save} disabled={saving || parsed.length === 0} className="h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] disabled:opacity-50">
              {saving ? "Adding…" : `Add ${parsed.length} worker${parsed.length === 1 ? "" : "s"}`}
            </button>
          </>
        )}
      </ModalFooter>
    </ModalShell>
  )
}

// ── Small UI primitives (local to this view) ─────────────────────────────────
const inputCls = "w-full h-9 px-3 rounded-lg border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 placeholder:text-[#94A3B8]"

function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40" onClick={onClose}>
      <div className="w-full max-w-md bg-white rounded-xl border border-[#E2E8F0] shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[#E2E8F0]">
          <h2 className="text-[15px] font-bold text-[#0F172A]">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="text-[#94A3B8] hover:text-[#0F172A] transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  )
}

function ModalFooter({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center justify-end gap-2 mt-5">{children}</div>
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[12px] font-semibold text-[#475569] mb-1">{label}{required && <span className="text-red-500"> *</span>}</span>
      {children}
    </label>
  )
}
