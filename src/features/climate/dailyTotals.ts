// Daily values of the running totals (climate_daily_totals): radiation sum and
// drain % for the whole greenhouse, cumulative irrigation per zone. A day's
// value is its final file's reading (radiation and irrigation 23:00, drain
// 22:00); running totals are never summed or averaged over the day.

export type TotalMetric = 'radiation_sum' | 'drain_percentage' | 'irrigation_cumulative'

export type DailyTotalRow = {
  local_date: string
  metric: TotalMetric
  zone_id: string
  final_hour: number
  final_value: number | null
  status: 'final' | 'running' | 'incomplete' | 'no_data'
  running_value: number | null
  running_hour: number | null
  restart_hour: number | null
  problems: string[]
}

export const TOTAL_METRICS: { key: TotalMetric; label: string; unit: string; decimals: number; greenhouse: boolean; weekly: 'sum' | 'mean' }[] = [
  { key: 'radiation_sum', label: 'Radiation sum', unit: 'J/cm²', decimals: 1, greenhouse: true, weekly: 'sum' },
  { key: 'irrigation_cumulative', label: 'Irrigation', unit: 'ml/dripper', decimals: 0, greenhouse: false, weekly: 'sum' },
  { key: 'drain_percentage', label: 'Drain', unit: '%', decimals: 1, greenhouse: true, weekly: 'mean' },
]

const hh = (h: number) => `${String(h).padStart(2, '0')}:00`

export type TotalCell = { text: string; title: string; final: boolean }

/** One day's cell: the final value, or clearly a partial / missing one. */
export function totalCell(r: DailyTotalRow, decimals: number): TotalCell {
  const fmt = (v: number) => v.toFixed(decimals)
  const counter = r.problems.includes('counter_fell') ? ' The running total fell during the day (counter problem).' : ''
  switch (r.status) {
    case 'final':
      return { text: fmt(r.final_value!), title: `Final: the ${hh(r.final_hour)} reading.${counter}`, final: true }
    case 'running':
      return r.running_value === null
        ? { text: 'Not started', title: `Today's value starts when the counter restarts; final at ${hh(r.final_hour)}.`, final: false }
        : { text: `${fmt(r.running_value)} so far`, title: `Running total at ${hh(r.running_hour!)}; the day's value is the ${hh(r.final_hour)} reading.${counter}`, final: false }
    case 'incomplete':
      return r.running_value === null
        ? { text: `Incomplete`, title: `No ${hh(r.final_hour)} reading, and no reading after the day's restart.`, final: false }
        : { text: `≥ ${fmt(r.running_value)} · incomplete`, title: `No ${hh(r.final_hour)} reading: last running total ${fmt(r.running_value)} at ${hh(r.running_hour!)}.${counter}`, final: false }
    case 'no_data':
      return { text: '—', title: 'No file in effect for this day.', final: false }
  }
}

/** ISO week (Monday-based) of a YYYY-MM-DD date. */
function isoWeekOf(date: string): { year: number; week: number } {
  const d = new Date(`${date}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7))
  const year = d.getUTCFullYear()
  return { year, week: Math.ceil(((d.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7) }
}

export type WeeklyTotal = { key: string; label: string; value: number | null; finalDays: number; days: number }

/** Per ISO week: the sum (radiation, irrigation) or mean (drain %) of its final days only. */
export function weeklyTotals(rows: readonly DailyTotalRow[], kind: 'sum' | 'mean'): WeeklyTotal[] {
  const weeks = new Map<string, WeeklyTotal & { sum: number }>()
  for (const r of rows) {
    const w = isoWeekOf(r.local_date)
    const key = `${w.year}-W${String(w.week).padStart(2, '0')}`
    const acc = weeks.get(key) ?? { key, label: `W${w.week} ${w.year}`, value: null, finalDays: 0, days: 0, sum: 0 }
    acc.days++
    if (r.status === 'final' && r.final_value !== null) {
      acc.finalDays++
      acc.sum += r.final_value
    }
    weeks.set(key, acc)
  }
  return [...weeks.values()]
    .sort((a, b) => b.key.localeCompare(a.key))
    .map(({ sum, ...w }) => ({ ...w, value: w.finalDays === 0 ? null : kind === 'sum' ? sum : sum / w.finalDays }))
}
