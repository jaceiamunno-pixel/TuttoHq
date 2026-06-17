"use client"

import { useEffect, useState } from "react"

// User's own PO numbering (Settings → Account). Each user sets their OWN prefix
// + starting number; issue_po_number() reads them from user_profiles at PO
// create time. Writes go through /api/profile/po-numbering (own row only).
//
// PO numbers are unique COMPANY-WIDE (enforced by a unique index), so the live
// preview + the backward-move warning exist to help a user pick a starting point
// that doesn't collide with a number they (or a teammate) already issued —
// otherwise issuance is rejected with a 409 at create time.

export default function ProfilePoNumbering() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)

  // Inputs (prefix is optional; start is required, positive integer).
  const [prefix, setPrefix] = useState("")
  const [start, setStart] = useState("")

  // Last-saved values, used to detect changes and to anchor the backward-move
  // warning. savedSeq is the user's current po_next_seq (the next number that
  // would be issued); null = not configured yet.
  const [savedPrefix, setSavedPrefix] = useState<string | null>(null)
  const [savedSeq, setSavedSeq] = useState<number | null>(null)

  function flash(text: string, ok = true) {
    setMessage({ text, ok })
    setTimeout(() => setMessage(null), 5000)
  }

  useEffect(() => {
    fetch("/api/profile/po-numbering")
      .then(r => r.json())
      .then((d: { po_prefix?: string | null; po_next_seq?: number | null }) => {
        setSavedPrefix(d.po_prefix ?? null)
        setSavedSeq(d.po_next_seq ?? null)
        setPrefix(d.po_prefix ?? "")
        setStart(d.po_next_seq != null ? String(d.po_next_seq) : "")
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  // Parse the start input to a positive integer, or null if invalid/empty.
  const parsedStart: number | null = (() => {
    const s = start.trim()
    if (!/^\d+$/.test(s)) return null
    const n = Number(s)
    return Number.isInteger(n) && n > 0 ? n : null
  })()

  const trimmedPrefix = prefix.trim()
  const preview = parsedStart != null ? `${trimmedPrefix}${parsedStart}` : null

  // Backward-move warning: setting the start at/below the current next number can
  // re-use an already-issued number.
  const backwardWarning =
    savedSeq != null && parsedStart != null && parsedStart <= savedSeq
      ? `You've issued PO numbers up to ${savedSeq - 1}. Starting at or below ${savedSeq} can re-use an already-issued number — issuing it will be rejected as a duplicate.`
      : null

  const unchanged =
    parsedStart === savedSeq && (trimmedPrefix === (savedPrefix ?? ""))

  async function handleSave() {
    if (parsedStart == null) { flash("Enter a starting number (a whole number greater than 0).", false); return }
    setSaving(true)
    try {
      const res = await fetch("/api/profile/po-numbering", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ po_prefix: trimmedPrefix || null, po_next_seq: parsedStart }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { flash(d.error ?? "Could not save PO numbering", false); return }
      setSavedPrefix(d.po_prefix ?? null)
      setSavedSeq(d.po_next_seq ?? parsedStart)
      setPrefix(d.po_prefix ?? "")
      setStart(d.po_next_seq != null ? String(d.po_next_seq) : String(parsedStart))
      flash(d.warning ?? "PO numbering saved", d.warning ? false : true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-white rounded-xl border border-[#E2E8F0] p-5">
      <h2 className="text-[14px] font-semibold text-[#0F172A] mb-0.5">Purchase order numbering</h2>
      <p className="text-[12px] text-[#64748B] mb-4">
        Sets the prefix and next number for purchase orders <span className="font-medium text-[#0F172A]">you</span> issue.
        Each person has their own sequence. Changing these only affects PO numbers issued from now on.
      </p>

      {loading ? (
        <div className="text-[13px] text-[#64748B]">Loading…</div>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <label className="block text-[12px] font-medium text-[#475569]">Prefix <span className="text-[#94A3B8] font-normal">(optional)</span></label>
              <input
                type="text"
                value={prefix}
                onChange={e => setPrefix(e.target.value)}
                maxLength={16}
                placeholder="e.g. 9"
                className="w-28 h-9 px-3 rounded-md border border-[#E2E8F0] bg-white text-[13px] text-[#0F172A] placeholder-[#94A3B8] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40"
              />
            </div>
            <div className="space-y-1">
              <label className="block text-[12px] font-medium text-[#475569]">Starting number</label>
              <input
                type="text"
                inputMode="numeric"
                value={start}
                onChange={e => setStart(e.target.value)}
                placeholder="e.g. 1005"
                className="w-36 h-9 px-3 rounded-md border border-[#E2E8F0] bg-white text-[13px] text-[#0F172A] placeholder-[#94A3B8] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40"
              />
            </div>
            <div className="space-y-1">
              <span className="block text-[12px] font-medium text-[#475569]">Next PO will be</span>
              <div className="h-9 px-3 rounded-md bg-[#F1F5F9] border border-[#E2E8F0] flex items-center text-[13px] font-semibold text-[#0F172A] min-w-[6rem]">
                {preview ?? <span className="text-[#94A3B8] font-normal">—</span>}
              </div>
            </div>
            <button
              onClick={handleSave}
              disabled={saving || parsedStart == null || unchanged}
              className="h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>

          <p className="mt-3 text-[11px] text-[#64748B] leading-relaxed">
            PO numbers are unique company-wide. If two people start at overlapping numbers, issuing is
            rejected at creation — use the preview to pick a starting number no teammate is already using.
          </p>

          {backwardWarning && (
            <div className="mt-3 rounded-md px-3 py-2 text-[12px] bg-amber-50 border border-amber-200 text-amber-800">
              {backwardWarning}
            </div>
          )}

          {message && (
            <div className={`mt-3 rounded-md px-3 py-2 text-[12px] ${message.ok ? "bg-green-50 border border-green-200 text-green-700" : "bg-amber-50 border border-amber-200 text-amber-800"}`}>
              {message.text}
            </div>
          )}
        </>
      )}
    </div>
  )
}
