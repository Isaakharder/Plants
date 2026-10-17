import { describe, expect, it } from 'vitest'
import type { CohortCell, SamplingWeekRow, SetHarvestCohortRow } from './model'
import { cohortDetail, harvestedKgSoFar, inUnit, shownAges, weekRanges, type TimelineContext } from './cohortTimeline'

/** Harvest-week rows holding one cohort's cells (set in `setWeek`), as set_harvest_cohorts() returns them. */
function rows(setWeek: number, sets: number, byDelay: Record<number, number | null>, outcome: { h: number; a: number; p: number; t: number; o: number; closed: boolean }): SetHarvestCohortRow[] {
  return Object.entries(byDelay).map(([d, harvested]) => {
    const delay = Number(d)
    const cell: CohortCell = {
      delay, set_year: 2026, set_week: setWeek, cohort_sets: sets, harvested: harvested ?? 0,
      percent: harvested === null ? null : (100 * harvested) / sets, is_baseline_cohort: false,
      cohort_harvested: outcome.h, cohort_aborted: outcome.a, cohort_pruned: outcome.p, cohort_timeout: outcome.t, cohort_on_plant: outcome.o, cohort_closed: outcome.closed,
    }
    return { iso_week: setWeek + delay, is_sampled: harvested !== null, is_provisional: false, harvested_total: 0, harvested_in_window: 0, harvested_without_set: 0, harvested_after_timeout: 0, cells: [cell], closing: {} as never }
  })
}
const sampling = (entries: [number, number, number][]) =>
  new Map(entries.map(([w, visited, expected]) => [w, { iso_week: w, visited_stems: visited, expected_stems: expected } as SamplingWeekRow]))
const ctx = (over: Partial<TimelineContext> = {}): TimelineContext => ({
  currentYw: 202642, sampling: new Map(), breakerOnly: (_y, w) => w >= 42, flagged: new Map(), ...over,
})

describe('cohort detail', () => {
  // Mathieu W30 (closed): 167 sets; harvested 73, aborted 72, pruned 15, unresolved 7.
  const w30 = rows(30, 167, { 0: 0, 3: 0, 5: 0, 6: 6, 7: 0, 8: 51, 9: 12, 10: 4 }, { h: 73, a: 72, p: 15, t: 7, o: 0, closed: true })

  it('takes the outcome straight from the cohort: harvested, aborted, pruned, unresolved, still on plant (they sum to the sets)', () => {
    const d = cohortDetail(w30, 2026, 30, 20.27, ctx())!
    expect(d).toMatchObject({ sets: 167, closed: true, outcome: { harvested: 73, aborted: 72, pruned: 15, unresolved: 7, onPlant: 0 } })
    const o = d.outcome
    expect(o.harvested + o.aborted + o.pruned + o.unresolved + o.onPlant).toBe(d.sets)
  })

  it('a sampled week with no harvest is a genuine 0%; a flagged week keeps its value with the reason', () => {
    const d = cohortDetail(w30, 2026, 30, 20.27, ctx({ flagged: new Map([[37, 'Harvests possibly not recorded']]) }))!
    const at = (delay: number) => d.ages.find((a) => a.delay === delay)!
    expect(at(5)).toMatchObject({ state: 'recorded', percent: 0, harvestWeek: 35 })
    expect(at(7)).toMatchObject({ state: 'incomplete', percent: 0, note: 'Harvests possibly not recorded' })
    expect(at(8).percent).toBeCloseTo(30.54, 2)
  })

  it('a partial visit (under 90% of stems) is incomplete', () => {
    const d = cohortDetail(w30, 2026, 30, 20.27, ctx({ sampling: sampling([[36, 40, 56]]) }))!
    expect(d.ages.find((a) => a.delay === 6)).toMatchObject({ state: 'incomplete', note: 'Partial visit: 40 of 56 stems.' })
  })

  // Mathieu W37 (open): 95 sets; 0 harvested, 55 aborted, 7 pruned, 33 on plant. W41 partial, W42 Breakers only.
  const w37 = rows(37, 95, { 0: 0, 3: 0, 4: 0, 5: 0, 6: null, 7: null }, { h: 0, a: 55, p: 7, t: 0, o: 33, closed: false })

  it('never shows a Breakers-only week, an unsampled week or a future week as 0%', () => {
    const d = cohortDetail(w37, 2026, 37, 11.53, ctx({ currentYw: 202644, breakerOnly: (_y, w) => w === 42 || w === 43, sampling: sampling([[41, 5, 56]]) }))!
    const at = (delay: number) => d.ages.find((a) => a.delay === delay)!
    expect(at(3)).toMatchObject({ state: 'recorded', percent: 0 }) // W40
    expect(at(4)).toMatchObject({ state: 'incomplete', percent: 0 }) // W41: 5 of 56 stems
    expect(at(5)).toMatchObject({ state: 'not_recorded', percent: null }) // W42: Breakers only
    expect(at(6)).toMatchObject({ state: 'not_recorded', percent: null }) // W43
    expect(at(7)).toMatchObject({ state: 'in_progress' }) // W44 is this week
    const notSampled = cohortDetail(w37, 2026, 37, 11.53, ctx({ currentYw: 202650, breakerOnly: () => false }))!
    expect(notSampled.ages.find((a) => a.delay === 6)).toMatchObject({ state: 'not_sampled', percent: null })
    const early = cohortDetail(w37, 2026, 37, 11.53, ctx({ currentYw: 202640 }))!
    expect(early.ages.find((a) => a.delay === 5)).toMatchObject({ state: 'future', percent: null })
  })

  it('shows +3 … +10 and any earlier age with a harvest', () => {
    const d = cohortDetail(rows(30, 10, { 1: 0, 2: 1, 3: 0, 4: 0 }, { h: 1, a: 0, p: 0, t: 0, o: 9, closed: false }), 2026, 30, 1, ctx({ breakerOnly: () => false }))!
    expect(shownAges(d).map((a) => a.delay)).toEqual([2, 3, 4])
  })

  it('units: %, per m² (Sets/m² × share), kg with that harvest week’s AFW; nothing without the inputs', () => {
    const d = cohortDetail(w30, 2026, 30, 20.27, ctx())!
    expect(inUnit(73, d, 'percent')).toBeCloseTo(43.71, 2)
    expect(inUnit(73, d, 'perM2')).toBeCloseTo((20.27 * 73) / 167, 6)
    expect(inUnit(51, d, 'kg', { afwG: 218, areaM2: 15000 })).toBeCloseTo((((20.27 * 51) / 167) * 218 * 15000) / 1000, 6)
    expect(inUnit(51, d, 'kg', { afwG: null, areaM2: 15000 })).toBeNull()
    expect(inUnit(51, d, 'kg')).toBeNull() // lost / still-on-plant fruit has no weight
    expect(inUnit(51, { ...d, setsPerM2: null }, 'perM2')).toBeNull()
    const afw: Record<number, number> = { 36: 228, 38: 218, 39: 209 } // W40 has no AFW
    const sum = harvestedKgSoFar(d, (w) => afw[w] ?? null, 15000)
    expect(sum.complete).toBe(false)
    expect(sum.kg!).toBeCloseTo([6 * 228, 51 * 218, 12 * 209].reduce((a, x) => a + (20.27 / 167) * x * 15000 / 1000, 0), 4)
  })

  it('a Breakers-only current week reads not recorded, never this week’s 0%', () => {
    const d = cohortDetail(w37, 2026, 37, 11.53, ctx({ currentYw: 202642, breakerOnly: (_y, w) => w >= 42 }))!
    expect(d.ages.find((a) => a.delay === 5)).toMatchObject({ harvestWeek: 42, state: 'not_recorded', percent: null })
  })
})

describe('week ranges in notes', () => {
  it('uses a range only for consecutive weeks', () => {
    expect(weekRanges([35, 37])).toBe('W35, W37')
    expect(weekRanges([42, 43, 44, 35])).toBe('W35, W42–W44')
  })
})
