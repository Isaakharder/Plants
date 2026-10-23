import { describe, expect, it } from 'vitest'
import { latestOf, latestRevisions, revisable, revisionDeadline } from './revisions'

const run = (id: string, week: number, revision: number, basis = 'breaker_only', crop = 'c') => ({
  id, crop_id: crop, origin_year: 2026, origin_week: week, revision, basis,
  // W43 (Oct 19–25) ends Monday Oct 26 00:00 Toronto (EDT) = 04:00 UTC.
  first_target_starts: week === 43 ? '2026-10-26T04:00:00Z' : '2026-10-19T04:00:00Z',
})
const RUNS = [run('w42', 42, 1), run('w43', 43, 1), run('w43r2', 43, 2), run('w43r3', 43, 3), run('m43', 43, 1, 'breaker_only', 'm')]

describe('revised official forecasts', () => {
  it('the latest version of each sampling week counts; earlier ones are kept', () => {
    expect(latestRevisions(RUNS).map((r) => r.id).sort()).toEqual(['m43', 'w42', 'w43r3'])
    expect(latestOf(RUNS, RUNS[1]).id).toBe('w43r3')
  })

  it('can be revised until Monday 00:00 greenhouse time after the sampling week, the latest version only', () => {
    const sunday = new Date('2026-10-26T03:59:59Z') // Sun Oct 25, 23:59:59 EDT
    const monday = new Date('2026-10-26T04:00:00Z') // Mon Oct 26, 00:00 EDT
    expect(revisable(RUNS, RUNS[3], sunday)).toBe(true)
    expect(revisable(RUNS, RUNS[3], monday)).toBe(false)
    expect(revisable(RUNS, RUNS[1], sunday)).toBe(false) // an earlier version
    expect(revisable(RUNS, RUNS[0], sunday)).toBe(false) // W42 ended on the 19th
    expect(revisable([run('l', 43, 1, 'lifecycle')], run('l', 43, 1, 'lifecycle'), sunday)).toBe(false)
    expect(revisionDeadline(RUNS[1]).toISOString()).toBe('2026-10-26T04:00:00.000Z')
  })
})
