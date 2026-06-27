"use client"

import { apiFetch } from "@/lib/api-client"
import { useEffect, useRef, useState } from "react"

// User's own signature image (Settings → Profile). Rendered on the PCO cover
// sheet next to the saving user's typed name/title (Phase 3/4). Stored at
// company-assets {company_id}/signatures/{user_id}.png and written through the
// SECURITY DEFINER set_my_signature() RPC — see /api/profile/signature.

export default function ProfileSignature() {
  const [signatureUrl, setSignatureUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Full name — appears as "Reviewed By" on submittal review stamps.
  const [fullName, setFullName] = useState("")
  const [savedName, setSavedName] = useState<string | null>(null)
  const [savingName, setSavingName] = useState(false)

  function flash(text: string, ok = true) {
    setMessage({ text, ok })
    setTimeout(() => setMessage(null), 3500)
  }

  useEffect(() => {
    apiFetch("/api/profile/signature")
      .then(r => r.json())
      .then((d: { signature_url?: string | null }) => setSignatureUrl(d.signature_url ?? null))
      .catch(() => {})
      .finally(() => setLoading(false))
    apiFetch("/api/profile")
      .then(r => r.json())
      .then((d: { full_name?: string | null }) => {
        setSavedName(d.full_name ?? null)
        setFullName(d.full_name ?? "")
      })
      .catch(() => {})
  }, [])

  async function handleSaveName() {
    const next = fullName.trim()
    if (!next) { flash("Name cannot be empty", false); return }
    setSavingName(true)
    try {
      const res = await apiFetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ full_name: next }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { flash(d.error ?? "Could not save name", false); return }
      setSavedName(d.full_name ?? next)
      setFullName(d.full_name ?? next)
      flash("Name saved")
    } finally {
      setSavingName(false)
    }
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setBusy(true)
    try {
      const form = new FormData()
      form.append("file", file)
      const res = await apiFetch("/api/profile/signature", { method: "POST", body: form })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { flash(d.error ?? "Upload failed", false); return }
      // Cache-bust so the <img> reloads even though the storage key is stable.
      setSignatureUrl(d.signature_url ? `${d.signature_url}${d.signature_url.includes("?") ? "&" : "?"}t=${Date.now()}` : null)
      flash("Signature updated")
    } finally {
      setBusy(false)
      e.target.value = ""
    }
  }

  async function handleRemove() {
    if (!window.confirm("Remove your signature?")) return
    setBusy(true)
    try {
      const res = await apiFetch("/api/profile/signature", { method: "DELETE" })
      if (!res.ok) { const d = await res.json().catch(() => ({})); flash(d.error ?? "Remove failed", false); return }
      setSignatureUrl(null)
      flash("Signature removed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-[#E2E8F0] p-5">
        <h2 className="text-[14px] font-semibold text-[#0F172A] mb-0.5">Full name</h2>
        <p className="text-[12px] text-[#64748B] mb-4">
          Appears as <span className="font-medium text-[#0F172A]">Reviewed By</span> on the review
          stamp of submittal cover sheets you generate.
        </p>
        <div className="flex items-center gap-2 max-w-md">
          <input
            type="text"
            value={fullName}
            onChange={e => setFullName(e.target.value)}
            maxLength={120}
            placeholder="e.g. Jane Smith"
            className="flex-1 h-9 px-3 rounded-md border border-[#E2E8F0] bg-white text-[13px] text-[#0F172A] placeholder-[#94A3B8] focus:outline-none focus:ring-1 focus:ring-[#7B9BB5]/40"
          />
          <button
            onClick={handleSaveName}
            disabled={savingName || fullName.trim() === (savedName ?? "")}
            className="h-9 px-4 rounded-md bg-[#7B9BB5] text-white text-[13px] font-semibold hover:bg-[#6A8AA4] transition-colors disabled:opacity-50"
          >
            {savingName ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-[#E2E8F0] p-5">
        <h2 className="text-[14px] font-semibold text-[#0F172A] mb-0.5">Signature</h2>
        <p className="text-[12px] text-[#64748B] mb-4">
          Appears on PCO cover sheets you create. Use a PNG with a transparent background for the
          cleanest result. PNG, JPG, or WebP under 2 MB.
        </p>

        {loading ? (
          <div className="text-[13px] text-[#64748B]">Loading…</div>
        ) : (
          <div className="flex items-center gap-4">
            <div className="w-48 h-20 rounded-lg border border-[#E2E8F0] bg-white flex items-center justify-center overflow-hidden flex-shrink-0">
              {signatureUrl ? (
                <img src={signatureUrl} alt="Signature" className="max-w-full max-h-full object-contain p-1" />
              ) : (
                <span className="text-[11px] text-[#94A3B8]">No signature</span>
              )}
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => inputRef.current?.click()}
                  disabled={busy}
                  className="h-8 px-4 rounded-md border border-[#E2E8F0] text-[13px] text-[#0F172A] hover:bg-[#F4F5F7] transition-colors disabled:opacity-50"
                >
                  {busy ? "Uploading…" : signatureUrl ? "Replace" : "Upload signature"}
                </button>
                {signatureUrl && !busy && (
                  <button
                    onClick={handleRemove}
                    className="h-8 px-3 rounded-md border border-[#E2E8F0] text-[13px] font-medium text-[#DC2626] hover:bg-red-50 transition-colors"
                  >
                    Remove
                  </button>
                )}
              </div>
              {signatureUrl && <p className="text-[11px] text-[#64748B]">Signature is active</p>}
            </div>
          </div>
        )}

        <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={handleFile} className="hidden" />

        {message && (
          <div className={`mt-4 rounded-md px-3 py-2 text-[12px] ${message.ok ? "bg-green-50 border border-green-200 text-green-700" : "bg-red-50 border border-red-200 text-red-600"}`}>
            {message.text}
          </div>
        )}
      </div>
    </div>
  )
}
