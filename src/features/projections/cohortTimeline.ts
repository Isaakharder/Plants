// Weekly Plant Data › cohort detail: one fruit-set week (a cohort) followed
// through harvest, for display only. Every number comes from
// set_harvest_cohorts() (and Sets/m², AFW, sampling coverage as already
// loaded); nothing is recalculated or projected.
//
// Each age (+N weeks after set) is labelled by what is known about its
// harvest week, so a gap in recording never reads as a 0% harvest:
//   recorded      sampled; the % is the share first harvested at that age (0% is a real 0)
//   incomplete    sampled, but partly (under 90% of stems) or flagged as harvests
//                 possibly not recorded: the % is shown with a warning
//   not_recorded  a Breakers-only week: Harvested isn't recorded on the walkthrough
//   not_sampled   the week wasn't sampled: no value
//   in_progress   the current week: what is recorded so far
//   future        not reached yet

import type { CohortCell, SamplingWeekRow, SetHarvestCohortRow } from './model'
import { cohortCells, cohortHarvestedKg } from './model'

export type AgeState = 'recorded' | 'incomplete' | 'not_recorded' | 'not_sampled' | 'in_progress' | 'future'

export type AgeCell = {
  delay: number
  harvestYear: number
  harvestWeek: number
  /** Peppers of the cohort first harvested at this age (null when the week can't tell). */
  harvested: number | null
  /** harvested ÷ sets × 100, unrounded (null when the week can't tell). */
  percent: number | null
  state: AgeState
  /** Why the age is incomplete or unknown. */
  note: string | null
}

export type CohortOutcome = { harvested: number; aborted: number; pruned: number; onPlant: number; unresolved: number }

export type CohortDetail = {
  setYear: number
  setWeek: number
  sets: number
  setsPerM2: number | null
  outcome: CohortOutcome
  closed: boolean
  baseline: boolean
  ages: AgeCell[]
}

export type TimelineContext = {
  /** The current greenhouse week (yyyyww). */
  currentYw: number
  sampling: Map<number, SamplingWeekRow>
  /** Harvest week (iso week of the shown year) → Breakers-only (Harvested not recorded). */
  breakerOnly: (year: number, week: number) => boolean
  /** Harvest week → why its harvests may be unreliable (data-quality flags), if any. */
  flagged: Map<number, string>
}

/** Below this share of stems visited, a week's harvest is shown as incomplete. */
export const COVERAGE_OK = 0.9

function ageState(cell: CohortCell, harvestYear: number, harvestWeek: number, ctx: TimelineContext): { state: AgeState; note: string | null } {
  const yw = harvestYear * 100 + harvestWeek
  if (yw > ctx.currentYw) return { state: 'future', note: null }
  // A Breakers-only week records no harvests at all, this week included.
  if (ctx.breakerOnly(harvestYear, harvestWeek)) return { state: 'not_recorded', note: 'Breakers-only week: Harvested isn’t recorded on the walkthrough.' }
  if (yw === ctx.currentYw) return { state: 'in_progress', note: 'This week: sampling may not be complete.' }
  if (cell.percent === null) return { state: 'not_sampled', note: 'This week wasn’t sampled.' }
  const flag = ctx.flagged.get(harvestWeek)
  if (flag) return { state: 'incomplete', note: flag }
  const s = ctx.sampling.get(harvestWeek)
  if (s && s.expected_stems > 0 && s.visited_stems / s.expected_stems < COVERAGE_OK) {
    return { state: 'incomplete', note: `Partial visit: ${s.visited_stems} of ${s.expected_stems} stems.` }
  }
  return { state: 'recorded', note: null }
}

/** The cohort set in (year, setWeek), from the harvest-week rows of that year; null when it isn't in the rows. */
export function cohortDetail(rows: SetHarvestCohortRow[], year: number, setWeek: number, setsPerM2: number | null, ctx: TimelineContext): CohortDetail | null {
  const cells = cohortCells(rows, year, setWeek)
  if (cells.length === 0) return null
  // Every cell carries the cohort's outcome; the latest one is the most up to date (the same today).
  const last = cells[cells.length - 1]
  const ages: AgeCell[] = cells
    .filter((c) => c.delay > 0)
    .map((c) => {
      const harvestWeek = c.set_week + c.delay
      const { state, note } = ageState(c, year, harvestWeek, ctx)
      const known = state === 'recorded' || state === 'incomplete' || state === 'in_progress'
      return {
        delay: c.delay,
        harvestYear: year,
        harvestWeek,
        harvested: known && c.percent !== null ? c.harvested : null,
        percent: known && c.percent !== null ? Number(c.percent) : null,
        state,
        note,
      }
    })
  return {
    setYear: year,
    setWeek,
    sets: last.cohort_sets,
    setsPerM2,
    outcome: {
      harvested: last.cohort_harvested,
      aborted: last.cohort_aborted,
      pruned: last.cohort_pruned,
      onPlant: last.cohort_on_plant,
      unresolved: last.cohort_timeout,
    },
    closed: last.cohort_closed,
    baseline: last.is_baseline_cohort,
    ages,
  }
}

/** The ages worth showing: +3 … +10, plus any earlier age with a harvest. */
export function shownAges(detail: CohortDetail): AgeCell[] {
  return detail.ages.filter((a) => a.delay >= 3 || (a.harvested ?? 0) > 0)
}

export type Unit = 'percent' | 'perM2' | 'kg'

/** A count of the cohort's peppers in the chosen unit; null when it can't be given (never invented). */
export function inUnit(count: number, detail: CohortDetail, unit: Unit, kg?: { afwG: number | null; areaM2: number }): number | null {
  if (detail.sets === 0) return null
  const share = count / detail.sets
  if (unit === 'percent') return 100 * share
  if (detail.setsPerM2 === null) return null
  if (unit === 'perM2') return detail.setsPerM2 * share
  // kg: only harvested fruit has a weight (that harvest week's AFW).
  if (!kg) return null
  return cohortHarvestedKg(detail.setsPerM2, share, kg.afwG, kg.areaM2)
}

/**
 * Harvested kg of the whole cohort so far: the sum over its harvest weeks, each
 * with that week's AFW. Partial (complete false) when a week with harvests
 * has no AFW; null when none has.
 */
export function harvestedKgSoFar(detail: CohortDetail, afwOf: (week: number) => number | null, areaM2: number): { kg: number | null; complete: boolean } {
  let kg = 0
  let any = false
  let complete = true
  for (const a of detail.ages) {
    if (!a.harvested) continue
    const v = inUnit(a.harvested, detail, 'kg', { afwG: afwOf(a.harvestWeek), areaM2 })
    if (v === null) complete = false
    else {
      kg += v
      any = true
    }
  }
  return { kg: any ? kg : null, complete }
}

/** [35, 37, 42, 43, 44] → "W35, W37, W42–W44": a range only for consecutive weeks. */
export function weekRanges(weeks: number[]): string {
  const sorted = [...new Set(weeks)].sort((a, b) => a - b)
  const parts: string[] = []
  for (let i = 0; i < sorted.length; i++) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++
    parts.push(j > i ? `W${sorted[i]}–W${sorted[j]}` : `W${sorted[i]}`)
    i = j
  }
  return parts.join(', ')
}
