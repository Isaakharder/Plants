// Plants › Metrics: weekly fruit counts per variety (weekly_variety_metrics()),
// shaped into a variety × metric × week table. Pure, so it can be tested.

import { isoWeekIndex } from './twin'

export type WeekMetrics = {
  crop_id: string
  yw: number
  stems: number
  rows_: number
  set_fruit: number
  fruit_load: number
  breakers: number
}

export type MetricKey = 'set_fruit' | 'fruit_load' | 'breakers'

export const METRICS: readonly { key: MetricKey; label: string; counted: string }[] = [
  { key: 'set_fruit', label: 'Avg Fruit Set', counted: 'fruit set' },
  { key: 'fruit_load', label: 'Avg Fruit Load', counted: 'fruit on the plant (set, mature green, breaker)' },
  { key: 'breakers', label: 'Avg Breakers', counted: 'breakers' },
]

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

/** The per-stem average to 1 decimal, or "—" without data. */
export function average(m: WeekMetrics | undefined, key: MetricKey): string {
  if (!m || m.stems === 0) return '—'
  return (m[key] / m.stems).toFixed(1)
}

/** Tooltip: the count, the stems it is divided by, and the rows they are in. */
export function cellDetail(m: WeekMetrics | undefined, key: MetricKey, variety: string, label: string): string {
  const metric = METRICS.find((x) => x.key === key)!
  if (!m || m.stems === 0) return `${variety} · ${label}: no stems observed this week`
  return `${variety} · ${label} · ${metric.label}: ${m[key]} ${metric.counted} ÷ ${m.stems} stem${m.stems === 1 ? '' : 's'} observed · ${m.rows_} row${m.rows_ === 1 ? '' : 's'}`
}
