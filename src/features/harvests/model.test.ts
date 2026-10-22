import { describe, expect, it } from 'vitest'
import { checkRanges, greenhouseRowNumber, inspectableHarvests, inspectedStems, rangesLabel, stemInspection, type InspectionAnswer, type RowRef } from './model'
import type { HarvestEventInEffect, NodeStatus } from '../../lib/database.types'

const rows: RowRef[] = [
  { id: 'r171', row_name: 'Row 171', crop_id: 'cad' },
  { id: 'r172', row_name: 'Row 172', crop_id: 'cad' },
  { id: 'r319', row_name: 'Row 319', crop_id: 'cad' },
  { id: 'r590', row_name: 'Row 590', crop_id: 'sil' },
  { id: 'r600', row_name: 'Row 600', crop_id: 'old' },
]
const growing = new Map([['cad', 'Cadalora'], ['sil', 'Silverstone']])
const draft = (from: string, to: string, coverage: 'complete' | 'partial' = 'complete') => ({ from, to, coverage })

describe('greenhouseRowNumber (as the database)', () => {
  it('reads the row number from the row name', () => {
    expect(['Row 171', ' row171 ', 'R 9', '171', 'ROW 00012'].map(greenhouseRowNumber)).toEqual([171, 171, 9, 171, 12])
    expect(['Bay A', 'Row 17 1', 'Row 171a', '', 'Row 123456'].map(greenhouseRowNumber)).toEqual([null, null, null, null, null])
  })
})

describe('checkRanges', () => {
  it('finds the sampled rows inside the ranges, with their coverage', () => {
    const c = checkRanges([draft('160', '180'), draft('319', '', 'partial'), draft('400', '410')], 'cad', rows, growing)
    expect(c.problems).toEqual([])
    expect(c.ranges).toEqual([{ from: 160, to: 180, coverage: 'complete' }, { from: 319, to: 319, coverage: 'partial' }, { from: 400, to: 410, coverage: 'complete' }])
    expect(c.sampledRows.map((r) => `${r.row_name}:${r.coverage}`)).toEqual(['Row 171:complete', 'Row 172:complete', 'Row 319:partial'])
    expect(c.withoutSampledRows).toEqual([{ from: 400, to: 410, coverage: 'complete' }])
    expect(rangesLabel(c.ranges!)).toBe('Rows 160–180, Row 319 (partial), Rows 400–410')
  })

  it('rejects what the database rejects', () => {
    expect(checkRanges([], 'cad', rows, growing).problems).toEqual(['Add at least one row range.'])
    expect(checkRanges([draft('180', '160')], 'cad', rows, growing).problems[0]).toMatch(/first row is after the last/)
    expect(checkRanges([draft('16a', '')], 'cad', rows, growing).problems[0]).toMatch(/not a range of whole row numbers/)
    expect(checkRanges([draft('160.5', '170')], 'cad', rows, growing).problems[0]).toMatch(/whole row numbers/)
    expect(checkRanges([draft('160', '175'), draft('170', '180')], 'cad', rows, growing).problems).toEqual(['Rows 160–175 and Rows 170–180 overlap.'])
    const other = checkRanges([draft('580', '600')], 'cad', rows, growing)
    // Row 590 belongs to Silverstone (growing); Row 600's variety isn't growing on that date.
    expect(other.problems).toEqual(['Row 590 is a sampled row of Silverstone, not this variety.'])
    expect(other.ranges).toBeNull()
    expect(checkRanges([draft('1', '5')], 'bay', [...rows, { id: 'b', row_name: 'Bay A', crop_id: 'bay' }], growing).problems[0]).toMatch(/Bay A/)
  })
})

const event = (over: Partial<HarvestEventInEffect>): HarvestEventInEffect => ({
  event_id: 'e', version_id: 'e', crop_id: 'cad', harvest_date: '2026-10-12', finished_at: null, starts_at: '', ends_at: '', min_colour_percent: 80,
  harvested_kg: null, note: null, cancelled: false, versions: 1, first_recorded_at: '2026-10-12T20:00:00Z', first_recorded_by: 'u', recorded_at: '', recorded_by: 'u',
  ranges: [], sampled_rows: [{ row_id: 'r171', row_name: 'Row 171', row_number: 171, coverage: 'complete' }], ...over,
})

describe('inspectableHarvests', () => {
  it('lists the variety’s harvests with sampled rows, newest first, without cancelled ones', () => {
    const list = inspectableHarvests([
      event({ event_id: 'a', harvest_date: '2026-10-12' }),
      event({ event_id: 'b', harvest_date: '2026-10-14' }),
      event({ event_id: 'c', harvest_date: '2026-10-15', cancelled: true }),
      event({ event_id: 'd', harvest_date: '2026-10-15', sampled_rows: [] }),
      event({ event_id: 'e', crop_id: 'sil' }),
      event({ event_id: 'f', harvest_date: '2026-10-14', first_recorded_at: '2026-10-14T23:00:00Z' }),
    ], 'cad')
    expect(list.map((e) => e.event_id)).toEqual(['f', 'b', 'a'])
  })
})

describe('stemInspection', () => {
  const latest = new Map<string, NodeStatus>([['n1', 'BreakerFruit'], ['n2', 'MatureGreen'], ['n3', 'SetFruit'], ['n4', 'Flower'], ['n5', 'Harvested']])
  const nodes = ['n1', 'n2', 'n3', 'n4', 'n5']
  const answer = (node: string, status: NodeStatus, at: string, ev = 'E1'): InspectionAnswer =>
    ({ node_observation_id: `o-${node}-${at}`, harvest_event_id: ev, plant_node_id: node, status, observed_at: at })

  it('asks for every fruit on the plant, never flowers or removed fruit', () => {
    const s = stemInspection('E1', nodes, latest, [], [])
    expect(s.toConfirm).toEqual(['n1', 'n2', 'n3'])
    expect(s.state).toBe('not_started')
  })

  it('counts only this harvest’s answers; the latest answer per node wins', () => {
    const answers = [answer('n1', 'BreakerFruit', '2026-10-12T19:00:00Z'), answer('n1', 'Harvested', '2026-10-12T19:01:00Z'), answer('n2', 'MatureGreen', '2026-10-10T19:00:00Z', 'E0')]
    const s = stemInspection('E1', nodes, latest, answers, [])
    expect(s.toConfirm).toEqual(['n2', 'n3'])
    expect(s.answered).toEqual(new Map([['n1', 'Harvested']]))
    expect(s.state).toBe('in_progress')
  })

  it('is complete only with “All fruit checked” and nothing left to confirm', () => {
    const all = [answer('n1', 'Harvested', 'a'), answer('n2', 'MatureGreen', 'b'), answer('n3', 'SetFruit', 'c')]
    const check = (at: string, checked = true, allFruit = true, ev = 'E1') => ({ measurement_stem_id: 's1', checked, observed_at: at, harvest_event_id: ev, all_fruit_checked: allFruit })
    expect(stemInspection('E1', nodes, latest, all.slice(0, 2), [check('d')]).state).toBe('in_progress')
    expect(stemInspection('E1', nodes, latest, all, [check('d')])).toMatchObject({ state: 'complete', checkedAt: 'd' })
    expect(stemInspection('E1', nodes, latest, all, [check('d'), check('e', false, false)]).state).toBe('retracted')
    // An ordinary check or another harvest's check doesn't complete it.
    expect(stemInspection('E1', nodes, latest, all, [{ measurement_stem_id: 's1', checked: true, observed_at: 'd' }, check('e', true, true, 'E2')]).state).toBe('in_progress')
  })
})

describe('greenhouse dates and times (America/Toronto)', () => {
  it('converts a greenhouse wall time to the instant and back, across DST', async () => {
    const { greenhouseInstant, greenhouseTime, greenhouseToday } = await import('./model')
    expect(greenhouseInstant('2026-10-12', '14:00')).toBe('2026-10-12T18:00:00.000Z') // EDT
    expect(greenhouseInstant('2026-12-01', '14:00')).toBe('2026-12-01T19:00:00.000Z') // EST
    expect(greenhouseInstant('2026-03-08', '02:30')).toBeNull() // doesn't exist
    expect(greenhouseInstant('2026-10-12', '25:00')).toBeNull()
    expect(greenhouseTime('2026-10-12T18:00:00Z')).toBe('14:00')
    expect(greenhouseToday(new Date('2026-10-22T03:30:00Z'))).toBe('2026-10-21') // still the 21st in Toronto
  })
})

describe('inspectedStems', () => {
  it('counts a stem once its latest check for that harvest is “All fruit checked”', () => {
    const v = (stem: string, at: string, ev: string | null, checked = true, all: boolean | null = true) => ({ measurement_stem_id: stem, observed_at: at, harvest_event_id: ev, checked, all_fruit_checked: ev ? all : null })
    expect([...inspectedStems([v('s1', 'a', 'E1'), v('s2', 'a', 'E1'), v('s2', 'b', 'E1', false, false), v('s3', 'a', null), v('s4', 'a', 'E2')], 'E1')]).toEqual(['s1'])
  })
})
