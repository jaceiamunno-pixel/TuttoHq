"use client"

// Photo surfaces for the Daily Reports module (step 3c + 4i).
//
// DraftPhotoGrid  — composer: photos captured into the IDB draft (offline-
//                   first, pre-upload). Multi-select picker + direct camera
//                   capture, per-photo compression progress, remove.
// SavedPhotoGrid  — detail: server photos merged with IDB photos still
//                   pending sync. Per-photo status overlays, a Retry
//                   affordance for needs-attention photos, lightbox viewer,
//                   and (0050) inline caption edit.
//
// Both extend the existing photo pipeline (photo-compression-client,
// idb-photos, photo-sync) — nothing here forks the queue.

import { useEffect, useRef, useState } from "react"
import { DAILY_0050_LIVE } from "@/lib/daily-flags"
import type { DailyDraftPhotoRow } from "@/lib/idb-photos"
import { derivePhotoStatus, retryStuckPhoto } from "@/lib/photo-sync"
import { DraftPhotoThumb } from "@/components/photos/DraftPhotoThumb"
import { SpinnerIcon, XIcon } from "../../_shared/icons"
import { btnGhostCls } from "./ui"
import type { ServerPhoto } from "./types"

// ─── Composer: draft photos (pre-upload) ────────────────────────────────────

export function DraftPhotoGrid({ photos, compressProgress, error, onIngest, onRemove, canEdit }: {
  photos: DailyDraftPhotoRow[]
  compressProgress: { done: number; total: number } | null
  error: string
  onIngest: (files: File[]) => void
  onRemove?: (photoId: string) => void
  canEdit: boolean
}) {
  const pickRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<HTMLInputElement>(null)

  return (
    <div>
      {canEdit && (
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <button type="button" onClick={() => pickRef.current?.click()} disabled={!!compressProgress} className={btnGhostCls}>
            + Add Photos
          </button>
          <button type="button" onClick={() => cameraRef.current?.click()} disabled={!!compressProgress} className={btnGhostCls}>
            Take Photo
          </button>
          {photos.length > 0 && (
            <span className="text-[12px] text-[#64748B]">{photos.length} photo{photos.length !== 1 ? "s" : ""} stored locally</span>
          )}
        </div>
      )}
      <input ref={pickRef} type="file" accept="image/*" multiple className="hidden"
        onChange={e => {
          const files = Array.from(e.target.files || [])
          e.currentTarget.value = "" // allow re-picking the same file
          onIngest(files)
        }} />
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden"
        onChange={e => {
          const files = Array.from(e.target.files || [])
          e.currentTarget.value = ""
          onIngest(files)
        }} />
      {compressProgress && (
        <p className="text-[12px] text-[#64748B] mb-2 flex items-center gap-1.5">
          <SpinnerIcon className="h-3 w-3" /> Processing photo {Math.min(compressProgress.done + 1, compressProgress.total)} of {compressProgress.total}…
        </p>
      )}
      {photos.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {photos.map(p => (
            <div key={p.id} className="relative aspect-square rounded-md border border-[#E2E8F0] bg-[#F4F5F7] overflow-hidden">
              <DraftPhotoThumb blob={p.bytes} alt={p.filename} className="absolute inset-0 w-full h-full object-cover" />
              <div className="absolute inset-x-0 bottom-0 bg-black/45 text-white text-[10px] px-1.5 py-0.5 truncate">
                {p.filename} · {(p.bytes.size / 1024).toFixed(0)} KB
              </div>
              {canEdit && onRemove && (
                <button type="button" onClick={() => onRemove(p.id)}
                  aria-label={`Remove ${p.filename}`}
                  className="absolute top-1 right-1 h-7 w-7 rounded-full bg-black/55 text-white flex items-center justify-center hover:bg-red-600 transition-colors">
                  <XIcon className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {error && <p className="text-[12px] text-red-500 mt-2">{error}</p>}
    </div>
  )
}

// ─── Detail: saved photos (server + pending sync) ───────────────────────────

export function SavedPhotoGrid({ serverPhotos, idbPhotos, inFlightIds, loading, uploading, canEdit, onAdd, onDelete, onCaption }: {
  serverPhotos: ServerPhoto[]
  idbPhotos: DailyDraftPhotoRow[]
  inFlightIds: ReadonlySet<string>
  loading: boolean
  uploading: boolean
  canEdit: boolean
  onAdd: (files: File[]) => void
  onDelete: (photoId: string) => void
  onCaption?: (photoId: string, caption: string) => void
}) {
  const addRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<HTMLInputElement>(null)
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null)
  const [editingCaption, setEditingCaption] = useState<string | null>(null) // photo id
  const [retrying, setRetrying] = useState<Set<string>>(() => new Set())

  // Server rows use the same id as their IDB origin row (upsert on
  // client_id), so exact-key dedupe removes the transient double-render.
  const serverIds = new Set(serverPhotos.map(p => p.id))
  const pendingIdb = idbPhotos.filter(p => !serverIds.has(p.id))
  const total = serverPhotos.length + pendingIdb.length

  async function retry(photoId: string) {
    setRetrying(prev => new Set(prev).add(photoId))
    try { await retryStuckPhoto(photoId) } finally {
      setRetrying(prev => { const next = new Set(prev); next.delete(photoId); return next })
    }
  }

  const captionsOn = DAILY_0050_LIVE && !!onCaption

  return (
    <div>
      <div className="flex items-center justify-between mb-2 gap-2">
        <span className="text-[11px] font-bold text-[#64748B] uppercase tracking-widest">
          Photos{total > 0 ? ` (${total})` : ""}
        </span>
        {canEdit && (
          <div className="flex items-center gap-1.5">
            <button type="button" onClick={() => addRef.current?.click()} disabled={uploading}
              className="h-9 sm:h-7 px-3 rounded-md border border-[#E2E8F0] text-[12px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50 flex items-center gap-1.5">
              {uploading ? <><SpinnerIcon className="h-3 w-3" /> Adding…</> : "+ Add"}
            </button>
            <button type="button" onClick={() => cameraRef.current?.click()} disabled={uploading}
              className="h-9 sm:h-7 px-3 rounded-md border border-[#E2E8F0] text-[12px] text-[#64748B] hover:bg-[#0F172A]/[0.04] transition-colors disabled:opacity-50 sm:hidden">
              Camera
            </button>
          </div>
        )}
        <input ref={addRef} type="file" accept="image/*" multiple className="hidden"
          onChange={e => { const files = Array.from(e.target.files || []); e.currentTarget.value = ""; if (files.length) onAdd(files) }} />
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden"
          onChange={e => { const files = Array.from(e.target.files || []); e.currentTarget.value = ""; if (files.length) onAdd(files) }} />
      </div>

      {loading && serverPhotos.length === 0 && pendingIdb.length === 0 ? (
        <div className="flex justify-center py-3"><SpinnerIcon className="h-4 w-4 text-[#64748B]" /></div>
      ) : total === 0 ? (
        <p className="text-[12px] text-[#64748B] italic">No photos yet{canEdit ? " — tap “+ Add” to capture or upload" : ""}</p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {serverPhotos.map((ph, i) => (
            <div key={`srv:${ph.id}`} className="group">
              <div className="relative aspect-square rounded-md overflow-hidden border border-[#E2E8F0] bg-[#F4F5F7]">
                <img src={ph.url} alt={ph.caption || ph.file_name || ""} loading="lazy"
                  className="w-full h-full object-cover cursor-pointer" onClick={() => setLightboxIdx(i)} />
                {canEdit && (
                  <button onClick={() => onDelete(ph.id)}
                    aria-label="Delete photo"
                    className="absolute top-1 right-1 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity h-7 w-7 sm:h-6 sm:w-6 rounded-full bg-red-500 text-white text-[11px] flex items-center justify-center shadow">
                    ✕
                  </button>
                )}
              </div>
              {captionsOn && (
                editingCaption === ph.id ? (
                  <input autoFocus type="text" defaultValue={ph.caption ?? ""}
                    className="mt-1 w-full h-8 px-2 rounded border border-[#7B9BB5]/50 text-[11px] text-[#0F172A] focus:outline-none"
                    placeholder="Add caption…"
                    onBlur={e => { onCaption!(ph.id, e.target.value.trim()); setEditingCaption(null) }}
                    onKeyDown={e => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur()
                      if (e.key === "Escape") setEditingCaption(null)
                    }} />
                ) : (
                  <button type="button" disabled={!canEdit}
                    onClick={() => canEdit && setEditingCaption(ph.id)}
                    className={`mt-1 w-full text-left text-[11px] truncate px-0.5 ${ph.caption ? "text-[#0F172A]" : "text-[#64748B] italic"} ${canEdit ? "hover:text-[#7B9BB5]" : ""}`}>
                    {ph.caption || (canEdit ? "Add caption…" : "")}
                  </button>
                )
              )}
            </div>
          ))}
          {pendingIdb.map(ph => {
            const status = retrying.has(ph.id) ? "uploading" : derivePhotoStatus(ph, inFlightIds)
            const overlay = status === "uploading"
              ? { bg: "bg-amber-500/90", label: "Uploading…", icon: <SpinnerIcon className="h-3 w-3" /> }
              : status === "needs_attention"
              ? { bg: "bg-red-600/90", label: "Failed", icon: null }
              : { bg: "bg-slate-600/85", label: "Waiting", icon: null }
            return (
              <div key={`idb:${ph.id}`} className={`relative aspect-square rounded-md overflow-hidden border bg-[#F4F5F7] ${status === "needs_attention" ? "border-red-300" : "border-[#E2E8F0]"}`}>
                <DraftPhotoThumb blob={ph.bytes} alt={ph.filename} className="w-full h-full object-cover" />
                <div className={`absolute inset-x-0 bottom-0 ${overlay.bg} text-white text-[10px] font-semibold px-1.5 py-0.5 flex items-center justify-center gap-1`}>
                  {overlay.icon} {overlay.label}
                </div>
                {status === "needs_attention" && (
                  <button type="button" onClick={() => retry(ph.id)}
                    className="absolute inset-0 flex items-center justify-center bg-black/35">
                    <span className="px-3 py-1.5 rounded-md bg-white text-[12px] font-semibold text-[#0F172A] shadow">↻ Retry</span>
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {lightboxIdx != null && serverPhotos[lightboxIdx] && (
        <Lightbox
          photos={serverPhotos}
          index={lightboxIdx}
          onIndex={setLightboxIdx}
          onClose={() => setLightboxIdx(null)}
          canEdit={canEdit && captionsOn}
          onCaption={onCaption}
        />
      )}
    </div>
  )
}

// ─── Lightbox ───────────────────────────────────────────────────────────────

function Lightbox({ photos, index, onIndex, onClose, canEdit, onCaption }: {
  photos: ServerPhoto[]
  index: number
  onIndex: (i: number) => void
  onClose: () => void
  canEdit: boolean
  onCaption?: (photoId: string, caption: string) => void
}) {
  const photo = photos[index]
  const [editing, setEditing] = useState(false)

  useEffect(() => { setEditing(false) }, [index])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) {
        if (e.key === "Escape") { e.stopPropagation() }
        return
      }
      if (e.key === "Escape") { e.preventDefault(); onClose() }
      else if (e.key === "ArrowRight" && index < photos.length - 1) { e.preventDefault(); onIndex(index + 1) }
      else if (e.key === "ArrowLeft" && index > 0) { e.preventDefault(); onIndex(index - 1) }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [index, photos.length, onClose, onIndex])

  return (
    <div data-daily-lightbox className="fixed inset-0 z-[70] bg-black/90 flex flex-col" onClick={onClose}>
      <div className="flex items-center justify-between px-4 py-3 flex-shrink-0" onClick={e => e.stopPropagation()}>
        <span className="text-[12px] text-white/70 tabular-nums">{index + 1} / {photos.length}</span>
        <button onClick={onClose} aria-label="Close viewer"
          className="h-9 w-9 rounded-full text-white/80 hover:text-white hover:bg-white/10 flex items-center justify-center transition-colors">
          <XIcon className="h-5 w-5" />
        </button>
      </div>
      <div className="flex-1 min-h-0 flex items-center justify-center px-2 relative">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={photo.url} alt={photo.caption || photo.file_name || ""}
          className="max-h-full max-w-full object-contain" onClick={e => e.stopPropagation()} />
        {index > 0 && (
          <button onClick={e => { e.stopPropagation(); onIndex(index - 1) }} aria-label="Previous photo"
            className="absolute left-2 top-1/2 -translate-y-1/2 h-11 w-11 rounded-full bg-black/50 text-white text-xl flex items-center justify-center hover:bg-black/70 transition-colors">‹</button>
        )}
        {index < photos.length - 1 && (
          <button onClick={e => { e.stopPropagation(); onIndex(index + 1) }} aria-label="Next photo"
            className="absolute right-2 top-1/2 -translate-y-1/2 h-11 w-11 rounded-full bg-black/50 text-white text-xl flex items-center justify-center hover:bg-black/70 transition-colors">›</button>
        )}
      </div>
      <div className="flex-shrink-0 px-4 py-3 min-h-[52px]" onClick={e => e.stopPropagation()}>
        {editing && onCaption ? (
          <input autoFocus type="text" defaultValue={photo.caption ?? ""}
            placeholder="Add caption…"
            className="w-full max-w-xl mx-auto block h-10 px-3 rounded-md bg-white/10 border border-white/25 text-[13px] text-white placeholder:text-white/40 focus:outline-none focus:border-white/60"
            onBlur={e => { onCaption(photo.id, e.target.value.trim()); setEditing(false) }}
            onKeyDown={e => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur()
              if (e.key === "Escape") setEditing(false)
            }} />
        ) : (
          <button type="button" disabled={!canEdit} onClick={() => canEdit && setEditing(true)}
            className={`w-full text-center text-[13px] ${photo.caption ? "text-white" : "text-white/45 italic"} ${canEdit ? "hover:text-white" : "cursor-default"}`}>
            {photo.caption || (canEdit ? "Add caption…" : photo.file_name || "")}
          </button>
        )}
      </div>
    </div>
  )
}
