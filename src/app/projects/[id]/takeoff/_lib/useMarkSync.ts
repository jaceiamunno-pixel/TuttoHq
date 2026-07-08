"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import * as api from "./api"
import type { MarkKind, Pt, TakeoffMark } from "./types"

// ── Optimistic count-mark sync ────────────────────────────────────────────────
// V1 blocked the UI on every dot: one serial POST per placement inside a busy
// gate, so 50 fixtures = 50 sequential saves with the sheet frozen between each.
//
// This hook makes placement INSTANT and the network invisible. A placed mark
// lands in local state immediately (status "new") and is queued into an outbox;
// a debounced background flush drains the outbox through the SAME single-row
// /api/takeoffs/:id/marks POST (no new endpoint, no new column) at bounded
// concurrency, then reconciles the server id back onto the local mark.
//
// GUARANTEE — no lost marks:
//   • A failed save keeps its mark in the outbox and flips it to "error"; the
//     flush auto-retries (and `retry()` forces one). Nothing is dropped.
//   • The browser is warned (via `syncing`) before unload while anything is
//     unsent, so a close mid-flush can't silently drop counts.
//   • Switching takeoffs does NOT abandon in-flight saves: each op carries the
//     takeoff it belongs to, so it still lands on the right takeoff after a
//     switch (its reconcile just no-ops against the now-unmounted marks and the
//     row reappears on reload).
//
// Deletes of already-saved marks queue the same single-row DELETE. Deleting a
// mark that never reached the server just drops it from the outbox (no request);
// deleting one that's mid-flight defers the delete until its create lands (so we
// never orphan a row). Tag/room deletes cascade server-side, so prune only has
// to forget the local/queued children — never re-issue a delete.

export type MarkSyncState = "new" | "saving" | "error" | "clean"

/** A mark in the UI. `_key` is a stable client handle (never changes, even after
 *  the server id arrives) — used as the React key and the delete/undo handle so
 *  the temp→real id swap never remounts a dot or breaks undo. */
export interface LocalMark extends TakeoffMark {
  _key: string
  _sync: MarkSyncState
}

export interface NewMarkInput {
  tag_id: string
  room_id: string
  source_ref: string | null
  page: number
  x: number
  y: number
  kind: MarkKind
  points: Pt[] | null
  raw_measure: number | null
}

type UndoAction =
  | { type: "place"; key: string }
  | { type: "remove"; input: NewMarkInput }

const FLUSH_MS = 250    // debounce a burst of placements into one flush pass
const RETRY_MS = 5000   // auto-retry a failed save/delete after this delay
const CONCURRENCY = 5   // max in-flight requests (creates + deletes each)
const UNDO_LIMIT = 100

export interface MarkSync {
  marks: LocalMark[]
  place: (input: NewMarkInput) => void
  remove: (key: string) => void
  undo: () => void
  canUndo: boolean
  /** Unsaved creates (new + saving + error). */
  pendingCount: number
  /** Creates whose last save attempt failed. */
  failedCount: number
  /** Anything queued or in flight (creates OR deletes) — drives the unload guard. */
  syncing: boolean
  retry: () => void
  /** Load a takeoff's saved marks; sets the takeoff future ops belong to. */
  reset: (marks: TakeoffMark[], takeoffId: string | null) => void
  pruneByTag: (tagId: string) => void
  pruneByRoom: (roomId: string) => void
}

const toInput = (m: LocalMark): NewMarkInput => ({
  tag_id: m.tag_id, room_id: m.room_id, source_ref: m.source_ref, page: m.page, x: m.x, y: m.y,
  kind: m.kind, points: m.points, raw_measure: m.raw_measure,
})

export function useMarkSync(): MarkSync {
  const [marks, setMarks] = useState<LocalMark[]>([])
  const [canUndo, setCanUndo] = useState(false)
  const [, forceRender] = useState(0) // re-render when ref-held queues change

  const marksRef = useRef<LocalMark[]>([])
  marksRef.current = marks

  const takeoffIdRef = useRef<string | null>(null)
  const keySeq = useRef(0)

  // Outbox — held in refs so the async flush reads live state without stale
  // closures and without forcing a render per mutation.
  const createQ = useRef(new Map<string, { input: NewMarkInput; takeoffId: string }>())
  const saving = useRef(new Set<string>())         // _keys with a POST in flight
  const dropAfterSave = useRef(new Set<string>())  // removed/pruned mid-flight → delete once it lands
  const deleteQ = useRef(new Map<string, string>())// realId → takeoffId
  const deleting = useRef(new Set<string>())       // realIds with a DELETE in flight

  const undoStack = useRef<UndoAction[]>([])
  const flushTimer = useRef<number | null>(null)
  const flushRef = useRef<() => void>(() => {})

  const bump = useCallback(() => forceRender(n => n + 1), [])

  const scheduleFlush = useCallback((delay: number = FLUSH_MS) => {
    if (flushTimer.current != null) return
    flushTimer.current = window.setTimeout(() => {
      flushTimer.current = null
      flushRef.current()
    }, delay)
  }, [])

  const enqueueDelete = useCallback((realId: string, takeoffId: string) => {
    deleteQ.current.set(realId, takeoffId)
    bump()
    scheduleFlush(0)
  }, [bump, scheduleFlush])

  // Drain the outbox at bounded concurrency. Re-pumps itself on every settle.
  const flush = useCallback(() => {
    for (const [key, op] of createQ.current) {
      if (saving.current.size >= CONCURRENCY) break
      if (saving.current.has(key)) continue
      saving.current.add(key)
      setMarks(prev => prev.map(m => (m._key === key ? { ...m, _sync: "saving" } : m)))
      api.createMark(op.takeoffId, op.input).then(saved => {
        saving.current.delete(key)
        createQ.current.delete(key)
        if (dropAfterSave.current.has(key)) {
          // Removed/pruned while this save was in flight → clean up the row.
          dropAfterSave.current.delete(key)
          enqueueDelete(saved.id, op.takeoffId)
        } else {
          setMarks(prev => prev.map(m => (m._key === key ? { ...m, id: saved.id, _sync: "clean" } : m)))
        }
        bump()
        scheduleFlush(0)
      }).catch(() => {
        saving.current.delete(key)
        if (dropAfterSave.current.has(key)) {
          // It was already removed/pruned and never landed — forget it.
          dropAfterSave.current.delete(key)
          createQ.current.delete(key)
        } else {
          setMarks(prev => prev.map(m => (m._key === key ? { ...m, _sync: "error" } : m)))
          // stays in createQ for the retry pass
        }
        bump()
        scheduleFlush(RETRY_MS)
      })
    }
    for (const [realId, tkId] of deleteQ.current) {
      if (deleting.current.size >= CONCURRENCY) break
      if (deleting.current.has(realId)) continue
      deleting.current.add(realId)
      api.deleteMark(tkId, realId).then(() => {
        deleting.current.delete(realId)
        deleteQ.current.delete(realId)
        bump()
        scheduleFlush(0)
      }).catch(() => {
        deleting.current.delete(realId)
        // stays in deleteQ for the retry pass
        bump()
        scheduleFlush(RETRY_MS)
      })
    }
  }, [bump, enqueueDelete, scheduleFlush])
  useEffect(() => { flushRef.current = flush }, [flush])

  const pushUndo = useCallback((a: UndoAction) => {
    undoStack.current.push(a)
    if (undoStack.current.length > UNDO_LIMIT) undoStack.current.shift()
    setCanUndo(true)
  }, [])

  const placeInternal = useCallback((input: NewMarkInput, record: boolean) => {
    const takeoffId = takeoffIdRef.current
    if (!takeoffId) return
    const key = `k${++keySeq.current}`
    const local: LocalMark = { _key: key, _sync: "new", id: key, takeoff_id: takeoffId, ...input }
    setMarks(prev => [...prev, local])
    createQ.current.set(key, { input, takeoffId })
    if (record) pushUndo({ type: "place", key })
    bump()
    scheduleFlush()
  }, [bump, pushUndo, scheduleFlush])

  const removeInternal = useCallback((key: string, record: boolean) => {
    const target = marksRef.current.find(m => m._key === key)
    if (!target) return
    setMarks(prev => prev.filter(m => m._key !== key))
    if (record) pushUndo({ type: "remove", input: toInput(target) })
    if (target._sync === "clean") {
      enqueueDelete(target.id, target.takeoff_id) // real server id → queue delete
    } else if (saving.current.has(key)) {
      dropAfterSave.current.add(key)              // in flight → delete once it lands
    } else {
      createQ.current.delete(key)                 // never sent → just forget it
    }
    bump()
  }, [bump, enqueueDelete, pushUndo])

  const place = useCallback((input: NewMarkInput) => placeInternal(input, true), [placeInternal])
  const remove = useCallback((key: string) => removeInternal(key, true), [removeInternal])

  const undo = useCallback(() => {
    const action = undoStack.current.pop()
    setCanUndo(undoStack.current.length > 0)
    if (!action) return
    if (action.type === "place") removeInternal(action.key, false)
    else placeInternal(action.input, false)
  }, [placeInternal, removeInternal])

  const retry = useCallback(() => {
    setMarks(prev => prev.map(m => (m._sync === "error" ? { ...m, _sync: "new" } : m)))
    scheduleFlush(0)
  }, [scheduleFlush])

  const reset = useCallback((rows: TakeoffMark[], takeoffId: string | null) => {
    // In-flight/queued ops from the previous takeoff are intentionally left to
    // drain (they carry their own takeoffId), so a switch never drops counts.
    takeoffIdRef.current = takeoffId
    undoStack.current = []
    setCanUndo(false)
    setMarks(rows.map(r => ({ ...r, _key: `k${++keySeq.current}`, _sync: "clean" as const })))
    bump()
  }, [bump])

  // Tag/room deletion cascades server-side; here we only forget the local +
  // queued children so we never re-issue a delete for a cascaded row.
  const pruneBy = useCallback((pred: (m: LocalMark) => boolean) => {
    const victims = marksRef.current.filter(pred)
    if (victims.length === 0) return
    setMarks(prev => prev.filter(m => !pred(m)))
    for (const m of victims) {
      if (m._sync === "clean") {
        /* already on the server; cascade handles it */
      } else if (saving.current.has(m._key)) {
        dropAfterSave.current.add(m._key)
      } else {
        createQ.current.delete(m._key)
      }
    }
    bump()
  }, [bump])
  const pruneByTag = useCallback((tagId: string) => pruneBy(m => m.tag_id === tagId), [pruneBy])
  const pruneByRoom = useCallback((roomId: string) => pruneBy(m => m.room_id === roomId), [pruneBy])

  useEffect(() => () => { if (flushTimer.current != null) clearTimeout(flushTimer.current) }, [])

  const pendingCount = marks.reduce((n, m) => n + (m._sync !== "clean" ? 1 : 0), 0)
  const failedCount = marks.reduce((n, m) => n + (m._sync === "error" ? 1 : 0), 0)
  // Include the raw queues so the unload guard still fires for creates left
  // in flight when the user switched takeoffs (those marks are gone from `marks`).
  const syncing = pendingCount > 0
    || createQ.current.size > 0 || saving.current.size > 0
    || deleteQ.current.size > 0 || deleting.current.size > 0

  return {
    marks, place, remove, undo, canUndo,
    pendingCount, failedCount, syncing, retry,
    reset, pruneByTag, pruneByRoom,
  }
}
