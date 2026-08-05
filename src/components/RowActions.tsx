"use client"

import React from "react"

export type RowAction = {
  label: string
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void
  variant?: "default" | "danger"
  disabled?: boolean
  title?: string
  /** Marks the row's primary action for keyboard-nav (Enter clicks [data-nav-primary]). */
  navPrimary?: boolean
}

// Row of text-link actions for list/table rows. Destructive action goes LAST
// in the actions array (caller's responsibility). Purely presentational.
export function RowActions({ actions, className }: { actions: RowAction[]; className?: string }) {
  if (actions.length === 0) return null
  return (
    <div className={`inline-flex items-center gap-2${className ? ` ${className}` : ""}`}>
      {actions.map((a, i) => (
        <button
          key={`${a.label}-${i}`}
          type="button"
          onClick={a.onClick}
          disabled={a.disabled}
          title={a.title}
          data-nav-primary={a.navPrimary || undefined}
          className={`text-xs font-medium whitespace-nowrap hover:underline disabled:opacity-50 disabled:no-underline disabled:cursor-default ${
            a.variant === "danger" ? "text-red-600" : "text-blue-600"
          }`}
        >
          {a.label}
        </button>
      ))}
    </div>
  )
}

export default RowActions
