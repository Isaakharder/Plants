import { describe, expect, it } from 'vitest'
import { chooseSource, colourGroups, productionTotals, sumCells, weekCell, type SourceWeek, type TotalsCrop } from './productionTotals'

const crop = (id: string, color: string, caseWeightKg: number | null = 5, plantingDate = '2025-12-01', pulloutDate = '2026-12-31'): TotalsCrop => ({
  id, name: id, color, caseWeightKg, plantingDate, pulloutDate,
})
const src = (cropId: string, targetYw: number, originYw: number, status: SourceWeek['status'], kg: number | null, extra: Partial<SourceWeek> = {}): SourceWeek => ({
  cropId, targetYw, originYw, status, available: true, cropFruit: kg === null ? 1000 : kg * 5, kg, cases: null, ...extra,
})

describe('colour groups', () => {
  it('groups by each variety’s colour, usual colours first, any other colour after', () => {
    const g = colourGroups([crop('Mathieu', 'red'), crop('Cadalora', 'red'), crop('Silverstone', 'yellow'), crop('Plum', 'purple'), crop('Levente', 'orange')])
    expect(g.map((x) => x.color)).toEqual(['red', 'orange', 'yellow', 'purple'])
    expect(g[0].crops.map((c) => c.name)).toEqual(['Cadalora', 'Mathieu'])
  })
})

describe('which forecast is used for a variety and week', () => {
  it('locked over preliminary, even when the preliminary one is newer', () => {
    expect(chooseSource([src('a', 202644, 202643, 'preliminary', 900), src('a', 202644, 202642, 'official', 1000)])!.status).toBe('official')
  })
  it('among locked forecasts, the latest sampling week (no overlapping versions added up)', () => {
    // A lifecycle W41 forecast (+3) and a Breakers-only W43 forecast (+1) both cover W44.
    const c = weekCell([crop('a', 'red')], 202644, [src('a', 202644, 202641, 'official', 800), src('a', 202644, 202643, 'late', 1000)])
    expect(c.kg).toBe(1000)
    expect(c.sources).toHaveLength(1)
    expect(c.sources[0]).toMatchObject({ originYw: 202643, status: 'late' })
  })
  it('among preliminary versions, the latest sampling week, then the newest version', () => {
    const chosen = chooseSource([
      src('a', 202644, 202643, 'preliminary', 900, { createdAt: '2026-10-23T10:00:00Z' }),
      src('a', 202644, 202643, 'preliminary', 950, { createdAt: '2026-10-23T12:00:00Z' }),
      src('a', 202644, 202642, 'preliminary', 700, { createdAt: '2026-10-24T09:00:00Z' }),
    ])
    expect(chosen!.kg).toBe(950)
  })
  it('a week the forecast doesn’t support (Breakers only beyond next week) is never used', () => {
    const c = weekCell([crop('a', 'red')], 202645, [src('a', 202645, 202643, 'official', null, { available: false })])
    expect(c.sources).toHaveLength(0)
    expect(c.missing).toEqual([{ cropId: 'a', cropName: 'a', reason: 'no_forecast' }])
    expect(c.kgComplete).toBe(false)
  })
})

describe('adding up', () => {
  it('adds varieties of a colour; cases with each variety’s own case weight, never one weight for the total', () => {
    const crops = [crop('r1', 'red', 5), crop('r2', 'red', 4.5)]
    const c = weekCell(crops, 202643, [src('r1', 202643, 202642, 'official', 1000), src('r2', 202643, 202642, 'official', 900)])
    expect(c.kg).toBe(1900)
    expect(c.cases).toBeCloseTo(200 + 200) // 1000 ÷ 5 + 900 ÷ 4.5, not 1900 ÷ one weight
    expect(c.kgComplete && c.casesComplete).toBe(true)
    expect(c.status).toBe('official')
  })

  it('uses the cases stored with a locked forecast when there are some', () => {
    const c = weekCell([crop('r1', 'red', 5)], 202643, [src('r1', 202643, 202642, 'official', 1000, { cases: 250 })])
    expect(c.cases).toBe(250)
  })

  it('a variety without AFW: kg and cases incomplete, named, never zero; the others still show (as a partial sum)', () => {
    const crops = [crop('Cadalora', 'red'), crop('Silverstone', 'red')]
    const c = weekCell(crops, 202643, [src('Cadalora', 202643, 202642, 'preliminary', 54222), src('Silverstone', 202643, 202642, 'preliminary', null)])
    expect(c.kg).toBe(54222)
    expect(c.kgComplete).toBe(false)
    expect(c.casesComplete).toBe(false)
    expect(c.missing).toEqual([{ cropId: 'Silverstone', cropName: 'Silverstone', reason: 'afw_needed' }])
    expect(c.status).toBe('preliminary')
  })

  it('a variety without a case weight: kg complete, cases incomplete', () => {
    const c = weekCell([crop('a', 'red', 5), crop('b', 'red', null)], 202643, [src('a', 202643, 202642, 'official', 100), src('b', 202643, 202642, 'official', 50)])
    expect(c).toMatchObject({ kg: 150, cases: 20, kgComplete: true, casesComplete: false })
    expect(c.missing[0].reason).toBe('no_case_weight')
  })

  it('a variety out of season that week isn’t expected', () => {
    const crops = [crop('a', 'red'), crop('old', 'red', 5, '2025-01-01', '2026-06-30')]
    const c = weekCell(crops, 202643, [src('a', 202643, 202642, 'official', 100)])
    expect(c).toMatchObject({ kg: 100, kgComplete: true, expected: 1 })
  })

  it('flags preliminary forecasts whose data changed', () => {
    const c = weekCell([crop('a', 'red')], 202643, [src('a', 202643, 202642, 'preliminary', 100, { outdated: true })])
    expect(c.anyOutdated).toBe(true)
  })

  it('over several weeks: complete only if every week is; locked and preliminary status carried', () => {
    const crops = [crop('a', 'red')]
    const w43 = weekCell(crops, 202643, [src('a', 202643, 202642, 'official', 100)])
    const w44 = weekCell(crops, 202644, [])
    const sum = sumCells([w43, w44])
    expect(sum).toMatchObject({ kg: 100, kgComplete: false })
    expect(sumCells([w43]).status).toBe('official')
  })

  it('the whole greenhouse: by colour and all colours, each variety counted once', () => {
    const crops = [crop('r1', 'red', 5), crop('r2', 'red', 5), crop('y1', 'yellow', 4), crop('o1', 'orange', 5)]
    const sources = [
      src('r1', 202643, 202642, 'official', 1000),
      src('r1', 202643, 202641, 'official', 999), // older locked forecast of the same week: not added
      src('r2', 202643, 202642, 'preliminary', 500),
      src('y1', 202643, 202642, 'official', 400),
      src('o1', 202643, 202642, 'official', 300),
      src('r1', 202644, 202643, 'preliminary', 1100),
    ]
    const t = productionTotals(crops, sources, [202643, 202644])
    expect(t.colours.map((g) => g.color)).toEqual(['red', 'orange', 'yellow'])
    const w43 = t.weeks[0]
    expect(w43.byColour.get('red')).toMatchObject({ kg: 1500, cases: 300, kgComplete: true, status: 'preliminary' })
    expect(w43.byColour.get('yellow')).toMatchObject({ kg: 400, cases: 100, status: 'official' })
    expect(w43.all).toMatchObject({ kg: 2200, cases: 300 + 100 + 60, kgComplete: true, status: 'preliminary' })
    // All colours = the sum of the colours.
    const colourSum = [...w43.byColour.values()].reduce((a, c) => a + (c.kg ?? 0), 0)
    expect(w43.all.kg).toBe(colourSum)
    // W44: only r1 has a forecast: partial and labelled incomplete.
    expect(t.weeks[1].all).toMatchObject({ kg: 1100, kgComplete: false })
    expect(t.totals.all).toMatchObject({ kg: 3300, kgComplete: false })
    expect(t.totals.byColour.get('red')!.kg).toBe(2600)
  })
})
