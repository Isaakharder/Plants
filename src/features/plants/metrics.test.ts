import { describe, expect, it } from 'vitest'
import { average, cellDetail, weekLabel, weekOfIsoIndex, weekRange, type WeekMetrics } from './metrics'
import { isoWeekIndex } from './twin'

const m = (yw: number, over: Partial<WeekMetrics> = {}): WeekMetrics => ({ crop_id: 'c', yw, stems: 40, rows_: 4, set_fruit: 183, fruit_load: 252, breakers: 69, ...over })

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

describe('values', () => {
  it('averages per observed stem to 1 decimal; no data is a dash', () => {
    expect([average(m(202643), 'set_fruit'), average(m(202643), 'fruit_load'), average(m(202643), 'breakers')]).toEqual(['4.6', '6.3', '1.7'])
    expect(average(undefined, 'breakers')).toBe('—')
    expect(average(m(202643, { stems: 0 }), 'breakers')).toBe('—')
  })

  it('explains each cell: the count, stems observed and rows', () => {
    expect(cellDetail(m(202643), 'breakers', 'Mathieu', 'W43')).toBe('Mathieu · W43 · Avg Breakers: 69 breakers ÷ 40 stems observed · 4 rows')
    expect(cellDetail(m(202643, { stems: 1, rows_: 1, set_fruit: 2 }), 'set_fruit', 'A', 'W1')).toBe('A · W1 · Avg Fruit Set: 2 fruit set ÷ 1 stem observed · 1 row')
    expect(cellDetail(undefined, 'set_fruit', 'A', 'W2')).toBe('A · W2: no stems observed this week')
  })
})
