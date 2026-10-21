import { describe, expect, it } from 'vitest'
import { weeklyClimate, type VarietyDay } from './varietyClimate'

const day = (local_date: string, metric: VarietyDay['metric'], over: Partial<VarietyDay>): VarietyDay => ({
  local_date, metric, value: null, status: 'final', hours: 24, min_value: null, max_value: null, running_value: null, running_hour: null, restart_hour: null,
  method: 'mean', zones_assigned: 3, min_coverage: 1, ...over,
})

describe('weekly climate for a variety', () => {
  it('weights hourly measurements by the hours present; a day without data adds nothing (never 0)', () => {
    const w = weeklyClimate([
      day('2026-10-19', 'air_temperature', { value: 20, hours: 24 }),
      day('2026-10-20', 'air_temperature', { value: 26, hours: 12, status: 'partial' }),
      day('2026-10-21', 'air_temperature', { value: null, hours: 0, status: 'no_data' }),
    ], 'air_temperature')
    expect(w).toEqual([{ year: 2026, week: 43, key: '2026-W43', value: 22, hours: 36, finalDays: 1, days: 3, complete: false }])
  })

  it('adds up the final days of running totals only; partial days are counted, not added', () => {
    const w = weeklyClimate([
      day('2026-10-19', 'radiation_sum', { value: 1676.9 }),
      day('2026-10-20', 'radiation_sum', { value: 1551.6 }),
      day('2026-10-21', 'radiation_sum', { status: 'running', running_value: 736.3, running_hour: 13 }),
      day('2026-10-18', 'radiation_sum', { status: 'incomplete', running_value: 900 }),
    ], 'radiation_sum')
    expect(w.map((x) => [x.key, x.value, x.finalDays, x.days])).toEqual([['2026-W42', null, 0, 1], ['2026-W43', 3228.5, 2, 3]])
  })

  it('a complete week has 7 final days', () => {
    const days = Array.from({ length: 7 }, (_, i) => day(`2026-10-${12 + i}`, 'irrigation_cumulative', { value: 800 }))
    expect(weeklyClimate(days, 'irrigation_cumulative')[0]).toMatchObject({ value: 5600, finalDays: 7, complete: true })
  })
})
