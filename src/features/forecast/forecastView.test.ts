import { describe, expect, it } from 'vitest'
import type { ForecastRunRow, ForecastRunWeekRow } from '../../lib/database.types'
import { breakerForecast } from './engine/breaker'
import { forecast } from './engine/forecast'
import { simulateCrop, toEngineInput } from './engine/testing/simulate'
import { weekIndex, weekOfIndex, weekStartInstant } from './engine/weeks'
import type { EngineInput } from './engine/types'
import { componentsTitle, readyShareAdjustable, statusExplanation, viewFromPreview, viewFromRun, withReadyShare } from './forecastView'

const START = weekIndex(2026, 20)
const END = weekIndex(2026, 40)
const input = toEngineInput(simulateCrop({ stems: 20, start: START, end: END, seed: 3 }), 20, { start: START, end: END })
const cutoff = new Date(weekStartInstant(END + 1).getTime() - 1).toISOString()
const result = forecast({ ...input, afwHistory: 'log' } as typeof input, { originIndex: END, cutoff })

describe('viewFromPreview', () => {
  const preview = { result, afwHistory: 'log' as const, origin: weekOfIndex(END), completion: null, computedAt: cutoff }
  const view = viewFromPreview(preview, 5)

  it('keeps eight weeks, five in the marketing window, and a marketing total of weeks 1–5 only', () => {
    expect(view.weeks).toHaveLength(8)
    expect(view.weeks.filter((w) => w.window === 'marketing')).toHaveLength(5)
    const five = view.weeks.slice(0, 5).reduce((a, w) => a + w.kg!, 0)
    expect(view.marketing.kg).toBeCloseTo(five)
    expect(view.marketing.kg).toBeLessThan(view.weeks.reduce((a, w) => a + w.kg!, 0))
    expect(view.marketing.cases).toBeCloseTo(five / 5)
    expect(view.weeks[0].cases).toBeCloseTo(view.weeks[0].kg! / 5)
  })

  it('is preliminary without a completed sampling week, and says so', () => {
    expect(view.status).toBe('preliminary')
    expect(statusExplanation(view)).toMatch(/isn’t marked complete.*saved and shown until it is generated again; it is never official and never counted in accuracy/)
    expect(viewFromPreview({ ...preview, completion: { id: 'e', year: 2026, week: 40, observedAt: cutoff, recordedAt: cutoff } }, null).status).toBe('preview')
  })

  it('has no cases without a case weight', () => {
    const v = viewFromPreview(preview, null)
    expect(v.marketing.cases).toBeNull()
    expect(v.weeks.every((w) => w.cases === null)).toBe(true)
  })

  it('scales the fate of the fruit on the plants to the crop', () => {
    const f = result.inventoryFate
    expect(view.fate!.aborted).toBeCloseTo(f.aborted * result.scale)
    expect(view.fate!.stillOnPlant).toBeCloseTo((f.stillOnPlant.S + f.stillOnPlant.M + f.stillOnPlant.B) * result.scale)
  })

  it('explains each week’s sources on hover', () => {
    expect(componentsTitle(view.weeks[6], view.scale)).toMatch(/From fruit at Breaker now: .* · MatureGreen: .* · SetFruit:/)
  })
})

describe('viewFromRun', () => {
  const run = {
    id: 'r', organization_id: 'o', crop_id: 'c', origin_year: 2026, origin_week: 40, kind: 'late', sampling_event_id: 'e',
    observed_cutoff: cutoff, recorded_cutoff: cutoff, locked_at: cutoff, locked_by: null, first_target_starts: cutoff, horizon: 8, marketing_weeks: 5,
    engine_version: 'stage-8w-test', confidence: 'experimental', confidence_reasons: ['Experimental: …'], model: { inventoryFate: result.inventoryFate },
    data_summary: result.dataSummary, sample_stems: 20, sample_stem_ids: result.sampleStemIds, scale: '1000' as unknown as number, case_weight_kg: null, marketing_sample_fruit: 1, marketing_crop_fruit: 1000, marketing_kg: 200,
    basis: 'lifecycle', harvest_ready_share: null, breaker_breakdown: null, coverage: null, revision: 1, revises_run_id: null, revision_note: null,
  } satisfies ForecastRunRow
  const weeks: ForecastRunWeekRow[] = result.weeks.map((w) => ({
    run_id: 'r', horizon: w.horizon, ...(({ year, week }) => ({ target_year: year, target_week: week }))(weekOfIndex(w.targetIndex)), window: w.window, available: true,
    sample_fruit: w.sampleFruit, sample_variance: w.sampleVariance, crop_fruit: w.cropFruit, components: w.components,
    expected_aborted: w.expectedAborted, expected_pruned: w.expectedPruned, afw_g: w.afwG, afw_source: w.afwSource, afw_kind: w.afwKind, kg: w.kg, cases: null,
  }))
  it('shows a late run as late, with its stored figures', () => {
    const v = viewFromRun(run, weeks)
    expect(v.status).toBe('late')
    expect(statusExplanation(v)).toMatch(/not counted as an on-time forecast/)
    expect(v.marketing.kg).toBe(200)
    expect(v.scale).toBe(1000)
    expect(v.weeks.map((w) => w.window).slice(4, 6)).toEqual(['marketing', 'outlook'])
  })
})

describe('Ready % experiments', () => {
  // Cadalora-like: 124 Breakers on 74 checked stems, 218,784 picking stems, 174 g AFW.
  const stems = Array.from({ length: 74 }, (_, i) => `s${i}`)
  const friday = new Date(Date.UTC(2026, 9, 16, 12)).toISOString()
  const input: EngineInput = {
    crop: { id: 'c', pickingStems: 218_784, areaM2: 100 },
    stems: stems.map((id) => ({ id, rowId: 'r', isActive: true })),
    nodes: Array.from({ length: 124 }, (_, i) => ({ id: `s${i % 74}.${Math.floor(i / 74)}`, stemId: `s${i % 74}`, isSideShoot: false, isActive: true, createdAt: '2026-01-01T00:00:00Z' })),
    observations: Array.from({ length: 124 }, (_, i) => ({ id: `o${i}`, nodeId: `s${i % 74}.${Math.floor(i / 74)}`, year: 2026, week: 42, status: 'BreakerFruit' as const, observedAt: friday, recordedAt: friday })),
    growth: [],
    stemVisits: stems.map((stemId) => ({ stemId, year: 2026, week: 42, checked: true, observedAt: friday, recordedAt: friday })),
    samplingEvents: [],
    afw: [{ year: 2026, week: 43, afwG: 174 }],
    flags: [],
  }
  const viewAt = (share: number, afw = true) =>
    viewFromPreview(
      { result: breakerForecast(afw ? input : { ...input, afw: [] }, { originIndex: weekIndex(2026, 42), cutoff: '2100-01-01T00:00:00Z', harvestReadyShare: share }), afwHistory: 'log', origin: { year: 2026, week: 42 }, completion: null, computedAt: friday },
      20,
    )

  it('recalculates next week exactly as the engine would with that share', () => {
    const tried = withReadyShare(viewAt(0.85), 0.7)
    const engine = viewAt(0.7)
    expect(tried.harvestReadyShare).toBe(0.7)
    for (const k of ['sampleFruit', 'cropFruit', 'kg', 'cases'] as const) expect(tried.weeks[0][k]!).toBeCloseTo(engine.weeks[0][k]!, 6)
    expect(tried.breakers!.possibleLaterCrop).toBeCloseTo(engine.breakers!.possibleLaterCrop, 6)
    expect(tried.marketing).toEqual(engine.marketing)
    expect(tried.weeks.slice(1)).toEqual(engine.weeks.slice(1))
  })

  it('never changes the saved forecast it starts from', () => {
    const saved = viewAt(0.7)
    const copy = JSON.parse(JSON.stringify(saved))
    withReadyShare(saved, 0.95)
    expect(JSON.parse(JSON.stringify(saved))).toEqual(copy)
    expect(withReadyShare(saved, 0.7).weeks[0].kg).toBeCloseTo(saved.weeks[0].kg!, 9) // the saved share gives the saved kg
  })

  it('is only offered where a projection can be calculated', () => {
    expect(readyShareAdjustable(viewAt(0.7))).toBe(true)
    expect(readyShareAdjustable(viewAt(0.7, false))).toBe(false) // no AFW: no kg
    expect(readyShareAdjustable({ ...viewAt(0.7), basis: 'lifecycle' })).toBe(false)
    const noNext = viewAt(0.7)
    expect(readyShareAdjustable({ ...noNext, weeks: noNext.weeks.map((w) => (w.horizon === 1 ? { ...w, available: false } : w)) })).toBe(false)
    const unchanged = viewAt(0.7, false)
    expect(withReadyShare(unchanged, 0.9)).toBe(unchanged)
  })
})
