// Weekly transition probabilities of a fruit, by stage and time in stage.
//
// Each training example is one fruit observed at the end of two consecutive
// weeks: its stage and weeks-in-stage at the first, and what it was at the
// second (still there, a later stage, Harvested or lost). Only pairs where
// both weeks were observed count; a gap (an unvisited or confirmed-error
// week) is left out rather than guessed, which keeps missed visits and late
// logging from looking like slow ripening or zero harvests.
//
// Estimation: recency-weighted counts per (stage, weeks-in-stage) cell,
// shrunk toward the stage's pooled probabilities so thin cells borrow from
// the rest. Weeks-in-stage beyond the last bin share the last bin.
//
// Fruit load: set fruit on a stem carrying many fruit abort more (sink
// competition), so SetFruit transitions can be split into bands of the stem's
// live fruit count (SetFruit + MatureGreen + BreakerFruit) at that week. The
// load at the forecast origin is known, which makes it a forward-looking
// predictor rather than a recency guess.
//
// Climate later: weeks-in-stage is the "development age" axis. With
// temperature data it becomes accumulated degree-days (binned), and further
// covariates enter as extra cell dimensions or a regression on these counts;
// nothing else in the engine changes.

import { stateAt, stateEntryAt, type CropHistory, type FruitStage, type State } from './history'
import type { ModelParams } from './types'

export const OUTCOMES: Record<FruitStage, State[]> = {
  S: ['S', 'M', 'B', 'H', 'A', 'P'],
  M: ['M', 'B', 'H', 'A', 'P'],
  B: ['B', 'H', 'A', 'P'],
}
/** Number of weeks-in-stage bins per stage (the last bin is "this many or more"). */
export const BINS: Record<FruitStage, number> = { S: 11, M: 8, B: 4 }

const STAGE_HALF_LIFE: Record<FruitStage, keyof ModelParams['halfLifeWeeks']> = { S: 'SetFruit', M: 'MatureGreen', B: 'BreakerFruit' }

export const binOf = (stage: FruitStage, weeksInStage: number) => Math.min(Math.max(weeksInStage, 0), BINS[stage] - 1)

/** probs[stage][bin][outcome index] */
export type TransitionTable = Record<FruitStage, number[][]>

export type TrainingExample = {
  stage: FruitStage
  bin: number
  outcome: State
  toIndex: number
  sideShoot: boolean
  load: number
  /** Both weeks verified (explicit stem checks in completed sampling weeks); otherwise legacy. */
  verified: boolean
}

/** Live fruit (SetFruit, MatureGreen, BreakerFruit) on each stem at the end of a week. */
export function stemLoad(history: CropHistory): (stemId: string, index: number) => number {
  const byStem = new Map<string, CropHistory['nodes']>()
  for (const h of history.nodes) {
    let list = byStem.get(h.stemId)
    if (!list) byStem.set(h.stemId, (list = []))
    list.push(h)
  }
  const cache = new Map<string, number>()
  return (stemId, index) => {
    const key = `${stemId}:${index}`
    let n = cache.get(key)
    if (n === undefined) {
      n = 0
      for (const h of byStem.get(stemId) ?? []) {
        const s = stateAt(h, index)
        if (s === 'S' || s === 'M' || s === 'B') n++
      }
      cache.set(key, n)
    }
    return n
  }
}

/** Every observed one-week transition of a fruit up to the origin, between two lifecycle weeks. */
export function trainingExamples(history: CropHistory): TrainingExample[] {
  const examples: TrainingExample[] = []
  const load = stemLoad(history)
  for (const h of history.nodes) {
    if (h.excluded || h.fruitIndex === null) continue
    const weeks = history.observedWeeks.get(h.stemId)
    if (!weeks) continue
    const verified = history.verifiedWeeks.get(h.stemId)
    const firstRecord = h.records[0][0]
    for (const w of weeks) {
      if (w < firstRecord || w >= history.originIndex || !weeks.has(w + 1)) continue
      // A Breakers-only week doesn't record SetFruit / MatureGreen changes: no transition can be read from it.
      if (!history.isLifecycleWeek(w) || !history.isLifecycleWeek(w + 1)) continue
      const from = stateAt(h, w)
      if (from !== 'S' && from !== 'M' && from !== 'B') continue
      const to = stateAt(h, w + 1)!
      const entry = stateEntryAt(h, w)!
      examples.push({ stage: from, bin: binOf(from, w - entry), outcome: to, toIndex: w + 1, sideShoot: h.isSideShoot, load: from === 'S' ? load(h.stemId, w) : 0, verified: Boolean(verified?.has(w) && verified.has(w + 1)) })
    }
  }
  return examples
}

function emptyCounts(): Record<FruitStage, number[][]> {
  return {
    S: Array.from({ length: BINS.S }, () => new Array(OUTCOMES.S.length).fill(0)),
    M: Array.from({ length: BINS.M }, () => new Array(OUTCOMES.M.length).fill(0)),
    B: Array.from({ length: BINS.B }, () => new Array(OUTCOMES.B.length).fill(0)),
  }
}

function weightedCounts(examples: TrainingExample[], originIndex: number, params: ModelParams) {
  const counts = emptyCounts()
  for (const e of examples) {
    const k = OUTCOMES[e.stage].indexOf(e.outcome)
    if (k < 0) continue
    const halfLife = params.halfLifeWeeks[STAGE_HALF_LIFE[e.stage]]
    const weight = Number.isFinite(halfLife) ? 0.5 ** ((originIndex - e.toIndex) / halfLife) : 1
    counts[e.stage][e.bin][k] += weight
  }
  return counts
}

/** A weak prior so no outcome of a stage is ever exactly impossible. */
const PRIOR = 0.05

function shrink(counts: Record<FruitStage, number[][]>, alpha: number, toward?: TransitionTable): TransitionTable {
  const table = {} as TransitionTable
  for (const stage of ['S', 'M', 'B'] as FruitStage[]) {
    const n = OUTCOMES[stage].length
    const pooled = new Array(n).fill(PRIOR)
    for (const cell of counts[stage]) cell.forEach((c, k) => (pooled[k] += c))
    const pooledTotal = pooled.reduce((a, b) => a + b, 0)
    const pooledP = pooled.map((c) => c / pooledTotal)
    table[stage] = counts[stage].map((cell, bin) => {
      const target = toward ? toward[stage][bin] : pooledP
      const total = cell.reduce((a, b) => a + b, 0)
      return cell.map((c, k) => (c + alpha * target[k]) / (total + alpha))
    })
  }
  return table
}

export type FittedModel = {
  all: TransitionTable
  side?: TransitionTable
  main?: TransitionTable
  /** Fruit-load bands for SetFruit: upper bounds (exclusive) and one SetFruit table per band. */
  load?: { cuts: number[]; setFruit: number[][][] }
  examples: number
  /** Training examples by data tier. */
  legacyExamples: number
  verifiedExamples: number
  /** Training examples by the stage they start from (enough history per stage: see MIN_STAGE_EXAMPLES). */
  stageExamples: Record<FruitStage, number>
}

/** Load-band cut points: quantiles of the SetFruit examples' stem loads (null when too few). */
function loadCuts(examples: TrainingExample[], bands: number): number[] | null {
  const loads = examples.filter((e) => e.stage === 'S').map((e) => e.load).sort((a, b) => a - b)
  if (bands < 2 || loads.length < 30 * bands) return null
  return Array.from({ length: bands - 1 }, (_, i) => loads[Math.floor(((i + 1) * loads.length) / bands)])
}

/** Fits every table on `examples`, each cell pulled toward `toward` (or its stage's pooled rates) with `alpha`. */
function fitOn(examples: TrainingExample[], origin: number, params: ModelParams, alpha: number, cuts: number[] | null, toward?: FittedModel): Omit<FittedModel, 'examples' | 'legacyExamples' | 'verifiedExamples' | 'stageExamples'> {
  const all = shrink(weightedCounts(examples, origin, params), alpha, toward?.all)
  const model: Omit<FittedModel, 'examples' | 'legacyExamples' | 'verifiedExamples' | 'stageExamples'> = { all }
  if (params.splitSideShoots) {
    model.side = shrink(weightedCounts(examples.filter((e) => e.sideShoot), origin, params), params.shrinkage, toward?.side ?? all)
    model.main = shrink(weightedCounts(examples.filter((e) => !e.sideShoot), origin, params), params.shrinkage, toward?.main ?? all)
  }
  if (cuts) {
    const band = (load: number) => cuts.filter((c) => load >= c).length
    model.load = {
      cuts,
      setFruit: Array.from({ length: cuts.length + 1 }, (_, b) => {
        const target = toward?.load ? { ...all, S: toward.load.setFruit[b] } : all
        return shrink(weightedCounts(examples.filter((e) => e.stage === 'S' && band(e.load) === b), origin, params), toward?.load ? alpha : params.shrinkage, target).S
      }),
    }
  }
  return model
}

/**
 * Legacy records alone → fitted as before. Verified records alone → fitted
 * on them. Both → the legacy fit is the prior: each cell is fitted on the
 * verified records, pulled toward the legacy estimate with
 * legacyPriorStrength pseudo-observations, so verified data takes over as it
 * accumulates while thin cells still lean on the history.
 */
export function fitTransitions(history: CropHistory, params: ModelParams): FittedModel {
  const examples = trainingExamples(history)
  const legacy = examples.filter((e) => !e.verified)
  const verified = examples.filter((e) => e.verified)
  const stageExamples = { S: 0, M: 0, B: 0 } as Record<FruitStage, number>
  for (const e of examples) stageExamples[e.stage]++
  const counts = { examples: examples.length, legacyExamples: legacy.length, verifiedExamples: verified.length, stageExamples }
  const origin = history.originIndex
  if (verified.length === 0 || legacy.length === 0) {
    const used = verified.length ? verified : legacy
    return { ...fitOn(used, origin, params, params.shrinkage, loadCuts(used, params.loadBands)), ...counts }
  }
  const cuts = loadCuts(examples, params.loadBands)
  const prior = fitOn(legacy, origin, params, params.shrinkage, cuts) as FittedModel
  return { ...fitOn(verified, origin, params, params.legacyPriorStrength, cuts, prior), ...counts }
}

/** The table for one fruit: side shoot or main stem, and its stem's fruit-load band for SetFruit. */
export function tableFor(model: FittedModel, sideShoot: boolean, load = 0): TransitionTable {
  const base = (sideShoot ? model.side : model.main) ?? model.all
  if (!model.load) return base
  const band = model.load.cuts.filter((c) => load >= c).length
  return { ...base, S: model.load.setFruit[band] }
}
