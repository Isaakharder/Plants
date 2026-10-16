// Next-week harvest from a Friday walkthrough that records Breakers only
// (approved 2026-10-16, for the rest of 2026).
//
//   Sample      the stems checked or recorded in the origin week. A checked
//               stem without Breakers counts as zero; a stem not checked is
//               left out (never a zero). Scale: picking stems ÷ those stems.
//   Breakers    distinct nodes whose latest record in the origin week is
//               Breaker: each pepper once, however often it was recorded.
//               A Breaker still on the plant is recorded again the next
//               Friday on the same node, so it is part of that week's count
//               (carried over) and of no other forecast: last week's
//               Breakers are never added on top.
//   Next week   share × Breakers × scale peppers (share: the harvest-ready
//               share of the variety's setting, an experimental 85% from
//               Mathieu 2026), × AFW ÷ 1000 kg when an AFW is entered.
//   Later weeks not available: what sets, ripens or breaks after this
//               Friday isn't recorded.
//
// A Breaker of last Friday not recorded again on a stem checked this Friday
// leaves the inventory. It is not counted as harvested: actual harvested kg
// is entered separately.

import { chooseAfw } from './afw'
import { buildHistory, confirmedErrors } from './history'
import {
  DEFAULT_PARAMS,
  ENGINE_VERSION,
  FORECAST_WEEKS,
  MARKETING_WEEKS,
  type BreakerBreakdown,
  type EngineInput,
  type ForecastOptions,
  type ForecastResult,
  type ForecastWeek,
  type ModelParams,
} from './types'
import { indexYw } from './weeks'

export const LOW_COVERAGE = 0.9

export type BreakerForecastOptions = ForecastOptions & {
  harvestReadyShare: number
  basisSource?: ForecastResult['basisSource']
}

const pct = (x: number) => `${Math.round(100 * x)}%`

export function breakerForecast(input: EngineInput, options: BreakerForecastOptions): ForecastResult {
  const params: ModelParams = { ...DEFAULT_PARAMS, ...options.params, halfLifeWeeks: { ...DEFAULT_PARAMS.halfLifeWeeks, ...options.params?.halfLifeWeeks } }
  const horizon = options.horizon ?? FORECAST_WEEKS
  const origin = options.originIndex
  const share = options.harvestReadyShare
  const history = buildHistory(input, origin, options.cutoff, params.assumeConfirmed, options.observedCutoff)

  const expected = history.sampleStemIds.length
  const visited = new Set(history.sampleStemIds.filter((id) => history.observedWeeks.get(id)?.has(origin)))
  const visitedPrev = (stemId: string) => history.observedWeeks.get(stemId)?.has(origin - 1) ?? false
  const scale = visited.size === 0 ? 0 : input.crop.pickingStems / visited.size

  const breakdown: BreakerBreakdown = { total: 0, carriedOver: 0, new: 0, firstSeen: 0, notRecordedAgain: 0, possibleLaterCrop: 0 }
  for (const h of history.nodes) {
    if (h.excluded || !visited.has(h.stemId)) continue
    const now = h.weekStates.get(origin)
    const before = h.weekStates.get(origin - 1)
    if (now === 'B') {
      breakdown.total++
      if (before === 'B') breakdown.carriedOver++
      else if (visitedPrev(h.stemId)) breakdown.new++
      else breakdown.firstSeen++
    } else if (before === 'B' && visitedPrev(h.stemId)) {
      breakdown.notRecordedAgain++
    }
  }
  breakdown.possibleLaterCrop = (1 - share) * breakdown.total * scale

  const nextFruit = share * breakdown.total
  const afw = chooseAfw(input.afw, origin, origin + 1, params.afwMethod, params.growerAfw)
  const notAvailable = 'Not available: only Breakers are recorded, which supports next week only (needs full lifecycle data).'
  const weeks: ForecastWeek[] = Array.from({ length: horizon }, (_, k) => {
    const targetIndex = origin + k + 1
    const next = k === 0
    const cropFruit = next ? nextFruit * scale : 0
    return {
      targetIndex,
      targetYw: indexYw(targetIndex),
      horizon: k + 1,
      window: k < MARKETING_WEEKS ? 'marketing' : 'outlook',
      available: next,
      unavailableReason: next ? null : notAvailable,
      sampleFruit: next ? nextFruit : 0,
      sampleVariance: next ? breakdown.total * share * (1 - share) : 0,
      components: { breaker: next ? nextFruit : 0, matureGreen: 0, setFruit: 0, catchUp: 0, newSets: 0 },
      expectedAborted: 0,
      expectedPruned: 0,
      cropFruit,
      afwG: next ? afw?.grams ?? null : null,
      afwSource: next ? afw?.source ?? null : null,
      afwKind: next ? afw?.kind ?? null : null,
      kg: next && afw ? (cropFruit * afw.grams) / 1000 : null,
    }
  })

  const validated = (options.validatedHorizons ?? []).includes(1)
  const coverage = expected ? visited.size / expected : null
  const reasons: string[] = [
    `Experimental: next week = ${pct(share)} of this week's Breakers (harvest-ready share; an assumption from Mathieu 2026 Breaker records${validated ? '' : ', not yet validated against actual harvested kg'}).`,
  ]
  if (coverage !== null && visited.size < expected) {
    reasons.push(`Incomplete walkthrough: ${visited.size} of ${expected} sampled stems checked or recorded this week${coverage < LOW_COVERAGE ? ` (low coverage: below ${pct(LOW_COVERAGE)})` : ''}. Stems not checked are left out, not counted as zero.`)
  }
  if (expected === 0 || visited.size === 0) reasons.push('No sampled stem was checked or recorded this week.')
  if (!afw) reasons.push('No AFW entered for this variety: kilograms and cases can’t be calculated.')
  reasons.push('Weeks 2–8 aren’t available while only Breakers are recorded.')

  const flagsAtCutoff = input.flags
  const applied = confirmedErrors(flagsAtCutoff, params.assumeConfirmed)
  const inventory = { setFruit: 0, matureGreen: 0, breaker: breakdown.total, unvisitedAtOrigin: 0 }
  return {
    originIndex: origin,
    originYw: indexYw(origin),
    cutoff: options.cutoff,
    horizon,
    sampleStems: visited.size,
    sampleStemIds: [...visited].sort(),
    scale,
    inventory,
    inventoryFate: { harvested: nextFruit, aborted: 0, pruned: 0, stillOnPlant: { S: 0, M: 0, B: breakdown.total - nextFruit }, horizon: 1 },
    newSetsPerWeek: 0,
    training: { transitions: 0, excludedStemWeeks: history.excludedStemWeeks, excludedNodes: history.nodes.filter((n) => n.excluded).length },
    weeks,
    marketingTotal: { weeks: Math.min(MARKETING_WEEKS, horizon), sampleFruit: null, cropFruit: null, kg: null },
    params,
    engineVersion: ENGINE_VERSION,
    dataSummary: {
      observedCutoff: options.observedCutoff ?? options.cutoff,
      recordedCutoff: options.cutoff,
      training: { legacy: 0, verified: 0, verifiedShare: 0 },
      legacyWeeks: 0,
      verifiedWeeks: 0,
      flagsApplied: applied.map((f) => ({ flagKey: f.flagKey, ruleId: f.ruleId, decision: f.reviewDecision === 'recording_error' ? 'recording_error' : 'assumed' })),
      unreviewedFlags: flagsAtCutoff.filter((f) => f.reviewDecision === null).length,
      excludedStemWeeks: history.excludedStemWeeks,
      excludedNodes: history.nodes.filter((n) => n.excluded).length,
      inventory,
      loadBandCuts: null,
      afwSource: afw?.source ?? null,
    },
    confidence: { level: validated ? 'standard' : 'experimental', reasons },
    basis: 'breaker_only',
    basisSource: options.basisSource ?? { kind: 'default' },
    harvestReadyShare: share,
    breakers: breakdown,
    coverage: { visited: visited.size, expected, share: coverage },
  }
}
