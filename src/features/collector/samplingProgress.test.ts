import { describe, expect, it } from 'vitest'
import { breakerProgress, checkedStemIds, completionNote, cropWeekProgress, latestSamplingEvent, nextUncheckedIndex } from './samplingProgress'
import { previousIsoWeek } from './greenhouseWeek'
import type { MobileRowCard, NodeStatus, SamplingWeekEvent, StemVisit, WeekObservation } from './types'

const W42 = { year: 2026, week: 42 }
const visit = (id: string, stem: string, checked: boolean, at: string, week = 42): StemVisit => ({
  id, measurement_stem_id: stem, year: 2026, week_number: week, checked, observed_at: `2026-10-16T${at}:00Z`,
})
const row = (id: string, name: string, stems: string[], crop = 'c1'): MobileRowCard => ({
  id, row_name: name, crop_id: crop, sort_order: 0, stem_ids: stems, stem_count: stems.length, last_updated: '2026-10-16T00:00:00Z',
})
const event = (id: string, kind: 'completed' | 'reopened', at: string, crop = 'c1', week = 42): SamplingWeekEvent => ({
  id, crop_id: crop, year: 2026, week_number: week, event: kind, observed_at: `2026-10-16T${at}:00Z`,
})

describe('checkedStemIds', () => {
  it('uses each stem’s latest record in the week; a retraction unchecks it', () => {
    const visits = [
      visit('1', 's1', true, '10:00'),
      visit('2', 's2', true, '10:01'),
      visit('3', 's2', false, '10:05'), // undo
      visit('4', 's3', false, '10:00'),
      visit('5', 's3', true, '10:09'), // checked again
      visit('6', 's4', true, '10:00', 41), // last week: not this week
    ]
    expect([...checkedStemIds(visits, W42)].sort()).toEqual(['s1', 's3'])
  })
})

describe('cropWeekProgress', () => {
  const rows = [row('r1', 'Row 27', ['a', 'b', 'c']), row('r2', 'Row 28', ['d', 'e']), row('rx', 'Other', ['x'], 'c2')]

  it('counts checked against expected stems of the crop only, by row', () => {
    const p = cropWeekProgress('c1', rows, [visit('1', 'a', true, '10:00'), visit('2', 'd', true, '10:00'), visit('3', 'e', true, '10:00'), visit('4', 'x', true, '10:00')], [], W42)
    expect(p.expected).toBe(5)
    expect(p.checked).toBe(3)
    expect(p.uncheckedByRow).toEqual([{ rowId: 'r1', rowName: 'Row 27', unchecked: 2 }])
    expect(p.byRow.get('r2')).toEqual({ checked: 2, total: 2 })
    expect(p.complete).toBe(false)
  })

  it('follows the latest completion event: completed, then reopened', () => {
    const done = cropWeekProgress('c1', rows, [], [event('e1', 'completed', '15:00')], W42)
    expect(done.complete).toBe(true)
    expect(done.completedAt).toBe('2026-10-16T15:00:00Z')
    const reopened = cropWeekProgress('c1', rows, [], [event('e1', 'completed', '15:00'), event('e2', 'reopened', '16:00')], W42)
    expect(reopened.complete).toBe(false)
    expect(reopened.completedAt).toBeNull()
    // Another crop's or another week's event doesn't count.
    expect(cropWeekProgress('c1', rows, [], [event('e3', 'completed', '15:00', 'c2'), event('e4', 'completed', '15:00', 'c1', 41)], W42).complete).toBe(false)
    expect(latestSamplingEvent([event('e4', 'completed', '15:00', 'c1', 41)], 'c1', { year: 2026, week: 41 })?.id).toBe('e4')
  })

  it('never treats unchecked stems as checked when completing', () => {
    const p = cropWeekProgress('c1', rows, [visit('1', 'a', true, '10:00')], [event('e1', 'completed', '15:00')], W42)
    expect(p.complete).toBe(true)
    expect(p.checked).toBe(1)
    expect(completionNote(p)).toBe('Completed with 1 of 5 stems checked; 4 confirmed as not checked this week.')
    expect(completionNote({ checked: 5, expected: 5 })).toBe('Completed with all 5 stems checked.')
  })
})

describe('nextUncheckedIndex', () => {
  const ids = ['a', 'b', 'c', 'd']
  it('moves to the next unchecked stem, wrapping around', () => {
    expect(nextUncheckedIndex(ids, 0, new Set(['a']))).toBe(1)
    expect(nextUncheckedIndex(ids, 1, new Set(['a', 'b', 'c']))).toBe(3)
    expect(nextUncheckedIndex(ids, 3, new Set(['b', 'c', 'd']))).toBe(0)
  })
  it('is null once every stem is checked', () => {
    expect(nextUncheckedIndex(ids, 2, new Set(ids))).toBeNull()
  })
})

describe('previousIsoWeek', () => {
  it('steps back across New Year, including week 53', () => {
    expect(previousIsoWeek({ year: 2026, week: 42 })).toEqual({ year: 2026, week: 41 })
    expect(previousIsoWeek({ year: 2027, week: 1 })).toEqual({ year: 2026, week: 53 })
    expect(previousIsoWeek({ year: 2026, week: 1 })).toEqual({ year: 2025, week: 52 })
  })
})

describe('Friday progress: Breakers this week', () => {
  const W = { year: 2026, week: 43 }
  const o = (id: string, node: string, stem: string | null, week: number, status: NodeStatus, at = '12:00', crop = 'c1'): WeekObservation => ({
    id, crop_id: crop, plant_node_id: node, stem_id: stem, year: 2026, week_number: week, status, observed_at: `2026-10-${week === 43 ? 23 : 16}T${at}:00Z`,
  })
  const check = (stem: string, week: number): StemVisit => ({ id: `v${stem}${week}`, measurement_stem_id: stem, year: 2026, week_number: week, checked: true, observed_at: `2026-10-${week === 43 ? 23 : 16}T11:00:00Z` })

  it('counts each node once: still Breaker, new on a stem walked last week, first seen otherwise', () => {
    const obs = [
      o('1', 'n1', 'a', 42, 'BreakerFruit'),
      o('2', 'n1', 'a', 43, 'BreakerFruit'), // still Breaker
      o('3', 'n1', 'a', 43, 'BreakerFruit', '12:05'), // tapped twice
      o('4', 'n2', 'a', 43, 'BreakerFruit'), // new: stem a recorded last week
      o('5', 'n3', 'b', 43, 'BreakerFruit'), // new: stem b checked last week
      o('6', 'n4', 'c', 43, 'BreakerFruit'), // first seen: stem c not walked last week
      o('7', 'n5', null, 43, 'BreakerFruit'), // stem unknown on this device: first seen
      o('8', 'n6', 'a', 43, 'BreakerFruit'),
      o('9', 'n6', 'a', 43, 'Harvested', '13:00'), // changed the same week: not a Breaker now
      o('10', 'x1', 'z', 43, 'BreakerFruit', '12:00', 'c2'), // another variety
    ]
    expect(breakerProgress('c1', obs, [check('b', 42)], W)).toEqual({ total: 5, stillBreaker: 1, new: 2, firstSeen: 2 })
  })
})

