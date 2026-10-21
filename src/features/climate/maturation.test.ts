import { describe, expect, it } from 'vitest'
import { studyFruits, studyResult, summarize, windowClimate, type StudyClimate, type StudyObservation } from './maturation'
import { addDays } from './reports'

const TZ = 'America/Toronto'
const at = (date: string) => `${date}T16:00:00Z` // noon in Toronto (EDT)
let n = 0
const obs = (node: string, status: string, date: string, legacy = false): StudyObservation => ({
  id: `o${++n}`, plant_node_id: node, status, observed_at: at(date), recorded_at: legacy ? at(date) : `${date}T16:05:00Z`, created_by: legacy ? null : 'u1',
})
/** 20 °C every hour, RH 80, CO₂ 500, radiation 1000 J/cm² a day, 1–25 Oct, with optional gaps. */
function climate(opts: { dropHours?: Record<string, number>; dropDays?: string[]; noRadiation?: string[] } = {}): StudyClimate {
  const hourly = new Map<string, { temp: number[]; rh: number[]; co2: number[] }>()
  const radiationFinal = new Map<string, number>()
  for (let d = '2026-10-01'; d <= '2026-10-25'; d = addDays(d, 1)) {
    if (opts.dropDays?.includes(d)) continue
    const k = 24 - (opts.dropHours?.[d] ?? 0)
    hourly.set(d, { temp: Array(k).fill(20), rh: Array(k).fill(80), co2: Array(k).fill(500) })
    if (!opts.noRadiation?.includes(d)) radiationFinal.set(d, 1000)
  }
  return { hourly, radiationFinal }
}
const stems = new Map([['s1', new Set(['2026-10-07', '2026-10-14', '2026-10-21'])]])
const nodes = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => ({ id, measurement_stem_id: 's1', is_active: id !== 'f' }))
const fruitObs = (node: string, legacy = false) => [obs(node, 'SetFruit', '2026-10-07', legacy), obs(node, 'BreakerFruit', '2026-10-14', legacy), obs(node, 'Harvested', '2026-10-21', legacy)]

describe('a fruit as an interval', () => {
  const [f] = studyFruits(fruitObs('a'), nodes, stems, [], climate(), TZ)
  it('bounds Breaker and harvest by the stem’s visits, with a central estimate', () => {
    expect(f).toMatchObject({ breakerRecord: '2026-10-14', harvestRecord: '2026-10-21', visitBeforeBreaker: '2026-10-07', visitBeforeHarvest: '2026-10-14', excluded: null, legacy: false })
    expect(f.shortest).toMatchObject({ start: '2026-10-14', end: '2026-10-14', days: 0, degreeDays: 0 })
    expect(f.longest).toMatchObject({ start: '2026-10-07', end: '2026-10-21', days: 14, degreeDays: 280, radiation: 14000 })
    expect(f.central).toMatchObject({ start: '2026-10-11', end: '2026-10-18', days: 7, degreeDays: 140, radiation: 7000, meanTemp: 20, meanRh: 80, meanCo2: 500 })
  })
})

describe('only evidence about this fruit bounds it', () => {
  it('ignores another fruit’s record on the same stem', () => {
    const withOther = [...fruitObs('a'), obs('z', 'MatureGreen', '2026-10-17')]
    const a = studyFruits(withOther, [...nodes, { id: 'z', measurement_stem_id: 's1', is_active: true }], stems, [], climate(), TZ).find((f) => f.node === 'a')!
    expect(a.visitBeforeHarvest).toBe('2026-10-14')
  })
})

describe('climate is never filled in', () => {
  it('accepts a window with ≥ 90 % of hourly readings, as a sum of daily means', () => {
    const w = windowClimate('2026-10-11', '2026-10-18', climate({ dropHours: { '2026-10-12': 3 } }), TZ)
    expect(w.tempCoverage).toBeCloseTo(165 / 168)
    expect(w.degreeDays).toBe(140) // each day's mean is still 20 °C: missing hours aren’t counted as 0
  })
  it('rejects temperature below 90 % coverage or with an empty day, and radiation with a missing final', () => {
    expect(windowClimate('2026-10-11', '2026-10-18', climate({ dropHours: { '2026-10-12': 20 } }), TZ).degreeDays).toBeNull()
    expect(windowClimate('2026-10-11', '2026-10-25', climate({ dropDays: ['2026-10-13'] }), TZ)).toMatchObject({ degreeDays: null, meanTemp: null })
    expect(windowClimate('2026-10-11', '2026-10-18', climate({ noRadiation: ['2026-10-15'] }), TZ)).toMatchObject({ radiation: null, degreeDays: 140 })
  })
})

describe('which fruit are used', () => {
  const all = [
    ...fruitObs('a'),
    ...fruitObs('b', true), // legacy CropLink import
    obs('c', 'SetFruit', '2026-10-07'), obs('c', 'BreakerFruit', '2026-10-14'), obs('c', 'MatureGreen', '2026-10-17'), obs('c', 'Harvested', '2026-10-21'), // goes backwards
    ...fruitObs('d'), // flagged stage_regression, not reviewed
    ...fruitObs('e'), // flagged but reviewed as legitimate
    ...fruitObs('f'), // node deactivated
    obs('g', 'BreakerFruit', '2026-10-14'), obs('g', 'Harvested', '2026-10-21'), // first seen already at Breaker (stem visited on 7 Oct, fruit not recorded)
  ]
  const flags = [
    { node: 'd', rule_id: 'stage_regression', review_decision: null },
    { node: 'e', rule_id: 'stage_regression', review_decision: 'legitimate' },
  ]
  const fruits = studyFruits(all, nodes, stems, flags, climate(), TZ)
  it('excludes invalid sequences, unreliable identity and unbounded onsets, with the reason', () => {
    expect(Object.fromEntries(fruits.map((f) => [f.node, f.excluded]))).toEqual({
      a: null, b: null, c: 'invalid_sequence', d: 'flagged_unreliable', e: null, f: 'node_deactivated', g: 'no_visit_before_breaker',
    })
    expect(fruits.find((f) => f.node === 'b')!.legacy).toBe(true)
  })
  it('summarises with and without legacy observations', () => {
    const withLegacy = studyResult(fruits, true), without = studyResult(fruits, false)
    expect(withLegacy).toMatchObject({ fruits: 7, usable: 3, withTemperature: 3, withRadiation: 3, excluded: { invalid_sequence: 1, flagged_unreliable: 1, node_deactivated: 1, no_visit_before_breaker: 1 } })
    expect(without).toMatchObject({ fruits: 6, usable: 2 })
    expect(withLegacy.degreeDays).toMatchObject({ n: 3, median: 140, min: 140, max: 140, cv: 0 })
    expect(withLegacy.degreeDaysShortest.median).toBe(0)
    expect(withLegacy.degreeDaysLongest.median).toBe(280)
  })
})

describe('summaries', () => {
  it('median, mean, range and spread relative to the mean', () => {
    expect(summarize([4, 1, 3, 2])).toMatchObject({ n: 4, median: 2.5, mean: 2.5, min: 1, max: 4 })
    expect(summarize([10, 10]).cv).toBe(0)
    expect(summarize([])).toMatchObject({ n: 0, median: null, cv: null })
  })
})
