// Set → harvest timing, estimated properly from incomplete records.
//
// A plain average of "weeks from set to harvest" over harvested fruit is
// biased short: the slowest fruit of recent cohorts haven't been harvested
// yet, and fruit that abort never get a harvest age. This is a discrete-time
// competing-risks life table by age (weeks since the fruit was first
// recorded as fruit):
//
//   * at each age, the fruit still on the plant and observed both that week
//     and the week before are at risk; of them, some are harvested, aborted or
//     pruned that week;
//   * a fruit still on the plant when the data ends is right-censored: it
//     counts as at risk up to its last observation and never shortens the
//     timing;
//   * a week its stem wasn't visited (or a confirmed recording-error week) is
//     left out instead of guessed, so an event recorded after a gap is not
//     credited to one particular week; the number of such interval-censored
//     events is reported;
//   * a fruit harvested without MatureGreen/Breaker records still has a
//     known harvest age; only its stage path is missing.
//
// Cumulative incidence at age a: harvested by a = Σ S(age − 1) × h(age),
// with S the probability of still being on the plant. Harvests beyond the
// last age shown stay in "still on the plant", never forced into the table.

import { isLoss, stateAt, type CropHistory, type State } from './history'
import { propagate } from './forecast'
import type { TransitionTable } from './hazards'

export type TimingRow = {
  age: number
  atRisk: number
  harvested: number
  aborted: number
  pruned: number
  /** Probability of first harvest at exactly this age (from set). */
  pHarvest: number
  cumHarvested: number
  cumAborted: number
  cumPruned: number
  /** Probability of still being on the plant (unharvested) after this age. */
  stillOnPlant: number
}

export type TimingTable = {
  rows: TimingRow[]
  fruit: number
  /** Fruit still on the plant at their last observation (right-censored). */
  rightCensored: number
  /** Events recorded after an unobserved week (not credited to a single age). */
  intervalCensored: number
  /** Median age at harvest among fruit that are harvested (null if fewer than half resolved). */
  medianHarvestAge: number | null
}

export function setToHarvestTiming(history: CropHistory, opts: { maxAge?: number; setFrom?: number; setTo?: number } = {}): TimingTable {
  const maxAge = opts.maxAge ?? 14
  const counts = Array.from({ length: maxAge + 1 }, () => ({ atRisk: 0, H: 0, A: 0, P: 0 }))
  let fruit = 0
  let rightCensored = 0
  let intervalCensored = 0
  for (const h of history.nodes) {
    if (h.excluded || h.fruitIndex === null) continue
    if (opts.setFrom !== undefined && h.fruitIndex < opts.setFrom) continue
    if (opts.setTo !== undefined && h.fruitIndex > opts.setTo) continue
    const weeks = history.observedWeeks.get(h.stemId) ?? new Set<number>()
    fruit++
    let resolved = false
    for (let age = 1; age <= maxAge; age++) {
      const w = h.fruitIndex + age
      if (w > history.originIndex) break
      const before = stateAt(h, w - 1)
      if (before === 'H' || isLoss(before)) {
        resolved = true
        break
      }
      const now = stateAt(h, w) as State
      const ended = now === 'H' || isLoss(now)
      if (!weeks.has(w) || !weeks.has(w - 1)) {
        if (ended) {
          intervalCensored++
          resolved = true
          break
        }
        continue
      }
      counts[age].atRisk++
      if (now === 'H') counts[age].H++
      else if (now === 'A') counts[age].A++
      else if (now === 'P') counts[age].P++
      if (ended) {
        resolved = true
        break
      }
    }
    if (!resolved) rightCensored++
  }

  const rows: TimingRow[] = []
  let surv = 1
  let cumH = 0
  let cumA = 0
  let cumP = 0
  for (let age = 1; age <= maxAge; age++) {
    const c = counts[age]
    const hH = c.atRisk ? c.H / c.atRisk : 0
    const hA = c.atRisk ? c.A / c.atRisk : 0
    const hP = c.atRisk ? c.P / c.atRisk : 0
    const pHarvest = surv * hH
    cumH += pHarvest
    cumA += surv * hA
    cumP += surv * hP
    surv *= 1 - hH - hA - hP
    rows.push({ age, atRisk: c.atRisk, harvested: c.H, aborted: c.A, pruned: c.P, pHarvest, cumHarvested: cumH, cumAborted: cumA, cumPruned: cumP, stillOnPlant: surv })
  }
  // Median harvest age among harvested fruit: the age at which half the eventual harvest (as far as observed) is reached.
  const half = cumH / 2
  const median = cumH > 0 && cumH >= 0.5 * (cumH + surv) ? rows.find((r) => r.cumHarvested >= half)?.age ?? null : null
  return { rows, fruit, rightCensored, intervalCensored, medianHarvestAge: median }
}

/** The model's set → harvest timing for a fruit set now: harvest probability by age from SetFruit, week 0. */
export function modelTiming(table: TransitionTable, maxAge = 14): number[] {
  return propagate(table, 'S', 0, maxAge).harvest
}
