import { describe, expect, it } from 'vitest'
import {
  accuracyOf,
  chooseForecast,
  formatError,
  historyWeeks,
  latestActuals,
  phaseOf,
  productionHistory,
  weekStartsAt,
  type Actual,
  type HistoryCrop,
  type Snapshot,
} from './productionHistory'

// Shaped like production on 2026-10-22 (W43, a Thursday).
const NOW = 202643
const crop = (id: string, color: string): HistoryCrop => ({ id, name: id, color, plantingDate: '2026-01-05', pulloutDate: '2026-12-20' })
const CROPS = [crop('Cadalora', 'red'), crop('Mathieu', 'red'), crop('Silverstone', 'orange'), crop('P3 Levente', 'yellow')]
const snap = (cropId: string, originYw: number, targetYw: number, savedAt: string, kg: number | null, kind: Snapshot['kind'] = 'preliminary', available = true): Snapshot => ({
  cropId, originYw, targetYw, savedAt, kg, kind, available,
})
const SNAPSHOTS: Snapshot[] = [
  // Cadalora W43: two versions on Friday W42, two more saved after W43 had begun (Monday 19 Oct, 04:00 UTC).
  snap('Cadalora', 202642, 202643, '2026-10-16T20:30:33Z', 54222),
  snap('Cadalora', 202642, 202643, '2026-10-17T00:25:00Z', 44653),
  snap('Cadalora', 202642, 202643, '2026-10-22T23:02:00Z', 57411),
  snap('Cadalora', 202642, 202644, '2026-10-17T00:25:00Z', null, 'preliminary', false), // beyond a Breaker forecast
  snap('Mathieu', 202642, 202643, '2026-10-17T00:26:19Z', 17730),
  snap('Silverstone', 202642, 202643, '2026-10-17T00:27:18Z', 21371),
  snap('P3 Levente', 202642, 202643, '2026-10-17T00:26:37Z', 6677),
  // W44: official locks on W43, and a preliminary saved after one of them.
  snap('Cadalora', 202643, 202644, '2026-10-22T20:20:41Z', 16496, 'official'),
  snap('P3 Levente', 202643, 202644, '2026-10-22T11:49:16Z', 2993, 'official'),
  snap('P3 Levente', 202643, 202644, '2026-10-22T16:00:06Z', 3421),
  snap('Silverstone', 202643, 202644, '2026-10-22T17:40:04Z', null, 'official'), // no AFW
  // Far future: outside the 8-week horizon.
  snap('Mathieu', 202643, 202653, '2026-10-22T21:24:48Z', 999),
]
const ACTUALS: Actual[] = [
  { cropId: 'Cadalora', yw: 202642, kg: 28694, enteredAt: '2026-10-16T20:37:00Z' },
  { cropId: 'Silverstone', yw: 202642, kg: 9648, enteredAt: '2026-10-16T20:32:00Z' },
  { cropId: 'Silverstone', yw: 202643, kg: 15567, enteredAt: '2026-10-23T00:17:00Z' },
  { cropId: 'P3 Levente', yw: 202643, kg: 5251, enteredAt: '2026-10-23T00:20:00Z' },
]

describe('weeks', () => {
  it('start at Monday 00:00 greenhouse time, daylight saving included', () => {
    expect(new Date(weekStartsAt(202643)).toISOString()).toBe('2026-10-19T04:00:00.000Z') // EDT
    expect(new Date(weekStartsAt(202650)).toISOString()).toBe('2026-12-07T05:00:00.000Z') // EST
    expect([phaseOf(202642, NOW), phaseOf(202643, NOW), phaseOf(202644, NOW)]).toEqual(['completed', 'current', 'future'])
    expect(phaseOf(202701, 202653)).toBe('future')
  })

  it('run from the first saved projection or actual to the furthest forecast within 8 weeks, newest first', () => {
    // W42 (an actual), W43 (now), W44 (forecasts); W53 is beyond the horizon; the n/a W44 doesn't extend anything.
    expect(historyWeeks(2026, NOW, SNAPSHOTS, ACTUALS)).toEqual([202644, 202643, 202642])
    expect(historyWeeks(2026, NOW, [], [])).toEqual([])
    // A gap is filled, so a missing week shows as missing.
    expect(historyWeeks(2026, NOW, [snap('Mathieu', 202639, 202640, '2026-10-02T20:00:00Z', 1)], [])).toEqual([202643, 202642, 202641, 202640])
  })
})

describe('choosing the saved forecast', () => {
  const cad = SNAPSHOTS.filter((s) => s.cropId === 'Cadalora')
  it('uses the latest version saved before the target week began, never a later one', () => {
    expect(chooseForecast(cad, 202643, 'current').forecast?.kg).toBe(44653)
    expect(chooseForecast(cad, 202643, 'completed').forecast?.kg).toBe(44653)
  })

  it('prefers the locked forecast of the same sampling week, even if a preliminary was saved later', () => {
    expect(chooseForecast(SNAPSHOTS.filter((s) => s.cropId === 'P3 Levente'), 202644, 'future').forecast).toMatchObject({ kg: 2993, kind: 'official' })
  })

  it('prefers a newer sampling week over an older locked one', () => {
    const s = [snap('X', 202642, 202645, '2026-10-16T20:00:00Z', 100, 'official'), snap('X', 202643, 202645, '2026-10-22T20:00:00Z', 120)]
    expect(chooseForecast(s, 202645, 'future').forecast?.kg).toBe(120)
  })

  it('names why there is none', () => {
    expect(chooseForecast([snap('X', 202643, 202643, '2026-10-22T20:00:00Z', 5)], 202643, 'current').missing).toBe('saved_after_start')
    expect(chooseForecast([snap('X', 202642, 202644, '2026-10-17T00:25:00Z', null, 'preliminary', false)], 202644, 'completed').missing).toBe('not_available')
    expect(chooseForecast([], 202643, 'completed').missing).toBe('no_forecast')
    expect(chooseForecast(SNAPSHOTS.filter((s) => s.cropId === 'Silverstone'), 202644, 'future')).toMatchObject({ missing: 'afw_needed' })
  })
})

describe('the page', () => {
  const page = productionHistory(CROPS, SNAPSHOTS, ACTUALS, 2026, NOW)
  const row = (yw: number) => page.rows.find((r) => r.yw === yw)!

  it('shows projected and actual per colour, never counting missing values as zero', () => {
    const red43 = row(202643).byGroup.get('red')!
    expect(red43).toMatchObject({ projected: 44653 + 17730, projectedComplete: true, actual: null, actualComplete: false, matchedCount: 0, errorPct: null })
    const red42 = row(202642).byGroup.get('red')!
    expect(red42).toMatchObject({ projected: null, projectedComplete: false, actual: 28694, actualComplete: false })
    expect(red42.parts.map((p) => [p.crop.id, p.forecastMissing, p.actualMissing])).toEqual([
      ['Cadalora', 'no_forecast', null],
      ['Mathieu', 'no_forecast', 'not_entered'],
    ])
  })

  it('keeps the current week out of accuracy, and future weeks without actuals', () => {
    const orange43 = row(202643).byGroup.get('orange')!
    expect(orange43).toMatchObject({ projected: 21371, actual: 15567, matchedCount: 0, errorPct: null }) // in progress
    expect(row(202644).all.parts.every((p) => p.actualMissing === 'future' && p.actualKg === null)).toBe(true)
  })

  it('computes accuracy only over completed weeks with both values, with the error sign', () => {
    const done = productionHistory(CROPS, SNAPSHOTS, ACTUALS, 2026, 202644) // W43 now completed
    const yellow = done.accuracy.byGroup.get('yellow')!
    // P3 Levente: 6677 projected, 5251 actual: (6677 − 5251) / 6677 = +21.4% (overestimated).
    expect(yellow).toMatchObject({ projected: 6677, actual: 5251, matched: 1 })
    expect(formatError(yellow.errorPct)).toBe('+21.4%')
    const all = done.accuracy.all
    // Matched: Silverstone W43 and P3 Levente W43. Cadalora/Mathieu W43 have no actual; W42 has no forecast.
    expect(all).toMatchObject({ projected: 21371 + 6677, actual: 15567 + 5251, matched: 2, weeks: 1 })
    expect(all.excluded).toEqual({ forecast: 4, actual: 2 })
    // (28048 − 20818) / 28048 = +25.8%
    expect(formatError(all.errorPct)).toBe('+25.8%')
  })

  it('reports no accuracy rather than 0% when nothing matches', () => {
    expect(accuracyOf([], (r) => r.all)).toMatchObject({ errorPct: null, matched: 0 })
    expect(formatError(null)).toBe('—')
    expect(formatError(-8.06)).toBe('−8.1%')
  })
})

describe('actual kg', () => {
  it('uses the newest entry per variety and week; a cleared week is missing', () => {
    const got = latestActuals([
      { id: 1, crop_id: 'A', year: 2026, week: 42, actual_kg: '1234.00', entered_at: '2026-10-16T10:00:00Z' },
      { id: 2, crop_id: 'A', year: 2026, week: 42, actual_kg: '1300.00', entered_at: '2026-10-16T11:00:00Z' },
      { id: 3, crop_id: 'A', year: 2026, week: 43, actual_kg: '900.00', entered_at: '2026-10-22T10:00:00Z' },
      { id: 4, crop_id: 'A', year: 2026, week: 43, actual_kg: null, entered_at: '2026-10-22T11:00:00Z' },
    ])
    expect(got.map((a) => [a.yw, a.kg])).toEqual([[202642, 1300], [202643, null]])
  })
})
