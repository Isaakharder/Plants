// Hourly increments of a running total that restarts every day (radiation sum
// since midnight; cumulative irrigation and drain likewise), for one zone.
//
// An hour's increment is given only when it can be read off two consecutive
// valid readings:
//   ok        same day, consecutive hours: this − previous (never negative)
//   reset     the counter restarted (the day changed, or a reset hour): this value
//   gap       the previous hour is missing: no value (not spread over the gap)
//   decrease  the total fell without a reset: a counter problem, no value
//   after_decrease  the hour after such a fall: one of the two readings is wrong,
//             so this difference can't be trusted either, no value
//   first     no earlier reading
// Daily totals are the day's last valid reading; complete only when the day's
// last hour (23:00) is there and nothing went wrong that day.

export type CumulativePoint = {
  /** UTC instant of the reading (whole hour). */
  hourUtc: string
  /** Greenhouse-local calendar date (YYYY-MM-DD) and hour of the reading. */
  localDate: string
  localHour: number
  /** null: missing or flagged unusable. */
  value: number | null
}

export type IncrementStatus = 'ok' | 'reset' | 'gap' | 'decrease' | 'after_decrease' | 'first' | 'missing'

export type Increment = { hourUtc: string; localDate: string; localHour: number; value: number | null; status: IncrementStatus }

export type CumulativeOptions = {
  /** Local hours at which the counter may restart besides a change of date (default none). */
  resetHours?: number[]
  /** Rounding noise tolerated before a fall counts as a decrease (default 0.05). */
  tolerance?: number
}

const HOUR = 3_600_000

export function cumulativeIncrements(points: CumulativePoint[], options: CumulativeOptions = {}): Increment[] {
  const tolerance = options.tolerance ?? 0.05
  const resetHours = new Set(options.resetHours ?? [])
  const sorted = [...points].sort((a, b) => Date.parse(a.hourUtc) - Date.parse(b.hourUtc))
  const out: Increment[] = []
  let prev: CumulativePoint | null = null
  let prevFell = false
  for (const p of sorted) {
    const base = { hourUtc: p.hourUtc, localDate: p.localDate, localHour: p.localHour }
    if (p.value === null) {
      out.push({ ...base, value: null, status: 'missing' })
      continue
    }
    if (!prev) {
      out.push({ ...base, value: null, status: 'first' })
    } else {
      const consecutive = Date.parse(p.hourUtc) - Date.parse(prev.hourUtc) === HOUR
      const restarted = p.localDate !== prev.localDate || resetHours.has(p.localHour)
      const fell = consecutive && p.value < prev.value! - tolerance && !restarted
      if (!consecutive) out.push({ ...base, value: null, status: 'gap' })
      else if (fell) out.push({ ...base, value: null, status: 'decrease' })
      else if (prevFell && !restarted) out.push({ ...base, value: null, status: 'after_decrease' })
      else if (p.value >= prev.value! - tolerance) out.push({ ...base, value: Math.max(0, p.value - prev.value!), status: 'ok' })
      else out.push({ ...base, value: p.value, status: 'reset' })
      prevFell = fell
    }
    prev = p
  }
  return out
}

export type DailyTotal = {
  localDate: string
  /** The day's last valid reading (the running total so far). */
  total: number | null
  hoursPresent: number
  complete: boolean
  problems: ('no_late_reading' | 'decrease' | 'no_readings')[]
}

/** Per local date: the running total at the end of the day, and whether it can be trusted. */
export function dailyTotals(points: CumulativePoint[], options: CumulativeOptions = {}): DailyTotal[] {
  const increments = cumulativeIncrements(points, options)
  const byDate = new Map<string, { points: CumulativePoint[]; increments: Increment[] }>()
  const sorted = [...points].sort((a, b) => Date.parse(a.hourUtc) - Date.parse(b.hourUtc))
  for (const p of sorted) {
    const d = byDate.get(p.localDate) ?? { points: [], increments: [] }
    d.points.push(p)
    byDate.set(p.localDate, d)
  }
  for (const i of increments) byDate.get(i.localDate)?.increments.push(i)
  return [...byDate.entries()].map(([localDate, d]) => {
    const valid = d.points.filter((p) => p.value !== null)
    const last = valid[valid.length - 1]
    const problems: DailyTotal['problems'] = []
    if (valid.length === 0) problems.push('no_readings')
    else if (last.localHour < 23) problems.push('no_late_reading')
    if (d.increments.some((i) => i.status === 'decrease')) problems.push('decrease')
    return { localDate, total: last?.value ?? null, hoursPresent: valid.length, complete: problems.length === 0, problems }
  })
}
