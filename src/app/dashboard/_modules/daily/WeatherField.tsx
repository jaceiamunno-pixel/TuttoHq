"use client"

// Weather + temperature pair with Open-Meteo auto-fill (step 3a). The
// values live in the composer's form state — this component only decides
// when to prefill them. Rules:
//   - Auto-fill fires when the project has a location AND the user hasn't
//     typed their own values (empty, or still equal to the last auto-fill).
//   - A manual edit wins permanently for that composer session — the auto
//     pass never overwrites user input.
//   - Every failure is silent-graceful: fields stay manual, save never blocks.

import { useEffect, useRef, useState } from "react"
import { WEATHER_OPTIONS } from "./types"
import { fetchWeatherFor, type AutoWeather } from "./weather"
import { fieldCls, selectCls, labelCls } from "./ui"
import { SpinnerIcon } from "../../_shared/icons"

export default function WeatherField({ weather, temperature, onWeather, onTemperature, reportDate, projectLocation, canEdit }: {
  weather: string
  temperature: string
  onWeather: (v: string) => void
  onTemperature: (v: string) => void
  reportDate: string
  projectLocation: string | null
  canEdit: boolean
}) {
  const [fetching, setFetching] = useState(false)
  const [lastAuto, setLastAuto] = useState<AutoWeather | null>(null)
  // Mirror current values in a ref so the fetch effect can check "has the
  // user typed?" without re-running on every keystroke.
  const currentRef = useRef({ weather, temperature })
  currentRef.current = { weather, temperature }
  const lastAutoRef = useRef<AutoWeather | null>(null)
  useEffect(() => { lastAutoRef.current = lastAuto }, [lastAuto])
  const seqRef = useRef(0)

  async function runAutoFill(force: boolean) {
    if (!projectLocation || !canEdit) return
    const cur = currentRef.current
    const auto = lastAutoRef.current
    const untouched =
      (cur.weather === "" || cur.weather === auto?.conditions) &&
      (cur.temperature === "" || cur.temperature === auto?.temperature)
    if (!force && !untouched) return
    const seq = ++seqRef.current
    setFetching(true)
    const result = await fetchWeatherFor(projectLocation, reportDate)
    if (seq !== seqRef.current) return // superseded by a newer request
    setFetching(false)
    if (!result) return
    onWeather(result.conditions)
    onTemperature(result.temperature)
    setLastAuto(result)
  }

  // Auto-attempt whenever the date or project changes (and on first open).
  useEffect(() => {
    runAutoFill(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportDate, projectLocation])

  const isAuto = !!lastAuto && weather === lastAuto.conditions && temperature === lastAuto.temperature

  return (
    <div className="flex flex-col sm:flex-row gap-3">
      <div className="flex-1">
        <label className={labelCls}>
          Weather
          {isAuto && (
            <span className="ml-2 normal-case tracking-normal inline-flex items-center gap-1 text-[10px] font-semibold text-sky-700 bg-sky-50 border border-sky-200 px-1.5 py-0.5 rounded-full" title="Auto-filled from Open-Meteo — edit freely">
              ⚡ Auto
            </span>
          )}
          {fetching && <SpinnerIcon className="ml-2 inline h-3 w-3 text-[#64748B]" />}
        </label>
        <div className="flex gap-2">
          <select value={weather} onChange={e => onWeather(e.target.value)} disabled={!canEdit} className={selectCls}>
            <option value="">Select…</option>
            {WEATHER_OPTIONS.map(w => <option key={w} value={w}>{w}</option>)}
            {/* Keep a legacy free-text value selectable rather than silently dropping it */}
            {weather && !WEATHER_OPTIONS.includes(weather) && <option value={weather}>{weather}</option>}
          </select>
          {projectLocation && canEdit && (
            <button type="button" onClick={() => runAutoFill(true)} disabled={fetching}
              title={`Fetch conditions for ${projectLocation}`}
              className="h-11 sm:h-9 px-2.5 rounded-md border border-[#E2E8F0] text-[12px] text-[#64748B] bg-[#F4F5F7] hover:bg-white/50 transition-colors disabled:opacity-50 flex-shrink-0">
              {fetching ? <SpinnerIcon className="h-3 w-3" /> : "Auto"}
            </button>
          )}
        </div>
      </div>
      <div className="sm:w-32 sm:flex-shrink-0">
        <label className={labelCls}>Temperature</label>
        <input type="text" value={temperature} onChange={e => onTemperature(e.target.value)}
          placeholder="e.g. 72°F" disabled={!canEdit} className={fieldCls} />
      </div>
    </div>
  )
}
