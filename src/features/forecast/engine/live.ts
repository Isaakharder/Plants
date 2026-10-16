// Live accuracy: each locked forecast against what was later recorded.
//
// The locked forecast is never recalculated. What changes is the observed
// side, as records arrive:
//
//   pending      the target week hasn't started
//   in_progress  it is the current week
//   provisional  it is over, but the next visit (which brings late harvest
//                records) hasn't happened yet: shown, not scored
//   settled      over and followed by a visit (or two weeks have passed):
//                scored
//   unreliable   not visited, visited on fewer than 90% of the stems, or
//                flagged (harvests possibly not recorded, incomplete visit,
//                a confirmed recording error): never scored as a zero; it is
//                merged with the next week into one block, so harvests logged
//                late meet their forecast
//
// Observed harvest of a week = peppers first recorded Harvested that week on
// the forecast's own sampled stems, leaving out nodes confirmed as recording
// errors. Observed kg = observed peppers × the forecast's scale × the actual
// AFW entered for that week. Fruit-count and kg accuracy are kept apart.
//
// Validation of a week ahead (horizon) needs all of: at least MIN_SETTLED
// scored official forecasts, |bias| ≤ MAX_ABS_BIAS, mean sampling coverage ≥
// MIN_COVERAGE, and WAPE within the goal. The goals are improvement targets;
// meeting one alone never marks a horizon reliable. Late forecasts are shown
// but never counted. Historical backtests never count.
//
// Actual harvested kg (approved 2026-10-16): every locked forecast's kg is
// also scored against the actual kg entered for its target week (the newest
// entry; corrections flow through, the forecast is never recalculated).
// Breakers-only forecasts can only be scored this way (harvests aren't
// recorded on the walkthrough). Each basis is validated separately, with the
// same rules on kg: at least MIN_SETTLED scored official forecasts, |bias| ≤
// MAX_ABS_BIAS, mean stem coverage ≥ MIN_COVERAGE and WAPE within the goal.

import { metrics, scoringUnits, type Metrics, type ScoringUnit, type ScoringWeek } from './accuracy'
import type { CropHistory } from './history'
import type { EngineFlag, ForecastBasis } from './types'
import { MARKETING_WEEKS } from './types'
import { weekIndex } from './weeks'

/** WAPE goals by week ahead (approved 2026-10-15): improvement targets, not reliability thresholds. */
export const WAPE_GOALS: Record<number, number> = { 1: 0.15, 2: 0.2, 3: 0.25, 4: 0.3, 5: 0.35, 6: 0.4, 7: 0.4, 8: 0.4 }
export const MIN_SETTLED = 8
export const MAX_ABS_BIAS = 0.1
export const MIN_COVERAGE = 0.9

export type LiveRun = {
  id: string
  originIndex: number
  kind: 'official' | 'late'
  confidence: 'experimental' | 'standard'
  sampleStemIds: string[]
  scale: number
  /** Older forecasts: lifecycle. */
  basis?: ForecastBasis
  harvestReadyShare?: number | null
  /** Stems checked or recorded at the origin ÷ stems in the sample. */
  coverage?: number | null
  /** Weeks a basis couldn't support (available false) have no numbers and are never scored. */
  weeks: { horizon: number; targetIndex: number; window: 'marketing' | 'outlook'; available?: boolean; sampleFruit: number; kg: number | null; afwG: number | null }[]
}

/** A week's sampling (sampling_weeks): stems visited of those expected, and whether it was marked complete. */
export type SamplingWeek = { visited: number; expected: number; complete: boolean }

export type ObservedContext = {
  currentIndex: number
  /** All records now, with confirmed recording errors marked (excluded nodes). */
  history: CropHistory
  sampling: Map<number, SamplingWeek>
  /** Flags as they stand now, with their latest review. */
  flags: EngineFlag[]
  /** Actual AFW entered per week. */
  actualAfw: Map<number, number>
  /** Actual harvested kg entered per week (newest entry; cleared weeks absent). */
  actualKg?: Map<number, number>
}

export type WeekStatus = 'pending' | 'in_progress' | 'provisional' | 'settled' | 'unreliable'

export type ObservedWeek = {
  status: WeekStatus
  /** Why a week is unreliable (or provisional). */
  reason: string | null
  coverage: number | null
  observedFruit: number | null
  observedKg: number | null
  actualAfw: number | null
}

const UNRELIABLE_RULES = new Set(['harvest_not_recorded', 'incomplete_visit'])

function weekFlagReason(flags: EngineFlag[], index: number): string | null {
  for (const f of flags) {
    if (f.scope !== 'week' || weekIndex(Math.floor(f.yw / 100), f.yw % 100) !== index || f.reviewDecision === 'legitimate') continue
    if (f.reviewDecision === 'recording_error') return 'confirmed recording error'
    if (UNRELIABLE_RULES.has(f.ruleId)) return f.ruleId === 'harvest_not_recorded' ? 'harvests possibly not recorded' : 'incomplete visit'
  }
  return null
}

/** What was recorded for one target week of a forecast, and whether it can be scored. */
export function observeWeek(ctx: ObservedContext, run: Pick<LiveRun, 'sampleStemIds' | 'scale'>, index: number): ObservedWeek {
  const s = ctx.sampling.get(index)
  const coverage = s && s.expected > 0 ? s.visited / s.expected : null
  const base = { coverage, observedFruit: null, observedKg: null, actualAfw: ctx.actualAfw.get(index) ?? null }
  if (index > ctx.currentIndex) return { ...base, status: 'pending', reason: null }
  if (index === ctx.currentIndex) return { ...base, status: 'in_progress', reason: null }

  const stems = new Set(run.sampleStemIds)
  const fruit = ctx.history.nodes.filter((h) => !h.excluded && h.harvestIndex === index && stems.has(h.stemId)).length
  const kg = base.actualAfw === null ? null : (fruit * run.scale * base.actualAfw) / 1000
  const observed = { ...base, observedFruit: fruit, observedKg: kg }

  if (!s || s.visited === 0) return { ...observed, status: 'unreliable', reason: 'not sampled' }
  if (coverage !== null && coverage < MIN_COVERAGE) return { ...observed, status: 'unreliable', reason: `incomplete visit (${s.visited} of ${s.expected} stems)` }
  const flagged = weekFlagReason(ctx.flags, index)
  if (flagged) return { ...observed, status: 'unreliable', reason: flagged }
  const next = ctx.sampling.get(index + 1)
  // Settled once the next visit has happened, or two full weeks have passed since it ended.
  const followedByVisit = (next?.visited ?? 0) > 0 || ctx.currentIndex >= index + 3
  return followedByVisit ? { ...observed, status: 'settled', reason: null } : { ...observed, status: 'provisional', reason: 'waiting for the next visit (late records)' }
}

export type ScoredWeek = LiveRun['weeks'][number] & ObservedWeek & {
  /** forecast ÷ observed − 1 for a settled single week (null otherwise). */
  fruitError: number | null
  kgError: number | null
}

export type ScoredRun = { run: LiveRun; weeks: ScoredWeek[]; units: ScoringUnit[] }

export function scoreRun(ctx: ObservedContext, run: LiveRun): ScoredRun {
  const weeks: ScoredWeek[] = run.weeks.filter((w) => w.available !== false).map((w) => {
    const o = observeWeek(ctx, run, w.targetIndex)
    const single = o.status === 'settled'
    return {
      ...w,
      ...o,
      fruitError: single && o.observedFruit ? w.sampleFruit / o.observedFruit - 1 : null,
      kgError: single && o.observedKg && w.kg !== null ? w.kg / o.observedKg - 1 : null,
    }
  })
  const unreliable = new Set(weeks.filter((w) => w.status === 'unreliable').map((w) => w.targetIndex))
  const settled = weeks.filter((w) => w.status === 'settled').map((w) => w.targetIndex)
  const lastScoreable = settled.length ? Math.max(...settled) : -Infinity
  // Only weeks that are settled or unreliable (closed) can be part of a unit; later ones end the run's scoring.
  const closed = weeks.filter((w) => w.status === 'settled' || w.status === 'unreliable')
  const scoring: ScoringWeek[] = closed.map((w) => ({
    index: w.targetIndex,
    horizon: w.horizon,
    forecastFruit: w.sampleFruit,
    observedFruit: w.observedFruit ?? 0,
    forecastKg: w.kg,
    observedKg: w.observedKg,
  }))
  return { run, weeks, units: scoringUnits(scoring, unreliable, lastScoreable) }
}

export type HorizonStatus = 'collecting' | 'validated' | 'not_validated'

export type HorizonAccuracy = {
  horizon: number
  window: 'marketing' | 'outlook'
  goal: number
  fruit: Metrics
  kg: Metrics
  blocks: number
  /** Mean sampling coverage of the scored weeks. */
  coverage: number | null
  status: HorizonStatus
  /** Why it isn't validated (empty when validated). */
  reasons: string[]
}

export type LiveAccuracy = {
  horizons: HorizonAccuracy[]
  /** Weeks 1–5 summed per forecast, when all five could be scored. */
  marketing: { fruit: Metrics; kg: Metrics }
  officialRuns: number
  lateRuns: number
  validatedHorizons: number[]
}

export function liveAccuracy(ctx: ObservedContext, runs: LiveRun[], horizon = 8): { accuracy: LiveAccuracy; scored: ScoredRun[]; actual: ActualAccuracy } {
  const actual = actualAccuracy(ctx, runs, horizon)
  // Harvested records score lifecycle forecasts only (the Friday walkthrough records no harvests).
  const scored = runs.filter((r) => (r.basis ?? 'lifecycle') === 'lifecycle').map((r) => scoreRun(ctx, r))
  const official = scored.filter((s) => s.run.kind === 'official')
  const horizons: HorizonAccuracy[] = []
  for (let h = 1; h <= horizon; h++) {
    const units = official.flatMap((s) => s.units.filter((u) => u.horizon === h))
    const fruit = metrics(units.map((u) => ({ forecast: u.forecastFruit, observed: u.observedFruit })))
    const kgUnits = units.filter((u) => u.forecastKg !== null && u.observedKg !== null)
    const kg = metrics(kgUnits.map((u) => ({ forecast: u.forecastKg!, observed: u.observedKg! })))
    const covs = official.flatMap((s) => s.weeks.filter((w) => w.horizon === h && (w.status === 'settled' || w.status === 'unreliable') && w.coverage !== null).map((w) => w.coverage!))
    const coverage = covs.length ? covs.reduce((a, b) => a + b, 0) / covs.length : null
    const goal = WAPE_GOALS[h] ?? WAPE_GOALS[8]
    const reasons: string[] = []
    if (fruit.n < MIN_SETTLED) reasons.push(`${fruit.n} of ${MIN_SETTLED} settled forecasts so far`)
    if (fruit.bias !== null && Math.abs(fruit.bias) > MAX_ABS_BIAS) reasons.push(`bias ${fruit.bias > 0 ? '+' : ''}${Math.round(100 * fruit.bias)}% (limit ±${100 * MAX_ABS_BIAS}%)`)
    if (coverage !== null && coverage < MIN_COVERAGE) reasons.push(`sampling coverage ${Math.round(100 * coverage)}% (needs ${100 * MIN_COVERAGE}%)`)
    if (fruit.wape !== null && fruit.wape > goal) reasons.push(`WAPE ${Math.round(100 * fruit.wape)}% above the ${Math.round(100 * goal)}% goal`)
    const status: HorizonStatus = fruit.n < MIN_SETTLED ? 'collecting' : reasons.length === 0 ? 'validated' : 'not_validated'
    horizons.push({ horizon: h, window: h <= MARKETING_WEEKS ? 'marketing' : 'outlook', goal, fruit, kg, blocks: units.filter((u) => u.block).length, coverage, status, reasons })
  }
  // Marketing total: forecasts whose weeks 1–5 are all scored (blocks included, none cut off).
  const totals = official
    .filter((s) => {
      const covered = new Set(s.units.filter((u) => u.horizon <= MARKETING_WEEKS).flatMap((u) => u.weeks))
      return s.run.weeks.filter((w) => w.horizon <= MARKETING_WEEKS).every((w) => covered.has(w.targetIndex))
    })
    .map((s) => s.units.filter((u) => u.horizon <= MARKETING_WEEKS))
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
  const marketing = {
    fruit: metrics(totals.map((units) => ({ forecast: sum(units.map((u) => u.forecastFruit)), observed: sum(units.map((u) => u.observedFruit)) }))),
    kg: metrics(
      totals
        .filter((units) => units.every((u) => u.forecastKg !== null && u.observedKg !== null))
        .map((units) => ({ forecast: sum(units.map((u) => u.forecastKg!)), observed: sum(units.map((u) => u.observedKg!)) })),
    ),
  }
  return {
    accuracy: {
      horizons,
      marketing,
      officialRuns: official.length,
      lateRuns: scored.length - official.length,
      validatedHorizons: horizons.filter((h) => h.status === 'validated').map((h) => h.horizon),
    },
    scored,
    actual,
  }
}

// ── Against actual harvested kg ──────────────────────────────────────────────

/** Actual kg in effect per week index: the newest entry per week (by entry time, then id); a cleared week (null) is left out. */
export function actualsInEffect(rows: { year: number; week: number; actualKg: number | null; enteredAt: string; id: number }[]): Map<number, number> {
  const latest = new Map<number, { kg: number | null; enteredAt: string; id: number }>()
  for (const r of rows) {
    const index = weekIndex(r.year, r.week)
    const cur = latest.get(index)
    if (!cur || r.enteredAt > cur.enteredAt || (r.enteredAt === cur.enteredAt && r.id > cur.id)) latest.set(index, { kg: r.actualKg, enteredAt: r.enteredAt, id: r.id })
  }
  return new Map([...latest].filter(([, v]) => v.kg !== null).map(([i, v]) => [i, v.kg!]))
}

export type ActualWeekStatus = 'pending' | 'in_progress' | 'awaiting_actual' | 'not_scorable' | 'scored'

export type ActualScoredWeek = {
  horizon: number
  targetIndex: number
  forecastKg: number | null
  actualKg: number | null
  status: ActualWeekStatus
  /** forecast ÷ actual − 1 (positive = forecast too high). */
  error: number | null
  /** Breakers only: the share that would have matched the actual kg (share × actual ÷ forecast). A diagnostic; it changes nothing. */
  impliedShare: number | null
}

export type ActualScoredRun = { run: LiveRun; weeks: ActualScoredWeek[] }

export type ActualHorizonAccuracy = {
  basis: ForecastBasis
  horizon: number
  goal: number
  kg: Metrics
  coverage: number | null
  status: HorizonStatus
  reasons: string[]
}

export type ActualAccuracy = {
  runs: ActualScoredRun[]
  /** Official forecasts only, by basis and week ahead (weeks a basis supports). */
  horizons: ActualHorizonAccuracy[]
  validatedHorizons: Record<ForecastBasis, number[]>
}

/** One locked forecast's available weeks against the actual kg entered for them. */
export function scoreAgainstActual(ctx: Pick<ObservedContext, 'currentIndex' | 'actualKg'>, run: LiveRun): ActualScoredRun {
  const weeks = run.weeks
    .filter((w) => w.available !== false)
    .map((w): ActualScoredWeek => {
      const actualKg = ctx.actualKg?.get(w.targetIndex) ?? null
      const base = { horizon: w.horizon, targetIndex: w.targetIndex, forecastKg: w.kg, actualKg, error: null, impliedShare: null }
      if (w.targetIndex > ctx.currentIndex) return { ...base, status: 'pending' }
      if (w.targetIndex === ctx.currentIndex) return { ...base, status: 'in_progress' }
      if (actualKg === null) return { ...base, status: 'awaiting_actual' }
      if (w.kg === null || actualKg === 0) return { ...base, status: 'not_scorable' }
      const share = run.basis === 'breaker_only' && run.harvestReadyShare != null && w.kg > 0 ? (run.harvestReadyShare * actualKg) / w.kg : null
      return { ...base, status: 'scored', error: w.kg / actualKg - 1, impliedShare: share }
    })
  return { run, weeks }
}

export function actualAccuracy(ctx: Pick<ObservedContext, 'currentIndex' | 'actualKg'>, runs: LiveRun[], horizon = 8): ActualAccuracy {
  const scored = runs.map((r) => scoreAgainstActual(ctx, r))
  const horizons: ActualHorizonAccuracy[] = []
  const validatedHorizons: Record<ForecastBasis, number[]> = { lifecycle: [], breaker_only: [] }
  for (const basis of ['lifecycle', 'breaker_only'] as ForecastBasis[]) {
    const official = scored.filter((s) => s.run.kind === 'official' && (s.run.basis ?? 'lifecycle') === basis)
    const maxH = basis === 'breaker_only' ? 1 : horizon
    for (let h = 1; h <= maxH; h++) {
      const weeks = official.flatMap((s) => s.weeks.filter((w) => w.horizon === h && w.status === 'scored').map((w) => ({ w, run: s.run })))
      const kg = metrics(weeks.map(({ w }) => ({ forecast: w.forecastKg!, observed: w.actualKg! })))
      const covs = weeks.map(({ run }) => run.coverage).filter((c): c is number => c !== null && c !== undefined)
      const coverage = covs.length ? covs.reduce((a, b) => a + b, 0) / covs.length : null
      const goal = WAPE_GOALS[h] ?? WAPE_GOALS[8]
      const reasons: string[] = []
      if (kg.n < MIN_SETTLED) reasons.push(`${kg.n} of ${MIN_SETTLED} official forecasts scored against actual kg so far`)
      if (kg.bias !== null && Math.abs(kg.bias) > MAX_ABS_BIAS) reasons.push(`bias ${kg.bias > 0 ? '+' : ''}${Math.round(100 * kg.bias)}% (limit ±${100 * MAX_ABS_BIAS}%)`)
      if (coverage !== null && coverage < MIN_COVERAGE) reasons.push(`stem coverage ${Math.round(100 * coverage)}% (needs ${100 * MIN_COVERAGE}%)`)
      if (kg.wape !== null && kg.wape > goal) reasons.push(`WAPE ${Math.round(100 * kg.wape)}% above the ${Math.round(100 * goal)}% goal`)
      const status: HorizonStatus = kg.n < MIN_SETTLED ? 'collecting' : reasons.length === 0 ? 'validated' : 'not_validated'
      if (status === 'validated') validatedHorizons[basis].push(h)
      horizons.push({ basis, horizon: h, goal, kg, coverage, status, reasons })
    }
  }
  return { runs: scored, horizons, validatedHorizons }
}
