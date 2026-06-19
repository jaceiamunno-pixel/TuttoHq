// In-app drawing markup — vector model + serialization (ADR-005 Phase 2, Part 1).
//
// DECIDED MODEL: markup is stored as VECTOR primitives (editable forever) and
// rendered FLATTENED on view/export (Bluebeam/Procore behavior). This file owns
// ONLY the vector model + (de)serialization — the flatten/render step and the
// drawing_revisions persistence are Part 2.
//
// COORDINATE SPACE (resolution-independent on purpose):
//   - All point coords are NORMALIZED to [0,1]: x = fraction of page WIDTH,
//     y = fraction of page HEIGHT (origin = top-left of the sheet page).
//   - `strokeWidth` and `fontSize` are fractions of page HEIGHT.
// Storing this way means the same array round-trips at any viewport size and
// Part 2 can flatten it onto the sheet at any DPI server-side without a remap.
//
// This module is pure (no React, no DOM) so it can be imported by the editor,
// the Part-2 flatten pipeline, and any server route alike.

// v2 adds the "highlight" + "cloud" variants and MarkupStyle.opacity. The bump is
// purely additive — deserializeMarkups still reads v1 docs fine (they simply have
// neither new type and no opacity → opaque).
export const MARKUP_DOC_VERSION = 2

export type MarkupType = "line" | "rect" | "arrow" | "text" | "highlight" | "cloud"

/** A point in normalized page space — both components in [0,1]. */
export interface Point {
  x: number
  y: number
}

export interface MarkupStyle {
  /** Stroke / text / fill color (hex). */
  color: string
  /** Stroke width as a fraction of page height. */
  strokeWidth: number
  /** Text height as a fraction of page height (only meaningful for `text`). */
  fontSize: number
  /** Fill/stroke opacity in [0,1]. undefined = opaque (1). Highlights set ~0.35;
   *  every other variant leaves it undefined. */
  opacity?: number
}

interface BaseMarkup {
  id: string
  /** Paint order — higher draws on top. The serialized array is z-ordered. */
  z: number
  style: MarkupStyle
}

/** Freehand pen stroke — an open polyline of normalized points. */
export interface LineMarkup extends BaseMarkup {
  type: "line"
  points: Point[]
}

/** Axis-aligned rectangle — top-left (x,y) + size (w,h), all normalized. */
export interface RectMarkup extends BaseMarkup {
  type: "rect"
  x: number
  y: number
  w: number
  h: number
}

/** Straight arrow from (x1,y1) to (x2,y2); the head is at the (x2,y2) end. */
export interface ArrowMarkup extends BaseMarkup {
  type: "arrow"
  x1: number
  y1: number
  x2: number
  y2: number
}

/** Text label anchored at its top-left (x,y). */
export interface TextMarkup extends BaseMarkup {
  type: "text"
  x: number
  y: number
  text: string
}

/** Translucent highlighter. ONE variant, TWO geometric forms discriminated by
 *  `shape`: "rect" (a filled box, like RectMarkup) or "free" (a freehand band,
 *  like LineMarkup). Translucency comes from style.opacity (~0.35). */
export interface HighlightRectMarkup extends BaseMarkup {
  type: "highlight"
  shape: "rect"
  x: number
  y: number
  w: number
  h: number
}
export interface HighlightFreeMarkup extends BaseMarkup {
  type: "highlight"
  shape: "free"
  points: Point[]
}
export type HighlightMarkup = HighlightRectMarkup | HighlightFreeMarkup

/** Revision cloud — a scalloped rectangle. Geometry is JUST the bounding box
 *  (like RectMarkup); the scalloping is a RENDER concern (editor SVG + pdf-lib),
 *  never stored. */
export interface CloudMarkup extends BaseMarkup {
  type: "cloud"
  x: number
  y: number
  w: number
  h: number
}

export type Markup = LineMarkup | RectMarkup | ArrowMarkup | TextMarkup | HighlightMarkup | CloudMarkup

/** The serializable document — this is what Part 2 persists as jsonb. */
export interface MarkupDoc {
  version: number
  /** drawing_revisions.id this layer was drawn over (its base). null if unknown. */
  baseRevisionId: string | null
  /** The base revision's label at save time — provenance / display lineage. */
  baseLabel: string | null
  markups: Markup[]
}

// ── Editor presets (kept here so the model + UI agree on one vocabulary) ─────

/** Bold, fully-saturated marker palette — chosen to POP on a white sheet (high
 *  saturation, not high luminance, which washes out). index 0 (red) is the
 *  default stroke colour; index 2 (amber) is the highlighter default. */
export const MARKUP_COLORS = [
  "#FF0000", // red (pure)
  "#FF7A00", // orange
  "#FFB300", // amber (highlighter default)
  "#00B050", // green
  "#0052FF", // blue
  "#C400C4", // magenta
  "#111827", // near-black
] as const

/** Stroke widths as fractions of page height. */
export const STROKE_PRESETS = { thin: 0.0018, medium: 0.0032, thick: 0.0055 } as const
/** Text heights as fractions of page height. */
export const FONT_PRESETS = { small: 0.016, medium: 0.024, large: 0.034 } as const

export const DEFAULT_STYLE: MarkupStyle = {
  color: MARKUP_COLORS[0],
  strokeWidth: STROKE_PRESETS.medium,
  fontSize: FONT_PRESETS.medium,
}

/** Highlighter defaults: translucent + amber (the palette still applies). */
export const HIGHLIGHT_OPACITY = 0.35
export const HIGHLIGHT_DEFAULT_COLOR = MARKUP_COLORS[2] // amber #CA8A04
/** Revision-cloud scallop radius as a fraction of (displayed) page height. Used
 *  by BOTH the editor SVG and the pdf-lib export so the scallop count agrees. */
export const CLOUD_SCALLOP_FRAC = 0.012

export function newMarkupId(): string {
  // crypto.randomUUID is available in the browser + modern Node; the small
  // fallback keeps this module usable in any context without throwing.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID()
  return `mk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

// ── Geometry helpers (pure, normalized space) ────────────────────────────────

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)
const clampPoint = (p: Point): Point => ({ x: clamp01(p.x), y: clamp01(p.y) })

type Box = { x: number; y: number; w: number; h: number }

/** Normalized bbox of an axis-aligned rect given as (x,y)+(w,h), either sign. */
function rectBox(x: number, y: number, w: number, h: number): Box {
  return { x: Math.min(x, x + w), y: Math.min(y, y + h), w: Math.abs(w), h: Math.abs(h) }
}
/** Normalized bbox enclosing a polyline. */
function lineBox(points: Point[]): Box {
  if (points.length === 0) return { x: 0, y: 0, w: 0, h: 0 }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/** Normalized axis-aligned bounding box of a markup. */
export function boundingBox(m: Markup): Box {
  switch (m.type) {
    // rect / cloud / highlight-rect all share the rect bbox; highlight-free and
    // line share the polyline bbox — factored into rectBox/lineBox.
    case "rect":
    case "cloud":
      return rectBox(m.x, m.y, m.w, m.h)
    case "highlight":
      return m.shape === "rect" ? rectBox(m.x, m.y, m.w, m.h) : lineBox(m.points)
    case "arrow": {
      const x = Math.min(m.x1, m.x2), y = Math.min(m.y1, m.y2)
      return { x, y, w: Math.abs(m.x2 - m.x1), h: Math.abs(m.y2 - m.y1) }
    }
    case "line":
      return lineBox(m.points)
    case "text": {
      // Approximate — exact width needs font metrics we don't carry here. Good
      // enough for selection hit-testing (callers add a tolerance band).
      const h = m.style.fontSize * 1.2
      const w = Math.max(0.02, (m.text.length || 1) * m.style.fontSize * 0.55)
      return { x: m.x, y: m.y, w, h }
    }
  }
}

/** Distance from point `p` to segment a→b, in normalized space. */
function distToSegment(p: Point, a: Point, b: Point): number {
  const vx = b.x - a.x, vy = b.y - a.y
  const len2 = vx * vx + vy * vy
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy))
}

function pointInBox(p: Point, box: { x: number; y: number; w: number; h: number }, tol: number): boolean {
  return p.x >= box.x - tol && p.x <= box.x + box.w + tol && p.y >= box.y - tol && p.y <= box.y + box.h + tol
}

/**
 * Does `p` hit `m` within `tol` (normalized)? Thin shapes (line/arrow) use a
 * near-segment test so a diagonal stroke isn't a giant rectangular hot-zone;
 * filled-ish shapes (rect/text) use an expanded bounding box for easy grabbing.
 */
function lineHit(points: Point[], p: Point, tol: number): boolean {
  if (points.length === 1) return Math.hypot(p.x - points[0].x, p.y - points[0].y) <= tol
  for (let i = 1; i < points.length; i++) {
    if (distToSegment(p, points[i - 1], points[i]) <= tol) return true
  }
  return false
}

export function hitTest(m: Markup, p: Point, tol = 0.012): boolean {
  switch (m.type) {
    // rect / cloud / text / highlight-rect grab via an expanded bbox; line and
    // highlight-free use the near-segment test (shared lineHit).
    case "rect":
    case "cloud":
    case "text":
      return pointInBox(p, boundingBox(m), tol)
    case "highlight":
      return m.shape === "rect" ? pointInBox(p, boundingBox(m), tol) : lineHit(m.points, p, tol)
    case "arrow":
      return distToSegment(p, { x: m.x1, y: m.y1 }, { x: m.x2, y: m.y2 }) <= tol
    case "line":
      return lineHit(m.points, p, tol)
  }
}

/** Return a copy of `m` translated by (dx,dy) normalized, clamped to the page. */
export function translateMarkup(m: Markup, dx: number, dy: number): Markup {
  const shiftPts = (pts: Point[]) => pts.map(p => clampPoint({ x: p.x + dx, y: p.y + dy }))
  switch (m.type) {
    case "line":
      return { ...m, points: shiftPts(m.points) }
    case "rect":
    case "cloud":
      return { ...m, x: clamp01(m.x + dx), y: clamp01(m.y + dy) }
    case "highlight":
      return m.shape === "rect"
        ? { ...m, x: clamp01(m.x + dx), y: clamp01(m.y + dy) }
        : { ...m, points: shiftPts(m.points) }
    case "arrow":
      return { ...m, x1: clamp01(m.x1 + dx), y1: clamp01(m.y1 + dy), x2: clamp01(m.x2 + dx), y2: clamp01(m.y2 + dy) }
    case "text":
      return { ...m, x: clamp01(m.x + dx), y: clamp01(m.y + dy) }
  }
}

// ── Serialization (the thing Part 2 will store as jsonb) ─────────────────────

/** Pack markups into the versioned, z-ordered document. `base` records which
 *  revision the layer was drawn over (provenance for the persisted row). */
export function serializeMarkups(
  markups: Markup[],
  base?: { revisionId: string | null; label: string | null },
): MarkupDoc {
  const ordered = [...markups].sort((a, b) => a.z - b.z)
  return {
    version: MARKUP_DOC_VERSION,
    baseRevisionId: base?.revisionId ?? null,
    baseLabel: base?.label ?? null,
    markups: ordered,
  }
}

const isFiniteNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n)
const isPoint = (p: unknown): p is Point =>
  !!p && typeof p === "object" && isFiniteNum((p as Point).x) && isFiniteNum((p as Point).y)

function validStyle(s: unknown): MarkupStyle {
  const o = (s && typeof s === "object" ? s : {}) as Partial<MarkupStyle>
  return {
    color: typeof o.color === "string" ? o.color : DEFAULT_STYLE.color,
    strokeWidth: isFiniteNum(o.strokeWidth) ? o.strokeWidth : DEFAULT_STYLE.strokeWidth,
    fontSize: isFiniteNum(o.fontSize) ? o.fontSize : DEFAULT_STYLE.fontSize,
    // opacity is optional — pass it through (clamped) only when present + finite,
    // so v1 docs without it stay opaque.
    ...(isFiniteNum(o.opacity) ? { opacity: clamp01(o.opacity) } : {}),
  }
}

/** One raw entry → a valid Markup, or null if it can't be salvaged. */
function reviveMarkup(raw: unknown, fallbackZ: number): Markup | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const id = typeof r.id === "string" ? r.id : newMarkupId()
  const z = isFiniteNum(r.z) ? r.z : fallbackZ
  const style = validStyle(r.style)
  switch (r.type) {
    case "line": {
      const pts = Array.isArray(r.points) ? r.points.filter(isPoint).map(clampPoint) : []
      return pts.length > 0 ? { type: "line", id, z, style, points: pts } : null
    }
    case "rect":
      return isFiniteNum(r.x) && isFiniteNum(r.y) && isFiniteNum(r.w) && isFiniteNum(r.h)
        ? { type: "rect", id, z, style, x: clamp01(r.x), y: clamp01(r.y), w: r.w, h: r.h }
        : null
    case "arrow":
      return isFiniteNum(r.x1) && isFiniteNum(r.y1) && isFiniteNum(r.x2) && isFiniteNum(r.y2)
        ? { type: "arrow", id, z, style, x1: clamp01(r.x1), y1: clamp01(r.y1), x2: clamp01(r.x2), y2: clamp01(r.y2) }
        : null
    case "text":
      return isFiniteNum(r.x) && isFiniteNum(r.y) && typeof r.text === "string" && r.text.length > 0
        ? { type: "text", id, z, style, x: clamp01(r.x), y: clamp01(r.y), text: r.text }
        : null
    case "highlight": {
      if (r.shape === "rect") {
        return isFiniteNum(r.x) && isFiniteNum(r.y) && isFiniteNum(r.w) && isFiniteNum(r.h)
          ? { type: "highlight", shape: "rect", id, z, style, x: clamp01(r.x), y: clamp01(r.y), w: r.w, h: r.h }
          : null
      }
      if (r.shape === "free") {
        const pts = Array.isArray(r.points) ? r.points.filter(isPoint).map(clampPoint) : []
        return pts.length > 0 ? { type: "highlight", shape: "free", id, z, style, points: pts } : null
      }
      return null
    }
    case "cloud":
      return isFiniteNum(r.x) && isFiniteNum(r.y) && isFiniteNum(r.w) && isFiniteNum(r.h)
        ? { type: "cloud", id, z, style, x: clamp01(r.x), y: clamp01(r.y), w: r.w, h: r.h }
        : null
    default:
      return null
  }
}

/**
 * Parse a stored document (or a bare markups array) back into a clean,
 * z-ordered Markup[]. Drops anything malformed rather than throwing — a single
 * bad entry must never blank the whole sheet's markup.
 */
export function deserializeMarkups(input: unknown): Markup[] {
  const arr: unknown[] = Array.isArray(input)
    ? input
    : Array.isArray((input as MarkupDoc | null)?.markups)
      ? (input as MarkupDoc).markups
      : []
  const out: Markup[] = []
  arr.forEach((raw, i) => {
    const m = reviveMarkup(raw, i)
    if (m) out.push(m)
  })
  return out.sort((a, b) => a.z - b.z)
}

// ── Revision-cloud scallop geometry (shared editor + export) ─────────────────

/** Walk the perimeter of the rectangle `corners` (4 points, in perimeter order)
 *  and emit a polyline that scallops each edge with outward semicircular arcs —
 *  the classic revision cloud. Space-agnostic: pass screen px (editor) OR page
 *  points (export); the only requirement is an isotropic frame (so screen-circle
 *  ↔ page-circle agree, which they do since displayed px preserves the page
 *  aspect). `radius` is the scallop radius in the SAME units as `corners`. */
export function cloudOutline(
  corners: { x: number; y: number }[],
  radius: number,
  samplesPerArc = 6,
): { x: number; y: number }[] {
  if (corners.length < 4 || radius <= 0) return corners.slice()
  const cx = (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4
  const cy = (corners[0].y + corners[1].y + corners[2].y + corners[3].y) / 4
  const out: { x: number; y: number }[] = []
  for (let i = 0; i < 4; i++) {
    const a = corners[i], b = corners[(i + 1) % 4]
    const ex = b.x - a.x, ey = b.y - a.y
    const len = Math.hypot(ex, ey)
    if (len < 1e-9) continue
    const ux = ex / len, uy = ey / len
    // Outward normal: perpendicular to the edge, flipped to point away from center.
    let nx = -uy, ny = ux
    const mx = (a.x + b.x) / 2 - cx, my = (a.y + b.y) / 2 - cy
    if (nx * mx + ny * my < 0) { nx = -nx; ny = -ny }
    // Scallop count: clamp so a tiny cloud still scallops + a huge one doesn't
    // over-subdivide. Each scallop spans seg = len/n with radius seg/2.
    const n = Math.max(1, Math.min(48, Math.round(len / (radius * 2))))
    const seg = len / n
    const r = seg / 2
    for (let j = 0; j < n; j++) {
      const midX = a.x + ux * (j + 0.5) * seg
      const midY = a.y + uy * (j + 0.5) * seg
      for (let k = 0; k <= samplesPerArc; k++) {
        const th = Math.PI * (k / samplesPerArc) // 0..π: start → outward → end
        const x = midX - r * Math.cos(th) * ux + r * Math.sin(th) * nx
        const y = midY - r * Math.cos(th) * uy + r * Math.sin(th) * ny
        out.push({ x, y })
      }
    }
  }
  return out
}
