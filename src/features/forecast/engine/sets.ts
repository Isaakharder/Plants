// Sets production potential: planning estimates, not forecasts (never saved).
//
// Only Plants' own observations: each sampling week's new SetFruit entries
// (Sets/m² from the sampling system), every pepper's status transitions
// (harvested, aborted, pruned, still on the plant), sampling coverage, the
// variety's area and AFW. For each set week (cohort), as of the origin:
//
//   set            genuinely new Sets/m² × area
//   harvested      already harvested               (observed)
//   lost           already aborted or pruned       (observed)
//   on the plant   still active, immature or late  (observed)
//   future harvest on the plant × P(harvested | still on the plant at its age)
//   further losses on the plant − future harvest
//
// So a cohort's expected harvest (harvested + future harvest) never exceeds
// harvested + on the plant, losses already seen are never subtracted again,
// and fruit still on the plant is never counted as lost. Each future pepper
// is spread over the coming weeks by timing shares that add up to 1, so it
// lands in one week only. Crop totals scale the sampled peppers by the
// week's Sets/m² × area.
//
// Survival and timing per variety, never borrowed from another variety:
//   measured     from the variety's own completed cohorts (harvest window of
//                MAX_AGE weeks over, whatever their outcome): for peppers
//                still on the plant at age a, the share later harvested and
//                when. Peppers resolved after the window are left out.
//   provisional  stated assumptions until there are enough completed cohorts:
//                survival from set and harvest 5–8 weeks after set. A cohort
//                keeps its own observations: its expected losses are the
//                assumed total minus those already seen (never below zero),
//                its harvest at most what is still on the plant.
//
// Which Sets count: sampled weeks except the baseline (every fruit already on
// the plant), catch-up peppers (a node position missed earlier) and partly
// sampled weeks (missing, never zero). A week whose new sets were nearly all
// first recorded already set may be catch-up: flagged and left out unless
// the viewer includes it.
//
// Breakers and Sets stay separate: next week is the official Breakers
// forecast. Sets-based harvest due next week is shown as such and never added
// to it; the outlook lists the weeks after.

import { chooseAfw } from './afw'
import type { EngineAfw } from './types'

export const SETS_MODEL_VERSION = 'sets-potential-2026.10.4'

/** Harvest window followed (weeks after set), as in set_cohort_outcomes. */
export const MAX_AGE = 10

/**
 * Provisional assumptions for a variety without enough completed cohorts.
 * Not measured: placeholders to review. Survival can be changed on the page
 * (nothing is saved). Timing spreads harvest over 5–8 weeks after set.
 */
export const PROVISIONAL_ASSUMPTIONS = {
  survival: 0.6,
  timing: [0, 0, 0, 0, 0, 0.2, 0.3, 0.3, 0.2, 0, 0] as number[],
}

/** Measured parameters need this many completed cohorts and set peppers. */
export const MIN_COMPLETED_COHORTS = 4
export const MIN_COMPLETED_SETS = 200
/** The most recent completed cohorts used (later in the season fruit is lost more often). */
export const RECENT_COHORTS = 8
/** Resolved peppers needed behind an age's measured P(harvested | still on the plant); fewer: the age falls back to the survival budget. */
export const MIN_AT_AGE = 30
/** A completed week needs this share of the sample's stems visited; the week in progress, at least MIN_PROGRESS_COVERAGE so far. */
export const MIN_STEM_COVERAGE = 0.9
export const MIN_PROGRESS_COVERAGE = 0.5
/** A week is possible catch-up when at least this share of its new sets (and at least MIN_CATCHUP_SETS) were first recorded already set. */
export const POSSIBLE_CATCHUP_SHARE = 0.9
export const MIN_CATCHUP_SETS = 20

/** One set week's sampled peppers and their outcomes by age (set_cohort_outcomes). Week indexes (weeks.ts). */
export type Cohort = {
  setIndex: number
  sets: number
  harvestedByAge: number[]
  /** Aborted or pruned, by the age it happened. */
  lostByAge: number[]
  /** Harvested or lost after MAX_AGE weeks. */
  resolvedLater: number
  onPlant: number
  isBaseline: boolean
}

const sum = (v: number[], from = 0, to = v.length - 1) => v.slice(from, to + 1).reduce((s, x) => s + x, 0)
export const harvestedOf = (c: Cohort) => sum(c.harvestedByAge)
export const lostOf = (c: Cohort) => sum(c.lostByAge)

export type Parameter<T> = { value: T; kind: 'measured' | 'provisional'; basis: string }

export type VarietyParameters = {
  /** Share of set peppers harvested (from set). */
  survival: Parameter<number>
  /** Share of harvested peppers picked at each age 0 … MAX_AGE (adds up to 1). */
  timing: Parameter<number[]>
  /** Measured only: per age a, P(harvested | still on the plant at the end of age a) and when (null: too few peppers). */
  afterAge: ({ survival: number; timing: number[] } | null)[]
  completed: Cohort[]
  /** Cohorts still inside their harvest window, newest first: never used for survival or timing. */
  incomplete: Cohort[]
}

/**
 * The variety's survival and timing from its own completed cohorts set by the
 * origin, else the provisional assumptions (survival can be overridden).
 */
export function varietyParameters(
  cohorts: Cohort[],
  originIndex: number,
  label: (index: number) => string,
  options: { provisionalSurvival?: number; forceProvisional?: boolean } = {},
): VarietyParameters {
  const known = cohorts.filter((c) => !c.isBaseline && c.sets > 0 && c.setIndex <= originIndex).sort((a, b) => b.setIndex - a.setIndex)
  const closed = (c: Cohort) => c.setIndex + MAX_AGE < originIndex
  const completed = known.filter(closed).slice(0, RECENT_COHORTS)
  const incomplete = known.filter((c) => !closed(c))
  const sets = completed.reduce((s, c) => s + c.sets, 0)
  const enough = completed.length >= MIN_COMPLETED_COHORTS && sets >= MIN_COMPLETED_SETS
  if (enough && !options.forceProvisional) {
    const byAge = (f: (c: Cohort) => number[]) => Array.from({ length: MAX_AGE + 1 }, (_, d) => completed.reduce((s, c) => s + f(c)[d], 0))
    const h = byAge((c) => c.harvestedByAge)
    const l = byAge((c) => c.lostByAge)
    const H = sum(h)
    const L = sum(l)
    const span = `${completed.length} completed cohorts (${label(completed.at(-1)!.setIndex)}–${label(completed[0].setIndex)}, ${sets} set peppers)`
    const later = completed.reduce((s, c) => s + c.resolvedLater + c.onPlant, 0)
    const afterAge = Array.from({ length: MAX_AGE + 1 }, (_, a) => {
      const hAfter = sum(h, a + 1)
      const resolved = hAfter + sum(l, a + 1)
      if (resolved < MIN_AT_AGE || hAfter === 0) return null
      return { survival: hAfter / resolved, timing: h.map((n, d) => (d > a ? n / hAfter : 0)) }
    })
    return {
      survival: {
        value: H + L > 0 ? H / (H + L) : 0,
        kind: 'measured',
        basis: `${H} harvested, ${L} aborted or pruned in ${span}${later ? `; ${later} resolved after ${MAX_AGE} weeks or still on the plant left out` : ''}`,
      },
      timing:
        H > 0
          ? { value: h.map((n) => n / H), kind: 'measured', basis: `harvest ages of the ${H} harvested peppers in ${span}` }
          : { value: PROVISIONAL_ASSUMPTIONS.timing, kind: 'provisional', basis: `assumption, 5–8 weeks after set: no harvested peppers in ${span}` },
      afterAge,
      completed,
      incomplete,
    }
  }
  const why = options.forceProvisional
    ? 'provisional by request'
    : `${completed.length} completed cohort${completed.length === 1 ? '' : 's'} (${sets} set peppers); measured values need ${MIN_COMPLETED_COHORTS} and ${MIN_COMPLETED_SETS}`
  return {
    survival: { value: options.provisionalSurvival ?? PROVISIONAL_ASSUMPTIONS.survival, kind: 'provisional', basis: `assumption: ${why}` },
    timing: { value: PROVISIONAL_ASSUMPTIONS.timing, kind: 'provisional', basis: `assumption, 5–8 weeks after set: ${why}` },
    afterAge: [],
    completed,
    incomplete,
  }
}

/** A week of weekly_new_sets() with its sampling coverage. Week indexes. */
export type SetsWeekInput = {
  index: number
  perM2: number | null
  isBaseline: boolean
  newSets: number | null
  catchupSets: number | null
  /** New sets first recorded already set (no earlier flower record). */
  firstSeenSet: number | null
  /** Stems visited ÷ stems in the sample (null: none expected). */
  coverage: number | null
  inProgress: boolean
}

export type SetsWeek = {
  index: number
  /** Genuinely new Sets/m² (catch-up peppers removed); null when the week can't be used. */
  perM2: number | null
  catchup: number
  status: 'used' | 'in_progress' | 'baseline' | 'not_sampled' | 'partly_sampled' | 'possible_catchup'
  /** Share of the week's new sets first recorded already set. */
  firstSeenShare: number | null
  inProgress: boolean
}

/** Which weeks' Sets count, and their genuinely new Sets/m². Possible catch-up weeks keep their value but count only when included. */
export function usableSets(rows: SetsWeekInput[], includePossibleCatchup = false): SetsWeek[] {
  return rows.map((r): SetsWeek => {
    const catchup = r.catchupSets ?? 0
    const firstSeenShare = r.newSets && r.firstSeenSet !== null ? r.firstSeenSet / r.newSets : null
    const base = { index: r.index, catchup, firstSeenShare, inProgress: r.inProgress }
    if (r.isBaseline) return { ...base, perM2: null, status: 'baseline' }
    if (r.perM2 === null || r.coverage === null) return { ...base, perM2: null, status: 'not_sampled' }
    if (r.coverage < (r.inProgress ? MIN_PROGRESS_COVERAGE : MIN_STEM_COVERAGE)) return { ...base, perM2: null, status: 'partly_sampled' }
    const genuine = r.newSets && r.newSets > 0 ? r.perM2 * ((r.newSets - catchup) / r.newSets) : r.perM2
    const possibleCatchup = (r.newSets ?? 0) >= MIN_CATCHUP_SETS && firstSeenShare !== null && firstSeenShare >= POSSIBLE_CATCHUP_SHARE
    if (possibleCatchup && !includePossibleCatchup) return { ...base, perM2: null, status: 'possible_catchup' }
    return { ...base, perM2: genuine, status: possibleCatchup ? 'possible_catchup' : r.inProgress ? 'in_progress' : 'used' }
  })
}

/** What a set week's peppers come to on the whole crop. */
export type PotentialWeek = {
  setIndex: number
  perM2: number
  status: SetsWeek['status']
  set: number
  harvested: number
  lost: number
  onPlant: number
  futureHarvest: number
  furtherLosses: number
  /** harvested + futureHarvest: never more than harvested + onPlant. */
  expectedHarvest: number
  /** Probability used for the peppers still on the plant, and where it came from. */
  stillOnPlantSurvival: number
  survivalBasis: 'measured at age' | 'survival budget'
  /** kg already harvested + expected kg (null without an AFW). */
  eventualKg: number | null
  futureKg: number | null
  /** Expected harvest by week index (future weeks only): peppers and kg. */
  byWeek: Map<number, { fruit: number; kg: number | null }>
  firstHarvest: number | null
  lastHarvest: number | null
}

export type OutlookWeek = {
  targetIndex: number
  fruit: number
  /** kg from recorded Sets (null: no AFW). */
  kg: number | null
  afwG: number | null
  afwSource: string | null
  /** Share of a typical week's harvest whose set weeks have usable Sets: below 1, coverage is incomplete (not a guaranteed minimum). */
  coverage: number
}

export type SetsPotential = {
  parameters: VarietyParameters
  weeks: SetsWeek[]
  potential: PotentialWeek[]
  /** Sets-based harvest due next week (the Breakers week): shown, never added to the Breakers forecast. */
  dueNextWeek: { fruit: number; kg: number | null }
  outlook: OutlookWeek[]
}

export type SetsPotentialInput = {
  cohorts: Cohort[]
  sets: SetsWeekInput[]
  originIndex: number
  areaM2: number
  afw: EngineAfw[]
  /** Harvest weeks listed after next week. */
  weeksAhead: number
  label: (index: number) => string
  provisionalSurvival?: number
  /** Count weeks flagged as possible catch-up (left out by default). */
  includePossibleCatchup?: boolean
  /** Backtests: use the provisional assumptions even when measured values exist. */
  forceProvisional?: boolean
}

/** Timing shares after age a (renormalised); with none left, the week after. */
function timingAfter(timing: number[], a: number): number[] {
  const rest = timing.map((v, d) => (d > a ? v : 0))
  const total = sum(rest)
  if (total > 0) return rest.map((v) => v / total)
  const next = Array<number>(Math.max(timing.length, a + 2)).fill(0)
  next[a + 1] = 1
  return next
}

export function setsPotential(input: SetsPotentialInput): SetsPotential {
  const { originIndex, areaM2 } = input
  const parameters = varietyParameters(input.cohorts, originIndex, input.label, input)
  const afwAt = (t: number) => chooseAfw(input.afw, originIndex, t, 'last', true)
  const weeks = usableSets(
    input.sets.filter((s) => s.index <= originIndex),
    input.includePossibleCatchup,
  )
  const cohorts = new Map(input.cohorts.map((c) => [c.setIndex, c]))
  const potential: PotentialWeek[] = []
  for (const w of weeks) {
    if (w.perM2 === null) continue
    const c = cohorts.get(w.index)
    const set = w.perM2 * areaM2
    // Sampled peppers → whole crop. A week without cohort records: all still on the plant.
    const n = c?.sets ?? 0
    const scale = n > 0 ? set / n : 0
    const age = originIndex - w.index
    const h = c ? harvestedOf(c) * scale : 0
    const lost = c ? lostOf(c) * scale : 0
    const onPlant = c ? c.onPlant * scale : set
    let p: number
    let timing: number[]
    let survivalBasis: PotentialWeek['survivalBasis']
    const measured = parameters.afterAge[age]
    if (parameters.survival.kind === 'measured' && measured) {
      p = measured.survival
      timing = measured.timing
      survivalBasis = 'measured at age'
    } else {
      // Survival budget: the cohort's expected losses are the assumed total minus those already seen.
      p = onPlant > 0 ? Math.min(1, Math.max(0, (parameters.survival.value * set - h) / onPlant)) : 0
      timing = timingAfter(parameters.timing.value, age)
      survivalBasis = 'survival budget'
    }
    const futureHarvest = onPlant * p
    const byWeek = new Map<number, { fruit: number; kg: number | null }>()
    let futureKg: number | null = 0
    timing.forEach((share, d) => {
      if (share <= 0) return
      const t = w.index + d
      const fruit = futureHarvest * share
      const afw = afwAt(t)
      const kg = afw ? (fruit * afw.grams) / 1000 : null
      byWeek.set(t, { fruit, kg })
      futureKg = kg === null || futureKg === null ? null : futureKg + kg
    })
    let harvestedKg: number | null = 0
    c?.harvestedByAge.forEach((count, d) => {
      if (count === 0) return
      const afw = afwAt(w.index + d)
      harvestedKg = afw && harvestedKg !== null ? harvestedKg + (count * scale * afw.grams) / 1000 : null
    })
    const harvestWeeks = [...byWeek.keys()]
    potential.push({
      setIndex: w.index,
      perM2: w.perM2,
      status: w.status,
      set,
      harvested: h,
      lost,
      onPlant,
      futureHarvest,
      furtherLosses: onPlant - futureHarvest,
      expectedHarvest: h + futureHarvest,
      stillOnPlantSurvival: p,
      survivalBasis,
      eventualKg: futureKg === null || harvestedKg === null ? null : harvestedKg + futureKg,
      futureKg,
      byWeek,
      firstHarvest: harvestWeeks.length ? Math.min(...harvestWeeks) : null,
      lastHarvest: harvestWeeks.length ? Math.max(...harvestWeeks) : null,
    })
  }
  const at = (t: number) => {
    let fruit = 0
    let kg: number | null = 0
    for (const p of potential) {
      const v = p.byWeek.get(t)
      if (!v) continue
      fruit += v.fruit
      kg = v.kg === null || kg === null ? null : kg + v.kg
    }
    return { fruit, kg }
  }
  const recorded = new Set(potential.map((p) => p.setIndex))
  const typical = parameters.timing.value
  const outlook: OutlookWeek[] = Array.from({ length: input.weeksAhead }, (_, i) => {
    const t = originIndex + 2 + i
    const afw = afwAt(t)
    const coverage = typical.reduce((s, share, d) => s + (recorded.has(t - d) ? share : 0), 0)
    return { targetIndex: t, ...at(t), afwG: afw?.grams ?? null, afwSource: afw?.source ?? null, coverage }
  })
  return { parameters, weeks, potential, dueNextWeek: at(originIndex + 1), outlook }
}
