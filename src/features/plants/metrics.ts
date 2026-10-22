// Plants › Metrics: weekly fruit counts per variety (weekly_variety_metrics()),
// shaped into a variety × metric × week table and reported per m². Pure, so it
// can be tested.
//
// Per m² (the same conversion as Projections › Weekly Plant Data):
//   metric/m² = (count on the sampled stems ÷ sampled stems observed that week)
//               × the variety's stems/m² (picking stems ÷ area, from Settings)
// The underlying per-stem counts are unchanged; only the report converts them.

import { isoWeekIndex } from './twin'

export type WeekMetrics = {
  crop_id: string
  yw: number
  /** Sampled stems observed that week: the denominator of every count. */
  stems: number
  /** The variety's sampled stems by then; fewer observed = partial sampling. */
  expected_stems: number
  rows_: number
  set_fruit: number
  fruit_load: number
  breakers: number
}

export type MetricKey = 'set_fruit' | 'fruit_load' | 'breakers'

export const METRICS: readonly { key: MetricKey; label: string; counted: string }[] = [
  { key: 'set_fruit', label: 'Fruit Set /m²', counted: 'fruit set' },
  { key: 'fruit_load', label: 'Fruit Load /m²', counted: 'fruit on the plant (set, mature green, breaker)' },
  { key: 'breakers', label: 'Breakers /m²', counted: 'breakers' },
]

/** Fewer sampled stems observed than this share = partial sampling (the forecast's LOW_COVERAGE rule). */
export const MIN_COVERAGE = 0.9

/** The variety's stems per m² (picking stems ÷ area), or null when either is missing or not positive. */
export function stemsPerM2(crop: { picking_stems: number | null; area_m2: number | null }): number | null {
  const stems = Number(crop.picking_stems), area = Number(crop.area_m2)
  return Number.isFinite(stems) && Number.isFinite(area) && stems > 0 && area > 0 ? stems / area : null
}

/** The metric per m², or null without observed stems or a usable stems/m². */
export function perM2(m: WeekMetrics | undefined, key: MetricKey, density: number | null): number | null {
  if (!m || m.stems <= 0 || density === null) return null
  return (m[key] / m.stems) * density
}

/** Partial sampling: fewer than 90% of the variety's sampled stems observed that week. */
export const isPartial = (m: WeekMetrics | undefined) => Boolean(m && m.expected_stems > 0 && m.stems / m.expected_stems < MIN_COVERAGE)

export const formatPerM2 = (v: number | null) => (v === null ? '—' : v.toFixed(1))

export type Week = { year: number; week: number; yw: number; index: number }

/** The ISO week starting `index` weeks after 1970-W01 (inverse of isoWeekIndex). */
export function weekOfIsoIndex(index: number): Week {
  const monday = (index - 1) * 7 + 4 // days since 1970-01-01 (a Thursday)
  const thursday = new Date((monday + 3) * 86_400_000)
  const year = thursday.getUTCFullYear()
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / (7 * 86_400_000)) + 1
  return { year, week, yw: year * 100 + week, index }
}

/** Every ISO week from the earliest to the latest with data, gaps included. */
export function weekRange(rows: readonly Pick<WeekMetrics, 'yw'>[]): Week[] {
  if (rows.length === 0) return []
  const indexes = rows.map((r) => isoWeekIndex(Math.floor(r.yw / 100), r.yw % 100))
  const first = Math.min(...indexes), last = Math.max(...indexes)
  return Array.from({ length: last - first + 1 }, (_, i) => weekOfIsoIndex(first + i))
}

/** "W20"; with the year when the range spans more than one ("2026-W52"). */
export const weekLabel = (w: Week, multiYear: boolean) => (multiYear ? `${w.year}-W${String(w.week).padStart(2, '0')}` : `W${w.week}`)

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** Tooltip: the count, the sampled stems it is divided by, the rows, and the conversion to /m². */
export function cellDetail(m: WeekMetrics | undefined, key: MetricKey, variety: string, label: string, density: number | null): string {
  const metric = METRICS.find((x) => x.key === key)!
  const head = `${variety} · ${label} · ${metric.label}`
  if (!m || m.stems <= 0) return `${variety} · ${label}: no sampled stems observed this week`
  const counts = `${m[key]} ${metric.counted} on ${m.stems} of ${m.expected_stems} sampled stems (${plural(m.rows_, 'row')})`
  if (density === null) return `${head}: ${counts}. Not shown per m²: the variety's area or picking stems aren't set.`
  const perStem = m[key] / m.stems
  const partial = isPartial(m) ? ` Partial sampling: only ${m.stems} of ${m.expected_stems} sampled stems observed.` : ''
  return `${head}: ${counts} = ${perStem.toFixed(2)} per stem × ${density.toFixed(2)} stems/m² = ${(perStem * density).toFixed(1)} /m².${partial}`
}
