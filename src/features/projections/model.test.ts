import { describe, expect, it } from 'vitest'
import {
  LADDER_AGES,
  cellAtAge,
  cohortBand,
  cohortCellTitle,
  cohortKey,
  cropYears,
  defaultYear,
  followCaption,
  formatLoss,
  formatPercent,
  formatRate,
  isoYearOfDate,
  ladderAgesWithHarvests,
  lossTitle,
  normalizeWeek,
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
    expect(cohortCellTitle(cell, 2026, 30)).toBe('42 of 61 peppers set in W23 were first harvested in W30 (+7 wk).')
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
