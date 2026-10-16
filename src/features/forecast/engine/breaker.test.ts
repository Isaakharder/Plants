// The Breakers-only next-week forecast, carry-over between Fridays, the
// forecast basis, the "no invented rates" rules and scoring against actual kg
// (approved 2026-10-16).

import { describe, expect, it } from 'vitest'
import { basisAt } from './basis'
import { breakerForecast } from './breaker'
import { DEFAULT_HARVEST_READY_SHARE, forecast, forecastForWeek, newSetRates } from './forecast'
import { fitTransitions, trainingExamples } from './hazards'
import { buildHistory } from './history'
import { actualAccuracy, actualsInEffect, scoreAgainstActual, type LiveRun } from './live'
import { simulateCrop, toEngineInput } from './testing/simulate'
import { DEFAULT_PARAMS, type EngineBasisSetting, type EngineInput, type NodeStatus } from './types'
import { weekIndex } from './weeks'

const FAR = '2100-01-01T00:00:00Z'
const W = (week: number) => weekIndex(2026, week)
/** A Friday of a 2026 week, at noon UTC. */
const friday = (week: number) => {
  const monday = Date.UTC(2026, 0, 5) + (week - 2) * 7 * 86_400_000
  return new Date(monday + 4 * 86_400_000 + 12 * 3_600_000).toISOString()
}

/**
 * A small crop: `stems` stems, records as [week, node, status], explicit stem
 * checks as [week, stem]. Node ids: "<stem>.<n>".
 */
function crop(opts: {
  stems: string[]
  records: [number, string, NodeStatus][]
  checks: [number, string][]
  pickingStems?: number
  afw?: { week: number; afwG: number }[]
  settings?: EngineBasisSetting[]
}): EngineInput {
  const nodeIds = [...new Set(opts.records.map(([, n]) => n))]
  return {
    crop: { id: 'c', pickingStems: opts.pickingStems ?? 1000, areaM2: 100 },
    stems: opts.stems.map((id) => ({ id, rowId: 'r', isActive: true })),
    // Nodes created long before, so a new node never counts as a visit.
    nodes: nodeIds.map((id) => ({ id, stemId: id.split('.')[0], isSideShoot: false, isActive: true, createdAt: '2026-01-01T00:00:00Z' })),
    observations: opts.records.map(([week, nodeId, status], i) => ({ id: `o${i}`, nodeId, year: 2026, week, status, observedAt: friday(week), recordedAt: friday(week) })),
    growth: [],
    stemVisits: opts.checks.map(([week, stemId]) => ({ stemId, year: 2026, week, checked: true, observedAt: friday(week), recordedAt: friday(week) })),
    samplingEvents: [],
    afw: (opts.afw ?? []).map((a) => ({ year: 2026, week: a.week, afwG: a.afwG })),
    flags: [],
    basisSettings: opts.settings,
  }
}

const breakersOnlyFrom42: EngineBasisSetting[] = [{ fromYear: 2026, fromWeek: 42, basis: 'breaker_only', harvestReadyShare: 0.85, createdAt: '2026-10-16T00:00:00Z' }]
const run = (input: EngineInput, week: number) => breakerForecast(input, { originIndex: W(week), cutoff: FAR, harvestReadyShare: 0.85 })

describe('next-week forecast from Breakers', () => {
  it('Cadalora W42: 124 Breakers on 74 checked stems, 218,784 picking stems, 174 g → about 54,000 kg next week, unreduced', () => {
    const stems = Array.from({ length: 74 }, (_, i) => `s${i}`)
    const records: [number, string, NodeStatus][] = Array.from({ length: 124 }, (_, i) => [42, `s${i % 74}.${Math.floor(i / 74)}`, 'BreakerFruit'])
    const input = crop({ stems, records, checks: stems.map((s) => [42, s]), pickingStems: 218_784, afw: [{ week: 43, afwG: 174 }] })
    const r = run(input, 42)
    expect(r.basis).toBe('breaker_only')
    expect(r.breakers!.total).toBe(124)
    expect(r.breakers!.firstSeen).toBe(124) // the variety's first walkthrough: never "new sets"
    expect(r.newSetsPerWeek).toBe(0)
    expect(r.weeks[0].available).toBe(true)
    expect(r.weeks[0].cropFruit).toBeCloseTo((0.85 * 124 * 218_784) / 74, 6)
    expect(r.weeks[0].kg!).toBeCloseTo((0.85 * 124 * 218_784 * 174) / 74 / 1000, 6)
    expect(Math.round(r.weeks[0].kg!)).toBe(54_222)
    expect(r.weeks[0].afwKind).toBe('grower')
    expect(r.confidence.level).toBe('experimental')
    expect(r.confidence.reasons[0]).toMatch(/Experimental: next week = 85% of this week's Breakers/)
  })

  it('weeks 2–8 are not available and carry no numbers; the marketing total is not available', () => {
    const input = crop({ stems: ['a'], records: [[42, 'a.1', 'BreakerFruit']], checks: [[42, 'a']], afw: [{ week: 43, afwG: 200 }] })
    const r = run(input, 42)
    expect(r.weeks.slice(1).every((w) => !w.available && w.kg === null && w.unavailableReason?.startsWith('Not available'))).toBe(true)
    expect(r.marketingTotal).toMatchObject({ sampleFruit: null, cropFruit: null, kg: null })
  })

  it('a Breaker re-recorded on the same node on later Fridays is counted once in each forecast', () => {
    const input = crop({
      stems: ['a', 'b'],
      records: [
        [42, 'a.1', 'BreakerFruit'],
        [42, 'b.1', 'BreakerFruit'],
        [43, 'a.1', 'BreakerFruit'], // still Breaker
        [43, 'a.1', 'BreakerFruit'], // tapped twice the same Friday: still one pepper
        [43, 'b.2', 'BreakerFruit'], // new
        [44, 'a.1', 'BreakerFruit'], // still Breaker a third Friday
      ],
      checks: [[42, 'a'], [42, 'b'], [43, 'a'], [43, 'b'], [44, 'a'], [44, 'b']],
    })
    const w43 = run(input, 43)
    expect(w43.breakers).toMatchObject({ total: 2, carriedOver: 1, new: 1, firstSeen: 0, notRecordedAgain: 1 })
    expect(w43.weeks[0].sampleFruit).toBeCloseTo(0.85 * 2)
    const w44 = run(input, 44)
    expect(w44.breakers).toMatchObject({ total: 1, carriedOver: 1, new: 0, notRecordedAgain: 1 })
    // Each forecast uses only its own Friday: last week's Breakers are never added on top.
    expect(w44.weeks[0].sampleFruit).toBeCloseTo(0.85)
  })

  it('a Breaker absent from the next completed walkthrough leaves the inventory without being counted as harvested', () => {
    const input = crop({ stems: ['a'], records: [[42, 'a.1', 'BreakerFruit'], [42, 'a.2', 'BreakerFruit'], [43, 'a.2', 'BreakerFruit']], checks: [[42, 'a'], [43, 'a']] })
    const r = run(input, 43)
    expect(r.breakers).toMatchObject({ total: 1, notRecordedAgain: 1 })
    expect(r.inventoryFate.harvested).toBeCloseTo(0.85) // only this week's Breaker; a.1 is not "harvested"
  })

  it('a stem not checked this week is left out (never zero); its old Breakers are neither counted nor dropped', () => {
    const input = crop({
      stems: ['a', 'b', 'c', 'd'],
      records: [[42, 'd.1', 'BreakerFruit'], [43, 'a.1', 'BreakerFruit']],
      checks: [[42, 'a'], [42, 'b'], [42, 'c'], [42, 'd'], [43, 'a'], [43, 'b'], [43, 'c']],
      pickingStems: 300,
    })
    const r = run(input, 43)
    expect(r.coverage).toEqual({ visited: 3, expected: 4, share: 0.75 })
    expect(r.scale).toBe(100) // 300 picking stems ÷ 3 stems checked
    expect(r.breakers).toMatchObject({ total: 1, notRecordedAgain: 0 })
    expect(r.confidence.reasons.some((x) => /Incomplete walkthrough: 3 of 4 .*low coverage/.test(x))).toBe(true)
  })

  it('a checked stem with no Breakers counts as zero', () => {
    const input = crop({ stems: ['a', 'b'], records: [[42, 'a.1', 'BreakerFruit']], checks: [[42, 'a'], [42, 'b']], pickingStems: 200 })
    expect(run(input, 42).scale).toBe(100)
  })

  it('a pepper first recorded as Breaker on a stem checked last week is new; one seen at another stage last week is new too', () => {
    const input = crop({ stems: ['a'], records: [[42, 'a.1', 'SetFruit'], [43, 'a.1', 'BreakerFruit'], [43, 'a.2', 'BreakerFruit']], checks: [[42, 'a'], [43, 'a']] })
    expect(run(input, 43).breakers).toMatchObject({ total: 2, new: 2, carriedOver: 0, firstSeen: 0 })
  })

  it('without an entered AFW, kg and cases aren’t calculated and the reason says so', () => {
    const input = crop({ stems: ['a'], records: [[42, 'a.1', 'BreakerFruit']], checks: [[42, 'a']] })
    const r = run(input, 42)
    expect(r.weeks[0].cropFruit).toBeGreaterThan(0)
    expect(r.weeks[0].kg).toBeNull()
    expect(r.weeks[0].afwG).toBeNull()
    expect(r.confidence.reasons).toContain('No AFW entered for this variety: kilograms and cases can’t be calculated.')
  })

  it('stays experimental until next week is validated against actual kg', () => {
    const input = crop({ stems: ['a'], records: [[42, 'a.1', 'BreakerFruit']], checks: [[42, 'a']] })
    expect(breakerForecast(input, { originIndex: W(42), cutoff: FAR, harvestReadyShare: 0.85, validatedHorizons: [1] }).confidence.level).toBe('standard')
    expect(run(input, 42).confidence.level).toBe('experimental')
  })
})

describe('forecast basis', () => {
  const settings: EngineBasisSetting[] = [
    { fromYear: 2026, fromWeek: 1, basis: 'lifecycle', harvestReadyShare: null, createdAt: '2026-10-16T00:00:00Z' },
    { fromYear: 2026, fromWeek: 42, basis: 'breaker_only', harvestReadyShare: 0.85, createdAt: '2026-10-16T00:00:00Z' },
  ]
  it('applies the setting with the latest start week at or before the week; the newest entry wins a tie; settings stored later don’t apply', () => {
    const cutoff = Date.parse('2026-10-20T00:00:00Z')
    expect(basisAt(settings, W(41), cutoff).basis).toBe('lifecycle')
    expect(basisAt(settings, W(42), cutoff)).toMatchObject({ basis: 'breaker_only', harvestReadyShare: 0.85 })
    const corrected = [...settings, { fromYear: 2026, fromWeek: 42, basis: 'breaker_only' as const, harvestReadyShare: 0.8, createdAt: '2026-10-18T00:00:00Z' }]
    expect(basisAt(corrected, W(44), cutoff).harvestReadyShare).toBe(0.8)
    expect(basisAt(corrected, W(44), Date.parse('2026-10-17T00:00:00Z')).harvestReadyShare).toBe(0.85)
    expect(basisAt([], W(44), cutoff, 'breaker_only')).toEqual({ basis: 'breaker_only', harvestReadyShare: null, source: { kind: 'default' } })
  })

  it('Mathieu: the full eight-week forecast through W41, next week from Breakers from W42', () => {
    const start = W(22)
    const fruits = simulateCrop({ stems: 56, start, end: W(42), seed: 7 })
    const input = { ...toEngineInput(fruits, 56, { start, end: W(42), afwG: 180 }), basisSettings: settings }
    const w41 = forecastForWeek(input, { originIndex: W(41), cutoff: FAR, defaultBasis: 'breaker_only' })
    expect(w41.basis).toBe('lifecycle')
    expect(w41.weeks.every((w) => w.available)).toBe(true)
    expect(w41.marketingTotal.kg).not.toBeNull()
    const w42 = forecastForWeek(input, { originIndex: W(42), cutoff: FAR, defaultBasis: 'breaker_only' })
    expect(w42.basis).toBe('breaker_only')
    expect(w42.harvestReadyShare).toBe(0.85)
    expect(w42.weeks.filter((w) => w.available).map((w) => w.horizon)).toEqual([1])
  })

  it('no setting: the next-week forecast from Breakers with the default share', () => {
    const input = crop({ stems: ['a'], records: [[42, 'a.1', 'BreakerFruit']], checks: [[42, 'a']] })
    const r = forecastForWeek(input, { originIndex: W(42), cutoff: FAR, defaultBasis: 'breaker_only' })
    expect(r.basis).toBe('breaker_only')
    expect(r.harvestReadyShare).toBe(DEFAULT_HARVEST_READY_SHARE)
    expect(r.basisSource).toEqual({ kind: 'default' })
  })

  it('Breakers-only weeks never teach stage transitions or new-set rates', () => {
    const start = W(22)
    const fruits = simulateCrop({ stems: 30, start, end: W(46), seed: 3 })
    const all = toEngineInput(fruits, 30, { start, end: W(46) })
    const lifecycle = buildHistory(all, W(46), FAR)
    const switched = buildHistory({ ...all, basisSettings: breakersOnlyFrom42 }, W(46), FAR)
    expect(trainingExamples(switched).every((e) => e.toIndex <= W(41))).toBe(true)
    expect(trainingExamples(switched).length).toBeLessThan(trainingExamples(lifecycle).length)
    expect(newSetRates(switched, 4).weeks).toBe(0)
    expect(fitTransitions(switched, DEFAULT_PARAMS).stageExamples.S).toBeLessThan(fitTransitions(lifecycle, DEFAULT_PARAMS).stageExamples.S)
  })
})

describe('no invented rates (lifecycle basis)', () => {
  it('a variety with one walkthrough: no new sets, no weeks, the reason names what is missing', () => {
    const input = crop({
      stems: ['a', 'b'],
      records: [[42, 'a.1', 'SetFruit'], [42, 'a.2', 'BreakerFruit'], [42, 'b.1', 'SetFruit'], [42, 'b.2', 'MatureGreen']],
      checks: [[42, 'a'], [42, 'b']],
      afw: [{ week: 43, afwG: 180 }],
    })
    const history = buildHistory(input, W(42), FAR)
    expect(newSetRates(history, 4)).toEqual({ rate: 0, weeks: 0 })
    const r = forecast(input, { originIndex: W(42), cutoff: FAR })
    expect(r.weeks.every((w) => !w.available && w.kg === null)).toBe(true)
    expect(r.weeks[0].unavailableReason).toMatch(/not enough full lifecycle history \(SetFruit: 0 of 200 .*; MatureGreen: 0 of 50 .*; Breaker: 0 of 50 .*; new sets: 0 of 2 lifecycle weeks\)/)
    expect(r.marketingTotal.kg).toBeNull()
  })

  it('fruit first seen at MatureGreen or Breaker never counts as a new set', () => {
    const input = crop({
      stems: ['a'],
      records: [[41, 'a.0', 'SetFruit'], [42, 'a.1', 'SetFruit'], [42, 'a.2', 'MatureGreen'], [42, 'a.3', 'BreakerFruit']],
      checks: [[41, 'a'], [42, 'a']],
    })
    const h = buildHistory(input, W(42), FAR)
    // W42: one new set on one stem checked W41 and W42; W41 has no checked week before it.
    expect(newSetRates(h, 4)).toEqual({ rate: 1, weeks: 1 })
  })
})

describe('accuracy against actual harvested kg', () => {
  it('uses the newest entry per week; a cleared week has no actual', () => {
    const m = actualsInEffect([
      { id: 1, year: 2026, week: 43, actualKg: 50_000, enteredAt: '2026-10-26T10:00:00Z' },
      { id: 2, year: 2026, week: 43, actualKg: 52_500, enteredAt: '2026-10-27T10:00:00Z' }, // correction
      { id: 3, year: 2026, week: 44, actualKg: 40_000, enteredAt: '2026-11-02T10:00:00Z' },
      { id: 4, year: 2026, week: 44, actualKg: null, enteredAt: '2026-11-03T10:00:00Z' }, // cleared
    ])
    expect(m.get(W(43))).toBe(52_500)
    expect(m.has(W(44))).toBe(false)
  })

  const breakerRun = (week: number, kg: number | null, coverage = 1): LiveRun => ({
    id: `r${week}`,
    originIndex: W(week),
    kind: 'official',
    confidence: 'experimental',
    sampleStemIds: [],
    scale: 1,
    basis: 'breaker_only',
    harvestReadyShare: 0.85,
    coverage,
    weeks: [
      { horizon: 1, targetIndex: W(week + 1), window: 'marketing', available: true, sampleFruit: 1, kg, afwG: 180 },
      { horizon: 2, targetIndex: W(week + 2), window: 'marketing', available: false, sampleFruit: 0, kg: null, afwG: null },
    ],
  })

  it('scores a locked forecast against the actual kg, with the implied harvest-ready share; waits for missing actuals', () => {
    const ctx = { currentIndex: W(50), actualKg: new Map([[W(43), 50_000]]) }
    const s = scoreAgainstActual(ctx, breakerRun(42, 54_000))
    expect(s.weeks).toHaveLength(1) // the unavailable week is never scored
    expect(s.weeks[0].status).toBe('scored')
    expect(s.weeks[0].error).toBeCloseTo(54_000 / 50_000 - 1)
    expect(s.weeks[0].impliedShare).toBeCloseTo((0.85 * 50_000) / 54_000)
    expect(scoreAgainstActual(ctx, breakerRun(43, 50_000)).weeks[0].status).toBe('awaiting_actual')
    expect(scoreAgainstActual({ ...ctx, actualKg: new Map([[W(43), 50_000]]) }, breakerRun(42, null)).weeks[0].status).toBe('not_scorable')
    expect(scoreAgainstActual({ currentIndex: W(43), actualKg: new Map() }, breakerRun(42, 54_000)).weeks[0].status).toBe('in_progress')
  })

  it('validates Breakers-only next week after 8 scored official forecasts within goal, bias and coverage; separately from lifecycle', () => {
    const weeks = Array.from({ length: 8 }, (_, i) => 30 + i)
    const actualKg = new Map(weeks.map((w) => [W(w + 1), 50_000]))
    const good = weeks.map((w, i) => breakerRun(w, i % 2 ? 53_000 : 48_000))
    const ok = actualAccuracy({ currentIndex: W(50), actualKg }, good)
    expect(ok.validatedHorizons).toEqual({ lifecycle: [], breaker_only: [1] })
    expect(ok.horizons.find((h) => h.basis === 'breaker_only')!.status).toBe('validated')
    const biased = actualAccuracy({ currentIndex: W(50), actualKg }, weeks.map((w) => breakerRun(w, 57_000)))
    expect(biased.horizons.find((h) => h.basis === 'breaker_only')!.reasons.join(' ')).toMatch(/bias \+14%/)
    const thin = actualAccuracy({ currentIndex: W(50), actualKg }, weeks.map((w, i) => breakerRun(w, i % 2 ? 53_000 : 48_000, 0.8)))
    expect(thin.validatedHorizons.breaker_only).toEqual([])
    const few = actualAccuracy({ currentIndex: W(50), actualKg }, good.slice(0, 5))
    expect(few.horizons.find((h) => h.basis === 'breaker_only')!.status).toBe('collecting')
  })
})
