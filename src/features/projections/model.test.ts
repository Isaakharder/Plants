import { describe, expect, it } from 'vitest'
import {
  LADDER_AGES,
  cellAtAge,
  cohortBand,
  cohortCellTitle,
  cohortCells,
  cohortKey,
  cropYears,
  defaultYear,
  followCaption,
  formatLoss,
  formatCohortPercent,
  formatPercent,
  formatRate,
  isoYearOfDate,
  ladderAgesWithHarvests,
  lossTitle,
  normalizeWeek,
  observedHarvestShare,
  parseAfw,
  pickedKg,
  pickedKgTitle,
  summarize,
  weeksFromFirstSample,
  type ClosingCohort,
  type CohortCell,
  type SetHarvestCohortRow,
  type WeeklyPlantDataRow,
} from './model'

describe('isoYearOfDate', () => {
  it('uses the ISO week-numbering year at year boundaries', () => {
    expect(isoYearOfDate('2026-01-26')).toBe(2026)
    expect(isoYearOfDate('2025-12-29')).toBe(2026) // Monday of 2026-W01
    expect(isoYearOfDate('2027-01-03')).toBe(2026) // Sunday of 2026-W53
    expect(isoYearOfDate('2027-01-04')).toBe(2027)
  })
})

describe('cropYears / defaultYear', () => {
  it('lists every ISO year a planting spans, newest first', () => {
    expect(cropYears({ planting_date: '2026-01-26', pullout_date: '2026-12-19' })).toEqual([2026])
    expect(cropYears({ planting_date: '2025-12-08', pullout_date: '2027-01-02' })).toEqual([2026, 2025])
  })

  it('defaults to the current greenhouse year when the planting spans it, else its latest year', () => {
    expect(defaultYear([2026, 2025], 2025)).toBe(2025)
    expect(defaultYear([2026, 2025], 2027)).toBe(2026)
  })
})

describe('formatRate', () => {
  it('shows two decimals, and — for a week that was not sampled (never 0.00)', () => {
    expect(formatRate(17.4789)).toBe('17.48')
    expect(formatRate(0)).toBe('0.00')
    expect(formatRate(null)).toBe('—')
  })
})

describe('normalizeWeek', () => {
  it('turns numeric strings from PostgREST into numbers and keeps nulls', () => {
    const row = {
      iso_week: 22, sampled_stems: 56, sampled_m2: '8.2369' as unknown as number, new_sets: 12, new_breakers: 0, new_harvested: 0,
      sets_per_m2: '1.4568' as unknown as number, breakers_per_m2: 0, harvested_per_m2: null,
      is_sampled: true, is_baseline: true, is_provisional: false,
    } satisfies WeeklyPlantDataRow
    expect(normalizeWeek(row)).toMatchObject({ sampled_m2: 8.2369, sets_per_m2: 1.4568, breakers_per_m2: 0, harvested_per_m2: null })
  })
})


describe('cohort ladder', () => {
  it('uses the fixed +0 … +10 clock', () => {
    expect(LADDER_AGES).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('cycles three shades across consecutive set weeks, including across week 53 and New Year', () => {
    const weeks: [number, number][] = [[2026, 50], [2026, 51], [2026, 52], [2026, 53], [2027, 1], [2027, 2]]
    const bands = weeks.map(([y, w]) => cohortBand(y, w))
    expect(new Set(bands.slice(0, 3)).size).toBe(3) // neighbours, and the opposite diagonal (2 apart), differ
    for (let i = 3; i < bands.length; i++) expect(bands[i]).toBe(bands[i - 3])
    expect(cohortKey(2026, 30)).toBe('2026-W30')
  })
})

describe('formatPercent', () => {
  it('distinguishes — (no cohort / not sampled) from an observed 0%', () => {
    expect(formatPercent(null)).toBe('—')
    expect(formatPercent(0)).toBe('0%')
    expect(formatPercent(68.85245901639344)).toBe('68.9%')
    expect(formatPercent(100)).toBe('100.0%')
  })
})

const cell: CohortCell = {
  delay: 7, set_year: 2026, set_week: 23, cohort_sets: 61, harvested: 42, percent: 68.85, is_baseline_cohort: false,
  cohort_harvested: 57, cohort_aborted: 2, cohort_pruned: 2, cohort_timeout: 0, cohort_on_plant: 0, cohort_closed: true,
}

describe('followCaption', () => {
  it('reports a closed cohort as Harvested + Loss with its reasons', () => {
    expect(followCaption(summarize({ ...cell, set_week: 25, cohort_sets: 21, cohort_harvested: 13, cohort_aborted: 6, cohort_pruned: 0, cohort_timeout: 2 }), 2026)).toBe(
      'Following W25 cohort (closed after +10): 21 sets · Harvested 61.9% · Loss 38.1% (Aborted 28.6% · Pruned 0.0% · Timeout 9.5%)',
    )
  })

  it('reports an open cohort as recorded so far, keeping unresolved fruit on the plant', () => {
    const open = summarize({ ...cell, set_week: 30, cohort_sets: 167, cohort_harvested: 73, cohort_aborted: 72, cohort_pruned: 15, cohort_timeout: 0, cohort_on_plant: 7, cohort_closed: false })
    expect(followCaption(open, 2026)).toBe('Following W30 cohort: 167 sets · Harvested so far 43.7% · Lost so far 52.1% · Still on plant 4.2%')
  })

  it('names a previous year’s cohort with its year', () => {
    expect(followCaption(summarize({ ...cell, set_year: 2026, set_week: 52 }), 2027)).toContain('Following W52 2026 cohort')
  })
})

describe('Loss column', () => {
  const closing: ClosingCohort = {
    set_year: 2026, set_week: 24, sets: 57, harvested: 47, aborted: 8, pruned: 1, timeout: 1, on_plant: 0, closed: true,
    is_baseline_cohort: false, loss_percent: 17.543859649122808,
  }

  it('shows the closed cohort’s loss, and — while its window is open', () => {
    expect(formatLoss(closing)).toBe('17.5%')
    expect(formatLoss({ ...closing, closed: false, loss_percent: null, timeout: 0, on_plant: 7 })).toBe('—')
    expect(formatLoss({ ...closing, sets: 0, loss_percent: null })).toBe('—')
    expect(formatLoss({ ...closing, aborted: 0, pruned: 0, timeout: 0, loss_percent: 0 })).toBe('0%')
  })

  it('explains the loss reasons on hover', () => {
    expect(lossTitle(closing, 2026)).toBe(
      'W24 cohort closed: 57 sets, 47 harvested within +10. Loss: 8 aborted, 1 pruned, 1 timeout (unresolved after +10).',
    )
    expect(lossTitle({ ...closing, closed: false }, 2026)).toContain('not final yet')
  })
})

describe('cohortCellTitle', () => {
  it('explains a harvest cell with its exact-age count of the original cohort', () => {
    expect(cohortCellTitle(cell, 2026, 30)).toBe('42 of 61 peppers set in W23 were first harvested in W30 (+7 wk) (68.8%).')
  })

  it('marks the cohort start at +0', () => {
    expect(cohortCellTitle({ ...cell, delay: 0, harvested: 0, percent: 0 }, 2026, 23)).toBe('W23 cohort starts here: 61 peppers first recorded as set (+0).')
  })

  it('names a previous year’s cohort, and flags baseline and unsampled cells', () => {
    const text = cohortCellTitle({ ...cell, set_year: 2026, set_week: 52, delay: 4, is_baseline_cohort: true, percent: null }, 2027, 3)
    expect(text).toContain('set in W52 2026 were first harvested in W3 (+4 wk)')
    expect(text).toContain('Baseline cohort')
    expect(text).toContain('not been sampled')
  })
})

// ---- Presentation: trimmed weeks, hidden empty ages, ladder mapping ----

/** A harvest-week row whose cells point at the cohorts set `delay` weeks earlier. */
function ladderRow(week: number, harvestedAt: Record<number, number> = {}, sampled = true): SetHarvestCohortRow {
  return {
    iso_week: week, is_sampled: sampled, is_provisional: false,
    harvested_total: 0, harvested_in_window: 0, harvested_without_set: 0, harvested_after_timeout: 0,
    cells: LADDER_AGES.map((delay) => ({
      ...cell, delay, set_year: 2026, set_week: week - delay, cohort_sets: week - delay >= 22 ? 50 : 0,
      harvested: harvestedAt[delay] ?? 0, percent: week - delay >= 22 && sampled ? ((harvestedAt[delay] ?? 0) * 100) / 50 : null,
    })),
    closing: { set_year: 2026, set_week: week - 10, sets: 0, harvested: 0, aborted: 0, pruned: 0, timeout: 0, on_plant: 0, closed: false, is_baseline_cohort: false, loss_percent: null },
  }
}

describe('weeksFromFirstSample', () => {
  const weeks = (firstSampled: number, gaps: number[] = []) =>
    Array.from({ length: 53 }, (_, i) => ({ iso_week: i + 1, is_sampled: i + 1 >= firstSampled && i + 1 <= 40 && !gaps.includes(i + 1) }))

  it('drops the empty weeks before sampling began and keeps the first sampled week', () => {
    const shown = weeksFromFirstSample(weeks(22))
    expect(shown[0].iso_week).toBe(22)
    expect(shown.some((w) => w.iso_week < 22)).toBe(false)
  })

  it('follows the data: another crop that starts sampling in W16 starts at W16', () => {
    expect(weeksFromFirstSample(weeks(16))[0].iso_week).toBe(16)
  })

  it('keeps later weeks, including unsampled gaps and current/future weeks', () => {
    const shown = weeksFromFirstSample(weeks(22, [31]))
    expect(shown.map((w) => w.iso_week)).toContain(31)
    expect(shown.at(-1)?.iso_week).toBe(53)
    expect(shown).toHaveLength(53 - 21)
  })

  it('shows nothing when nothing was sampled', () => {
    expect(weeksFromFirstSample(weeks(99))).toEqual([])
  })
})

describe('ladderAgesWithHarvests', () => {
  it('hides ages whose cells are all — or 0% (like +0 … +2 for Mathieu), keeping the rest', () => {
    const rows = [ladderRow(30, { 6: 31, 7: 42 }), ladderRow(31, { 3: 1 }), ladderRow(32), ladderRow(41, {}, false)]
    expect(ladderAgesWithHarvests(rows)).toEqual([3, 6, 7])
  })

  it('keeps an age as soon as one pepper anywhere was harvested at it', () => {
    const rows = [ladderRow(30, { 6: 31 }), ladderRow(35, { 2: 1 })]
    expect(ladderAgesWithHarvests(rows)).toEqual([2, 6])
  })

  it('shows no ages before anything has been harvested', () => {
    expect(ladderAgesWithHarvests([ladderRow(25), ladderRow(26)])).toEqual([])
  })
})

describe('ladder mapping with hidden ages', () => {
  // Weeks W30 … W40, every age harvested somewhere so we can hide some explicitly.
  const rows = Array.from({ length: 11 }, (_, i) => ladderRow(30 + i, { 3: 1, 5: 1, 6: 1, 7: 1, 8: 1, 9: 1, 10: 1, 4: 1 }))
  const visibleAges = [3, 4, 5, 6, 7, 8, 9, 10] // +0 … +2 hidden

  it('finds each cell by its age, not its position, so hidden columns cannot shift the ladder', () => {
    const shuffled = { ...rows[5], cells: [...rows[5].cells].reverse() }
    expect(cellAtAge(shuffled, 6)).toMatchObject({ delay: 6, set_week: 35 - 6 })
    expect(cellAtAge(rows[0], 11)).toBeUndefined()
  })

  it('a followed cohort highlights exactly its own cells at their real ages', () => {
    const followed = cohortKey(2026, 30)
    const path = rows.flatMap((row) =>
      visibleAges.flatMap((age) => {
        const c = cellAtAge(row, age)
        return c && cohortKey(c.set_year, c.set_week) === followed ? [`W${row.iso_week}+${age}`] : []
      }),
    )
    expect(path).toEqual(['W33+3', 'W34+4', 'W35+5', 'W36+6', 'W37+7', 'W38+8', 'W39+9', 'W40+10'])
  })
})

describe('AFW and Picked kg (per set-week cohort)', () => {
  // Built from Mathieu's W34-style numbers: a cohort harvested 2.777…% at +5,
  // 16.071…% at +6, 32.773…% at +7 and 10% at +8 (unrounded, as the database sends them).
  const cell = (setWeek: number, delay: number, percent: number | null, extra: Partial<CohortCell> = {}): CohortCell => ({
    delay, set_year: 2026, set_week: setWeek, cohort_sets: 100, harvested: 0, percent, is_baseline_cohort: false,
    cohort_harvested: 0, cohort_aborted: 0, cohort_pruned: 0, cohort_timeout: 0, cohort_on_plant: 0, cohort_closed: false, ...extra,
  })
  const harvestRow = (week: number, cells: CohortCell[]) => ({ iso_week: week, cells }) as unknown as SetHarvestCohortRow
  // 4/144, 9/56, 39/119 and 5/50 of each cohort's sets, as percentages.
  const PCTS = [(100 * 4) / 144, (100 * 9) / 56, (100 * 39) / 119, (100 * 5) / 50]
  // Cohort W34's diagonal: +5 in W39 … +8 in W42; +9/+10 not reached yet (no percentage).
  // Each harvest row also holds other cohorts' cells (W33 at +6 in W39, …) that must not be counted.
  const rows = [
    harvestRow(34, [cell(34, 0, 0)]),
    harvestRow(39, [cell(34, 5, PCTS[0]), cell(33, 6, 40)]),
    harvestRow(40, [cell(34, 6, PCTS[1]), cell(33, 7, 30)]),
    harvestRow(41, [cell(34, 7, PCTS[2]), cell(32, 9, 5)]),
    harvestRow(42, [cell(34, 8, PCTS[3])]),
    harvestRow(43, [cell(34, 9, null)]),
    harvestRow(44, [cell(34, 10, null)]),
  ]
  const SETS = Number('17.6037159582590990') // as PostgREST sends the numeric
  const AREA = 11787

  it('follows the cohort down its diagonal, not across a harvest-week row', () => {
    expect(cohortCells(rows, 2026, 34).map((c) => c.delay)).toEqual([0, 5, 6, 7, 8, 9, 10])
    expect(cohortCells(rows, 2026, 33).map((c) => c.delay)).toEqual([6, 7])
  })

  it('17.60 sets/m² × 61.7% × 200 g × 11,787 m² ≈ 25,600 kg, from unrounded values', () => {
    const share = observedHarvestShare(cohortCells(rows, 2026, 34))
    expect(share).toBeCloseTo(PCTS.reduce((a, b) => a + b) / 100, 12)
    expect(share).toBeCloseTo(0.61622, 4) // 61.6%, not the 61.7% from adding rounded cells
    const kg = pickedKg(SETS, share, 200, AREA)!
    expect(kg).toBeCloseTo(SETS * share * 0.2 * AREA, 6)
    expect(Math.round(kg / 100) * 100).toBe(25600)
    // The rounded-display arithmetic from the example lands in the same place.
    expect((17.6 * 0.617 * 200 / 1000) * AREA).toBeCloseTo(25599.5, 0)
  })

  it('changing AFW changes Picked kg proportionally', () => {
    const share = observedHarvestShare(cohortCells(rows, 2026, 34))
    expect(pickedKg(SETS, share, 100, AREA)! * 2).toBeCloseTo(pickedKg(SETS, share, 200, AREA)!, 6)
  })

  it('blank AFW or an unsampled set week gives no kg (never invented)', () => {
    expect(pickedKg(SETS, 0.5, null, AREA)).toBeNull()
    expect(pickedKg(null, 0.5, 200, AREA)).toBeNull()
  })

  it('a cohort with no harvest yet is 0 kg once it has an AFW', () => {
    const open = [harvestRow(41, [cell(41, 0, 0)]), harvestRow(42, [cell(41, 1, null)])]
    expect(pickedKg(SETS, observedHarvestShare(cohortCells(open, 2026, 41)), 200, AREA)).toBe(0)
  })

  it('future / unobserved ages are not counted as harvested', () => {
    expect(observedHarvestShare([cell(34, 9, null), cell(34, 10, null)])).toBe(0)
    expect(observedHarvestShare([cell(34, 5, 10), cell(34, 6, null)])).toBeCloseTo(0.1, 12)
  })

  it('reads AFW input as grams, rejecting nonsense', () => {
    expect(parseAfw('200')).toBe(200)
    expect(parseAfw(' 185.5 ')).toBe(185.5)
    expect(parseAfw('185,5')).toBe(185.5)
    expect(parseAfw('')).toBeNull()
    for (const bad of ['-5', '0', '0.0', '2001', 'abc', '1.25', '200g']) expect(parseAfw(bad)).toBe('invalid')
  })

  it('explains the calculation on hover', () => {
    const share = observedHarvestShare(cohortCells(rows, 2026, 34))
    const kg = pickedKg(SETS, share, 200, AREA)
    expect(pickedKgTitle(34, SETS, share, 200, AREA, kg, false)).toMatch(/^W34 cohort: 17\.60 sets\/m² × 61\.6% harvested so far × 200 g × 11,787 m² = 25,57\d kg/)
    expect(pickedKgTitle(34, SETS, share, null, AREA, null, false)).toContain("Enter W34's AFW")
    expect(pickedKgTitle(50, SETS, 0, 200, AREA, 0, true)).toContain('next year')
  })
})

describe('whole-percent display vs. unrounded calculations', () => {
  const cell = (delay: number, percent: number | null): CohortCell => ({
    delay, set_year: 2026, set_week: 34, cohort_sets: 1000, harvested: 0, percent, is_baseline_cohort: false,
    cohort_harvested: 0, cohort_aborted: 0, cohort_pruned: 0, cohort_timeout: 0, cohort_on_plant: 0, cohort_closed: false,
  })

  it('shows +N cells as whole percentages (normal rounding)', () => {
    expect([50.2, 32.8, 16.1, 2.8, 0, 100, 99.5, 0.4].map(formatCohortPercent)).toEqual(['50%', '33%', '16%', '3%', '0%', '100%', '100%', '0%'])
    expect(formatCohortPercent(null)).toBe('—')
    // Loss keeps one decimal.
    expect(formatPercent(32.8)).toBe('32.8%')
  })

  it('a 32.8% cell displays 33% but Picked kg uses 0.328, not 0.33', () => {
    const cells = [cell(6, 32.8)]
    expect(formatCohortPercent(cells[0].percent)).toBe('33%')
    const share = observedHarvestShare(cells)
    expect(share).toBeCloseTo(0.328, 12)
    expect(pickedKg(10, share, 200, 10_000)).toBeCloseTo(10 * 0.328 * 0.2 * 10_000, 6) // 6,560 kg
    expect(pickedKg(10, share, 200, 10_000)).not.toBeCloseTo(10 * 0.33 * 0.2 * 10_000, 0) // not 6,600 kg
  })

  it('a multi-age cohort never sums the displayed, rounded percentages', () => {
    // Three ages at 2.4% display as 2% each (6% if added up), but the cohort harvested 7.2%.
    const cells = [cell(5, 2.4), cell(6, 2.4), cell(7, 2.4), cell(8, 32.8)]
    expect(cells.map((c) => formatCohortPercent(c.percent))).toEqual(['2%', '2%', '2%', '33%'])
    const share = observedHarvestShare(cells)
    expect(share).toBeCloseTo(0.4, 12) // 2.4 × 3 + 32.8 = 40.0%
    const displayedSum = cells.reduce((s, c) => s + Number(formatCohortPercent(c.percent).replace('%', '')), 0) / 100
    expect(displayedSum).toBeCloseTo(0.39, 12)
    expect(pickedKg(17.6, share, 200, 11_787)).toBeCloseTo(17.6 * 0.4 * 0.2 * 11_787, 6)
    expect(pickedKg(17.6, share, 200, 11_787)).not.toBeCloseTo(17.6 * displayedSum * 0.2 * 11_787, 0)
  })

  it('the hover text keeps the exact percentage', () => {
    expect(cohortCellTitle({ ...cell(6, 32.8), harvested: 328 }, 2026, 40)).toContain('(32.8%)')
  })
})
