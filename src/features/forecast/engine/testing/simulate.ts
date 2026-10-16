// Simulated crops with known weekly transition probabilities, recorded the
// way the collector records them (one status record per change, at a weekly
// visit). Used to check that the engine recovers the true behaviour and how
// logging mistakes affect it.

import type { EngineFlag, EngineInput, EngineObservation, NodeStatus } from '../types'
import { weekOfIndex } from '../weeks'

export type SimTruth = {
  /** P(SetFruit → MatureGreen) by weeks in SetFruit. */
  sToM: (weeksInStage: number) => number
  /** P(SetFruit → lost) by weeks in SetFruit. */
  sLoss: (weeksInStage: number) => number
  mToB: number
  bToH: number
  bLoss: number
  /** Weekly probability the crew prunes a SetFruit or MatureGreen fruit. */
  prune: number
  setsPerStemWeek: number
}

export const DEFAULT_TRUTH: SimTruth = {
  sToM: (d) => (d < 3 ? 0 : 0.45),
  sLoss: (d) => (d < 2 ? 0.08 : 0.02),
  mToB: 0.4,
  bToH: 0.6,
  bLoss: 0.01,
  prune: 0.01,
  setsPerStemWeek: 2,
}

/** Deterministic pseudo-random numbers in [0, 1). */
export function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

export type SimFruit = { nodeId: string; stemId: string; path: [number, NodeStatus][] }

/** Simulates `stems` stems from week `start` to `end` (indices); every stem is visited every week. */
export function simulateCrop(opts: { stems: number; start: number; end: number; seed?: number; truth?: SimTruth }) {
  const truth = opts.truth ?? DEFAULT_TRUTH
  const rand = rng(opts.seed ?? 1)
  const fruits: SimFruit[] = []
  let nodeNo = 0
  for (let s = 0; s < opts.stems; s++) {
    const stemId = `stem-${String(s).padStart(3, '0')}`
    for (let w = opts.start; w <= opts.end; w++) {
      // Sets this week: 0–4, mean setsPerStemWeek.
      const sets = Math.floor(rand() * (2 * truth.setsPerStemWeek + 1))
      for (let i = 0; i < sets; i++) {
        const path: [number, NodeStatus][] = [[w, 'SetFruit']]
        let stage: NodeStatus = 'SetFruit'
        let inStage = 0
        for (let t = w + 1; t <= opts.end; t++) {
          const u = rand()
          let next: NodeStatus = stage
          if (stage === 'SetFruit') {
            const a = truth.sLoss(inStage)
            next = u < a ? 'Aborted' : u < a + truth.prune ? 'Pruned' : u < a + truth.prune + truth.sToM(inStage) ? 'MatureGreen' : stage
          } else if (stage === 'MatureGreen') next = u < truth.prune ? 'Pruned' : u < truth.prune + truth.mToB ? 'BreakerFruit' : stage
          else if (stage === 'BreakerFruit') next = u < truth.bLoss ? 'Aborted' : u < truth.bLoss + truth.bToH ? 'Harvested' : stage
          if (next === stage) inStage++
          else {
            stage = next
            inStage = 0
            path.push([t, next])
          }
          if (stage === 'Harvested' || stage === 'Aborted' || stage === 'Pruned') break
        }
        fruits.push({ nodeId: `node-${String(nodeNo++).padStart(5, '0')}`, stemId, path })
      }
    }
  }
  return fruits
}

const visitTime = (index: number) => {
  const { year, week } = weekOfIndex(index)
  // Tuesday noon UTC of that ISO week.
  const jan4 = Date.UTC(year, 0, 4)
  const monday = jan4 - ((new Date(jan4).getUTCDay() || 7) - 1) * 86_400_000 + (week - 1) * 7 * 86_400_000
  return new Date(monday + 86_400_000 + 12 * 3_600_000).toISOString()
}

/** Turns simulated fruit into collector records (one record per change, stored when made). */
export function toEngineInput(fruits: SimFruit[], stems: number, opts: { pickingStems?: number; afwG?: number; start: number; end: number }): EngineInput {
  const observations: EngineObservation[] = []
  for (const f of fruits) {
    for (const [index, status] of f.path) {
      const { year, week } = weekOfIndex(index)
      const at = visitTime(index)
      observations.push({ id: `${f.nodeId}-${index}`, nodeId: f.nodeId, year, week, status, observedAt: at, recordedAt: at })
    }
  }
  const afw = []
  for (let i = opts.start; i <= opts.end; i++) {
    const { year, week } = weekOfIndex(i)
    afw.push({ year, week, afwG: opts.afwG ?? 200 })
  }
  return {
    crop: { id: 'crop', pickingStems: opts.pickingStems ?? stems * 1000, areaM2: 1000 },
    stems: Array.from({ length: stems }, (_, s) => ({ id: `stem-${String(s).padStart(3, '0')}`, rowId: 'row', isActive: true })),
    nodes: fruits.map((f) => ({ id: f.nodeId, stemId: f.stemId, isSideShoot: false, isActive: true, createdAt: visitTime(f.path[0][0]) })),
    observations,
    growth: [],
    // Every stem confirmed checked every week (explicit tracking).
    stemVisits: Array.from({ length: stems }, (_, s) =>
      Array.from({ length: opts.end - opts.start + 1 }, (_, k) => {
        const { year, week } = weekOfIndex(opts.start + k)
        const at = visitTime(opts.start + k)
        return { stemId: `stem-${String(s).padStart(3, '0')}`, year, week, checked: true, observedAt: at, recordedAt: at }
      }),
    ).flat(),
    afw,
    flags: [] as EngineFlag[],
  }
}
