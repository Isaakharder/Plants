import type { ClosingCohort, CohortCell, SetHarvestCohortRow, WeeklyPlantDataRow } from '../../lib/database.types'
import type { IsoDate } from '../../lib/dates'
import { formatTwoDecimals } from '../../lib/format'

export type { ClosingCohort, CohortCell, SetHarvestCohortRow, WeeklyPlantDataRow }

/** ISO week-numbering year of a calendar date ("2025-12-29" → 2026). */
export function isoYearOfDate(iso: IsoDate): number {
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7))
  return date.getUTCFullYear()
}

/** The ISO years a planting spans, newest first. */
export function cropYears(crop: { planting_date: IsoDate; pullout_date: IsoDate }): number[] {
  const first = isoYearOfDate(crop.planting_date)
  const last = isoYearOfDate(crop.pullout_date)
  return Array.from({ length: last - first + 1 }, (_, i) => last - i)
}

/** The current greenhouse year when the planting spans it, otherwise its latest year. */
export function defaultYear(years: number[], currentYear: number): number {
  return years.includes(currentYear) ? currentYear : years[0]
}

/** Per-m² value for display: two decimals, or — for a week that wasn't sampled. */
export const formatRate = (value: number | null) => (value === null ? '—' : formatTwoDecimals(value))

/** PostgREST sends numeric columns as JSON numbers or strings; normalise them. */
export function normalizeWeek(row: WeeklyPlantDataRow): WeeklyPlantDataRow {
  const num = (v: number | null) => (v === null ? null : Number(v))
  return {
    ...row,
    sampled_m2: num(row.sampled_m2),
    sets_per_m2: num(row.sets_per_m2),
    breakers_per_m2: num(row.breakers_per_m2),
    harvested_per_m2: num(row.harvested_per_m2),
  }
}

/** The cohort clock: +0 is the SetFruit week, +10 the last week a harvest counts (+11 is outside the window). */
export const LADDER_AGES = Array.from({ length: 11 }, (_, i) => i)

/**
 * Weeks to display: from the first week with plant/sample data onward. Empty
 * weeks before sampling began are dropped; later weeks (current, future) stay
 * so cohort ladders can be followed forward. Nothing sampled → nothing shown.
 */
export function weeksFromFirstSample<T extends { is_sampled: boolean }>(weeks: T[]): T[] {
  const first = weeks.findIndex((w) => w.is_sampled)
  return first === -1 ? [] : weeks.slice(first)
}

/**
 * Cohort ages worth a column: those with at least one harvested pepper in the
 * displayed weeks. Ages whose cells are all — or 0% are hidden. Presentation
 * only: every cell keeps its real age, so ladders still map correctly.
 */
export function ladderAgesWithHarvests(rows: SetHarvestCohortRow[]): number[] {
  return LADDER_AGES.filter((age) => rows.some((row) => (cellAtAge(row, age)?.harvested ?? 0) > 0))
}

/** A row's cell for a cohort age, looked up by its age (not by array position). */
export function cellAtAge(row: SetHarvestCohortRow | undefined, age: number): CohortCell | undefined {
  return row?.cells.find((c) => c.delay === age)
}

/** Identifies a set cohort (its ISO year and week). */
export const cohortKey = (setYear: number, setWeek: number) => `${setYear}-W${setWeek}`

/** Monday of an ISO week, as days since the epoch. */
function isoWeekMondayDays(year: number, week: number): number {
  const jan4 = Date.UTC(year, 0, 4)
  const jan4Weekday = new Date(jan4).getUTCDay() || 7
  return jan4 / 86_400_000 - (jan4Weekday - 1) + (week - 1) * 7
}

/**
 * Cycles 0/1/2 across consecutive set weeks (also across week 53 and New
 * Year). Three shades make each cohort's diagonal read as a stripe: with two,
 * the table becomes a checkerboard and the opposite diagonal looks the same.
 */
export function cohortBand(setYear: number, setWeek: number): 0 | 1 | 2 {
  return (((Math.round(isoWeekMondayDays(setYear, setWeek) / 7) % 3) + 3) % 3) as 0 | 1 | 2
}

/**
 * A +N cohort cell, as displayed: a whole percentage (32.8 → "33%"), — when
 * there's no cohort or the week wasn't sampled. Display only: calculations
 * (Picked kg, Loss, captions) always use the unrounded value.
 */
export function formatCohortPercent(value: number | null): string {
  if (value === null) return '—'
  return `${Math.round(Number(value))}%`
}

/** A percentage with one decimal (Loss): — when not available; 0% for an observed zero. */
export function formatPercent(value: number | null): string {
  if (value === null) return '—'
  const n = Number(value)
  return n === 0 ? '0%' : `${n.toFixed(1)}%`
}

export type CohortSummary = {
  setYear: number
  setWeek: number
  sets: number
  harvested: number
  aborted: number
  pruned: number
  timeout: number
  onPlant: number
  closed: boolean
}

export function summarize(cell: CohortCell): CohortSummary {
  return {
    setYear: cell.set_year,
    setWeek: cell.set_week,
    sets: cell.cohort_sets,
    harvested: cell.cohort_harvested,
    aborted: cell.cohort_aborted,
    pruned: cell.cohort_pruned,
    timeout: cell.cohort_timeout,
    onPlant: cell.cohort_on_plant,
    closed: cell.cohort_closed,
  }
}

const share = (n: number, of: number) => `${((100 * n) / of).toFixed(1)}%`

/**
 * The caption shown while following a cohort. An open cohort reports only what
 * is recorded so far: Aborted + Pruned as "Lost so far", the rest as still on
 * the plant (Timeout doesn't exist until the +10 window closes).
 */
export function followCaption(c: CohortSummary, viewedYear: number): string {
  const name = c.setYear === viewedYear ? `W${c.setWeek}` : `W${c.setWeek} ${c.setYear}`
  if (c.sets === 0) return `Following ${name} cohort: no peppers were set that week.`
  if (c.closed) {
    const loss = c.aborted + c.pruned + c.timeout
    return (
      `Following ${name} cohort (closed after +10): ${c.sets} sets · Harvested ${share(c.harvested, c.sets)} · ` +
      `Loss ${share(loss, c.sets)} (Aborted ${share(c.aborted, c.sets)} · Pruned ${share(c.pruned, c.sets)} · Timeout ${share(c.timeout, c.sets)})`
    )
  }
  return (
    `Following ${name} cohort: ${c.sets} sets · Harvested so far ${share(c.harvested, c.sets)} · ` +
    `Lost so far ${share(c.aborted + c.pruned, c.sets)} · Still on plant ${share(c.onPlant, c.sets)}`
  )
}

/** The Loss column: — until the closing cohort's window has closed. */
export const formatLoss = (closing: ClosingCohort) => formatPercent(closing.closed && closing.sets > 0 ? closing.loss_percent : null)

/** Hover text for the Loss column. */
export function lossTitle(closing: ClosingCohort, harvestYear: number): string {
  const name = closing.set_year === harvestYear ? `W${closing.set_week}` : `W${closing.set_week} ${closing.set_year}`
  if (closing.sets === 0) return `No peppers were set in ${name}, so no cohort closes this week.`
  if (!closing.closed) return `${name} cohort's +10 window closes at the end of this week; its loss is not final yet.`
  return (
    `${name} cohort closed: ${closing.sets} sets, ${closing.harvested} harvested within +10. ` +
    `Loss: ${closing.aborted} aborted, ${closing.pruned} pruned, ${closing.timeout} timeout (unresolved after +10).`
  )
}

/** Hover text for a cohort cell, with the counts behind the percentage. */
export function cohortCellTitle(cell: CohortCell, harvestYear: number, harvestWeek: number): string {
  const cohort = cell.set_year === harvestYear ? `W${cell.set_week}` : `W${cell.set_week} ${cell.set_year}`
  if (cell.cohort_sets === 0) return `No peppers were set in ${cohort}.`
  if (cell.delay === 0) return `${cohort} cohort starts here: ${cell.cohort_sets} peppers first recorded as set (+0).`
  const exact = cell.percent === null ? '' : ` (${Number(cell.percent).toFixed(1)}%)`
  const lines = [`${cell.harvested} of ${cell.cohort_sets} peppers set in ${cohort} were first harvested in W${harvestWeek} (+${cell.delay} wk)${exact}.`]
  if (cell.is_baseline_cohort) lines.push('Baseline cohort: these peppers may have set before sampling began, so the delay may be longer.')
  if (cell.percent === null) lines.push('This harvest week has not been sampled.')
  return lines.join('\n')
}

// ── Manual AFW and Picked kg (per set-week cohort) ─────────────────────────

/** Average fruit weight bounds, grams (the database checks the same). */
export const AFW_MIN_G = 0.1
export const AFW_MAX_G = 2000

/**
 * A typed AFW: grams with at most one decimal. Blank clears the week's AFW
 * (null); anything else that isn't a sensible positive weight is invalid.
 */
export function parseAfw(input: string): number | null | 'invalid' {
  const s = input.trim().replace(',', '.')
  if (s === '') return null
  if (!/^\d+(\.\d)?$/.test(s)) return 'invalid'
  const g = Number(s)
  return g >= AFW_MIN_G && g <= AFW_MAX_G ? g : 'invalid'
}

/**
 * Every cell of one set cohort: its diagonal through the year's harvest-week
 * rows (row = harvest week; the cell at +N belongs to the cohort set N weeks
 * earlier). Never cells of other cohorts that land in the same harvest week.
 */
export function cohortCells(rows: SetHarvestCohortRow[], setYear: number, setWeek: number): CohortCell[] {
  const cells: CohortCell[] = []
  for (const row of rows) for (const cell of row.cells) if (cell.set_year === setYear && cell.set_week === setWeek) cells.push(cell)
  return cells.sort((a, b) => a.delay - b.delay)
}

/**
 * The share of a cohort harvested so far (0–1): the sum of its observed,
 * unrounded harvest percentages. Ages not reached yet, or in weeks that
 * weren't sampled, have no percentage and add nothing — nothing is projected.
 */
export function observedHarvestShare(cells: CohortCell[]): number {
  return cells.reduce((sum, c) => (c.percent === null ? sum : sum + Number(c.percent)), 0) / 100
}

/**
 * Picked kg for a cohort, scaled to the crop's whole area:
 *   setsPerM2 × harvested share × AFW g ÷ 1000 × crop area m²
 * Null without an AFW or without Sets/m² (unsampled set week): never invented.
 */
export function pickedKg(setsPerM2: number | null, harvestShare: number, afwG: number | null, cropAreaM2: number): number | null {
  if (afwG === null || setsPerM2 === null) return null
  return ((setsPerM2 * harvestShare * afwG) / 1000) * cropAreaM2
}

/** Hover text for a Picked kg cell, showing the calculation. */
export function pickedKgTitle(setWeek: number, setsPerM2: number | null, share: number, afwG: number | null, cropAreaM2: number, kg: number | null, crossesYearEnd: boolean): string {
  if (setsPerM2 === null) return `W${setWeek} wasn't sampled, so there is no Sets/m² to convert.`
  if (afwG === null) return `Enter W${setWeek}'s AFW (grams per fruit) to convert its harvest to kg.`
  const lines = [
    `W${setWeek} cohort: ${setsPerM2.toFixed(2)} sets/m² × ${(share * 100).toFixed(1)}% harvested so far × ${afwG} g × ${Math.round(cropAreaM2).toLocaleString('en-US')} m² = ${Math.round(kg ?? 0).toLocaleString('en-US')} kg`,
    'Only harvests already recorded count; later ages are not projected.',
  ]
  if (crossesYearEnd) lines.push('Harvest weeks in the next year are not included in this year’s table.')
  return lines.join('\n')
}
