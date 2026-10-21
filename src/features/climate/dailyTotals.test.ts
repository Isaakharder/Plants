import { describe, expect, it } from 'vitest'
import { totalCell, weeklyTotals, type DailyTotalRow } from './dailyTotals'

const row = (over: Partial<DailyTotalRow>): DailyTotalRow => ({
  local_date: '2026-10-19', metric: 'radiation_sum', zone_id: 'z1', final_hour: 23, final_value: null, status: 'final',
  running_value: null, running_hour: null, restart_hour: 8, problems: [], ...over,
})

describe('daily totals', () => {
  it('shows a final value plainly and a partial one as partial', () => {
    expect(totalCell(row({ final_value: 1736.9 }), 1)).toMatchObject({ text: '1736.9', final: true })
    expect(totalCell(row({ status: 'running', running_value: 736.3, running_hour: 13 }), 1)).toMatchObject({ text: '736.3 so far', final: false })
    expect(totalCell(row({ status: 'running', running_value: 736.3, running_hour: 13 }), 1).title).toContain('the 23:00 reading')
    expect(totalCell(row({ status: 'running' }), 1).text).toBe('Not started')
    expect(totalCell(row({ status: 'incomplete', running_value: 1500, running_hour: 21 }), 1)).toMatchObject({ text: '≥ 1500.0 · incomplete', final: false })
    expect(totalCell(row({ status: 'incomplete', metric: 'drain_percentage', final_hour: 22 }), 1).title).toContain('No 22:00 reading')
    expect(totalCell(row({ status: 'no_data' }), 1).text).toBe('—')
  })

  it('weeks add up (or average) final days only, and say how many', () => {
    const days = [
      row({ local_date: '2026-10-19', final_value: 1000 }),
      row({ local_date: '2026-10-20', final_value: 500 }),
      row({ local_date: '2026-10-21', status: 'running', running_value: 736.3, running_hour: 13 }),
      row({ local_date: '2026-10-18', final_value: 200 }),
    ]
    expect(weeklyTotals(days, 'sum')).toEqual([
      { key: '2026-W43', label: 'W43 2026', value: 1500, finalDays: 2, days: 3 },
      { key: '2026-W42', label: 'W42 2026', value: 200, finalDays: 1, days: 1 },
    ])
    expect(weeklyTotals(days, 'mean')[0].value).toBe(750)
    expect(weeklyTotals([row({ status: 'incomplete' })], 'sum')[0].value).toBeNull()
  })
})
