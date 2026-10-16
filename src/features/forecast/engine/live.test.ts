import { describe, expect, it } from 'vitest'
import { forecast } from './forecast'
import { buildHistory } from './history'
import { MIN_SETTLED, WAPE_GOALS, liveAccuracy, observeWeek, scoreRun, type LiveRun, type ObservedContext, type SamplingWeek } from './live'
import { simulateCrop, toEngineInput } from './testing/simulate'
import type { EngineFlag } from './types'
import { indexYw, weekIndex, weekStartInstant } from './weeks'

const START = weekIndex(2026, 10)
const END = weekIndex(2026, 40)
const STEMS = 40
const input = toEngineInput(simulateCrop({ stems: STEMS, start: START, end: END, seed: 9 }), STEMS, { start: START, end: END, afwG: 200 })
const cutoffOf = (i: number) => new Date(weekStartInstant(i + 1).getTime() - 1).toISOString()

/** A locked run as the snapshot stores it, from the engine. */
function runAt(origin: number, kind: 'official' | 'late' = 'official'): LiveRun {
  const f = forecast(input, { originIndex: origin, cutoff: cutoffOf(origin) })
  return {
    id: `run-${origin}`,
    originIndex: origin,
    kind,
    confidence: f.confidence.level,
    sampleStemIds: f.sampleStemIds,
    scale: f.scale,
    weeks: f.weeks.map((w) => ({ horizon: w.horizon, targetIndex: w.targetIndex, window: w.window, sampleFruit: w.sampleFruit, kg: w.kg, afwG: w.afwG })),
  }
}

function context(over: Partial<ObservedContext> = {}, flags: EngineFlag[] = []): ObservedContext {
  const sampling = new Map<number, SamplingWeek>()
  for (let i = START; i <= END; i++) sampling.set(i, { visited: STEMS, expected: STEMS, complete: true })
  return {
    currentIndex: END + 1,
    history: buildHistory({ ...input, flags }, END + 1, '2100-01-01T00:00:00Z'),
    sampling,
    flags,
    actualAfw: new Map(Array.from({ length: END - START + 1 }, (_, i) => [START + i, 200])),
    ...over,
  }
}

describe('observeWeek', () => {
  const run = runAt(END - 6)
  it('never scores weeks that haven’t happened, or the current one', () => {
    const ctx = context({ currentIndex: END - 3 })
    expect(observeWeek(ctx, run, END - 2).status).toBe('pending')
    expect(observeWeek(ctx, run, END - 3).status).toBe('in_progress')
  })
  it('waits for the next visit (late records) before settling a week', () => {
    const ctx = context({ currentIndex: END + 1 })
    expect(observeWeek(ctx, run, END).status).toBe('provisional')
    expect(observeWeek(ctx, run, END - 1).status).toBe('settled')
  })
  it('a missing or incomplete visit, or a flagged week, is unreliable, never a zero', () => {
    const ctx = context()
    ctx.sampling.set(END - 3, { visited: 0, expected: STEMS, complete: false })
    ctx.sampling.set(END - 4, { visited: 30, expected: STEMS, complete: false })
    expect(observeWeek(ctx, run, END - 3)).toMatchObject({ status: 'unreliable', reason: 'not sampled' })
    expect(observeWeek(ctx, run, END - 4)).toMatchObject({ status: 'unreliable', reason: 'incomplete visit (30 of 40 stems)' })
    const flag: EngineFlag = { flagKey: 'h', ruleId: 'harvest_not_recorded', scope: 'week', yw: indexYw(END - 2), stemId: null, nodeId: null, reviewDecision: null }
    expect(observeWeek(context({}, [flag]), run, END - 2)).toMatchObject({ status: 'unreliable', reason: 'harvests possibly not recorded' })
    // Dismissed as a legitimate crop event: scored as recorded.
    expect(observeWeek(context({}, [{ ...flag, reviewDecision: 'legitimate' }]), run, END - 2).status).toBe('settled')
  })
  it('counts observed harvests on the forecast’s own stems and converts them with the entered AFW', () => {
    const o = observeWeek(context(), run, END - 2)
    const expected = buildHistory({ ...input, flags: [] }, END + 1, '2100-01-01T00:00:00Z').nodes.filter((n) => n.harvestIndex === END - 2).length
    expect(o.observedFruit).toBe(expected)
    expect(o.observedKg).toBeCloseTo((expected * run.scale * 200) / 1000)
    // Only its own stems: a forecast covering half the stems sees about half the harvest.
    const half = { ...run, sampleStemIds: run.sampleStemIds.slice(0, STEMS / 2) }
    expect(observeWeek(context(), half, END - 2).observedFruit).toBeLessThan(expected)
    // Without an entered AFW there is no observed kg (the fruit count is still scored).
    const noAfw = context({ actualAfw: new Map() })
    expect(observeWeek(noAfw, run, END - 2)).toMatchObject({ observedFruit: expected, observedKg: null })
  })
  it('leaves out nodes confirmed as recording errors', () => {
    const ctxAll = context()
    const harvested = ctxAll.history.nodes.find((n) => n.harvestIndex === END - 2)!
    const flag: EngineFlag = { flagKey: 'n', ruleId: 'long_development', scope: 'node', yw: indexYw(END - 2), stemId: null, nodeId: harvested.nodeId, reviewDecision: 'recording_error' }
    expect(observeWeek(context({}, [flag]), runAt(END - 6), END - 2).observedFruit).toBe(observeWeek(ctxAll, runAt(END - 6), END - 2).observedFruit! - 1)
  })
})

describe('scoreRun', () => {
  it('scores settled weeks, merges an unreliable week with the next, and never changes the forecast', () => {
    const run = runAt(END - 8)
    const before = structuredClone(run)
    const ctx = context()
    ctx.sampling.set(END - 5, { visited: 10, expected: STEMS, complete: false })
    const s = scoreRun(ctx, run)
    expect(run).toEqual(before)
    const block = s.units.find((u) => u.block)!
    expect(block.weeks).toEqual([END - 5, END - 4])
    expect(s.units.map((u) => u.horizon)).toEqual([1, 2, 3, 5, 6, 7]) // +3 is the block with +4; +8 is still provisional
    // The last target week (END) is provisional: not scored.
    expect(s.weeks.at(-1)!.status).toBe('provisional')
    expect(s.weeks[0].fruitError).toBeCloseTo(s.weeks[0].sampleFruit / s.weeks[0].observedFruit! - 1)
  })
})

describe('liveAccuracy', () => {
  const runs = Array.from({ length: 12 }, (_, i) => runAt(START + 12 + i))
  const ctx = context()

  it('scores each horizon separately for fruit and kg, counting only official forecasts', () => {
    const { accuracy } = liveAccuracy(ctx, [...runs, runAt(START + 20, 'late')])
    expect(accuracy.officialRuns).toBe(12)
    expect(accuracy.lateRuns).toBe(1)
    expect(accuracy.horizons).toHaveLength(8)
    expect(accuracy.horizons.map((h) => h.goal)).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((h) => WAPE_GOALS[h]))
    expect(accuracy.horizons[0].fruit.n).toBe(12)
    expect(accuracy.horizons[0].kg.n).toBe(12)
    expect(accuracy.horizons.slice(5).every((h) => h.window === 'outlook')).toBe(true)
    expect(accuracy.marketing.fruit.n).toBe(12)
  })

  it('validates a horizon only with enough settled forecasts, small bias, good coverage and WAPE within the goal', () => {
    const { accuracy } = liveAccuracy(ctx, runs)
    for (const h of accuracy.horizons) {
      if (h.fruit.n < MIN_SETTLED) expect(h.status).toBe('collecting')
      else if (h.status === 'validated') {
        expect(Math.abs(h.fruit.bias!)).toBeLessThanOrEqual(0.1)
        expect(h.fruit.wape!).toBeLessThanOrEqual(h.goal)
        expect(h.coverage!).toBeGreaterThanOrEqual(0.9)
      } else expect(h.reasons.length).toBeGreaterThan(0)
    }
    // Too few forecasts: still collecting, whatever the error.
    expect(liveAccuracy(ctx, runs.slice(0, 3)).accuracy.horizons.every((h) => h.status === 'collecting')).toBe(true)
    // Poor coverage blocks validation even with a good error.
    const thin = context()
    for (const [i] of thin.sampling) thin.sampling.set(i, { visited: STEMS - 5, expected: STEMS, complete: true })
    expect(liveAccuracy(thin, runs).accuracy.validatedHorizons).toEqual([])
  })
})
