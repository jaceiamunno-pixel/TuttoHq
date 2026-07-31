"use client"

import { useMemo, useRef, useState } from "react"
import type { SubmittalRecord } from "@/app/dashboard/_shared/types"
import { SUBMITTAL_TYPE_OPTIONS } from "@/app/dashboard/_shared/types"
import { inputCls, labelCls } from "@/app/dashboard/_shared/ui"
import { SpinnerIcon } from "@/app/dashboard/_shared/icons"
import { canonicalSectionShape } from "@/lib/csi-section"

// "Add row" — hand-entered Submittal Log row (POST /api/submittals/manual-log-row).
//
// Quick-fix entry for spec sections the parser missed or mis-ingested: the
// user types (or picks) a CSI section and mints a manual placeholder row that
// behaves exactly like any other manual row — selection, Clear/Delete
// (delete-only), vendor picker, dates, status all work on it. Documents
// attach later through the existing flows.
//
// The section input carries a datalist of the project's EXISTING sections so
// adding a second type to an already-ingested section is a pick, not a
// retype — picking one prefills the section name from the log.

interface Props {
  projectId: string
  /** The loaded log rows — source of the existing-section datalist. */
  existingRows: SubmittalRecord[]
  onClose: () => void
  /** Called with the inserted row (full SELECT * shape) on success. */
  onCreated: (row: SubmittalRecord) => void
}

export default function AddLogRowModal({ projectId, existingRows, onClose, onCreated }: Props) {
  const [section, setSection]         = useState("")
  const [sectionName, setSectionName] = useState("")
  const [type, setType]               = useState("")
  const [title, setTitle]             = useState("")
  const [description, setDescription] = useState("")
  const [leadTime, setLeadTime]       = useState("")
  const [critical, setCritical]       = useState(false)
  const [saving, setSaving]           = useState(false)
  const [error, setError]             = useState<string | null>(null)
  // True while the section-name field holds a datalist prefill the user
  // hasn't touched — a different section pick may overwrite it; a manual
  // edit must never be overwritten.
  const nameWasPrefilled = useRef(false)

  // Distinct existing sections (canonical "XX YY ZZ" strings) → a
  // representative section name from the log.
  const sectionOptions = useMemo(() => {
    const bySection = new Map<string, string>()
    for (const s of existingRows) {
      const sec = (s.csi_section ?? "").trim()
      if (!sec) continue
      const existing = bySection.get(sec)
      if (existing === undefined) bySection.set(sec, s.section_name ?? "")
      else if (!existing && s.section_name) bySection.set(sec, s.section_name)
    }
    return [...bySection.entries()]
      .map(([sec, name]) => ({ sec, name }))
      .sort((a, b) => a.sec.localeCompare(b.sec))
  }, [existingRows])

  function handleSectionChange(v: string) {
    setSection(v)
    const canonical = canonicalSectionShape(v)
    if (!canonical) return
    const match = sectionOptions.find(o => o.sec === canonical)
    if (match?.name && (sectionName.trim() === "" || nameWasPrefilled.current)) {
      setSectionName(match.name)
      nameWasPrefilled.current = true
    }
  }

  const canonical = canonicalSectionShape(section)
  const sectionInvalid = section.trim().length > 0 && !canonical
  const canSave = !!canonical && sectionName.trim().length > 0 && type !== "" && !saving

  async function handleSave() {
    if (!canSave || !canonical) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/submittals/manual-log-row", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: projectId,
          csi_section: canonical,
          section_name: sectionName.trim(),
          submittal_type: type,
          title: title.trim() || undefined,
          description: description.trim() || undefined,
          lead_time: leadTime.trim() || undefined,
          is_critical: critical || undefined,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error ?? `Failed (HTTP ${res.status})`)
      onCreated(data.row as SubmittalRecord)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add the row")
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 z-[60] flex items-center justify-center p-4"
      onClick={e => { if (e.target === e.currentTarget && !saving) onClose() }}
    >
      <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full p-5 max-h-[90vh] overflow-y-auto">
        <h2 className="text-[15px] font-bold text-[#0F172A] mb-1">Add log row</h2>
        <p className="text-[13px] text-[#64748B] mb-4 leading-relaxed">
          Add a submittal-log row by hand — for a spec section the parser missed or mis-ingested.
          It gets the section&apos;s next number; documents attach later through the normal flows.
        </p>

        <div className="space-y-3.5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            <div>
              <label className={labelCls}>CSI Section *</label>
              <input
                list="add-log-row-sections"
                value={section}
                onChange={e => handleSectionChange(e.target.value)}
                placeholder="e.g. 12 66 13"
                autoFocus
                className={`${inputCls} ${sectionInvalid ? "border-red-300 focus:ring-red-200 focus:border-red-400" : ""}`}
              />
              <datalist id="add-log-row-sections">
                {sectionOptions.map(o => (
                  <option key={o.sec} value={o.sec}>{o.name || undefined}</option>
                ))}
              </datalist>
              {sectionInvalid && (
                <p className="text-[11px] text-red-600 mt-1">Use the MasterFormat shape, e.g. 12 66 13</p>
              )}
            </div>
            <div>
              <label className={labelCls}>Submittal Type *</label>
              <select value={type} onChange={e => setType(e.target.value)} className={inputCls}>
                <option value="">Select type…</option>
                {SUBMITTAL_TYPE_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className={labelCls}>Section Name *</label>
            <input
              value={sectionName}
              onChange={e => { setSectionName(e.target.value); nameWasPrefilled.current = false }}
              placeholder="e.g. Telescoping Stands"
              className={inputCls}
            />
          </div>

          <div>
            <label className={labelCls}>Title <span className="normal-case font-normal">(optional)</span></label>
            <input
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Item title — defaults to the section name"
              className={inputCls}
            />
          </div>

          <div>
            <label className={labelCls}>Description <span className="normal-case font-normal">(optional)</span></label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={2}
              placeholder="Free-text note"
              className={`${inputCls} h-auto py-2 resize-none`}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 items-end">
            <div>
              <label className={labelCls}>Lead Time <span className="normal-case font-normal">(optional)</span></label>
              <input
                value={leadTime}
                onChange={e => setLeadTime(e.target.value)}
                placeholder='e.g. "6-8 weeks"'
                className={inputCls}
              />
            </div>
            <label className="flex items-center gap-2 h-9 text-[13px] text-[#0F172A] cursor-pointer select-none">
              <input
                type="checkbox"
                checked={critical}
                onChange={e => setCritical(e.target.checked)}
                className="h-4 w-4 rounded border-[#E2E8F0] text-[#7B9BB5] focus:ring-[#7B9BB5]/40"
              />
              Critical item
            </label>
          </div>
        </div>

        {error && (
          <p className="text-[12px] text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2 mt-4 leading-relaxed">
            {error}
          </p>
        )}

        <div className="flex gap-2 justify-end mt-5">
          <button
            disabled={saving}
            onClick={onClose}
            className="h-9 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50">
            Cancel
          </button>
          <button
            disabled={!canSave}
            onClick={handleSave}
            className="h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50 flex items-center gap-1.5">
            {saving ? <SpinnerIcon className="h-3.5 w-3.5" /> : null}
            Add row
          </button>
        </div>
      </div>
    </div>
  )
}
