// Distinct dot colors for tags. On create we pick the first palette entry not
// already in use (then cycle once every color is taken) so dropped dots stay
// visually separable. Hex strings — stored verbatim on takeoff_tags.color and
// reused by the matrix swatches, the on-sheet dots, and the Excel banding.

export const TAG_PALETTE = [
  "#DC2626", // red
  "#2563EB", // blue
  "#16A34A", // green
  "#D97706", // amber
  "#7C3AED", // violet
  "#DB2777", // pink
  "#0891B2", // cyan
  "#65A30D", // lime
  "#EA580C", // orange
  "#4F46E5", // indigo
  "#0D9488", // teal
  "#CA8A04", // gold
  "#9333EA", // purple
  "#E11D48", // rose
  "#0284C7", // sky
  "#15803D", // emerald
]

/** First palette color not present in `used`; cycles by count once all are taken. */
export function nextTagColor(used: string[]): string {
  const taken = new Set(used.map(c => c.toLowerCase()))
  const free = TAG_PALETTE.find(c => !taken.has(c.toLowerCase()))
  return free ?? TAG_PALETTE[used.length % TAG_PALETTE.length]
}
