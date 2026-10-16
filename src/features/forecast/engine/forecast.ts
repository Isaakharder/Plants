// Eight-week harvest forecast from the fruit on the sampled stems. The
// marketing view uses the first five weeks; weeks 6–8 are the longer-range
// outlook. Both come from the same per-fruit model.
//
//   1. Inventory: every fruit (SetFruit, MatureGreen, BreakerFruit) on the
//      sample's stems, as of its stem's last trusted visit (v ≤ origin), with
//      its own history: weeks since it was first recorded at its current
//      stage (for SetFruit, weeks since set). A fruit set weeks ago is never
//      treated as new.
//   2. Each fruit's (stage, weeks-in-stage) distribution is stepped forward
//      one week at a time with the fitted transition table. Every week it can
//      be harvested, aborted, pruned, move to a later stage or stay. It can
//      be harvested once, so nothing is double-counted, and whatever is still
//      on the plant after the last week stays unharvested: nothing is forced
//      into the horizon. Harvest probability for weeks after v but not after
//      the origin wasn't recorded yet (the stem wasn't visited); the collector
//      records it at the next visit, so it is forecast for origin + 1
//      ("catch-up").
//   3. Fruit not set yet: the recent number of new sets per stem per week,
//      each future set stepped through the same model from SetFruit, week 0.
//      A pepper set next week typically reaches harvest around week 7–8, so
//      new sets matter only to the outlook weeks.
//   4. Scale: × picking stems ÷ sampled stems. Kg: × forecast AFW ÷ 1000.
//
// Enough history (approved 2026-10-16): no rate is invented. Unless each
// stage has at least MIN_STAGE_EXAMPLES week-to-week records from lifecycle
// weeks, and the new-set rate rests on at least MIN_SET_RATE_WEEKS weeks,
// the eight weeks are reported as not available (with the reason), never
// filled with default odds.
//
// forecastForWeek() picks the basis in effect for the origin week: this
// lifecycle forecast, or the next-week forecast from Breakers (breaker.ts).

import { chooseAfw } from './afw'
import { basisAt } from './basis'
import { breakerForecast } from './breaker'
import { assessConfidence } from './confidence'
import { buildHistory, confirmedErrors, isLoss, stateAt, stateEntryAt, type CropHistory, type FruitStage, type NodeHistory } from './history'
import { BINS, OUTCOMES, binOf, fitTransitions, stemLoad, tableFor, type FittedModel, type TransitionTable } from './hazards'
import {
  DEFAULT_PARAMS,
  ENGINE_VERSION,
  FORECAST_WEEKS,
  MARKETING_WEEKS,
  type EngineInput,
  type ForecastOptions,
  type ForecastResult,
  type ForecastBasis,
  type ForecastWeek,
  type ModelParams,
} from './types'
import { indexYw } from './weeks'

type Dist = Map<string, number> // "stage:weeksInStage" → probability (still on the plant)

export type Outcome = {
  /** Probability of first harvest in each step (index 0 = one week later). */
  harvest: number[]
  aborted: number[]
  pruned: number[]
  /** Probability of still being on the plant (unharvested) after the last step, by stage. */
  remaining: Record<FruitStage, number>
}

/** Steps one fruit forward `steps` weeks from its last observation. */
export function propagate(table: TransitionTable, stage: FruitStage, weeksInStage: number, steps: number): Outcome {
  let dist: Dist = new Map([[`${stage}:${weeksInStage}`, 1]])
  const out: Outcome = { harvest: [], aborted: [], pruned: [], remaining: { S: 0, M: 0, B: 0 } }
  for (let step = 0; step < steps; step++) {
    const next: Dist = new Map()
    let h = 0
    let a = 0
    let p = 0
    for (const [key, prob] of dist) {
      const [s, d] = key.split(':') as [FruitStage, string]
      const probs = table[s][binOf(s, Number(d))]
      OUTCOMES[s].forEach((outcome, k) => {
        const q = prob * probs[k]
        if (q === 0) return
        if (outcome === 'H') h += q
        else if (outcome === 'A') a += q
        else if (outcome === 'P') p += q
        else {
          const nextKey = outcome === s ? `${s}:${Math.min(Number(d) + 1, BINS[s] + 2)}` : `${outcome}:0`
          next.set(nextKey, (next.get(nextKey) ?? 0) + q)
        }
      })
    }
    out.harvest.push(h)
    out.aborted.push(a)
    out.pruned.push(p)
    dist = next
  }
  for (const [key, prob] of dist) out.remaining[key.split(':')[0] as FruitStage] += prob
  return out
}

/** Probability of first harvest in each of the next `steps` weeks (see propagate). */
export const harvestProbabilities = (table: TransitionTable, stage: FruitStage, weeksInStage: number, steps: number) =>
  propagate(table, stage, weeksInStage, steps).harvest

/** Where a fruit stood at its stem's last trusted visit (null when it isn't a fruit on the plant then). */
export function inventoryEntry(history: CropHistory, h: NodeHistory): { visitIndex: number; stage: FruitStage; weeksInStage: number } | null {
  const weeks = history.observedWeeks.get(h.stemId)
  if (!weeks) return null
  // Already recorded Harvested or lost by the origin (even in an untrusted week): not on the plant.
  const now = stateAt(h, history.originIndex)
  if (now === 'H' || isLoss(now)) return null
  let visit = -Infinity
  for (const w of weeks) if (w <= history.originIndex && w > visit) visit = w
  // A node first recorded after its stem's last trusted visit (e.g. in a confirmed-error week) starts from that record.
  const firstRecord = h.records[0][0]
  const at = Number.isFinite(visit) ? Math.max(visit, Math.min(firstRecord, history.originIndex)) : firstRecord
  const state = stateAt(h, at)
  if (state !== 'S' && state !== 'M' && state !== 'B') return null
  return { visitIndex: at, stage: state, weeksInStage: at - stateEntryAt(h, at)! }
}

/**
 * New sets per sampled stem per week, averaged over the last `weeks` weeks:
 * fruit first recorded as SetFruit in a week, on stems checked that week and
 * the week before, both lifecycle weeks. A fruit first seen at a later stage,
 * or on a stem not checked the week before (a variety's first walkthrough),
 * may have set any time earlier and is never counted as a new set.
 */
export function newSetRate(history: CropHistory, weeks: number): number {
  return newSetRates(history, weeks).rate
}

/** newSetRate with the number of weeks it rests on. */
export function newSetRates(history: CropHistory, weeks: number): { rate: number; weeks: number } {
  const rates: number[] = []
  for (let w = history.originIndex; w > history.originIndex - weeks; w--) {
    if (!history.isLifecycleWeek(w) || !history.isLifecycleWeek(w - 1)) continue
    const stems = [...history.observedWeeks.entries()].filter(([, set]) => set.has(w) && set.has(w - 1)).map(([id]) => id)
    if (stems.length === 0) continue
    const visited = new Set(stems)
    const sets = history.nodes.filter((h) => h.fruitIndex === w && h.stageEntry.S === w && visited.has(h.stemId)).length
    rates.push(sets / stems.length)
  }
  return { rate: rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : 0, weeks: rates.length }
}

/** Week-to-week records per stage needed before the lifecycle forecast uses that stage. */
export const MIN_STAGE_EXAMPLES: Record<FruitStage, number> = { S: 200, M: 50, B: 50 }
/** Lifecycle weeks (with the week before) the new-set rate must rest on. */
export const MIN_SET_RATE_WEEKS = 2
const STAGE_NAME: Record<FruitStage, string> = { S: 'SetFruit', M: 'MatureGreen', B: 'Breaker' }

/** Mean live fruit per sampled stem at the origin (the load band new sets start in). */
function meanLoad(history: CropHistory, load: (stemId: string, index: number) => number): number {
  const stems = history.sampleStemIds
  return stems.length ? stems.reduce((a, s) => a + load(s, history.originIndex), 0) / stems.length : 0
}

export function forecast(input: EngineInput, options: ForecastOptions): ForecastResult {
  const params: ModelParams = { ...DEFAULT_PARAMS, ...options.params, halfLifeWeeks: { ...DEFAULT_PARAMS.halfLifeWeeks, ...options.params?.halfLifeWeeks } }
  const horizon = options.horizon ?? FORECAST_WEEKS
  const origin = options.originIndex
  const history = buildHistory(input, origin, options.cutoff, params.assumeConfirmed, options.observedCutoff)
  const model: FittedModel = fitTransitions(history, params)

  const sampleStems = history.sampleStemIds.length
  const scale = sampleStems === 0 ? 0 : input.crop.pickingStems / sampleStems
  const visitedAtOrigin = history.sampleStemIds.filter((id) => history.observedWeeks.get(id)?.has(origin)).length
  // Not enough history for a stage (or the new-set rate): no week is forecast.
  const setRate = newSetRates(history, params.setRateWeeks)
  const missing = (['S', 'M', 'B'] as FruitStage[])
    .filter((st) => model.stageExamples[st] < MIN_STAGE_EXAMPLES[st])
    .map((st) => `${STAGE_NAME[st]}: ${model.stageExamples[st]} of ${MIN_STAGE_EXAMPLES[st]} week-to-week records`)
  if (setRate.weeks < MIN_SET_RATE_WEEKS) missing.push(`new sets: ${setRate.weeks} of ${MIN_SET_RATE_WEEKS} lifecycle weeks`)
  const unavailableReason = missing.length ? `Not available: not enough full lifecycle history (${missing.join('; ')}).` : null
  const totals = Array.from({ length: horizon }, () => ({ mean: 0, variance: 0, breaker: 0, matureGreen: 0, setFruit: 0, catchUp: 0, newSets: 0, aborted: 0, pruned: 0 }))
  const inventory = { setFruit: 0, matureGreen: 0, breaker: 0, unvisitedAtOrigin: 0 }
  const fate = { harvested: 0, aborted: 0, pruned: 0, stillOnPlant: { S: 0, M: 0, B: 0 } as Record<FruitStage, number> }
  const load = stemLoad(history)

  for (const h of history.nodes) {
    const entry = inventoryEntry(history, h)
    if (!entry) continue
    inventory[entry.stage === 'S' ? 'setFruit' : entry.stage === 'M' ? 'matureGreen' : 'breaker']++
    const behind = origin - entry.visitIndex
    if (behind > 0) inventory.unvisitedAtOrigin++
    const out = propagate(tableFor(model, h.isSideShoot, load(h.stemId, entry.visitIndex)), entry.stage, entry.weeksInStage, behind + horizon)
    const catchUp = out.harvest.slice(0, behind).reduce((a, b) => a + b, 0)
    for (let k = 0; k < horizon; k++) {
      const own = out.harvest[behind + k]
      const p = own + (k === 0 ? catchUp : 0)
      const t = totals[k]
      t.mean += p
      t.variance += p * (1 - p)
      if (k === 0) t.catchUp += catchUp
      if (entry.stage === 'B') t.breaker += own
      else if (entry.stage === 'M') t.matureGreen += own
      else t.setFruit += own
      t.aborted += out.aborted[behind + k]
      t.pruned += out.pruned[behind + k]
    }
    fate.harvested += out.harvest.reduce((a, b) => a + b, 0)
    fate.aborted += out.aborted.reduce((a, b) => a + b, 0)
    fate.pruned += out.pruned.reduce((a, b) => a + b, 0)
    for (const s of ['S', 'M', 'B'] as FruitStage[]) fate.stillOnPlant[s] += out.remaining[s]
  }

  // Fruit not set yet: sets in week origin + j are first recorded at that visit (week 0 of SetFruit).
  const setsPerWeek = setRate.rate * sampleStems
  const newSet = propagate(tableFor(model, false, meanLoad(history, load)), 'S', 0, horizon).harvest
  for (let k = 0; k < horizon; k++) {
    let n = 0
    for (let j = 1; j <= k; j++) n += setsPerWeek * newSet[k - j]
    totals[k].newSets = n
  }

  const weeks: ForecastWeek[] = totals.map((t, k) => {
    const sampleFruit = t.mean + t.newSets
    const targetIndex = origin + k + 1
    const afw = chooseAfw(input.afw, origin, targetIndex, params.afwMethod, params.growerAfw)
    const cropFruit = sampleFruit * scale
    return {
      targetIndex,
      targetYw: indexYw(targetIndex),
      horizon: k + 1,
      window: k < MARKETING_WEEKS ? 'marketing' : 'outlook',
      available: unavailableReason === null,
      unavailableReason,
      sampleFruit,
      sampleVariance: t.variance + t.newSets,
      components: { breaker: t.breaker, matureGreen: t.matureGreen, setFruit: t.setFruit, catchUp: t.catchUp, newSets: t.newSets },
      expectedAborted: t.aborted,
      expectedPruned: t.pruned,
      cropFruit,
      afwG: afw?.grams ?? null,
      afwSource: afw?.source ?? null,
      afwKind: afw?.kind ?? null,
      kg: afw && unavailableReason === null ? (cropFruit * afw.grams) / 1000 : null,
    }
  })
  const marketing = weeks.filter((w) => w.window === 'marketing')
  const training = { legacy: model.legacyExamples, verified: model.verifiedExamples }
  const confidence = assessConfidence(training, options.validatedHorizons ?? [], horizon)
  if (unavailableReason) confidence.reasons.unshift(unavailableReason)
  const flagsAtCutoff = input.flags
  const applied = confirmedErrors(flagsAtCutoff, params.assumeConfirmed)
  const countWeeks = (m: Map<string, Set<number>>) => [...m.values()].reduce((a, set) => a + set.size, 0)
  const verifiedWeekCount = countWeeks(history.verifiedWeeks)

  return {
    originIndex: origin,
    originYw: indexYw(origin),
    cutoff: options.cutoff,
    horizon,
    sampleStems,
    sampleStemIds: history.sampleStemIds,
    scale,
    inventory,
    inventoryFate: { ...fate, horizon },
    newSetsPerWeek: setsPerWeek,
    training: { transitions: model.examples, excludedStemWeeks: history.excludedStemWeeks, excludedNodes: history.nodes.filter((n) => n.excluded).length },
    weeks,
    marketingTotal: {
      weeks: marketing.length,
      sampleFruit: marketing.every((w) => w.available) ? marketing.reduce((a, w) => a + w.sampleFruit, 0) : null,
      cropFruit: marketing.every((w) => w.available) ? marketing.reduce((a, w) => a + w.cropFruit, 0) : null,
      kg: marketing.every((w) => w.available && w.kg !== null) ? marketing.reduce((a, w) => a + w.kg!, 0) : null,
    },
    basis: 'lifecycle',
    basisSource: basisAt(input.basisSettings, origin, Date.parse(options.cutoff)).source,
    harvestReadyShare: null,
    breakers: null,
    coverage: { visited: visitedAtOrigin, expected: sampleStems, share: sampleStems ? visitedAtOrigin / sampleStems : null },
    params,
    engineVersion: ENGINE_VERSION,
    dataSummary: {
      observedCutoff: options.observedCutoff ?? options.cutoff,
      recordedCutoff: options.cutoff,
      training: { ...training, verifiedShare: confidence.verifiedShare },
      legacyWeeks: countWeeks(history.observedWeeks) - verifiedWeekCount,
      verifiedWeeks: verifiedWeekCount,
      flagsApplied: applied.map((f) => ({ flagKey: f.flagKey, ruleId: f.ruleId, decision: f.reviewDecision === 'recording_error' ? 'recording_error' : 'assumed' })),
      unreviewedFlags: flagsAtCutoff.filter((f) => f.reviewDecision === null).length,
      excludedStemWeeks: history.excludedStemWeeks,
      excludedNodes: history.nodes.filter((n) => n.excluded).length,
      inventory,
      loadBandCuts: model.load?.cuts ?? null,
      afwSource: weeks[0]?.afwSource ?? null,
    },
    confidence: { level: confidence.level, reasons: confidence.reasons },
  }
}

/**
 * The forecast of a sampling week on the basis in effect for it: the
 * eight-week lifecycle forecast, or (Breakers only) next week from that
 * week's Breakers. `defaultBasis` applies when the variety has no setting.
 */
export function forecastForWeek(
  input: EngineInput,
  options: ForecastOptions & { defaultBasis?: ForecastBasis; validatedByBasis?: Record<ForecastBasis, number[]> },
): ForecastResult {
  const inEffect = basisAt(input.basisSettings, options.originIndex, Date.parse(options.cutoff), options.defaultBasis ?? 'lifecycle')
  const validatedHorizons = options.validatedByBasis?.[inEffect.basis] ?? options.validatedHorizons
  if (inEffect.basis === 'lifecycle') return forecast(input, { ...options, validatedHorizons })
  return breakerForecast(input, {
    ...options,
    validatedHorizons,
    harvestReadyShare: inEffect.harvestReadyShare ?? DEFAULT_HARVEST_READY_SHARE,
    basisSource: inEffect.source,
  })
}

/** The experimental share used when Breakers only applies by default (no setting yet). */
export const DEFAULT_HARVEST_READY_SHARE = 0.85
