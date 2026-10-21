// Climate per variety: the shared layer between the database's combined
// readings (crop_climate_hourly / crop_climate_daily, which combine a
// variety's zones and take radiation from the greenhouse-wide cell B6) and
// everything that uses them — the Climate page and projection climate inputs.
// Nothing here averages zones again: it only rolls days up into weeks.
//
//   raw zone readings → crop_climate_hourly → crop_climate_daily → weeklyClimate → Climate page / projection inputs

export type VarietyMetric = 'air_temperature' | 'relative_humidity' | 'co2' | 'radiation_sum' | 'irrigation_cumulative'

/** The five measurements, in the order the Climate page shows them. */
export const VARIETY_METRICS: { key: VarietyMetric; label: string; unit: string; decimals: number; kind: 'hourly' | 'running' }[] = [
  { key: 'air_temperature', label: 'Temperature', unit: '°C', decimals: 1, kind: 'hourly' },
  { key: 'relative_humidity', label: 'RH', unit: '%', decimals: 0, kind: 'hourly' },
  { key: 'co2', label: 'CO₂', unit: 'ppm', decimals: 0, kind: 'hourly' },
  { key: 'irrigation_cumulative', label: 'Irrigation', unit: 'ml/dripper', decimals: 0, kind: 'running' },
  { key: 'radiation_sum', label: 'Radiation', unit: 'J/cm²', decimals: 1, kind: 'running' },
]

/** The variety shown: the one in the link, else the one last chosen on this device, else Mathieu, else the first. */
export function pickVariety(varieties: readonly { id: string; name: string }[], fromLink: string | null, remembered: string | null): string | undefined {
  const has = (id: string | null) => id !== null && varieties.some((v) => v.id === id)
  if (has(fromLink)) return fromLink!
  if (has(remembered)) return remembered!
  return (varieties.find((v) => v.name.trim().toLowerCase() === 'mathieu') ?? varieties[0])?.id
}

/** One combined hourly value (crop_climate_hourly). value null: not enough zones had a usable reading. */
export type VarietyHour = {
  hour_utc: string
  local_date: string
  local_hour: number
  metric: VarietyMetric
  value: number | null
  method: 'mean' | 'area_weighted' | 'greenhouse'
  zones_assigned: number
  zones_used: number
  coverage: number
  inputs: { zone: string; value: number | null; share: number | null; reading_id: number | null; file_id: string | null }[]
}

/** One combined daily value (crop_climate_daily). */
export type VarietyDay = {
  local_date: string
  metric: VarietyMetric
  value: number | null
  status: 'final' | 'partial' | 'running' | 'incomplete' | 'no_data'
  hours: number
  min_value: number | null
  max_value: number | null
  running_value: number | null
  running_hour: number | null
  restart_hour: number | null
  method: string | null
  zones_assigned: number | null
  min_coverage: number | null
}

const n = (v: unknown) => (v === null || v === undefined ? null : Number(v))

/** PostgREST numerics arrive as numbers or strings. */
export function normalizeDay(r: VarietyDay): VarietyDay {
  return { ...r, value: n(r.value), min_value: n(r.min_value), max_value: n(r.max_value), running_value: n(r.running_value), min_coverage: n(r.min_coverage) }
}
export function normalizeHour(r: VarietyHour): VarietyHour {
  return { ...r, value: n(r.value), coverage: Number(r.coverage) }
}

/** ISO week of a YYYY-MM-DD date. */
export function isoWeekOf(date: string): { year: number; week: number } {
  const d = new Date(`${date}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7))
  const year = d.getUTCFullYear()
  return { year, week: Math.ceil(((d.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7) }
}

/**
 * A week of one measurement.
 *   hourly (temperature, RH, CO₂): hour-weighted mean of the days' means; hours = hours with a value
 *   running (radiation, irrigation): sum of the week's final days; finalDays of days
 * value is null when nothing usable was recorded: missing is never 0.
 */
export type ClimateWeek = { year: number; week: number; key: string; value: number | null; hours: number; finalDays: number; days: number; complete: boolean }

export function weeklyClimate(days: readonly VarietyDay[], metric: VarietyMetric): ClimateWeek[] {
  const kind = VARIETY_METRICS.find((m) => m.key === metric)!.kind
  const weeks = new Map<string, ClimateWeek & { sum: number }>()
  for (const d of days) {
    if (d.metric !== metric) continue
    const w = isoWeekOf(d.local_date)
    const key = `${w.year}-W${String(w.week).padStart(2, '0')}`
    const acc = weeks.get(key) ?? { ...w, key, value: null, hours: 0, finalDays: 0, days: 0, complete: false, sum: 0 }
    acc.days++
    if (kind === 'hourly') {
      if (d.value !== null && d.hours > 0) {
        acc.sum += d.value * d.hours
        acc.hours += d.hours
      }
      if (d.status === 'final') acc.finalDays++
    } else if (d.status === 'final' && d.value !== null) {
      acc.sum += d.value
      acc.finalDays++
    }
    weeks.set(key, acc)
  }
  return [...weeks.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(({ sum, ...w }) => ({
      ...w,
      value: kind === 'hourly' ? (w.hours > 0 ? sum / w.hours : null) : w.finalDays > 0 ? sum : null,
      complete: w.days === 7 && w.finalDays === 7,
    }))
}

const hh = (h: number) => `${String(h).padStart(2, '0')}:00`

/** One day's value for display: final ones plain, partial ones marked; never a 0 for missing data. */
export function dayCell(d: VarietyDay | undefined, decimals: number): { text: string; title: string; tone: 'final' | 'partial' | 'none' } {
  if (!d) return { text: '—', title: 'No data.', tone: 'none' }
  const fmt = (v: number) => v.toFixed(decimals)
  const kind = VARIETY_METRICS.find((m) => m.key === d.metric)!.kind
  if (kind === 'hourly') {
    if (d.value === null || d.hours === 0) return { text: '—', title: 'No hour with enough zones reporting.', tone: 'none' }
    const range = d.min_value !== null && d.max_value !== null ? ` (${fmt(d.min_value)}–${fmt(d.max_value)})` : ''
    if (d.status === 'final') return { text: fmt(d.value), title: `Mean of 24 hours${range}.`, tone: 'final' }
    return { text: `${fmt(d.value)} · ${d.hours}/24 h`, title: `${d.status === 'running' ? 'Today so far' : 'Hours missing'}: mean of ${d.hours} hours${range}.`, tone: 'partial' }
  }
  switch (d.status) {
    case 'final':
      return { text: fmt(d.value!), title: 'Final: the 23:00 reading.', tone: 'final' }
    case 'running':
      return d.running_value === null
        ? { text: 'Not started', title: 'The day’s value starts at the counter’s restart; final at 23:00.', tone: 'partial' }
        : { text: `${fmt(d.running_value)} so far`, title: `Running total at ${hh(d.running_hour!)}; the day’s value is the 23:00 reading.`, tone: 'partial' }
    case 'incomplete':
      return d.running_value === null
        ? { text: 'Incomplete', title: 'No 23:00 reading.', tone: 'partial' }
        : { text: `≥ ${fmt(d.running_value)} · incomplete`, title: `No 23:00 reading: last running total ${fmt(d.running_value)} at ${hh(d.running_hour!)}.`, tone: 'partial' }
    default:
      return { text: '—', title: 'No data.', tone: 'none' }
  }
}
