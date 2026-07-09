"use client"

import { useCallback, useEffect, useRef, useState } from "react"

/**
 * Shared "pending destructive action with undo" mechanism.
 *
 * The product model is DEFERRED destruction, never delete-then-reverse: the
 * `onCommit` callback (the actual API/DELETE call) does NOT fire until the undo
 * window closes. Undo simply cancels the pending call — nothing is ever
 * destroyed and re-created. During the window the caller keeps the row visible
 * but "marked" (dimmed + "Undo"), deriving that state from `isPending(key)`.
 *
 * Lifecycle: timers live in a ref and are cleared on unmount, so a component
 * that unmounts (navigation, tab close) never fires its pending commit — a
 * closed tab means "didn't happen". Because of that, this is a HOOK you call
 * inside the component that owns the action, not an app-root provider (a root
 * provider would never unmount on in-app navigation and would defeat the
 * navigate-away-cancels contract).
 *
 * Usage:
 *   const pending = usePendingAction()
 *   pending.schedule({ key, onCommit, onError })
 *   pending.cancel(key)              // Undo
 *   pending.isPending(key)           // derive the row's "marked" state
 *   pending.pending                  // render a toast per entry
 */

export type PendingActionInput = {
  /** Stable unique id for the thing being destroyed (e.g. `att:${id}`). */
  key: string
  /** Toast label shown during the window. Defaults to "Deleting…". */
  label?: string
  /** Undo window in ms. Defaults to 8000. */
  delayMs?: number
  /** The deferred destructive call. Runs only when the window closes. */
  onCommit: () => Promise<void>
  /** Optional side-effect when the user hits Undo (or the action is cancelled). */
  onUndo?: () => void
  /**
   * Called if `onCommit` rejects. The row is already un-marked by the time this
   * runs (the destruction did not happen), so callers use this only to surface
   * the error.
   */
  onError?: (error: unknown) => void
}

export type PendingItem = { key: string; label: string }

export const PENDING_ACTION_DEFAULT_DELAY_MS = 8000

type Entry = { timer: ReturnType<typeof setTimeout>; onUndo?: () => void }

export function usePendingAction() {
  // Live timers + undo callbacks, keyed. Kept in a ref (not state) so a
  // re-render never drops a timer and unmount cleanup can clear them
  // synchronously.
  const entriesRef = useRef<Map<string, Entry>>(new Map())
  // Reactive mirror of the currently-waiting keys — the single source of truth
  // for `isPending` and the toast stack. The list's data model is NOT touched.
  const [pending, setPending] = useState<PendingItem[]>([])

  const schedule = useCallback((input: PendingActionInput) => {
    const {
      key,
      label = "Deleting…",
      delayMs = PENDING_ACTION_DEFAULT_DELAY_MS,
      onCommit,
      onUndo,
      onError,
    } = input

    // Replace any in-flight action for the same key — never double-fire.
    const existing = entriesRef.current.get(key)
    if (existing) clearTimeout(existing.timer)

    const timer = setTimeout(() => {
      // Consume the entry and un-mark the row BEFORE the destructive call runs:
      // once the window closes the action is no longer undoable, and on failure
      // the row is already restored to normal (destruction did not happen).
      entriesRef.current.delete(key)
      setPending(prev => prev.filter(p => p.key !== key))
      Promise.resolve()
        .then(onCommit)
        .catch(err => { onError?.(err) })
    }, delayMs)

    entriesRef.current.set(key, { timer, onUndo })
    setPending(prev => [...prev.filter(p => p.key !== key), { key, label }])
  }, [])

  const cancel = useCallback((key: string) => {
    const entry = entriesRef.current.get(key)
    if (!entry) return
    clearTimeout(entry.timer)
    entriesRef.current.delete(key)
    setPending(prev => prev.filter(p => p.key !== key))
    entry.onUndo?.()
  }, [])

  // Derived from render state so rows re-render as pending changes.
  const isPending = useCallback(
    (key: string) => pending.some(p => p.key === key),
    [pending],
  )

  // Unmount → cancel every pending action (timers cleared, commits never run).
  useEffect(() => {
    const map = entriesRef.current
    return () => {
      map.forEach(e => clearTimeout(e.timer))
      map.clear()
    }
  }, [])

  return { schedule, cancel, isPending, pending }
}
