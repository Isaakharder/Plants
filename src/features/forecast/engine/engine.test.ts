import { describe, expect, it } from 'vitest'
import { scoringUnits, metrics, type ScoringWeek } from './accuracy'
import { forecastAfw } from './afw'
import { baselineForecast } from './baselines'
import { forecast, harvestProbabilities, inventoryEntry, propagate } from './forecast'
import { OUTCOMES, fitTransitions, tableFor } from './hazards'
import { buildHistory, cleanRecords } from './history'
import { DEFAULT_TRUTH, simulateCrop, toEngineInput } from './testing/simulate'
import { modelTiming, setToHarvestTiming } from './timing'
import { DEFAULT_PARAMS, FORECAST_WEEKS, MARKETING_WEEKS, type EngineFlag, type EngineInput } from './types'
import { indexYw, weekIndex, weekOfIndex, weekStartInstant, ywIndex } from './weeks'

const START = weekIndex(2026, 10)
const END = weekIndex(2026, 40)
const STEMS = 60
const fruits = simulateCrop({ stems: STEMS, start: START, end: END, seed: 42 })
const clean = toEngineInput(fruits, STEMS, { start: START, end: END })
const FAR = '2100-01-01T00:00:00Z'
const cutoffOf = (index: number) => new Date(weekStartInstant(index + 1).getTime() - 1).toISOString()

/** Breaker → Harvested probability fitted at a stage-B bin. */
const bToH = (input: EngineInput, origin: number, assumeConfirmed: string[] = [], bin = 0) => {
  const model = fitTransitions(buildHistory(input, origin, FAR, assumeConfirmed), { ...DEFAULT_PARAMS, halfLifeWeeks: { SetFruit: Infinity, MatureGreen: Infinity, BreakerFruit: Infinity } })
  return model.all.B[bin][OUTCOMES.B.indexOf('H')]
}

describe('weeks', () => {
  it('round-trips indices across New Year and week 53', () => {
    expect(weekIndex(2027, 1) - weekIndex(2026, 53)).toBe(1)
    expect(weekIndex(2026, 1) - weekIndex(2025, 52)).toBe(1)
    expect(weekOfIndex(weekIndex(2026, 53))).toEqual({ year: 2026, week: 53 })
    expect(indexYw(ywIndex(202701))).toBe(202701)
  })
  it('starts a greenhouse week on Monday 00:00 Toronto', () => {
    expect(weekStartInstant(weekIndex(2026, 42)).toISOString()).toBe('2026-10-12T04:00:00.000Z')
    expect(weekStartInstant(weekIndex(2026, 2)).toISOString()).toBe('2026-01-05T05:00:00.000Z')
  })
})

describe('cleanRecords', () => {
  it('drops mis-tapped losses, backward stages and repeats; stops at harvest', () => {
    expect(cleanRecords([[1, 'SetFruit'], [2, 'Aborted'], [3, 'MatureGreen'], [4, 'SetFruit'], [5, 'MatureGreen'], [6, 'Harvested'], [7, 'Flower']])).toEqual([
      [1, 'S'],
      [3, 'M'],
      [6, 'H'],
    ])
    expect(cleanRecords([[1, 'SetFruit'], [3, 'Pruned'], [4, 'Pruned']])).toEqual([
      [1, 'S'],
      [3, 'P'],
    ])
  })
})

describe('harvestProbabilities', () => {
  it('a breaker with 60% weekly harvest is picked 0.6, 0.24, 0.096 …', () => {
    const table = { S: [[1, 0, 0, 0, 0, 0]], M: [[1, 0, 0, 0, 0]], B: [[0.4, 0.6, 0, 0], [0.4, 0.6, 0, 0], [0.4, 0.6, 0, 0], [0.4, 0.6, 0, 0]] }
    const p = harvestProbabilities(table, 'B', 0, 3)
    expect(p[0]).toBeCloseTo(0.6)
    expect(p[1]).toBeCloseTo(0.24)
    expect(p[2]).toBeCloseTo(0.096)
  })
})

describe('on a simulated crop with perfect logging', () => {
  it('recovers the true weekly breaker → harvest probability', () => {
    expect(bToH(clean, END)).toBeCloseTo(DEFAULT_TRUTH.bToH, 1)
  })

  it('forecasts without material bias at all eight horizons', { timeout: 60_000 }, () => {
    const origins = Array.from({ length: 10 }, (_, i) => START + 14 + i)
    const final = buildHistory(clean, END, FAR)
    for (let h = 1; h <= FORECAST_WEEKS; h++) {
      const pairs = origins.map((o) => {
        const f = forecast(clean, { originIndex: o, cutoff: cutoffOf(o), params: { halfLifeWeeks: { SetFruit: Infinity, MatureGreen: Infinity, BreakerFruit: Infinity } } })
        return { forecast: f.weeks[h - 1].sampleFruit, observed: final.nodes.filter((n) => n.harvestIndex === o + h).length }
      })
      const m = metrics(pairs)
      expect(Math.abs(m.bias!), `bias at +${h}`).toBeLessThan(0.08)
      expect(m.wape!, `WAPE at +${h}`).toBeLessThan(0.2)
    }
  })

  it('scales sample fruit by picking stems ÷ sampled stems and converts to kg with the AFW', () => {
    const f = forecast(clean, { originIndex: START + 20, cutoff: cutoffOf(START + 20) })
    expect(f.sampleStems).toBe(STEMS)
    expect(f.scale).toBe(1000)
    expect(f.weeks[0].cropFruit).toBeCloseTo(f.weeks[0].sampleFruit * 1000)
    expect(f.weeks[0].kg).toBeCloseTo((f.weeks[0].cropFruit * 200) / 1000)
  })

  it('never uses records stored after the cutoff', () => {
    const origin = START + 20
    const late = structuredClone(clean)
    // A burst of harvest records for the origin week that only reached the database a month later.
    for (const o of late.observations) if (weekIndex(o.year, o.week) === origin && o.status === 'Harvested') o.recordedAt = '2026-12-01T00:00:00Z'
    const withLate = forecast(late, { originIndex: origin, cutoff: cutoffOf(origin) })
    const without = forecast(clean, { originIndex: origin, cutoff: cutoffOf(origin) })
    // The harvests weren't known at the cutoff, so those fruit are still in the inventory.
    expect(withLate.inventory.breaker).toBeGreaterThan(without.inventory.breaker)
  })
})

describe('with logging mistakes', () => {
  const MISSED = START + 18

  /** Harvests of MISSED not recorded that week; recorded at the next visit instead (late logging). */
  const lateLogged = (() => {
    const input = structuredClone(clean)
    for (const o of input.observations) {
      if (weekIndex(o.year, o.week) !== MISSED || o.status !== 'Harvested') continue
      const next = weekOfIndex(MISSED + 1)
      o.year = next.year
      o.week = next.week
    }
    return input
  })()
  const flag: EngineFlag = { flagKey: `harvest_not_recorded:${indexYw(MISSED)}`, ruleId: 'harvest_not_recorded', scope: 'week', yw: indexYw(MISSED), stemId: null, nodeId: null, reviewDecision: null }

  it('an unreviewed flag leaves the data as recorded; a confirmed one keeps the late week out of training', () => {
    const origin = MISSED + 3
    const asRecorded = bToH({ ...lateLogged, flags: [flag] }, origin)
    const confirmed = bToH({ ...lateLogged, flags: [{ ...flag, reviewDecision: 'recording_error' }] }, origin)
    const truthFit = bToH(clean, origin)
    // As recorded, the missing week looks like slower picking; confirmed, the estimate is back near the clean data.
    expect(asRecorded).toBeLessThan(truthFit - 0.02)
    expect(Math.abs(confirmed - truthFit)).toBeLessThan(0.02)
    // The same happens when the backtest assumes the rule's flags are confirmed.
    expect(bToH({ ...lateLogged, flags: [flag] }, origin, ['harvest_not_recorded'])).toBeCloseTo(confirmed, 6)
  })

  it('a legitimate (dismissed) flag is never treated as an error', () => {
    const origin = MISSED + 3
    expect(bToH({ ...lateLogged, flags: [{ ...flag, reviewDecision: 'legitimate' }] }, origin, ['harvest_not_recorded'])).toBeCloseTo(bToH({ ...lateLogged, flags: [] }, origin), 6)
  })

  it('a missed visit is never a zero: its fruit carry forward and their harvests come back as catch-up', () => {
    const skipped = new Set(['stem-000', 'stem-001', 'stem-002', 'stem-003', 'stem-004', 'stem-005'])
    const input = structuredClone(clean)
    // Those stems weren't visited in MISSED: no check, and any change shows up a week later.
    input.stemVisits = input.stemVisits.filter((v) => !(skipped.has(v.stemId) && weekIndex(v.year, v.week) === MISSED))
    const stemOf = new Map(input.nodes.map((n) => [n.id, n.stemId]))
    for (const o of input.observations) {
      if (weekIndex(o.year, o.week) !== MISSED || !skipped.has(stemOf.get(o.nodeId)!)) continue
      const next = weekOfIndex(MISSED + 1)
      o.year = next.year
      o.week = next.week
    }
    const f = forecast(input, { originIndex: MISSED, cutoff: cutoffOf(MISSED) })
    expect(f.inventory.unvisitedAtOrigin).toBeGreaterThan(0)
    expect(f.weeks[0].components.catchUp).toBeGreaterThan(1)
    // The skipped stems are still in the sample: the scale doesn't jump.
    expect(f.sampleStems).toBe(STEMS)
    // Five-week total close to the clean forecast's: nothing was lost or invented.
    const cleanF = forecast(clean, { originIndex: MISSED, cutoff: cutoffOf(MISSED) })
    const total = (r: typeof f) => r.weeks.reduce((a, w) => a + w.sampleFruit, 0)
    expect(Math.abs(total(f) / total(cleanF) - 1)).toBeLessThan(0.05)
    // Training skips the unobserved week instead of reading it as "nothing happened".
    expect(bToH(input, MISSED + 3)).toBeCloseTo(bToH(clean, MISSED + 3), 1)
  })

  it('a fruit already recorded Harvested is never forecast again, even in an untrusted week', () => {
    const origin = MISSED + 1
    const confirmed = { ...lateLogged, flags: [{ ...flag, yw: indexYw(MISSED + 1), reviewDecision: 'recording_error' as const }] }
    const h = buildHistory(confirmed, origin, cutoffOf(origin))
    const harvestedThen = h.nodes.filter((n) => n.harvestIndex === origin).length
    expect(harvestedThen).toBeGreaterThan(0)
    const f = forecast(confirmed, { originIndex: origin, cutoff: cutoffOf(origin) })
    const allFruit = h.nodes.filter((n) => n.fruitIndex !== null && n.harvestIndex === null).length
    expect(f.inventory.breaker + f.inventory.matureGreen + f.inventory.setFruit).toBeLessThanOrEqual(allFruit)
  })
})

describe('baselines', () => {
  it('lastWeek and mean3 repeat recent harvests; the cohort ladder uses set cohorts', () => {
    const origin = START + 20
    const h = buildHistory(clean, origin, cutoffOf(origin))
    const last = h.nodes.filter((n) => n.harvestIndex === origin).length
    expect(baselineForecast(h, 'lastWeek')).toEqual([last, last, last, last, last])
    const ladder = baselineForecast(h, 'cohortLadder')
    expect(ladder).toHaveLength(5)
    expect(ladder[0]).toBeGreaterThan(0)
  })
})

describe('forecastAfw', () => {
  const entries = [180, 190, 200, 210, 220, 230].map((g, i) => ({ year: 2026, week: 30 + i, afwG: g }))
  const o = weekIndex(2026, 35)
  it('uses only weeks up to the origin', () => {
    expect(forecastAfw([...entries, { year: 2026, week: 36, afwG: 999 }], o, o + 1, 'last')).toEqual({ grams: 230, source: 'Entered AFW, W35' })
    expect(forecastAfw(entries, o, o + 1, 'mean3')?.grams).toBeCloseTo(220)
    expect(forecastAfw(entries, weekIndex(2026, 29), o, 'mean3')).toBeNull()
  })
  it('damps a trend', () => {
    const t1 = forecastAfw(entries, o, o + 1, 'trend6')!.grams
    const t5 = forecastAfw(entries, o, o + 5, 'trend6')!.grams
    expect(t1).toBeCloseTo(238)
    expect(t5).toBeGreaterThan(t1)
    expect(t5).toBeLessThan(230 + 5 * 10)
  })
})

describe('scoringUnits', () => {
  const week = (index: number, horizon: number, f: number, o: number): ScoringWeek => ({ index, horizon, forecastFruit: f, observedFruit: o, forecastKg: f, observedKg: o })
  const weeks = [week(1, 1, 10, 10), week(2, 2, 10, 0), week(3, 3, 10, 20), week(4, 4, 10, 10), week(5, 5, 10, 0)]
  it('merges an unreliable week with the next one and drops a trailing one', () => {
    const units = scoringUnits(weeks, new Set([2, 5]), 99)
    expect(units.map((u) => u.weeks)).toEqual([[1], [2, 3], [4]])
    expect(units[1]).toMatchObject({ horizon: 2, block: true, forecastFruit: 20, observedFruit: 20 })
  })
  it('leaves out weeks that can’t be scored yet', () => {
    expect(scoringUnits(weeks, new Set(), 3).map((u) => u.weeks)).toEqual([[1], [2], [3]])
  })
  it('computes WAPE, MAE and bias', () => {
    const m = metrics([{ forecast: 12, observed: 10 }, { forecast: 6, observed: 10 }])
    expect(m.n).toBe(2)
    expect(m.wape).toBeCloseTo(0.3)
    expect(m.mae).toBeCloseTo(3)
    expect(m.bias).toBeCloseTo(-0.1)
  })
})

describe('eight-week horizon', () => {
  const origin = START + 20
  const result = forecast(clean, { originIndex: origin, cutoff: cutoffOf(origin) })
  const fitted = fitTransitions(buildHistory(clean, origin, cutoffOf(origin)), DEFAULT_PARAMS)

  it('covers eight weeks: 1–5 the marketing window, 6–8 the outlook, with a five-week total', () => {
    expect(result.weeks).toHaveLength(FORECAST_WEEKS)
    expect(result.weeks.map((w) => w.window)).toEqual(['marketing', 'marketing', 'marketing', 'marketing', 'marketing', 'outlook', 'outlook', 'outlook'])
    const five = result.weeks.slice(0, MARKETING_WEEKS)
    expect(result.marketingTotal.sampleFruit).toBeCloseTo(five.reduce((a, w) => a + w.sampleFruit, 0))
    expect(result.marketingTotal.kg).toBeCloseTo(five.reduce((a, w) => a + w.kg!, 0))
  })

  it('places a newly set pepper’s harvest around its usual age, not inside the first weeks', () => {
    // The simulated crop's true set → harvest timing (fruit fully resolved within the data).
    const ages = fruits.filter((f) => f.path.at(-1)![1] === 'Harvested' && f.path[0][0] < END - 16).map((f) => f.path.at(-1)![0] - f.path[0][0])
    const trueMode = [...new Set(ages)].sort((a, b) => ages.filter((x) => x === b).length - ages.filter((x) => x === a).length)[0]
    const p = modelTiming(tableFor(fitted, false, 10))
    const modelMode = p.indexOf(Math.max(...p)) + 1
    expect(Math.abs(modelMode - trueMode)).toBeLessThanOrEqual(1)
    expect(modelMode).toBeGreaterThan(5)
    // Most of its harvest probability lies beyond week 5, and some beyond week 8.
    expect(p.slice(0, 5).reduce((a, b) => a + b, 0)).toBeLessThan(p.slice(5, 14).reduce((a, b) => a + b, 0))
    expect(propagate(tableFor(fitted, false, 10), 'S', 0, 8).remaining.S + propagate(tableFor(fitted, false, 10), 'S', 0, 8).remaining.M + propagate(tableFor(fitted, false, 10), 'S', 0, 8).remaining.B).toBeGreaterThan(0.05)
  })

  it('forecasts an older pepper from its own history, not as newly set', () => {
    const h = buildHistory(clean, origin, cutoffOf(origin))
    const old = h.nodes.find((n) => n.fruitIndex === origin - 5 && inventoryEntry(h, n)?.stage === 'S')!
    const entry = inventoryEntry(h, old)!
    expect(entry.weeksInStage).toBe(5)
    const t = tableFor(fitted, false, 10)
    const fiveWeeks = (stage: 'S', d: number) => harvestProbabilities(t, stage, d, 5).reduce((a, b) => a + b, 0)
    expect(fiveWeeks('S', 5)).toBeGreaterThan(fiveWeeks('S', 0) + 0.1)
  })

  it('accounts for every fruit: harvested, aborted, pruned or still on the plant after week 8', () => {
    for (const [stage, d] of [['S', 0], ['S', 6], ['M', 1], ['B', 0]] as const) {
      const o = propagate(tableFor(fitted, false, 10), stage, d, FORECAST_WEEKS)
      const total = [...o.harvest, ...o.aborted, ...o.pruned].reduce((a, b) => a + b, 0) + o.remaining.S + o.remaining.M + o.remaining.B
      expect(total).toBeCloseTo(1, 9)
    }
    const f = result.inventoryFate
    const inv = result.inventory.setFruit + result.inventory.matureGreen + result.inventory.breaker
    expect(f.harvested + f.aborted + f.pruned + f.stillOnPlant.S + f.stillOnPlant.M + f.stillOnPlant.B).toBeCloseTo(inv, 6)
    // Abortion and pruning are kept apart and both happen in this crop.
    expect(f.aborted).toBeGreaterThan(0)
    expect(f.pruned).toBeGreaterThan(0)
    expect(result.weeks.reduce((a, w) => a + w.expectedPruned, 0)).toBeCloseTo(f.pruned, 6)
    // Young fruit are still on the plant after eight weeks: never forced into the horizon.
    expect(f.stillOnPlant.S + f.stillOnPlant.M + f.stillOnPlant.B).toBeGreaterThan(1)
  })

  it('new sets reach harvest only in the outlook weeks', () => {
    expect(result.weeks.slice(0, 3).every((w) => w.components.newSets < 0.5)).toBe(true)
    expect(result.weeks[7].components.newSets).toBeGreaterThan(result.weeks[4].components.newSets)
    expect(result.newSetsPerWeek).toBeGreaterThan(0)
  })
})

describe('set → harvest timing from incomplete records', () => {
  it('matches the true timing, and recent unfinished cohorts don’t pull it short', () => {
    // Truth: every simulated fruit's own outcome, from cohorts that had time to resolve.
    const resolved = fruits.filter((f) => f.path[0][0] <= END - 20)
    const truthCum = (age: number) => resolved.filter((f) => f.path.at(-1)![1] === 'Harvested' && f.path.at(-1)![0] - f.path[0][0] <= age).length / resolved.length

    // Cut the data early: the last cohorts are still on the plant (right-censored).
    const cut = START + 22
    const table = setToHarvestTiming(buildHistory(clean, cut, cutoffOf(cut)), { maxAge: 14 })
    expect(table.rightCensored).toBeGreaterThan(100)
    for (const age of [6, 8, 10]) expect(table.rows[age - 1].cumHarvested).toBeCloseTo(truthCum(age), 1)

    // Naively, "harvested within 8 weeks ÷ all fruit set" counts unfinished recent fruit as never harvested: too low.
    const h = buildHistory(clean, cut, cutoffOf(cut))
    const set = h.nodes.filter((n) => n.fruitIndex !== null)
    const naive8 = set.filter((n) => n.harvestIndex !== null && n.harvestIndex - n.fruitIndex! <= 8).length / set.length
    expect(naive8).toBeLessThan(truthCum(8) - 0.05)
    expect(Math.abs(table.rows[7].cumHarvested - truthCum(8))).toBeLessThan(Math.abs(naive8 - truthCum(8)) / 2)
  })

  it('leaves an unvisited week out instead of crediting its harvests to one week', () => {
    // The whole crop skipped a visit: everything that happened in `gap` was recorded at the next visit.
    const gap = START + 15
    const next = weekOfIndex(gap + 1)
    const input = structuredClone(clean)
    input.stemVisits = input.stemVisits.filter((v) => weekIndex(v.year, v.week) !== gap)
    for (const o of input.observations) if (weekIndex(o.year, o.week) === gap) Object.assign(o, { year: next.year, week: next.week })
    for (const n of input.nodes) if (Date.parse(n.createdAt) >= weekStartInstant(gap).getTime() && Date.parse(n.createdAt) < weekStartInstant(gap + 1).getTime()) n.createdAt = new Date(Date.parse(n.createdAt) + 7 * 86_400_000).toISOString()
    const withGap = setToHarvestTiming(buildHistory(input, END, FAR))
    expect(withGap.intervalCensored).toBeGreaterThan(10)
    // The estimate barely moves: the gap is left out, not read as "nothing harvested that week".
    const full = setToHarvestTiming(buildHistory(clean, END, FAR))
    expect(full.intervalCensored).toBe(0)
    expect(withGap.rows[7].cumHarvested).toBeCloseTo(full.rows[7].cumHarvested, 1)
  })
})

describe('data tiers: legacy history as a prior, verified records take over', () => {
  // Legacy period: harvest recording was unreliable (a third of harvests logged a week late).
  // Verified period (explicit checks + completed weeks): clean records.
  const SPLIT = START + 18
  const build = (verifiedFrom: number) => {
    const input = structuredClone(clean)
    let i = 0
    for (const o of input.observations) {
      const w = weekIndex(o.year, o.week)
      if (w < SPLIT && o.status === 'Harvested' && i++ % 3 === 0) Object.assign(o, weekOfIndex(w + 1))
    }
    input.samplingEvents = []
    for (let w = verifiedFrom; w <= END; w++) {
      const { year, week } = weekOfIndex(w)
      const at = weekStartInstant(w + 1).toISOString()
      input.samplingEvents.push({ year, week, event: 'completed', observedAt: at, recordedAt: at })
    }
    return input
  }
  const pBH = (input: EngineInput, origin: number, strength = DEFAULT_PARAMS.legacyPriorStrength) => {
    const m = fitTransitions(buildHistory(input, origin, FAR), { ...DEFAULT_PARAMS, legacyPriorStrength: strength, halfLifeWeeks: { SetFruit: Infinity, MatureGreen: Infinity, BreakerFruit: Infinity } })
    return { p: m.all.B[0][OUTCOMES.B.indexOf('H')], m }
  }

  it('with only legacy records, fits them as before and calls itself experimental', () => {
    const input = build(END + 1)
    const { p, m } = pBH(input, END)
    expect(m.verifiedExamples).toBe(0)
    expect(p).toBeLessThan(DEFAULT_TRUTH.bToH - 0.03) // the late logging biases it
    const f = forecast(input, { originIndex: END, cutoff: FAR })
    expect(f.confidence.level).toBe('experimental')
    expect(f.confidence.reasons[0]).toMatch(/unverified history/)
    expect(f.dataSummary.training.verified).toBe(0)
  })

  it('moves to the verified estimate as verified weeks accumulate', () => {
    const input = build(SPLIT)
    const early = pBH(input, SPLIT + 2).p
    const late = pBH(input, END).p
    expect(pBH(input, END).m.verifiedExamples).toBeGreaterThan(1000)
    expect(Math.abs(late - DEFAULT_TRUTH.bToH)).toBeLessThan(0.04)
    expect(Math.abs(late - DEFAULT_TRUTH.bToH)).toBeLessThan(Math.abs(early - DEFAULT_TRUTH.bToH))
    const f = forecast(input, { originIndex: END, cutoff: FAR, validatedHorizons: [1, 2] })
    expect(f.dataSummary.verifiedWeeks).toBeGreaterThan(0)
    expect(f.dataSummary.legacyWeeks).toBeGreaterThan(0)
    expect(f.confidence.reasons.join(' ')).toMatch(/Not yet validated by live forecasts: \+3/)
  })
})

describe('auditability', () => {
  const origin = START + 20

  it('reproduces a forecast exactly from the same inputs and cutoffs', () => {
    const a = forecast(clean, { originIndex: origin, cutoff: cutoffOf(origin) })
    const b = forecast(structuredClone(clean), { originIndex: origin, cutoff: cutoffOf(origin) })
    expect(b).toEqual(a)
    expect(a.engineVersion).toMatch(/^stage-8w-/)
  })

  it('ignores records observed after the sampling completion, even in the same week', () => {
    const input = structuredClone(clean)
    const completion = weekStartInstant(origin).getTime() + 3 * 86_400_000 // Thursday of the origin week
    // A harvest record made on the Saturday after completion, in the same week.
    const late = input.observations.find((o) => weekIndex(o.year, o.week) === origin && o.status === 'Harvested')!
    late.observedAt = late.recordedAt = new Date(completion + 2 * 86_400_000).toISOString()
    const f = forecast(input, { originIndex: origin, cutoff: FAR, observedCutoff: new Date(completion).toISOString() })
    const g = forecast(input, { originIndex: origin, cutoff: FAR })
    expect(f.inventory.breaker).toBe(g.inventory.breaker + 1) // still on the plant as far as the completion knew
    expect(f.dataSummary.observedCutoff).toBe(new Date(completion).toISOString())
  })

  it('lists the flags it treated as recording errors and counts the open ones', () => {
    const flags: EngineFlag[] = [
      { flagKey: 'harvest_not_recorded:x', ruleId: 'harvest_not_recorded', scope: 'week', yw: indexYw(origin - 3), stemId: null, nodeId: null, reviewDecision: 'recording_error' },
      { flagKey: 'long_development:n', ruleId: 'long_development', scope: 'node', yw: indexYw(origin - 2), stemId: null, nodeId: 'node-00001', reviewDecision: null },
      { flagKey: 'stale_status:n', ruleId: 'stale_status', scope: 'node', yw: indexYw(origin - 2), stemId: null, nodeId: 'node-00002', reviewDecision: 'legitimate' },
    ]
    const f = forecast({ ...clean, flags }, { originIndex: origin, cutoff: cutoffOf(origin) })
    expect(f.dataSummary.flagsApplied).toEqual([{ flagKey: 'harvest_not_recorded:x', ruleId: 'harvest_not_recorded', decision: 'recording_error' }])
    expect(f.dataSummary.unreviewedFlags).toBe(1)
    expect(f.dataSummary.excludedStemWeeks).toBe(STEMS)
  })
})
