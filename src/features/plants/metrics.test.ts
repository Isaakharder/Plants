import { describe, expect, it } from 'vitest'
import { cellDetail, coverageMark, coverageText, formatPerM2, isPartial, perM2, samplingProgressText, stemsPerM2, weekLabel, weekOfIsoIndex, weekRange, type WeekMetrics } from './metrics'
import { isoWeekIndex } from './twin'

// Phase 3 Levente, W43 (production copy): 56 of 56 sampled stems in 4 rows; 8,268 m², 56,160 picking stems.
const m = (yw: number, over: Partial<WeekMetrics> = {}): WeekMetrics => ({ crop_id: 'c', yw, stems: 56, expected_stems: 56, rows_: 4, set_fruit: 193, fruit_load: 233, breakers: 40, ...over })
const levente = { picking_stems: 56160, area_m2: 8268 }

describe('weeks', () => {
  it('round-trips ISO week indexes, across year ends', () => {
    for (const [y, w] of [[2026, 1], [2026, 43], [2026, 53], [2027, 1], [2020, 53], [2021, 1]]) {
      expect(weekOfIsoIndex(isoWeekIndex(y, w))).toMatchObject({ year: y, week: w })
    }
  })

  it('spans the earliest to the latest week with data, gaps included', () => {
    expect(weekRange([m(202643), m(202640), m(202641)]).map((w) => w.week)).toEqual([40, 41, 42, 43])
    expect(weekRange([m(202652), m(202702)]).map((w) => w.yw)).toEqual([202652, 202653, 202701, 202702])
    expect(weekRange([])).toEqual([])
    expect(weekLabel(weekOfIsoIndex(isoWeekIndex(2026, 7)), false)).toBe('W7')
    expect(weekLabel(weekOfIsoIndex(isoWeekIndex(2026, 7)), true)).toBe('2026-W07')
  })
})

describe('per m²', () => {
  it('uses the variety’s picking stems ÷ area, never a guess', () => {
    expect(stemsPerM2(levente)).toBeCloseTo(6.7925, 4)
    expect(stemsPerM2({ picking_stems: 0, area_m2: 8268 })).toBeNull()
    expect(stemsPerM2({ picking_stems: 56160, area_m2: 0 })).toBeNull()
    expect(stemsPerM2({ picking_stems: null, area_m2: 8268 })).toBeNull()
  })

  it('converts the per-stem average with the observed stems as denominator', () => {
    const d = stemsPerM2(levente)
    // 193 / 56 = 3.45 per stem × 6.79 = 23.4 /m²; 233 / 56 × 6.79 = 28.3; 40 / 56 × 6.79 = 4.9.
    expect(['set_fruit', 'fruit_load', 'breakers'].map((k) => formatPerM2(perM2(m(202643), k as never, d)))).toEqual(['23.4', '28.3', '4.9'])
    // A partial week divides by the stems actually observed (40), not the variety's 56.
    expect(perM2(m(202643, { stems: 40, breakers: 69 }), 'breakers', d)).toBeCloseTo((69 / 40) * (56160 / 8268), 10)
    expect(perM2(undefined, 'breakers', d)).toBeNull()
    expect(perM2(m(202643, { stems: 0 }), 'breakers', d)).toBeNull()
    expect(perM2(m(202643), 'breakers', null)).toBeNull()
    expect(formatPerM2(null)).toBe('—')
  })

  it('flags partial sampling below 90% of the variety’s sampled stems', () => {
    expect(isPartial(m(202643))).toBe(false)
    expect(isPartial(m(202643, { stems: 51 }))).toBe(false) // 91%
    expect(isPartial(m(202643, { stems: 40 }))).toBe(true)
    expect(isPartial(undefined)).toBe(false)
  })

  it('explains each cell: count, sampled stems, rows and the conversion', () => {
    const d = stemsPerM2(levente)
    expect(cellDetail(m(202643), 'breakers', 'Phase 3 Levente', 'W43', d)).toBe(
      'Phase 3 Levente · W43 · Breakers /m²: 40 breakers on 56 sampled stems (4 rows) = 0.71 per stem × 6.79 stems/m² = 4.9 /m². 56 of 56 stems observed (100%).',
    )
    expect(cellDetail(m(202641, { stems: 5, rows_: 3, breakers: 5 }), 'breakers', 'Mathieu', 'W41', d)).toMatch(/= 6\.8 \/m²\. Partial sampling: 5 of 56 stems observed \(8%\)\.$/)
    expect(cellDetail(m(202643), 'set_fruit', 'X', 'W43', null)).toMatch(/Not shown per m²: the variety's area or picking stems aren't set\. 56 of 56 stems observed \(100%\)\.$/)
    expect(cellDetail(undefined, 'set_fruit', 'A', 'W2', d)).toBe('A · W2: no sampled stems observed this week')
  })

  it('marks the current week in progress, never partial; finished weeks under 90% partial', () => {
    expect(coverageMark(m(202643, { stems: 40 }), true)).toBe('in-progress')
    expect(coverageMark(m(202643), true)).toBe('in-progress')
    expect(coverageMark(m(202641, { stems: 5 }), false)).toBe('partial')
    expect(coverageMark(m(202642, { stems: 54 }), false)).toBeNull() // 96%
    expect(coverageMark(undefined, false)).toBeNull()
    const d = stemsPerM2(levente)
    expect(cellDetail(m(202643, { stems: 40, breakers: 69 }), 'breakers', 'Mathieu', 'W43', d, true)).toMatch(/Week in progress: so far 40 of 56 stems observed \(71%\)\.$/)
    expect(cellDetail(undefined, 'breakers', 'Mathieu', 'W43', d, true)).toBe('Mathieu · W43: no sampled stems observed yet (week in progress)')
  })

  it('states coverage as a percentage, rounded down so a partial week never reads 90%', () => {
    expect(coverageText({ stems: 40, expected_stems: 56 })).toBe('40 of 56 stems observed (71%)')
    expect(coverageText({ stems: 50, expected_stems: 56 })).toBe('50 of 56 stems observed (89%)') // 89.3%, flagged
    expect(coverageText({ stems: 56, expected_stems: 56 })).toBe('56 of 56 stems observed (100%)')
    expect(coverageText({ stems: 3, expected_stems: 0 })).toBe('3 of 0 stems observed')
  })
})

describe('sampling progress under the variety name', () => {
  it('shows this week\'s checked stems of the sampling plan, rounded down', () => {
    expect(samplingProgressText(43, { visited_stems: 40, expected_stems: 56 })).toBe('W43: 40 / 56 stems checked (71%)')
    expect(samplingProgressText(43, { visited_stems: 0, expected_stems: 84 })).toBe('W43: 0 / 84 stems checked (0%)')
    expect(samplingProgressText(43, { visited_stems: 56, expected_stems: 56 })).toBe('W43: 56 / 56 stems checked (100%)')
    expect(samplingProgressText(43, { visited_stems: 50, expected_stems: 56 })).toBe('W43: 50 / 56 stems checked (89%)')
    expect(samplingProgressText(2, undefined)).toBe('W2: no sampled stems yet')
    expect(samplingProgressText(2, { visited_stems: 0, expected_stems: 0 })).toBe('W2: no sampled stems yet')
  })
})
