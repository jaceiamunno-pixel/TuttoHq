// Open-Meteo weather auto-fill (https://open-meteo.com — free, no key, CORS).
// Client-side only. Every failure path resolves to null: weather prefill is
// best-effort decoration and must never block or break a save.

export interface AutoWeather {
  conditions: string   // one of WEATHER_OPTIONS
  temperature: string  // e.g. "72°F"
}

interface GeoPoint { lat: number; lon: number }

// Geocode results cached per location string for the life of the tab (the
// task caches "per project" — the project's location text IS the key, so a
// project edit naturally invalidates).
const geoCache = new Map<string, GeoPoint | null>()

const FETCH_TIMEOUT_MS = 8_000

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json()
}

/** Geocode a free-text project location. Site addresses are usually street-
 *  level ("123 Main St, Chattanooga, TN") while the geocoder resolves
 *  place names, so on a miss we retry with the leading segment(s) stripped. */
export async function geocodeLocation(location: string): Promise<GeoPoint | null> {
  const key = location.trim().toLowerCase()
  if (!key) return null
  if (geoCache.has(key)) return geoCache.get(key) ?? null

  const parts = location.split(",").map(s => s.trim()).filter(Boolean)
  const candidates = [...new Set([
    location.trim(),
    parts.slice(1).join(", "),
    parts.slice(-2).join(", "),
  ].filter(Boolean))]

  let point: GeoPoint | null = null
  for (const candidate of candidates) {
    try {
      const data = await getJson(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(candidate)}&count=1&language=en&format=json`
      ) as { results?: { latitude: number; longitude: number }[] }
      const hit = data.results?.[0]
      if (hit && Number.isFinite(hit.latitude) && Number.isFinite(hit.longitude)) {
        point = { lat: hit.latitude, lon: hit.longitude }
        break
      }
    } catch {
      // try the next candidate; a network failure falls through to null
    }
  }
  geoCache.set(key, point)
  return point
}

/** WMO weather code → the module's existing weather vocabulary. */
function mapWeatherCode(code: number, windMph: number): string {
  let label: string
  if (code === 0) label = "Clear"
  else if (code === 1 || code === 2) label = "Partly Cloudy"
  else if (code === 3) label = "Cloudy"
  else if (code === 45 || code === 48) label = "Fog"
  else if ([65, 67, 82, 95, 96, 99].includes(code)) label = "Heavy Rain"
  else if ((code >= 51 && code <= 63) || code === 66 || code === 80 || code === 81) label = "Rain"
  else if ((code >= 71 && code <= 77) || code === 85 || code === 86) label = "Snow"
  else label = "Cloudy"
  // Strong wind on an otherwise clear/partly day reads as "Wind" on site.
  if (windMph >= 24 && (label === "Clear" || label === "Partly Cloudy")) return "Wind"
  return label
}

/** Fetch conditions + high temp for a report date. Recent/future dates hit
 *  the forecast endpoint; older dates the historical archive (the forecast
 *  API only reaches ~3 months back, the archive lags a few days behind
 *  the present — a 6-day cutoff sits safely inside both windows). */
export async function fetchWeatherFor(location: string, dateISO: string): Promise<AutoWeather | null> {
  try {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return null
    const point = await geocodeLocation(location)
    if (!point) return null

    const today = new Date(); today.setHours(0, 0, 0, 0)
    const date = new Date(`${dateISO}T00:00:00`)
    const diffDays = Math.round((today.getTime() - date.getTime()) / 86_400_000)
    if (diffDays < -16) return null // beyond the forecast horizon

    const host = diffDays > 6
      ? "https://archive-api.open-meteo.com/v1/archive"
      : "https://api.open-meteo.com/v1/forecast"
    const data = await getJson(
      `${host}?latitude=${point.lat}&longitude=${point.lon}` +
      `&daily=weather_code,temperature_2m_max,wind_speed_10m_max` +
      `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto` +
      `&start_date=${dateISO}&end_date=${dateISO}`
    ) as { daily?: { weather_code?: (number | null)[]; temperature_2m_max?: (number | null)[]; wind_speed_10m_max?: (number | null)[] } }

    const code = data.daily?.weather_code?.[0]
    const tMax = data.daily?.temperature_2m_max?.[0]
    const wind = data.daily?.wind_speed_10m_max?.[0] ?? 0
    if (code == null || tMax == null) return null
    return {
      conditions: mapWeatherCode(code, wind ?? 0),
      temperature: `${Math.round(tMax)}°F`,
    }
  } catch {
    return null
  }
}
