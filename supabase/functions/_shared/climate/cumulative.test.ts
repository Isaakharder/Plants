import { describe, expect, it } from 'vitest'
import { cumulativeIncrements, dailyTotals, type CumulativePoint } from './cumulative.ts'
import { wallClock } from './zonedTime.ts'

/** Hourly radiation-sum readings starting at a UTC hour; null = missing/unusable, undefined = no file. */
function series(startUtc: string, values: (number | null | undefined)[]): CumulativePoint[] {
  const out: CumulativePoint[] = []
  values.forEach((value, i) => {
    if (value === undefined) return
    const t = Date.parse(startUtc) + i * 3_600_000
    const w = wallClock(t, 'America/Toronto')
    out.push({
      hourUtc: new Date(t).toISOString(),
      localDate: `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`,
      localHour: w.hour,
      value,
    })
  })
  return out
}

describe('hourly increments of a daily running total', () => {
  // 17 Oct, 08:00–12:00 Toronto (12:00–16:00 UTC).
  it('consecutive hours: the difference', () => {
    const inc = cumulativeIncrements(series('2026-10-17T12:00:00Z', [24.6, 80.1, 148.9, 230.0]))
    expect(inc.map((i) => [i.status, i.value])).toEqual([
      ['first', null],
      ['ok', expect.closeTo(55.5, 6)],
      ['ok', expect.closeTo(68.8, 6)],
      ['ok', expect.closeTo(81.1, 6)],
    ])
  })

  it('a missing hour gives no increment (it is not spread over the gap)', () => {
    const inc = cumulativeIncrements(series('2026-10-17T12:00:00Z', [24.6, undefined, 148.9, 230.0]))
    expect(inc.map((i) => i.status)).toEqual(['first', 'gap', 'ok'])
    expect(inc[1].value).toBeNull()
  })

  it('a flagged reading is missing; the next hour waits for two valid readings', () => {
    const inc = cumulativeIncrements(series('2026-10-17T12:00:00Z', [24.6, null, 148.9, 230.0]))
    expect(inc.map((i) => i.status)).toEqual(['first', 'missing', 'gap', 'ok'])
  })

  it('the midnight reset: the new day’s first value is that hour’s increment', () => {
    // 22:00, 23:00, 00:00, 01:00 Toronto on 17/18 Oct (EDT).
    const inc = cumulativeIncrements(series('2026-10-18T02:00:00Z', [912.4, 912.4, 0, 0]))
    expect(inc.map((i) => [i.localHour, i.status, i.value])).toEqual([
      [22, 'first', null],
      [23, 'ok', 0],
      [0, 'reset', 0],
      [1, 'ok', 0],
    ])
  })

  it('a fall during the day is a counter problem, not a negative increment', () => {
    const inc = cumulativeIncrements(series('2026-10-17T12:00:00Z', [24.6, 80.1, 12.0, 30.0]))
    expect(inc.map((i) => [i.status, i.value])).toEqual([
      ['first', null],
      ['ok', expect.closeTo(55.5, 6)],
      ['decrease', null],
      // The next hour's difference rests on the suspect reading: not trusted either.
      ['after_decrease', null],
    ])
  })

  it('rounding noise is not a decrease', () => {
    const inc = cumulativeIncrements(series('2026-10-17T12:00:00Z', [80.1, 80.08]))
    expect(inc[1]).toMatchObject({ status: 'ok', value: 0 })
  })

  it('a counter with another reset hour (e.g. irrigation starting its day at 06:00)', () => {
    // 05:00 and 06:00 Toronto.
    const inc = cumulativeIncrements(series('2026-10-17T09:00:00Z', [350, 0]), { resetHours: [6] })
    expect(inc[1]).toMatchObject({ status: 'reset', value: 0 })
  })

  it('across the autumn clock change the hours stay consecutive in UTC', () => {
    // 00:00 EDT, 01:00 EDT, 01:00 EST, 02:00 EST on 1 Nov.
    const inc = cumulativeIncrements(series('2026-11-01T04:00:00Z', [0, 0, 0, 0]))
    expect(inc.map((i) => i.status)).toEqual(['first', 'ok', 'ok', 'ok'])
    expect(inc.map((i) => i.localHour)).toEqual([0, 1, 1, 2])
  })
})

describe('daily totals', () => {
  it('the day’s last reading; complete only with the 23:00 reading and no counter problem', () => {
    // 17 Oct 20:00 → 18 Oct 01:00 Toronto.
    const full = dailyTotals(series('2026-10-18T00:00:00Z', [900, 910, 912.4, 912.4, 0, 0]))
    expect(full[0]).toMatchObject({ localDate: '2026-10-17', total: 912.4, hoursPresent: 4, complete: true })
    expect(full[1]).toMatchObject({ localDate: '2026-10-18', total: 0, complete: false, problems: ['no_late_reading'] })
    const short = dailyTotals(series('2026-10-18T00:00:00Z', [900, 910, undefined, undefined]))
    expect(short[0]).toMatchObject({ total: 910, complete: false, problems: ['no_late_reading'] })
    const bad = dailyTotals(series('2026-10-18T00:00:00Z', [900, 500, 910, 912.4]))
    expect(bad[0]).toMatchObject({ complete: false, problems: ['decrease'] })
  })
})
