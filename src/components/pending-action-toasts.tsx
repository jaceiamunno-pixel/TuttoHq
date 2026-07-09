"use client"

import type { PendingItem } from "@/hooks/usePendingAction"

/**
 * Toast stack for pending destructive actions (see `usePendingAction`). Each
 * entry shows its label + a working Undo. Multiple pending actions stack — they
 * never overwrite each other. Renders nothing when idle.
 */
export function PendingActionToasts({
  items,
  onUndo,
}: {
  items: PendingItem[]
  onUndo: (key: string) => void
}) {
  if (items.length === 0) return null
  return (
    <div
      className="fixed bottom-4 right-4 z-[80] flex flex-col gap-2"
      role="status"
      aria-live="polite"
    >
      {items.map(item => (
        <div
          key={item.key}
          className="flex items-center gap-3 rounded-lg bg-[#0F172A] text-white shadow-lg ring-1 ring-white/10 px-4 py-2.5 min-w-[240px]"
        >
          <svg
            className="h-4 w-4 flex-shrink-0 animate-spin text-white/60"
            fill="none"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z" />
          </svg>
          <span className="flex-1 text-[12px] leading-tight">{item.label}</span>
          <button
            type="button"
            onClick={() => onUndo(item.key)}
            className="text-[12px] font-semibold text-[#7DD3FC] hover:text-white underline underline-offset-2 transition-colors"
          >
            Undo
          </button>
        </div>
      ))}
    </div>
  )
}
