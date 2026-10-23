// Pure assembly of the Sets production potential inputs from database rows
// (shared by the page and scripts/sets-backtest.ts).

import type { SamplingWeekRow, SetCohortOutcomeRow, WeeklyNewSetsRow } from '../../lib/database.types'
import type { Cohort, SetsWeekInput } from './engine/sets'
import { weekIndex } from './engine/weeks'

/** set_cohort_outcomes rows as cohorts (aborted and pruned together as lost). */
export function cohortsFrom(rows: SetCohortOutcomeRow[]): Cohort[] {
  return rows.map((r) => ({
    setIndex: weekIndex(r.set_year, r.set_week),
    sets: r.sets,
    harvestedByAge: r.harvested_by_age,
    lostByAge: r.aborted_by_age.map((n, a) => n + r.pruned_by_age[a]),
    resolvedLater: r.resolved_later,
    onPlant: r.on_plant,
    isBaseline: r.is_baseline,
  }))
}

/** weekly_new_sets rows with their sampling coverage; the current week and later are in progress. */
export function setsWeeks(newSets: WeeklyNewSetsRow[], samplingRows: SamplingWeekRow[], year: number, currentWeek: number): SetsWeekInput[] {
  const sampling = new Map(samplingRows.map((s) => [s.iso_week, s]))
  return newSets.map((r) => {
    const s = sampling.get(r.iso_week)
    return {
      index: weekIndex(year, r.iso_week),
      perM2: r.is_sampled ? r.sets_per_m2 : null,
      isBaseline: r.is_baseline,
      newSets: r.new_sets,
      catchupSets: r.catchup_sets,
      firstSeenSet: r.first_seen_set,
      coverage: s && s.expected_stems > 0 ? s.visited_stems / s.expected_stems : null,
      inProgress: r.iso_week >= currentWeek,
    }
  })
}
