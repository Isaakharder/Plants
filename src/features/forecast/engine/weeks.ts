// Week arithmetic for the forecast engine. Weeks are ISO weeks; internally a
// week is its index: the number of weeks from the Monday 1970-01-05 (day 4
// after the epoch) to its Monday, so consecutive weeks differ by exactly 1
// across New Year and week 53.

export type YearWeek = { year: number; week: number }

/** Monday of an ISO week as days since 1970-01-01. */
function mondayDays(year: number, week: number): number {
  const jan4 = Date.UTC(year, 0, 4)
  const jan4Weekday = new Date(jan4).getUTCDay() || 7
  return jan4 / 86_400_000 - (jan4Weekday - 1) + (week - 1) * 7
}

/** Monday 1970-01-05 is day 4 after the epoch. */
const indexOfMonday = (days: number) => (days - 4) / 7

/** The week's index (consecutive weeks differ by 1). */
export const weekIndex = (year: number, week: number): number => indexOfMonday(mondayDays(year, week))

/** yyyyww (e.g. 202641) → index. */
export const ywIndex = (yw: number): number => weekIndex(Math.floor(yw / 100), yw % 100)

/** Index → ISO year and week. */
export function weekOfIndex(index: number): YearWeek {
  const days = index * 7 + 4 + 3 // Thursday decides the ISO year
  const thursday = new Date(days * 86_400_000)
  const year = thursday.getUTCFullYear()
  const week = Math.floor((days - mondayDays(year, 1) - 3) / 7) + 1
  return { year, week }
}

/** Index → yyyyww. */
export const indexYw = (index: number): number => {
  const { year, week } = weekOfIndex(index)
  return year * 100 + week
}

/** "W41" or "W41 2025" when outside the given year. */
export function weekLabel(index: number, year?: number): string {
  const w = weekOfIndex(index)
  return year === undefined || w.year === year ? `W${w.week}` : `W${w.week} ${w.year}`
}

/** The greenhouse (Toronto) ISO week of an instant, as an index. */
export function greenhouseWeekIndex(at: Date): number {
  const p: Record<string, number> = {}
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: 'America/Toronto', year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(at)) {
    if (x.type !== 'literal') p[x.type] = Number(x.value)
  }
  const days = Date.UTC(p.year, p.month - 1, p.day) / 86_400_000
  const weekday = (new Date(days * 86_400_000).getUTCDay() + 6) % 7 // Monday = 0
  return indexOfMonday(days - weekday)
}

/** Monday 00:00 America/Toronto of a week, as an instant. */
export function weekStartInstant(index: number): Date {
  const { year, week } = weekOfIndex(index)
  const days = mondayDays(year, week)
  // Toronto is UTC−5 or UTC−4; find the UTC instant whose Toronto date is that Monday at 00:00.
  for (const offsetHours of [4, 5]) {
    const at = new Date((days * 24 + offsetHours) * 3_600_000)
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Toronto', hour: 'numeric', hourCycle: 'h23' }).format(at)
    if (Number(parts) === 0 && greenhouseWeekIndex(at) === index) return at
  }
  return new Date((days * 24 + 5) * 3_600_000)
}
