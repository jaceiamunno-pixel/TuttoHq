"use client"

// ─────────────────────────────────────────────────────────────────────────────
// Global keyboard-navigation layer (Part 1 of N).
//
// A single provider, mounted once at the app shell, owns ALL arrow-key / region
// navigation for the whole site. Surfaces opt in by calling `useNavRegion` —
// they do NOT write their own onKeyDown. Region registration is route-aware: a
// region registers when its container mounts and unregisters when it unmounts
// (callback ref), so the live region map follows the live route. Nothing about
// today's IA is hard-coded here (the ADR-006 migration is still in flight).
//
// Navigation is built on REAL DOM focus + roving tabindex, never a parallel
// "selectedIndex" in the consumer: whatever the browser reports as the focused
// element IS the selection. That is what makes Enter/Escape and future
// screen-reader support work without rework.
//
// Keys — active only when focus is NOT inside an editable/combobox context and
// NO modal trap is open:
//   ArrowUp / ArrowDown  move focus between items in the active region
//   ArrowRight           step INTO the focused item (e.g. open its detail view)
//   ArrowLeft            step OUT / back
//   Enter                activate the focused item
//   [  /  ]              jump to the previous / next top-level region
//   Tab / Shift-Tab      mirror [ / ] when focus is already inside a region
//   Escape               closes the active modal trap (see useFocusTrap)
//
// The #1 rule: YIELD to native controls. When focus is in an <input>,
// <textarea>, <select>, [contenteditable], or any element marked
// [data-nav-yield] / role=combobox|listbox (the VendorCell picker mid-search),
// the handler stands fully down — arrows move the cursor / options, and "[" "]"
// type normally.
// ─────────────────────────────────────────────────────────────────────────────

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef,
  type ReactNode, type RefObject,
} from "react"

// ── Public API surface a Part-2 surface registers against ────────────────────
//
// A region's behaviour is supplied as plain handler props. They are read live
// (through a ref) so a surface can close over fresh state without re-registering.
export interface NavRegionHandlers {
  /** Sort key for [ / ] and Tab/Shift-Tab ordering between regions. Default 0. */
  order?: number
  /** Selector for navigable items inside the region. Default "[data-nav-item]". */
  itemSelector?: string
  /** Enter on the focused item. Default: click its [data-nav-primary] child. */
  onActivate?: (item: HTMLElement) => void
  /** ArrowRight on the focused item. Default: click its [data-nav-primary] child. */
  onStepInto?: (item: HTMLElement) => void
  /** ArrowLeft on the focused item. Default: no-op. */
  onStepOut?: (item: HTMLElement) => void
}

// ── Internal registry shapes ─────────────────────────────────────────────────
interface RegionEntry {
  id: string
  el: HTMLElement
  handlers: RefObject<NavRegionHandlers>
  /** Last item focused inside this region — the roving "cursor", DOM-anchored. */
  lastItem: HTMLElement | null
}

interface TrapEntry {
  getEl: () => HTMLElement | null
  onEscape: () => void
}

interface KeyboardNavApi {
  registerRegion: (entry: RegionEntry) => () => void
  pushTrap: (entry: TrapEntry) => () => void
}

const KeyboardNavContext = createContext<KeyboardNavApi | null>(null)

function useKeyboardNav(): KeyboardNavApi {
  const v = useContext(KeyboardNavContext)
  if (!v) throw new Error("keyboard-nav hooks must be used inside <KeyboardNavProvider>")
  return v
}

// ── DOM helpers (module scope; shared by provider + hooks) ───────────────────
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",")

const EDITABLE_ROLES = new Set([
  "combobox", "listbox", "option", "menu", "menuitem",
  "textbox", "searchbox", "spinbutton", "slider",
])

function isVisible(el: HTMLElement): boolean {
  return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
}

function focusables(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isVisible)
}

/**
 * The yield check — the crux of "stand down for native controls". Returns true
 * when the global handler must not act so arrows/[/]/Enter behave natively.
 */
export function isEditableContext(el: Element | null): boolean {
  if (!el) return false
  const node = el as HTMLElement
  const tag = node.tagName
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true
  if (node.isContentEditable) return true
  // Explicit opt-out marker any custom combobox/picker can set on its open root
  // (the VendorCell dropdown uses this so option navigation also yields).
  if (node.closest("[data-nav-yield]")) return true
  const role = node.getAttribute("role")
  if (role && EDITABLE_ROLES.has(role)) return true
  // A focused control that currently owns an expanded popup.
  if (node.getAttribute("aria-expanded") === "true") return true
  return false
}

function itemSelectorOf(r: RegionEntry): string {
  return r.handlers.current.itemSelector ?? "[data-nav-item]"
}

function itemsOf(r: RegionEntry): HTMLElement[] {
  return Array.from(r.el.querySelectorAll<HTMLElement>(itemSelectorOf(r))).filter(isVisible)
}

function closestItem(node: Element | null, r: RegionEntry): HTMLElement | null {
  if (!node) return null
  const found = (node as HTMLElement).closest<HTMLElement>(itemSelectorOf(r))
  return found && r.el.contains(found) ? found : null
}

/** Keep exactly one item tabbable (tabindex 0) so native Tab can reach it. */
function normalizeTabindex(r: RegionEntry): void {
  const items = itemsOf(r)
  if (!items.length) return
  const tabbable = r.lastItem && items.includes(r.lastItem) ? r.lastItem : items[0]
  for (const it of items) it.tabIndex = it === tabbable ? 0 : -1
}

function focusItem(r: RegionEntry, item: HTMLElement): void {
  r.lastItem = item
  for (const it of itemsOf(r)) it.tabIndex = it === item ? 0 : -1
  item.focus()
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider — mount ONCE at the app shell. Owns the single document-level
// keydown listener, the live region registry, and the modal-trap stack.
// ─────────────────────────────────────────────────────────────────────────────
export function KeyboardNavProvider({ children }: { children: ReactNode }) {
  const regionsRef = useRef<Map<string, RegionEntry>>(new Map())
  const trapsRef = useRef<TrapEntry[]>([])

  const registerRegion = useCallback((entry: RegionEntry) => {
    regionsRef.current.set(entry.id, entry)
    return () => {
      // Only drop it if the same entry is still registered (mount/unmount races).
      if (regionsRef.current.get(entry.id) === entry) regionsRef.current.delete(entry.id)
    }
  }, [])

  const pushTrap = useCallback((entry: TrapEntry) => {
    trapsRef.current.push(entry)
    return () => {
      const i = trapsRef.current.indexOf(entry)
      if (i !== -1) trapsRef.current.splice(i, 1)
    }
  }, [])

  useEffect(() => {
    function regionsSorted(): RegionEntry[] {
      return Array.from(regionsRef.current.values()).sort((a, b) => {
        const ao = a.handlers.current.order ?? 0
        const bo = b.handlers.current.order ?? 0
        if (ao !== bo) return ao - bo
        const pos = a.el.compareDocumentPosition(b.el)
        return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
      })
    }
    function regionOf(node: Element | null): RegionEntry | null {
      if (!node) return null
      for (const r of regionsRef.current.values()) if (r.el.contains(node)) return r
      return null
    }
    function focusRegionEntry(r: RegionEntry): void {
      const items = itemsOf(r)
      const target = r.lastItem && items.includes(r.lastItem) ? r.lastItem : items[0]
      if (target) focusItem(r, target)
      else { r.el.tabIndex = -1; r.el.focus() }
    }
    /** Returns true if it moved (and thus consumed the key). */
    function jumpRegion(dir: 1 | -1, allowSelf: boolean): boolean {
      const regions = regionsSorted()
      if (!regions.length) return false
      const curIdx = regions.findIndex(r => r.el.contains(document.activeElement))
      const nextIdx = curIdx === -1
        ? (dir > 0 ? 0 : regions.length - 1)
        : (curIdx + dir + regions.length) % regions.length
      if (!allowSelf && nextIdx === curIdx) return false
      focusRegionEntry(regions[nextIdx])
      return true
    }
    function moveWithin(r: RegionEntry, dir: 1 | -1): void {
      const items = itemsOf(r)
      if (!items.length) return
      const here = closestItem(document.activeElement, r) ?? r.lastItem
      const cur = here ? items.indexOf(here) : -1
      if (cur === -1) { focusItem(r, items[dir > 0 ? 0 : items.length - 1]); return }
      focusItem(r, items[Math.max(0, Math.min(items.length - 1, cur + dir))])
    }
    function clickPrimary(item: HTMLElement): void {
      const primary = item.querySelector<HTMLElement>("[data-nav-primary]")
      ;(primary ?? item).click()
    }
    function activate(r: RegionEntry, item: HTMLElement): void {
      const h = r.handlers.current
      h.onActivate ? h.onActivate(item) : clickPrimary(item)
    }
    function stepInto(r: RegionEntry, item: HTMLElement): void {
      const h = r.handlers.current
      h.onStepInto ? h.onStepInto(item) : clickPrimary(item)
    }
    function stepOut(r: RegionEntry, item: HTMLElement): void {
      r.handlers.current.onStepOut?.(item)
    }
    function cycleTrap(el: HTMLElement, backward: boolean): void {
      const f = focusables(el)
      if (!f.length) { el.focus(); return }
      const idx = f.indexOf(document.activeElement as HTMLElement)
      if (idx === -1) { (backward ? f[f.length - 1] : f[0]).focus(); return }
      f[(idx + (backward ? -1 : 1) + f.length) % f.length].focus()
    }
    function focusFirstInTrap(el: HTMLElement): void {
      const f = focusables(el)
      if (f.length) f[0].focus()
      else { el.tabIndex = -1; el.focus() }
    }

    function onKeyDown(e: KeyboardEvent): void {
      if (e.defaultPrevented || e.isComposing) return
      const active = document.activeElement as HTMLElement | null

      // ── 1. Modal trap active: confine focus inside the topmost trap ────────
      const trap = trapsRef.current[trapsRef.current.length - 1]
      if (trap) {
        const el = trap.getEl()
        if (!el) return
        if (e.key === "Escape") {
          if (isEditableContext(active)) return // let the field's own Escape run first
          e.preventDefault()
          trap.onEscape()
          return
        }
        if (e.key === "Tab") {
          e.preventDefault()
          cycleTrap(el, e.shiftKey)
          return
        }
        // Region-jump / arrow keys must never reach the page behind the modal.
        if (e.key === "[" || e.key === "]" || e.key.startsWith("Arrow")) {
          if (!el.contains(active)) { e.preventDefault(); focusFirstInTrap(el) }
          // else inside modal: let native behaviour run (text cursor, selects…)
        }
        return
      }

      // ── 2. Yield to native editable / combobox contexts ───────────────────
      if (isEditableContext(active)) return

      // ── 3. Region jump: [ ]  and  Tab / Shift-Tab (mirror) ────────────────
      if (e.key === "[") { if (jumpRegion(-1, true)) e.preventDefault(); return }
      if (e.key === "]") { if (jumpRegion(1, true)) e.preventDefault(); return }
      if (e.key === "Tab") {
        // Only hijack Tab when focus is already inside a region, and only when
        // there is a DIFFERENT region to land on — otherwise leave native Tab
        // alone so the user is never trapped in the only region.
        if (regionOf(active) && jumpRegion(e.shiftKey ? -1 : 1, false)) e.preventDefault()
        return
      }

      // ── 4. Within-region navigation ───────────────────────────────────────
      const region = regionOf(active)
      if (!region) return
      const item = closestItem(active, region)
      const onItem = item !== null && active === item
      const onContainer = active === region.el

      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        // Up/Down move rows when the row (or empty container) is focused; if
        // focus is on an inner control they stay native.
        if (!onItem && !onContainer) return
        e.preventDefault()
        moveWithin(region, e.key === "ArrowDown" ? 1 : -1)
        return
      }
      if (!onItem) return // remaining keys require the row itself to be focused
      if (e.key === "ArrowRight") { e.preventDefault(); stepInto(region, item) }
      else if (e.key === "ArrowLeft") { e.preventDefault(); stepOut(region, item) }
      else if (e.key === "Enter") { e.preventDefault(); activate(region, item) }
    }

    document.addEventListener("keydown", onKeyDown, true)
    return () => document.removeEventListener("keydown", onKeyDown, true)
  }, [])

  const api = useMemo<KeyboardNavApi>(() => ({ registerRegion, pushTrap }), [registerRegion, pushTrap])
  return <KeyboardNavContext.Provider value={api}>{children}</KeyboardNavContext.Provider>
}

// ─────────────────────────────────────────────────────────────────────────────
// useNavRegion — a surface registers ONE region with this. Spread the returned
// `regionProps` on the region container; mark each navigable child with
// `data-nav-item`, and (optionally) its open-detail control with
// `data-nav-primary`. That is the entire Part-2 wiring contract.
// ─────────────────────────────────────────────────────────────────────────────
export function useNavRegion<T extends HTMLElement = HTMLElement>(
  options: { id: string } & NavRegionHandlers,
): { regionProps: { ref: (el: T | null) => void; "data-nav-region": string; tabIndex: -1 } } {
  const nav = useKeyboardNav()
  const { id } = options

  // Handlers are read live by the provider, so re-renders don't re-register.
  const handlersRef = useRef<NavRegionHandlers>(options)
  handlersRef.current = options

  const cleanupRef = useRef<(() => void) | null>(null)

  // Callback ref = mount/unmount-driven registration → the map follows the
  // live route without depending on effect deps or the current layout.
  const ref = useCallback((el: T | null) => {
    if (cleanupRef.current) { cleanupRef.current(); cleanupRef.current = null }
    if (!el) return
    const entry: RegionEntry = { id, el, handlers: handlersRef, lastItem: null }
    const unregister = nav.registerRegion(entry)
    const obs = new MutationObserver(() => normalizeTabindex(entry))
    obs.observe(el, { childList: true, subtree: true })
    normalizeTabindex(entry)
    cleanupRef.current = () => { obs.disconnect(); unregister() }
  }, [nav, id])

  return { regionProps: { ref, "data-nav-region": id, tabIndex: -1 } }
}

// ─────────────────────────────────────────────────────────────────────────────
// useFocusTrap — trap focus inside a modal/dialog while `active`. On open it
// moves focus inside; while open the provider confines Tab + region keys to it
// and routes Escape to `onEscape`; on close it restores focus to whatever was
// focused before the trap opened (the trigger). There is no shared modal
// primitive in this codebase yet, so each bespoke modal opts in with one call —
// see the Part-2 note for the consolidation path.
// ─────────────────────────────────────────────────────────────────────────────
export function useFocusTrap<T extends HTMLElement = HTMLElement>(
  containerRef: RefObject<T | null>,
  active: boolean,
  onEscape: () => void,
): void {
  const nav = useKeyboardNav()
  const onEscapeRef = useRef(onEscape)
  onEscapeRef.current = onEscape

  useEffect(() => {
    if (!active) return
    const prevFocused = document.activeElement as HTMLElement | null
    const trap: TrapEntry = {
      getEl: () => containerRef.current,
      onEscape: () => onEscapeRef.current(),
    }
    const pop = nav.pushTrap(trap)

    const el = containerRef.current
    if (el) {
      const f = focusables(el)
      if (f.length) f[0].focus()
      else { el.tabIndex = -1; el.focus() }
    }

    return () => {
      pop()
      if (prevFocused && prevFocused.isConnected && typeof prevFocused.focus === "function") {
        prevFocused.focus()
      }
    }
    // containerRef identity is stable; re-run only when the modal opens/closes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, nav])
}
