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
// Model groups: every variety belongs to one pepper type (pepper_types), and
// learns and falls back only within it. Survival and timing come from, in
// order:
//   1. measured, variety     the variety's own completed cohorts (harvest
//                            window of MAX_AGE weeks over, whatever their
//                            outcome): for peppers still on the plant at age
//                            a, the share later harvested and when. Peppers
//                            resolved after the window are left out.
//   2. measured, pepper type completed cohorts of all varieties of the SAME
//                            type, only when the type allows it
//                            (pool_within_type; off by default).
//   3. provisional           stated assumptions: the variety's own setting,
//                            else its type's. A cohort keeps its own
//                            observations: its expected losses are the
//                            assumed total minus those already seen (never
//                            below zero), its harvest at most what is still
//                            on the plant.
//   4. not configured        no provisional values for the type: no estimate,
//                            and the page says so. Another type's values are
//                            never used.
// Cohorts carry their pepper type; mixing types is refused (ModelGroupError).
// AFW: the variety's entered AFW, else the type's provisional default (if any).
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

export const SETS_MODEL_VERSION = 'sets-potential-2026.11.1'

/** Harvest window followed (weeks after set), as in set_cohort_outcomes. */
export const MAX_AGE = 10

/** A variety's model group (pepper_types): what it falls back on before it has enough history of its own. */
export type ModelGroup = {
  pepperTypeId: string
  name: string
  /** Provisional survival from set (0–1); null: not configured. */
  provisionalSurvival: number | null
  /** Provisional share of the harvest at each age 0 … MAX_AGE; null: not configured. */
  provisionalTiming: number[] | null
  /** AFW for a variety with no AFW entered yet; null: none. */
  defaultAfwG: number | null
  /** Let a variety without enough completed cohorts use those of other varieties of this type. */
  poolWithinType: boolean
}

/** A variety's own provisional settings (crops.sets_provisional_*): null uses its type's. */
export type VarietyOverrides = { provisionalSurvival: number | null; provisionalTiming: number[] | null }

/** Thrown when cohorts of another pepper type reach a model group's parameters. */
export class ModelGroupError extends Error {}

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
  /** The variety's pepper type: cohorts are only ever used within their own type. */
  pepperTypeId: string
  cropId: string
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

export type ParameterSource = 'variety' | 'pepper type' | 'variety setting' | 'pepper type setting' | 'this page'
export type Parameter<T> = { value: T; kind: 'measured' | 'provisional'; source: ParameterSource; basis: string }

export type VarietyParameters = {
  group: ModelGroup
  /** Share of set peppers harvested (from set); null: not configured. */
  survival: Parameter<number> | null
  /** Share of harvested peppers picked at each age 0 … MAX_AGE (adds up to 1); null: not configured. */
  timing: Parameter<number[]> | null
  /** Measured only: per age a, P(harvested | still on the plant at the end of age a) and when (null: too few peppers). */
  afterAge: ({ survival: number; timing: number[] } | null)[]
  completed: Cohort[]
  /** Cohorts still inside their harvest window, newest first: never used for survival or timing. */
  incomplete: Cohort[]
}

export type ParameterOptions = {
  group: ModelGroup
  /** Cohorts of all varieties of the same pepper type (pool_within_type only). */
  typeCohorts?: Cohort[]
  overrides?: VarietyOverrides
  /** Survival typed on the page (provisional only; never saved). */
  provisionalSurvival?: number
  /** Backtests: use the provisional assumptions even when measured values exist. */
  forceProvisional?: boolean
}

const closedAt = (originIndex: number) => (c: Cohort) => c.setIndex + MAX_AGE < originIndex
const usable = (cohorts: Cohort[], originIndex: number) =>
  cohorts.filter((c) => !c.isBaseline && c.sets > 0 && c.setIndex <= originIndex).sort((a, b) => b.setIndex - a.setIndex)

/** Survival, timing and survival after each age from completed cohorts (null: not enough of them). */
function measuredFrom(completed: Cohort[], source: 'variety' | 'pepper type', describe: string, group: ModelGroup) {
  const sets = completed.reduce((s, c) => s + c.sets, 0)
  const weeks = new Set(completed.map((c) => c.setIndex)).size
  if (weeks < MIN_COMPLETED_COHORTS || sets < MIN_COMPLETED_SETS) return null
  const byAge = (f: (c: Cohort) => number[]) => Array.from({ length: MAX_AGE + 1 }, (_, d) => completed.reduce((s, c) => s + f(c)[d], 0))
  const h = byAge((c) => c.harvestedByAge)
  const l = byAge((c) => c.lostByAge)
  const H = sum(h)
  const L = sum(l)
  const later = completed.reduce((s, c) => s + c.resolvedLater + c.onPlant, 0)
  const afterAge = Array.from({ length: MAX_AGE + 1 }, (_, a) => {
    const hAfter = sum(h, a + 1)
    const resolved = hAfter + sum(l, a + 1)
    if (resolved < MIN_AT_AGE || hAfter === 0) return null
    return { survival: hAfter / resolved, timing: h.map((n, d) => (d > a ? n / hAfter : 0)) }
  })
  const survival: Parameter<number> = {
    value: H + L > 0 ? H / (H + L) : 0,
    kind: 'measured',
    source,
    basis: `${H} harvested, ${L} aborted or pruned in ${describe}${later ? `; ${later} resolved after ${MAX_AGE} weeks or still on the plant left out` : ''}`,
  }
  const timing: Parameter<number[]> | null =
    H > 0
      ? { value: h.map((n) => n / H), kind: 'measured', source, basis: `harvest ages of the ${H} harvested peppers in ${describe}` }
      : group.provisionalTiming
        ? { value: group.provisionalTiming, kind: 'provisional', source: 'pepper type setting', basis: `${group.name} assumption: no harvested peppers in ${describe}` }
        : null
  return { survival, timing, afterAge }
}

/**
 * The variety's survival and timing: measured from its own completed cohorts,
 * else (if its type allows) from completed cohorts of its pepper type, else
 * provisional settings of the variety or its type. Never another type's.
 */
export function varietyParameters(cohorts: Cohort[], originIndex: number, label: (index: number) => string, options: ParameterOptions): VarietyParameters {
  const { group } = options
  const foreign = [...cohorts, ...(options.typeCohorts ?? [])].find((c) => c.pepperTypeId !== group.pepperTypeId)
  if (foreign) throw new ModelGroupError(`A cohort of another pepper type (${foreign.pepperTypeId}) reached the ${group.name} model`)
  const closed = closedAt(originIndex)
  const known = usable(cohorts, originIndex)
  const completed = known.filter(closed).slice(0, RECENT_COHORTS)
  const incomplete = known.filter((c) => !closed(c))
  const sets = completed.reduce((s, c) => s + c.sets, 0)
  const span = (list: Cohort[], what: string) =>
    `${list.length} completed ${what} (${label(list.at(-1)!.setIndex)}–${label(list[0].setIndex)}, ${list.reduce((s, c) => s + c.sets, 0)} set peppers)`

  if (!options.forceProvisional) {
    const own = completed.length ? measuredFrom(completed, 'variety', span(completed, 'cohorts'), group) : null
    if (own) return { group, ...own, completed, incomplete }
    if (group.poolWithinType && options.typeCohorts) {
      const pool = usable(options.typeCohorts, originIndex).filter(closed)
      const recentWeeks = [...new Set(pool.map((c) => c.setIndex))].slice(0, RECENT_COHORTS)
      const pooled = pool.filter((c) => recentWeeks.includes(c.setIndex))
      const varieties = new Set(pooled.map((c) => c.cropId)).size
      const typed = pooled.length ? measuredFrom(pooled, 'pepper type', `${span(pooled, `${group.name} cohorts`)} from ${varieties} variet${varieties === 1 ? 'y' : 'ies'}`, group) : null
      if (typed) return { group, ...typed, completed: pooled, incomplete }
    }
  }

  const why = options.forceProvisional
    ? 'provisional by request'
    : `${completed.length} completed cohort${completed.length === 1 ? '' : 's'} (${sets} set peppers); measured values need ${MIN_COMPLETED_COHORTS} and ${MIN_COMPLETED_SETS}`
  const survival: Parameter<number> | null =
    options.provisionalSurvival !== undefined
      ? { value: options.provisionalSurvival, kind: 'provisional', source: 'this page', basis: `tried on this page, not saved: ${why}` }
      : options.overrides?.provisionalSurvival != null
        ? { value: options.overrides.provisionalSurvival, kind: 'provisional', source: 'variety setting', basis: `variety assumption: ${why}` }
        : group.provisionalSurvival !== null
          ? { value: group.provisionalSurvival, kind: 'provisional', source: 'pepper type setting', basis: `${group.name} assumption: ${why}` }
          : null
  const timing: Parameter<number[]> | null =
    options.overrides?.provisionalTiming != null
      ? { value: options.overrides.provisionalTiming, kind: 'provisional', source: 'variety setting', basis: `variety assumption: ${why}` }
      : group.provisionalTiming !== null
        ? { value: group.provisionalTiming, kind: 'provisional', source: 'pepper type setting', basis: `${group.name} assumption: ${why}` }
        : null
  return { group, survival, timing, afterAge: [], completed, incomplete }
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
  /** Why there is no estimate (provisional values not configured for the pepper type), else null. */
  notConfigured: string | null
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
  /** The variety's model group, and what may be used within it. */
  group: ModelGroup
  typeCohorts?: Cohort[]
  overrides?: VarietyOverrides
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
  const { group } = input
  // The variety's AFW; before any is entered, its type's provisional default (if configured).
  const afwAt = (t: number) =>
    chooseAfw(input.afw, originIndex, t, 'last', true) ??
    (group.defaultAfwG !== null ? { grams: group.defaultAfwG, source: `${group.name} provisional AFW (none entered yet)`, kind: 'model' as const } : null)
  const weeks = usableSets(
    input.sets.filter((s) => s.index <= originIndex),
    input.includePossibleCatchup,
  )
  if (!parameters.survival || !parameters.timing) {
    const missing = [!parameters.survival && 'survival', !parameters.timing && 'harvest timing'].filter(Boolean).join(' and ')
    return {
      parameters,
      notConfigured: `No ${missing} for ${group.name} yet: set its provisional assumptions in Settings (never borrowed from another pepper type).`,
      weeks,
      potential: [],
      dueNextWeek: { fruit: 0, kg: null },
      outlook: [],
    }
  }
  const survivalValue = parameters.survival.value
  const timingValue = parameters.timing.value
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
      p = onPlant > 0 ? Math.min(1, Math.max(0, (survivalValue * set - h) / onPlant)) : 0
      timing = timingAfter(timingValue, age)
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
  const typical = timingValue
  const outlook: OutlookWeek[] = Array.from({ length: input.weeksAhead }, (_, i) => {
    const t = originIndex + 2 + i
    const afw = afwAt(t)
    const coverage = typical.reduce((s, share, d) => s + (recorded.has(t - d) ? share : 0), 0)
    return { targetIndex: t, ...at(t), afwG: afw?.grams ?? null, afwSource: afw?.source ?? null, coverage }
  })
  return { parameters, notConfigured: null, weeks, potential, dueNextWeek: at(originIndex + 1), outlook }
}
