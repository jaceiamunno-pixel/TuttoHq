"use client"

import { useCallback, useEffect, useState } from "react"

// Per-user project favorites.
//
// Stored in localStorage keyed by the signed-in user's email so a shared
// browser keeps each user's favorites separate (PER-USER, not company-wide).
// The favorited ids are only ever sorted/rendered against the company-scoped
// project list returned by /api/projects (RLS-enforced server-side), so a
// stored id can never surface a project outside the user's own company —
// there is no cross-user or cross-tenant read path here.
//
// This was wired into the old single-shell ProjectSelector before the ADR-006
// project-first redesign dropped that shell; it lived in localStorage then too.

function storageKey(userEmail: string) {
  return `tuttohq:project-favorites:${userEmail}`
}

export function useProjectFavorites(userEmail: string | null) {
  const [favorites, setFavorites] = useState<Set<string>>(new Set())

  // Hydrate once the signed-in user is known; reset to empty when signed out.
  useEffect(() => {
    if (typeof window === "undefined" || !userEmail) {
      setFavorites(new Set())
      return
    }
    try {
      const raw = window.localStorage.getItem(storageKey(userEmail))
      setFavorites(raw ? new Set(JSON.parse(raw) as string[]) : new Set())
    } catch {
      setFavorites(new Set())
    }
  }, [userEmail])

  const toggleFavorite = useCallback((id: string) => {
    if (!userEmail) return
    setFavorites(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      try {
        window.localStorage.setItem(storageKey(userEmail), JSON.stringify([...next]))
      } catch {
        /* ignore quota */
      }
      return next
    })
  }, [userEmail])

  return { favorites, toggleFavorite }
}

// Floats favorited projects to the top, preserving server order within each
// group (Array.prototype.sort is stable).
export function sortByFavorite<T extends { id: string }>(items: T[], favorites: Set<string>): T[] {
  return items.slice().sort((a, b) => (favorites.has(a.id) ? 0 : 1) - (favorites.has(b.id) ? 0 : 1))
}
