"use client"

import { useEffect, useMemo, useState } from "react"
import type { PackageReminderSettings, SubmittalPackage, CloseoutPackage } from "@/app/dashboard/_shared/types"
import {
  formatCadence,
  parseCadenceInput,
  validateSettingsBody,
  MAX_CADENCE_DAY,
  MAX_REMINDER_COUNT,
  type ValidatedSettingsPatch,
} from "@/lib/reminder-settings"
// Single shared date formatter (fixed for date-only UTC-shift). last_sent_at /
// next_due_at are both timestamptz today, so this is instant-accurate now AND
// safe if either ever becomes a date-only string.
import { fmtDate } from "@/app/dashboard/_shared/format"

// ─── ReminderSettingsPanel (Session K2) ─────────────────────────────────────
// Shared between PackagesView and CloseoutPackagesView. Inputs are nullable
// — empty / "Inherit company default" clears the per-package override. Right
// column shows the resolved effective values so the PM sees exactly what
// will run, not just what they typed.
//
// The panel is the only place that talks to /settings — the parent passes
// the package row (for current override values), the effective settings
// (for the right-column display), and a save callback. After a successful
// save the parent calls its loader to refetch.

export type ReminderSettingsPackage = Pick<
  SubmittalPackage | CloseoutPackage,
  "reminder_cadence_days" | "reminder_max_count" | "reminder_attach_pdf" | "reminders_paused" | "dispatched_at"
>

interface Props {
  pkg: ReminderSettingsPackage
  reminderSettings: PackageReminderSettings
  saveEndpoint: string                                // e.g. /api/submittal-packages/{id}/settings
  onSaved: () => void
}

function fmtBool(v: boolean): string {
  return v ? "Re-attach package PDF" : "Text only"
}

export default function ReminderSettingsPanel({ pkg, reminderSettings, saveEndpoint, onSaved }: Props) {
  // ── Form state ──────────────────────────────────────────────────────────
  const [cadenceInput,  setCadenceInput]  = useState<string>(pkg.reminder_cadence_days ? formatCadence(pkg.reminder_cadence_days) : "")
  const [maxInput,      setMaxInput]      = useState<string>(pkg.reminder_max_count != null ? String(pkg.reminder_max_count) : "")
  // attach: "inherit" | "true" | "false" — a 3-state dropdown so PMs can
  // explicitly say "off" vs "inherit (which happens to be off)".
  const [attachSelect,  setAttachSelect]  = useState<"inherit" | "true" | "false">(
    pkg.reminder_attach_pdf === null ? "inherit" : pkg.reminder_attach_pdf ? "true" : "false",
  )
  const [paused,        setPaused]        = useState<boolean>(pkg.reminders_paused)
  const [saving,        setSaving]        = useState(false)
  const [error,         setError]         = useState<string | null>(null)
  const [success,       setSuccess]       = useState(false)

  // When the parent reloads after save and passes a fresh pkg, sync inputs.
  useEffect(() => {
    setCadenceInput(pkg.reminder_cadence_days ? formatCadence(pkg.reminder_cadence_days) : "")
    setMaxInput(pkg.reminder_max_count != null ? String(pkg.reminder_max_count) : "")
    setAttachSelect(pkg.reminder_attach_pdf === null ? "inherit" : pkg.reminder_attach_pdf ? "true" : "false")
    setPaused(pkg.reminders_paused)
  }, [pkg.reminder_cadence_days, pkg.reminder_max_count, pkg.reminder_attach_pdf, pkg.reminders_paused])

  // ── Build the patch + run shared validation ──────────────────────────────
  const builtPatch: ValidatedSettingsPatch | null = useMemo(() => {
    const patch: Record<string, unknown> = {}

    const cadenceParsed = parseCadenceInput(cadenceInput)
    patch.reminder_cadence_days = cadenceParsed   // null if input is empty

    const maxTrim = maxInput.trim()
    patch.reminder_max_count = maxTrim === "" ? null : Number(maxTrim)

    patch.reminder_attach_pdf = attachSelect === "inherit" ? null : attachSelect === "true"

    patch.reminders_paused = paused

    const result = validateSettingsBody(patch)
    return result.ok ? result.value : null
  }, [cadenceInput, maxInput, attachSelect, paused])

  // Validation message for the form (re-runs validation to grab the error
  // string when builtPatch is null — keeps it co-located with the inputs).
  const validationError = useMemo(() => {
    const patch: Record<string, unknown> = {
      reminder_cadence_days: parseCadenceInput(cadenceInput),
      reminder_max_count:    maxInput.trim() === "" ? null : Number(maxInput),
      reminder_attach_pdf:   attachSelect === "inherit" ? null : attachSelect === "true",
      reminders_paused:      paused,
    }
    const r = validateSettingsBody(patch)
    return r.ok ? null : r.error
  }, [cadenceInput, maxInput, attachSelect, paused])

  // Dirty check — Save disabled until something has actually changed.
  const dirty = useMemo(() => {
    if (paused !== pkg.reminders_paused) return true
    const wantCadence = parseCadenceInput(cadenceInput)
    const haveCadence = pkg.reminder_cadence_days
    if (JSON.stringify(wantCadence) !== JSON.stringify(haveCadence)) return true
    const wantMax = maxInput.trim() === "" ? null : Number(maxInput)
    if (wantMax !== pkg.reminder_max_count) return true
    const wantAttach = attachSelect === "inherit" ? null : attachSelect === "true"
    if (wantAttach !== pkg.reminder_attach_pdf) return true
    return false
  }, [cadenceInput, maxInput, attachSelect, paused, pkg])

  function revert() {
    setCadenceInput(pkg.reminder_cadence_days ? formatCadence(pkg.reminder_cadence_days) : "")
    setMaxInput(pkg.reminder_max_count != null ? String(pkg.reminder_max_count) : "")
    setAttachSelect(pkg.reminder_attach_pdf === null ? "inherit" : pkg.reminder_attach_pdf ? "true" : "false")
    setPaused(pkg.reminders_paused)
    setError(null)
    setSuccess(false)
  }

  async function save() {
    if (!builtPatch || !dirty) return
    setSaving(true); setError(null); setSuccess(false)
    try {
      const res = await fetch(saveEndpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(builtPatch),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(d.error ?? "Could not save settings")
        return
      }
      setSuccess(true)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error")
    } finally {
      setSaving(false)
    }
  }

  // ── Right-column observability ──────────────────────────────────────────
  const nextDueLabel: string = (() => {
    if (paused) return "Paused"
    if (!pkg.dispatched_at) return "Not yet dispatched"
    if (reminderSettings.sent_count >= reminderSettings.effective_max_reminders) {
      return "No more reminders (max reached)"
    }
    return reminderSettings.next_due_at ? fmtDate(reminderSettings.next_due_at) : "—"
  })()

  const sentLabel = `${reminderSettings.sent_count} / ${reminderSettings.effective_max_reminders}`

  // ── Pill in the section header — quick status at a glance ──────────────
  const headerPillLabel: string = paused
    ? "Paused"
    : reminderSettings.sent_count === 0
      ? "No reminders sent yet"
      : `${reminderSettings.sent_count} reminder${reminderSettings.sent_count === 1 ? "" : "s"} sent`
  const headerPillClass: string = paused
    ? "bg-amber-100 text-amber-700"
    : reminderSettings.sent_count > 0
      ? "bg-blue-100 text-blue-700"
      : "bg-[#F1F5F9] text-[#64748B]"

  return (
    <div className="rounded-xl border border-[#E2E8F0] bg-white overflow-clip">
      <div className="px-4 py-2.5 border-b border-[#E2E8F0] bg-[#F8F9FA] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <p className="text-[12px] font-bold text-[#0F172A]">Reminders</p>
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${headerPillClass}`}>
            {headerPillLabel}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5 p-4">
        {/* ── Left: configuration ────────────────────────────────────────── */}
        <div className="space-y-3">
          <div>
            <label className="block text-[11px] font-semibold text-[#0F172A] mb-1">
              Cadence (days after dispatch)
            </label>
            <input
              type="text"
              value={cadenceInput}
              onChange={(e) => setCadenceInput(e.target.value)}
              placeholder={`e.g. ${formatCadence(reminderSettings.effective_cadence)} (company default)`}
              className="w-full h-8 px-2 rounded border border-[#E2E8F0] text-[12px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]"
            />
            <p className="text-[11px] text-[#64748B] mt-1">
              Comma-separated, strictly ascending, each ≤ {MAX_CADENCE_DAY}. Leave blank to inherit.
            </p>
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-[#0F172A] mb-1">
              Max reminders
            </label>
            <input
              type="number"
              min={1}
              max={MAX_REMINDER_COUNT}
              value={maxInput}
              onChange={(e) => setMaxInput(e.target.value)}
              placeholder={`${reminderSettings.effective_max} (company default)`}
              className="w-32 h-8 px-2 rounded border border-[#E2E8F0] text-[12px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]"
            />
            <p className="text-[11px] text-[#64748B] mt-1">
              1–{MAX_REMINDER_COUNT}. Leave blank to inherit.
            </p>
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-[#0F172A] mb-1">
              Email content
            </label>
            <select
              value={attachSelect}
              onChange={(e) => setAttachSelect(e.target.value as "inherit" | "true" | "false")}
              className="w-full h-8 px-2 rounded border border-[#E2E8F0] bg-white text-[12px] text-[#0F172A] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]"
            >
              <option value="inherit">Inherit company default ({fmtBool(reminderSettings.effective_attach)})</option>
              <option value="false">Text only</option>
              <option value="true">Re-attach package PDF</option>
            </select>
          </div>

          <div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={paused}
                onChange={(e) => setPaused(e.target.checked)}
                className="h-4 w-4 rounded border-[#CBD5E1] text-amber-600 focus:ring-amber-500"
              />
              <span className="text-[12px] font-semibold text-[#0F172A]">
                Pause reminders for this package
              </span>
            </label>
            <p className="text-[11px] text-[#64748B] mt-1 ml-6">
              When paused, the daily cron skips this package entirely. No effect on already-sent reminders.
            </p>
          </div>

          {validationError && (
            <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-[12px] text-red-600">
              {validationError}
            </div>
          )}
          {error && (
            <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-[12px] text-red-600">
              {error}
            </div>
          )}
          {success && !dirty && (
            <div className="rounded-md bg-green-50 border border-green-200 px-3 py-2 text-[12px] text-green-700">
              Saved.
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={save}
              disabled={!dirty || saving || !builtPatch}
              className="h-8 px-3 rounded-md bg-[#7B9BB5] text-white text-[12px] font-semibold hover:bg-[#5A7A94] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              onClick={revert}
              disabled={!dirty || saving}
              className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[12px] font-semibold text-[#0F172A] hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Cancel
            </button>
          </div>
        </div>

        {/* ── Right: observability ───────────────────────────────────────── */}
        <div className="md:border-l md:border-[#E2E8F0] md:pl-5 space-y-3">
          <div>
            <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-1">Effective settings</p>
            <ul className="text-[12px] text-[#0F172A] space-y-1 tabular-nums">
              <li>
                <span className="text-[#64748B]">Cadence:</span>{" "}
                <span className="font-semibold">{formatCadence(reminderSettings.effective_cadence)}</span>{" "}
                {pkg.reminder_cadence_days === null && <span className="text-[10px] text-[#94A3B8]">(inherited)</span>}
              </li>
              <li>
                <span className="text-[#64748B]">Max:</span>{" "}
                <span className="font-semibold">{reminderSettings.effective_max}</span>{" "}
                {pkg.reminder_max_count === null && <span className="text-[10px] text-[#94A3B8]">(inherited)</span>}
              </li>
              <li>
                <span className="text-[#64748B]">Content:</span>{" "}
                <span className="font-semibold">{fmtBool(reminderSettings.effective_attach)}</span>{" "}
                {pkg.reminder_attach_pdf === null && <span className="text-[10px] text-[#94A3B8]">(inherited)</span>}
              </li>
            </ul>
          </div>

          <div>
            <p className="text-[10px] font-bold text-[#64748B] uppercase tracking-widest mb-1">Activity</p>
            <ul className="text-[12px] text-[#0F172A] space-y-1 tabular-nums">
              <li>
                <span className="text-[#64748B]">Sent so far:</span>{" "}
                <span className="font-semibold">{sentLabel}</span>
              </li>
              <li>
                <span className="text-[#64748B]">Last sent:</span>{" "}
                <span className="font-semibold">{reminderSettings.last_sent_at ? fmtDate(reminderSettings.last_sent_at) : "—"}</span>
              </li>
              <li>
                <span className="text-[#64748B]">Next due:</span>{" "}
                <span className={`font-semibold ${paused ? "text-amber-700" : ""}`}>{nextDueLabel}</span>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}
