// Daily-report weather snapshot (migration 0051) — Open-Meteo, free, no key.
//
// The WRITE half (fetchDailyWeather) runs server-side in the daily-reports
// POST route at creation time. It is best-effort decoration under a hard
// overall deadline: every failure path — bad location, geocode miss, network
// error, timeout — resolves to null and MUST NEVER block or fail report
// creation.
//
// The READ half (parseWeatherSnapshot / formatWeatherLine) is pure and
// isomorphic — imported by the client report detail and the server PDF route.
//
// Related but separate: _modules/daily/weather.ts is the CLIENT prefill for
// the user-editable weather_conditions/temperature form fields. This module
// is the canonical server-captured record; the two deliberately coexist.

/** Shape stored in daily_reports.weather (jsonb). All value fields nullable —
 *  Open-Meteo can return partial daily aggregates. */
export interface DailyWeatherSnapshot {
  temp_high_f: number | null
  temp_low_f: number | null
  conditions: string | null
  precipitation_in: number | null
  wind_max_mph: number | null
  /** The location text the geocoder resolved (project or company address). */
  location: string
  fetched_at: string
  source: "open-meteo"
}

// Overall wall-clock budget for the whole capture (geocode candidates +
// forecast). Kept short because it runs inline in the create POST.
const TOTAL_BUDGET_MS = 4_000
const PER_REQUEST_CAP_MS = 2_500

async function getJson(url: string, deadline: number): Promise<unknown> {
  const remaining = deadline - Date.now()
  if (remaining < 300) throw new Error("weather budget exhausted")
  const res = await fetch(url, { signal: AbortSignal.timeout(Math.min(remaining, PER_REQUEST_CAP_MS)) })
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json()
}

/** Geocode a free-text site location. Same candidate-stripping strategy as
 *  the client prefill: street-level addresses miss, so retry with the
 *  leading segment(s) dropped ("123 Main St, Chattanooga, TN" → "Chattanooga, TN"). */
async function geocode(location: string, deadline: number): Promise<{ lat: number; lon: number } | null> {
  const parts = location.split(",").map(s => s.trim()).filter(Boolean)
  const candidates = [...new Set([
    location.trim(),
    parts.slice(1).join(", "),
    parts.slice(-2).join(", "),
  ].filter(Boolean))]

  for (const candidate of candidates) {
    try {
      const data = await getJson(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(candidate)}&count=1&language=en&format=json`,
        deadline,
      ) as { results?: { latitude: number; longitude: number }[] }
      const hit = data.results?.[0]
      if (hit && Number.isFinite(hit.latitude) && Number.isFinite(hit.longitude)) {
        return { lat: hit.latitude, lon: hit.longitude }
      }
    } catch {
      // next candidate; total-budget exhaustion falls through to null fast
    }
  }
  return null
}

/** WMO weather code → site-report vocabulary (mirrors the client prefill's
 *  mapping so both surfaces speak the same language). */
function conditionsFromCode(code: number, windMph: number): string {
  let label: string
  if (code === 0) label = "Clear"
  else if (code === 1 || code === 2) label = "Partly Cloudy"
  else if (code === 3) label = "Cloudy"
  else if (code === 45 || code === 48) label = "Fog"
  else if ([65, 67, 82, 95, 96, 99].includes(code)) label = "Heavy Rain"
  else if ((code >= 51 && code <= 63) || code === 66 || code === 80 || code === 81) label = "Rain"
  else if ((code >= 71 && code <= 77) || code === 85 || code === 86) label = "Snow"
  else label = "Cloudy"
  if (windMph >= 24 && (label === "Clear" || label === "Partly Cloudy")) return "Wind"
  return label
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null

/** Fetch the day's weather for a free-text location. Null on ANY failure. */
export async function fetchDailyWeather(location: string, dateISO: string): Promise<DailyWeatherSnapshot | null> {
  try {
    if (!location.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return null
    const deadline = Date.now() + TOTAL_BUDGET_MS
    const point = await geocode(location, deadline)
    if (!point) return null

    const data = await getJson(
      `https://api.open-meteo.com/v1/forecast?latitude=${point.lat}&longitude=${point.lon}` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max` +
      `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=auto` +
      `&start_date=${dateISO}&end_date=${dateISO}`,
      deadline,
    ) as { daily?: Record<string, (number | null)[] | undefined> }

    const d = data.daily ?? {}
    const code = num(d.weather_code?.[0])
    const high = num(d.temperature_2m_max?.[0])
    const low = num(d.temperature_2m_min?.[0])
    const precip = num(d.precipitation_sum?.[0])
    const wind = num(d.wind_speed_10m_max?.[0])
    if (code == null && high == null) return null

    return {
      temp_high_f: high != null ? Math.round(high) : null,
      temp_low_f: low != null ? Math.round(low) : null,
      conditions: code != null ? conditionsFromCode(code, wind ?? 0) : null,
      precipitation_in: precip != null ? Math.round(precip * 100) / 100 : null,
      wind_max_mph: wind != null ? Math.round(wind) : null,
      location: location.trim(),
      fetched_at: new Date().toISOString(),
      source: "open-meteo",
    }
  } catch {
    return null
  }
}

/** Tolerant parse of the jsonb column — a malformed value renders as no
 *  weather line, never a throw. */
export function parseWeatherSnapshot(raw: unknown): DailyWeatherSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const snapshot: DailyWeatherSnapshot = {
    temp_high_f: num(r.temp_high_f),
    temp_low_f: num(r.temp_low_f),
    conditions: typeof r.conditions === "string" && r.conditions ? r.conditions : null,
    precipitation_in: num(r.precipitation_in),
    wind_max_mph: num(r.wind_max_mph),
    location: typeof r.location === "string" ? r.location : "",
    fetched_at: typeof r.fetched_at === "string" ? r.fetched_at : "",
    source: "open-meteo",
  }
  const hasAny = snapshot.temp_high_f != null || snapshot.temp_low_f != null ||
    snapshot.conditions != null || snapshot.precipitation_in != null || snapshot.wind_max_mph != null
  return hasAny ? snapshot : null
}

/** One-line summary for the report header + PDF, e.g.
 *  "High 84°F / Low 63°F · Rain · 0.25 in precip · Wind 18 mph". */
export function formatWeatherLine(w: DailyWeatherSnapshot): string {
  const parts: string[] = []
  if (w.temp_high_f != null && w.temp_low_f != null) parts.push(`High ${w.temp_high_f}°F / Low ${w.temp_low_f}°F`)
  else if (w.temp_high_f != null) parts.push(`High ${w.temp_high_f}°F`)
  else if (w.temp_low_f != null) parts.push(`Low ${w.temp_low_f}°F`)
  if (w.conditions) parts.push(w.conditions)
  if (w.precipitation_in != null && w.precipitation_in > 0) parts.push(`${w.precipitation_in} in precip`)
  if (w.wind_max_mph != null) parts.push(`Wind ${w.wind_max_mph} mph`)
  return parts.join(" · ")
}
