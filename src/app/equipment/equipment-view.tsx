"use client"

import { useEffect, useMemo, useState } from "react"
import { fmtDate } from "@/app/dashboard/_shared/format"

// ── Equipment Inventory (ADR-018) ───────────────────────────────────────────
// Company-scoped catalog + checkout. Counts (owned / checked_out / available)
// come ONLY from the equipment_availability VIEW, surfaced by /api/equipment/*;
// this component never recomputes them. Two screens in one view: the catalog
// list, and an item's unit list (drill-in by state, not a route).
//
// The careful seam lives server-side (the one-open-per-unit invariant is a DB
// index); here we just render its result and surface the 409 conflict plainly.

interface EquipmentItem {
  item_id: string
  name: string
  description: string | null
  owned: number
  checked_out: number
  available: number
}

interface OpenAssignment {
  id: string
  holder_type: string
  holder_label: string
  checked_out_at: string
  expected_return_date: string | null
}

interface Unit {
  id: string
  serial: string | null
  created_at: string
  open_assignment: OpenAssignment | null
}

// A full timestamp (checked_out_at carries a "T") — new Date is instant-accurate
// here. Date-ONLY strings (expected_return_date) go through fmtDate instead, which
// parses them as local to dodge the UTC one-day-early bug.
function fmtSince(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

export default function EquipmentView() {
  const [items, setItems]         = useState<EquipmentItem[]>([])
  const [loading, setLoading]     = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery]         = useState("")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [addOpen, setAddOpen]     = useState(false)

  function loadItems() {
    setLoading(true)
    setLoadError(null)
    return fetch("/api/equipment/items")
      .then(async r => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? "Failed to load")
        return r.json()
      })
      .then(d => setItems(d.items ?? []))
      .catch(e => setLoadError(e.message ?? "Failed to load equipment"))
      .finally(() => setLoading(false))
  }
  useEffect(() => { loadItems() }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter(i => `${i.name} ${i.description ?? ""}`.toLowerCase().includes(q))
  }, [items, query])

  const selectedItem = selectedId ? items.find(i => i.item_id === selectedId) ?? null : null

  // Detail screen — an item's units.
  if (selectedId) {
    return (
      <ItemDetail
        itemId={selectedId}
        item={selectedItem}
        onBack={() => setSelectedId(null)}
        onCountsChanged={loadItems}
      />
    )
  }

  // Catalog screen.
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="max-w-[1100px] mx-auto px-4 sm:px-6 py-8 sm:py-10">
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-5">
          <div>
            <h1 className="text-[20px] sm:text-[22px] font-bold text-[#0F172A] tracking-tight">Equipment</h1>
            <p className="text-[13px] text-[#64748B] mt-0.5">Your company&apos;s tools and gear — what&apos;s in the shop and what&apos;s out on a job.</p>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-4">
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search equipment…"
            className="w-full sm:flex-1 h-9 px-3 rounded-lg border border-[#E2E8F0] text-[13px] text-[#0F172A] bg-white focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40 placeholder:text-[#94A3B8]"
          />
          <button
            onClick={() => setAddOpen(true)}
            className="h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors whitespace-nowrap"
          >
            Add equipment
          </button>
        </div>

        {loadError ? (
          <div className="bg-white rounded-xl border border-red-200 px-6 py-8 text-center">
            <p className="text-[13px] text-red-600">{loadError}</p>
            <button onClick={loadItems} className="mt-3 h-8 px-3 rounded-md border border-[#E2E8F0] text-[13px] font-semibold text-[#0F172A] hover:bg-[#F8FAFC]">Retry</button>
          </div>
        ) : loading ? (
          <p className="text-[13px] text-[#64748B]">Loading…</p>
        ) : items.length === 0 ? (
          <div className="bg-white rounded-xl border border-[#E2E8F0] px-6 py-12 text-center">
            <p className="text-[14px] font-semibold text-[#0F172A]">No equipment yet</p>
            <p className="text-[13px] text-[#64748B] mt-1 mb-4">Add a tool or piece of gear, and how many you own.</p>
            <button onClick={() => setAddOpen(true)} className="h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4]">Add equipment</button>
          </div>
        ) : (
          <>
            <p className="text-[12px] text-[#64748B] mb-2">{items.length} item{items.length === 1 ? "" : "s"}</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {filtered.map(i => (
                <button
                  key={i.item_id}
                  onClick={() => setSelectedId(i.item_id)}
                  className="text-left bg-white rounded-xl border border-[#E2E8F0] p-4 hover:border-[#7B9BB5] hover:shadow-sm transition-all"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-[14px] font-semibold text-[#0F172A] truncate">{i.name}</p>
                      {i.description && <p className="text-[12px] text-[#64748B] mt-0.5 line-clamp-2">{i.description}</p>}
                    </div>
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    <AvailabilityPill available={i.available} owned={i.owned} />
                    {i.checked_out > 0 && (
                      <span className="text-[11px] text-[#64748B]">{i.checked_out} out</span>
                    )}
                  </div>
                </button>
              ))}
              {filtered.length === 0 && (
                <p className="col-span-full text-[13px] text-[#64748B] py-6 text-center">No equipment matches “{query}”.</p>
              )}
            </div>
          </>
        )}
      </div>

      {addOpen && (
        <AddEquipmentModal
          onClose={() => setAddOpen(false)}
          onSaved={() => { setAddOpen(false); loadItems() }}
        />
      )}
    </div>
  )
}

// "X of Y available" — the at-a-glance shop count. Green when something's in;
// amber when the whole item is out.
function AvailabilityPill({ available, owned }: { available: number; owned: number }) {
  const allOut = owned > 0 && available === 0
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[12px] font-semibold ${
        allOut ? "bg-amber-100 text-amber-700" : "bg-green-100 text-green-700"
      }`}
    >
      {available} of {owned} available
    </span>
  )
}

// ── Item detail — the unit list ─────────────────────────────────────────────
function ItemDetail({ itemId, item, onBack, onCountsChanged }: {
  itemId: string
  item: EquipmentItem | null
  onBack: () => void
  onCountsChanged: () => void
}) {
  const [units, setUnits]         = useState<Unit[]>([])
  const [loading, setLoading]     = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Modals, each keyed to the unit they act on.
  const [addUnitOpen, setAddUnitOpen] = useState(false)
  const [editUnit, setEditUnit]       = useState<Unit | null>(null)
  const [checkoutUnit, setCheckoutUnit] = useState<Unit | null>(null)
  const [busyUnit, setBusyUnit]       = useState<string | null>(null)

  function loadUnits() {
    setLoading(true)
    setLoadError(null)
    return fetch(`/api/equipment/items/${itemId}/units`)
      .then(async r => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? "Failed to load")
        return r.json()
      })
      .then(d => setUnits(d.units ?? []))
      .catch(e => setLoadError(e.message ?? "Failed to load units"))
      .finally(() => setLoading(false))
  }
  useEffect(() => { loadUnits() }, [itemId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Any mutation that changes availability refreshes both the unit list and the
  // catalog counts (which come from the view).
  async function refresh() {
    await loadUnits()
    onCountsChanged()
  }

  async function checkIn(u: Unit) {
    setBusyUnit(u.id)
    const res = await fetch(`/api/equipment/units/${u.id}/checkin`, { method: "POST" })
    setBusyUnit(null)
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      alert(d?.error ?? "Failed to check in")
    }
    // Refresh either way — a 409 means our view of the unit was stale.
    refresh()
  }

  async function retire(u: Unit) {
    const label = u.serial ? `serial ${u.serial}` : "this unit"
    if (!confirm(`Retire ${label}? It's removed from your inventory counts. This can't be undone here.`)) return
    setBusyUnit(u.id)
    const res = await fetch(`/api/equipment/units/${u.id}`, { method: "DELETE" })
    setBusyUnit(null)
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      alert(d?.error ?? "Failed to retire unit")
    }
    refresh()
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="max-w-[900px] mx-auto px-4 sm:px-6 py-8 sm:py-10">
        <button onClick={onBack} className="text-[12px] font-semibold text-[#456A88] hover:text-[#2F4D66] mb-4 inline-flex items-center gap-1">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          All equipment
        </button>

        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-5">
          <div className="min-w-0">
            <h1 className="text-[20px] sm:text-[22px] font-bold text-[#0F172A] tracking-tight truncate">{item?.name ?? "Equipment"}</h1>
            {item?.description && <p className="text-[13px] text-[#64748B] mt-0.5">{item.description}</p>}
            {item && (
              <div className="mt-2"><AvailabilityPill available={item.available} owned={item.owned} /></div>
            )}
          </div>
          <button
            onClick={() => setAddUnitOpen(true)}
            className="h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors whitespace-nowrap self-start sm:self-auto"
          >
            Add unit
          </button>
        </div>

        {loadError ? (
          <div className="bg-white rounded-xl border border-red-200 px-6 py-8 text-center">
            <p className="text-[13px] text-red-600">{loadError}</p>
            <button onClick={loadUnits} className="mt-3 h-8 px-3 rounded-md border border-[#E2E8F0] text-[13px] font-semibold text-[#0F172A] hover:bg-[#F8FAFC]">Retry</button>
          </div>
        ) : loading ? (
          <p className="text-[13px] text-[#64748B]">Loading…</p>
        ) : units.length === 0 ? (
          <div className="bg-white rounded-xl border border-[#E2E8F0] px-6 py-12 text-center">
            <p className="text-[14px] font-semibold text-[#0F172A]">No units</p>
            <p className="text-[13px] text-[#64748B] mt-1 mb-4">This item has no physical units yet.</p>
            <button onClick={() => setAddUnitOpen(true)} className="h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4]">Add unit</button>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-[#E2E8F0] divide-y divide-[#F1F5F9]">
            {units.map((u, idx) => {
              const out = !!u.open_assignment
              const busy = busyUnit === u.id
              return (
                <div key={u.id} className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-semibold text-[#0F172A]">
                      {u.serial ? u.serial : `Unit ${idx + 1}`}
                      {!u.serial && <span className="ml-2 text-[10px] font-medium uppercase tracking-wide text-[#94A3B8]">no serial</span>}
                    </p>
                    {out ? (
                      <p className="text-[12px] text-[#B45309] mt-0.5">
                        Out — {u.open_assignment!.holder_label} · since {fmtSince(u.open_assignment!.checked_out_at)}
                        {u.open_assignment!.expected_return_date && <> · due {fmtDate(u.open_assignment!.expected_return_date)}</>}
                      </p>
                    ) : (
                      <p className="text-[12px] text-green-700 mt-0.5">Available</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {out ? (
                      <button onClick={() => checkIn(u)} disabled={busy} className="h-8 px-3 rounded-md bg-[#7B9BB5] text-white text-[12px] font-semibold hover:bg-[#6A8AA4] disabled:opacity-50">
                        {busy ? "…" : "Check in"}
                      </button>
                    ) : (
                      <button onClick={() => setCheckoutUnit(u)} disabled={busy} className="h-8 px-3 rounded-md bg-[#7B9BB5] text-white text-[12px] font-semibold hover:bg-[#6A8AA4] disabled:opacity-50">
                        Check out
                      </button>
                    )}
                    <button onClick={() => setEditUnit(u)} className="h-8 px-2.5 rounded-md border border-[#E2E8F0] text-[12px] font-semibold text-[#0F172A] hover:bg-[#F8FAFC]">Edit</button>
                    <button onClick={() => retire(u)} disabled={busy} className="h-8 px-2.5 rounded-md text-[12px] font-semibold text-red-500 hover:text-red-600 disabled:opacity-50">Retire</button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {addUnitOpen && (
        <AddUnitModal itemId={itemId} onClose={() => setAddUnitOpen(false)} onSaved={() => { setAddUnitOpen(false); refresh() }} />
      )}
      {editUnit && (
        <EditSerialModal unit={editUnit} onClose={() => setEditUnit(null)} onSaved={() => { setEditUnit(null); loadUnits() }} />
      )}
      {checkoutUnit && (
        <CheckoutModal
          unit={checkoutUnit}
          onClose={() => setCheckoutUnit(null)}
          onDone={() => { setCheckoutUnit(null); refresh() }}
        />
      )}
    </div>
  )
}

// ── Add equipment (item + N units) ──────────────────────────────────────────
function AddEquipmentModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName]           = useState("")
  const [description, setDescription] = useState("")
  const [quantity, setQuantity]   = useState("1")
  const [serialsText, setSerialsText] = useState("")
  const [saving, setSaving]       = useState(false)
  const [err, setErr]             = useState<string | null>(null)

  // Serial mode vs count mode: if the user lists any serials, those drive the
  // quantity (one unit per serial). Otherwise the number field drives it and every
  // unit is serial-less (count-only).
  const serials = useMemo(
    () => serialsText.split(/\r?\n/).map(s => s.trim()).filter(Boolean),
    [serialsText],
  )
  const hasSerials = serials.length > 0
  const effectiveQty = hasSerials ? serials.length : Math.max(0, parseInt(quantity, 10) || 0)

  async function save() {
    if (!name.trim()) { setErr("Name is required."); return }
    if (effectiveQty < 1) { setErr("Quantity must be at least 1."); return }
    setSaving(true)
    setErr(null)
    const res = await fetch("/api/equipment/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        description: description.trim() || null,
        quantity: effectiveQty,
        serials: hasSerials ? serials : [],
      }),
    })
    const d = await res.json().catch(() => ({}))
    setSaving(false)
    if (!res.ok) { setErr(d?.error ?? "Save failed"); return }
    onSaved()
  }

  return (
    <ModalShell title="Add equipment" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Name" required>
          <input autoFocus value={name} onChange={e => setName(e.target.value)} className={inputCls} placeholder="14in cutoff saw" />
        </Field>
        <Field label="Description">
          <input value={description} onChange={e => setDescription(e.target.value)} className={inputCls} placeholder="Optional" />
        </Field>
        <Field label="Quantity" required>
          <input
            type="number"
            min={1}
            value={quantity}
            onChange={e => setQuantity(e.target.value)}
            disabled={hasSerials}
            className={`${inputCls} ${hasSerials ? "opacity-50" : ""}`}
          />
          {hasSerials && <span className="block text-[11px] text-[#64748B] mt-1">Set by the {serials.length} serial{serials.length === 1 ? "" : "s"} below.</span>}
        </Field>
        <Field label="Serials">
          <textarea
            value={serialsText}
            onChange={e => setSerialsText(e.target.value)}
            rows={3}
            className={`${inputCls} resize-none font-mono`}
            placeholder={"Optional — one serial per line.\nLeave blank for count-only."}
          />
        </Field>
        {err && <p className="text-[12px] text-red-600">{err}</p>}
      </div>
      <ModalFooter>
        <button onClick={onClose} className="h-9 px-4 rounded-md border border-[#E2E8F0] bg-white text-[13px] font-semibold text-[#0F172A] hover:bg-[#F8FAFC]">Cancel</button>
        <button onClick={save} disabled={saving || !name.trim() || effectiveQty < 1} className="h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] disabled:opacity-50">
          {saving ? "Adding…" : `Add ${effectiveQty || ""} ${effectiveQty === 1 ? "unit" : "units"}`.trim()}
        </button>
      </ModalFooter>
    </ModalShell>
  )
}

// ── Add a single unit ───────────────────────────────────────────────────────
function AddUnitModal({ itemId, onClose, onSaved }: { itemId: string; onClose: () => void; onSaved: () => void }) {
  const [serial, setSerial] = useState("")
  const [saving, setSaving] = useState(false)
  const [err, setErr]       = useState<string | null>(null)

  async function save() {
    setSaving(true)
    setErr(null)
    const res = await fetch(`/api/equipment/items/${itemId}/units`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serial: serial.trim() || null }),
    })
    const d = await res.json().catch(() => ({}))
    setSaving(false)
    if (!res.ok) { setErr(d?.error ?? "Save failed"); return }
    onSaved()
  }

  return (
    <ModalShell title="Add unit" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Serial">
          <input autoFocus value={serial} onChange={e => setSerial(e.target.value)} className={inputCls} placeholder="Optional — leave blank for count-only" />
        </Field>
        {err && <p className="text-[12px] text-red-600">{err}</p>}
      </div>
      <ModalFooter>
        <button onClick={onClose} className="h-9 px-4 rounded-md border border-[#E2E8F0] bg-white text-[13px] font-semibold text-[#0F172A] hover:bg-[#F8FAFC]">Cancel</button>
        <button onClick={save} disabled={saving} className="h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] disabled:opacity-50">
          {saving ? "Adding…" : "Add unit"}
        </button>
      </ModalFooter>
    </ModalShell>
  )
}

// ── Edit a unit's serial ────────────────────────────────────────────────────
function EditSerialModal({ unit, onClose, onSaved }: { unit: Unit; onClose: () => void; onSaved: () => void }) {
  const [serial, setSerial] = useState(unit.serial ?? "")
  const [saving, setSaving] = useState(false)
  const [err, setErr]       = useState<string | null>(null)

  async function save() {
    setSaving(true)
    setErr(null)
    const res = await fetch(`/api/equipment/units/${unit.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serial: serial.trim() || null }),
    })
    const d = await res.json().catch(() => ({}))
    setSaving(false)
    if (!res.ok) { setErr(d?.error ?? "Save failed"); return }
    onSaved()
  }

  return (
    <ModalShell title="Edit serial" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Serial">
          <input autoFocus value={serial} onChange={e => setSerial(e.target.value)} className={inputCls} placeholder="Blank = count-only" />
        </Field>
        {err && <p className="text-[12px] text-red-600">{err}</p>}
      </div>
      <ModalFooter>
        <button onClick={onClose} className="h-9 px-4 rounded-md border border-[#E2E8F0] bg-white text-[13px] font-semibold text-[#0F172A] hover:bg-[#F8FAFC]">Cancel</button>
        <button onClick={save} disabled={saving} className="h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] disabled:opacity-50">
          {saving ? "Saving…" : "Save"}
        </button>
      </ModalFooter>
    </ModalShell>
  )
}

// ── Check out a unit (the careful seam, client side) ────────────────────────
interface PickerProject { id: string; name: string }
interface PickerWorker { id: string; full_name: string }
type HolderType = "project" | "person" | "location"

function CheckoutModal({ unit, onClose, onDone }: {
  unit: Unit
  onClose: () => void
  onDone: () => void
}) {
  const [holderType, setHolderType] = useState<HolderType>("project")
  const [projectId, setProjectId]   = useState("")
  const [workerId, setWorkerId]     = useState("")
  const [locationLabel, setLocationLabel] = useState("")
  const [expected, setExpected]     = useState("") // "YYYY-MM-DD" or ""
  const [projects, setProjects]     = useState<PickerProject[]>([])
  const [workers, setWorkers]       = useState<PickerWorker[]>([])
  const [saving, setSaving]         = useState(false)
  const [err, setErr]               = useState<string | null>(null)

  useEffect(() => {
    fetch("/api/projects").then(r => r.json()).then(d => setProjects(d.projects ?? [])).catch(() => {})
    fetch("/api/workers").then(r => r.json()).then(d => setWorkers(d.workers ?? [])).catch(() => {})
  }, [])

  const canSave =
    holderType === "project" ? !!projectId
      : holderType === "person" ? !!workerId
        : !!locationLabel.trim()

  async function save() {
    if (!canSave) { setErr("Choose who this is checked out to."); return }
    setSaving(true)
    setErr(null)
    const payload: Record<string, unknown> = { holder_type: holderType }
    if (holderType === "project") payload.project_id = projectId
    else if (holderType === "person") payload.worker_id = workerId
    else payload.location_label = locationLabel.trim()
    if (expected) payload.expected_return_date = expected

    const res = await fetch(`/api/equipment/units/${unit.id}/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    const d = await res.json().catch(() => ({}))
    setSaving(false)
    if (!res.ok) {
      // 409 = the DB one-open-per-unit index fired (already out / a race). Surface
      // it plainly and refresh the unit's status by closing back to the list.
      if (res.status === 409) {
        alert(d?.error ?? "This unit is already checked out.")
        onDone()
        return
      }
      setErr(d?.error ?? "Check out failed")
      return
    }
    onDone()
  }

  const label = unit.serial ? `serial ${unit.serial}` : "this unit"

  return (
    <ModalShell title="Check out" onClose={onClose}>
      <div className="space-y-3">
        <p className="text-[12px] text-[#64748B]">Checking out {label}.</p>

        <Field label="Check out to" required>
          <div className="flex items-center gap-1 rounded-lg border border-[#E2E8F0] p-0.5">
            {(["project", "person", "location"] as HolderType[]).map(t => (
              <button
                key={t}
                type="button"
                onClick={() => { setHolderType(t); setErr(null) }}
                className={`flex-1 h-8 rounded-md text-[12px] font-semibold capitalize transition-colors ${holderType === t ? "bg-[#7B9BB5] text-white" : "text-[#64748B] hover:text-[#0F172A]"}`}
              >
                {t}
              </button>
            ))}
          </div>
        </Field>

        {holderType === "project" && (
          <Field label="Project" required>
            <select value={projectId} onChange={e => setProjectId(e.target.value)} className={inputCls}>
              <option value="">Select a project…</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
        )}
        {holderType === "person" && (
          <Field label="Person" required>
            <select value={workerId} onChange={e => setWorkerId(e.target.value)} className={inputCls}>
              <option value="">Select a person…</option>
              {workers.map(w => <option key={w.id} value={w.id}>{w.full_name}</option>)}
            </select>
          </Field>
        )}
        {holderType === "location" && (
          <Field label="Location" required>
            <input autoFocus value={locationLabel} onChange={e => setLocationLabel(e.target.value)} className={inputCls} placeholder="Yard, shop, storage…" />
          </Field>
        )}

        <Field label="Expected return">
          <input type="date" value={expected} onChange={e => setExpected(e.target.value)} className={inputCls} />
        </Field>

        {err && <p className="text-[12px] text-red-600">{err}</p>}
      </div>
      <ModalFooter>
        <button onClick={onClose} className="h-9 px-4 rounded-md border border-[#E2E8F0] bg-white text-[13px] font-semibold text-[#0F172A] hover:bg-[#F8FAFC]">Cancel</button>
        <button onClick={save} disabled={saving || !canSave} className="h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] disabled:opacity-50">
          {saving ? "Checking out…" : "Check out"}
        </button>
      </ModalFooter>
    </ModalShell>
  )
}

// ── Small UI primitives (mirrors the manpower roster) ───────────────────────
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
