import { describe, expect, it } from 'vitest'
import { DEFAULT_ATTENTION_RULES, duplicateExplanation, duplicatesByNode, findDuplicateGroups, nodeClock, rowAttention, rulesFromRows, type AttentionRules } from './attention'
import type { QueuedAction, QueuedWrite } from './offline/offlineQueue'
import { mergeRowCanvas } from './offline/optimisticStore'
import type { LatestNodeStatus, NodeStatus, PlantNode, RowCanvasData } from './types'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const base = { organization_id: 'org', crop_id: 'crop' }
const node = (id: string, n: number, extra: Partial<PlantNode> = {}): PlantNode => ({
  id, ...base, measurement_stem_id: 's1', node_number: n, sort_order: n, is_side_shoot: false, parent_node_id: null, node_label: null, side: null,
  is_active: true, created_by: null, created_at: '2026-06-01T12:00:00.000Z', updated_at: '2026-06-01T12:00:00.000Z', ...extra,
})
const shoot = (id: string, parent: PlantNode, k: number, extra: Partial<PlantNode> = {}) =>
  node(id, parent.node_number, { is_side_shoot: true, parent_node_id: parent.id, node_label: `${parent.node_number}+${k}`, side: 'right', ...extra })
const status = (nodeId: string, s: NodeStatus, observedAt: string, year = 2026, week = 39): LatestNodeStatus => ({ id: `o-${nodeId}`, plant_node_id: nodeId, year, week_number: week, status: s, observed_at: observedAt })
const at = (iso: string) => Date.parse(iso)

const RULES: AttentionRules = DEFAULT_ATTENTION_RULES

describe('clock: overdue for an update, by latest status', () => {
  const n18 = node('n18', 18)
  const last = '2026-09-28T13:00:00.000Z'
  const clockAt = (s: NodeStatus, elapsed: number, rules = RULES) => nodeClock(n18, status('n18', s, last), at(last) + elapsed, rules)

  it('defaults: No status 7, Flower 7, Set fruit 14, Mature green 49, Breaker 14 days', () => {
    expect(DEFAULT_ATTENTION_RULES).toEqual({ NoStatus: 7, Flower: 7, SetFruit: 14, MatureGreen: 49, BreakerFruit: 14 })
  })

  const cases: [NodeStatus, number][] = [['Flower', 7], ['SetFruit', 14], ['MatureGreen', 49], ['BreakerFruit', 14]]
  for (const [s, days] of cases) {
    it(`${s}: ${days - 1} d 23 h 59 min → no clock; exactly ${days} d → clock; ${days} d later still`, () => {
      expect(clockAt(s, days * DAY - MIN)).toBeNull()
      expect(clockAt(s, days * DAY)).toEqual({ kind: 'overdue', ageDays: days, intervalDays: days, status: s, year: 2026, week: 39, observedAt: last })
      expect(clockAt(s, days * DAY + 5 * HOUR)).toMatchObject({ kind: 'overdue', ageDays: days })
    })
  }

  it('the examples: Flower 6 d, Set fruit 10 d, Mature green 30 d, Breaker 13 d → no clock', () => {
    expect(clockAt('Flower', 6 * DAY)).toBeNull()
    expect(clockAt('SetFruit', 10 * DAY)).toBeNull()
    expect(clockAt('MatureGreen', 30 * DAY)).toBeNull()
    expect(clockAt('BreakerFruit', 13 * DAY)).toBeNull()
    expect(clockAt('SetFruit', 16 * DAY)).toMatchObject({ ageDays: 16, intervalDays: 14 })
    expect(clockAt('MatureGreen', 52 * DAY)).toMatchObject({ ageDays: 52, intervalDays: 49 })
  })

  it('final statuses (Harvested, Aborted, Pruned) never show a clock', () => {
    for (const s of ['Harvested', 'Aborted', 'Pruned'] as const) expect(clockAt(s, 400 * DAY)).toBeNull()
  })

  it('uses the organization’s rules, not the defaults', () => {
    const custom = rulesFromRows([{ rule_key: 'Flower', max_days: 3 }, { rule_key: 'SetFruit', max_days: 21 }])
    expect(clockAt('Flower', 3 * DAY, custom)).toMatchObject({ intervalDays: 3 })
    expect(clockAt('SetFruit', 14 * DAY, custom)).toBeNull()
    expect(clockAt('SetFruit', 21 * DAY, custom)).toMatchObject({ intervalDays: 21 })
    // No row for a status → no clock for it.
    expect(clockAt('MatureGreen', 400 * DAY, custom)).toBeNull()
  })

  it('a new status restarts the timer with that status’s interval (Set fruit → Mature green)', () => {
    const now = at('2026-10-20T13:00:00.000Z')
    expect(nodeClock(n18, status('n18', 'SetFruit', last, 2026, 40), now, RULES)).toMatchObject({ intervalDays: 14, ageDays: 22 })
    const mg = status('n18', 'MatureGreen', '2026-10-20T12:00:00.000Z', 2026, 43)
    expect(nodeClock(n18, mg, now, RULES)).toBeNull()
    expect(nodeClock(n18, mg, at('2026-11-20T12:00:00.000Z'), RULES)).toBeNull() // 31 days: within 49
    expect(nodeClock(n18, mg, at('2026-12-08T12:00:00.000Z'), RULES)).toMatchObject({ intervalDays: 49, ageDays: 49 })
  })

  it('removed nodes never show one; a device clock ahead of now never shows one', () => {
    expect(nodeClock({ ...n18, is_active: false }, status('n18', 'SetFruit', last), at(last) + 400 * DAY, RULES)).toBeNull()
    expect(nodeClock(n18, status('n18', 'Flower', '2026-10-06T00:00:00.000Z'), at('2026-10-05T00:00:00.000Z'), RULES)).toBeNull()
  })

  describe('No status yet (never observed): its own rule, from when the node was added', () => {
    const fresh = node('n30', 30, { created_at: '2026-10-01T12:00:00.000Z' })
    const added = at('2026-10-01T12:00:00.000Z')

    it('just under the threshold → no clock; exactly → clock', () => {
      expect(nodeClock(fresh, undefined, added + 7 * DAY - MIN, RULES)).toBeNull()
      expect(nodeClock(fresh, undefined, added + 7 * DAY, RULES)).toEqual({ kind: 'never', ageDays: 7, intervalDays: 7, createdAt: '2026-10-01T12:00:00.000Z' })
      expect(nodeClock(fresh, undefined, added + 9 * DAY + HOUR, RULES)).toMatchObject({ kind: 'never', ageDays: 9, intervalDays: 7 })
    })

    it('follows the organization’s setting, not a fruit stage', () => {
      const three = { ...RULES, NoStatus: 3 }
      expect(nodeClock(fresh, undefined, added + 3 * DAY - MIN, three)).toBeNull()
      expect(nodeClock(fresh, undefined, added + 3 * DAY, three)).toMatchObject({ kind: 'never', intervalDays: 3 })
      // Changing Flower doesn't affect it.
      expect(nodeClock(fresh, undefined, added + 7 * DAY, { ...RULES, Flower: 30 })).toMatchObject({ kind: 'never', intervalDays: 7 })
      // No rule, no clock.
      expect(nodeClock(fresh, undefined, added + 400 * DAY, { Flower: 7 })).toBeNull()
    })

    it('the first observation switches the node to its status’s rule at once', () => {
      const now = added + 10 * DAY // overdue under No status yet
      expect(nodeClock(fresh, undefined, now, RULES)).toMatchObject({ kind: 'never' })
      expect(nodeClock(fresh, status('n30', 'SetFruit', new Date(now - MIN).toISOString(), 2026, 42), now, RULES)).toBeNull()
      // …and from then on Set fruit's 14 days count from that observation, not from when the node was added.
      const obs = status('n30', 'SetFruit', new Date(now).toISOString(), 2026, 42)
      expect(nodeClock(fresh, obs, now + 14 * DAY - MIN, RULES)).toBeNull()
      expect(nodeClock(fresh, obs, now + 14 * DAY, RULES)).toMatchObject({ kind: 'overdue', intervalDays: 14 })
    })
  })

  it('crosses ISO year and week boundaries (2026 has 53 weeks)', () => {
    // Flower on Wed Dec 30 2026 (W53 2026); 7 days later is W1 2027.
    const s = status('n18', 'Flower', '2026-12-30T15:00:00.000Z', 2026, 53)
    expect(nodeClock(n18, s, at('2027-01-06T14:59:00.000Z'), RULES)).toBeNull()
    expect(nodeClock(n18, s, at('2027-01-06T15:00:00.000Z'), RULES)).toMatchObject({ kind: 'overdue', ageDays: 7, year: 2026, week: 53 })
    // Set fruit on Dec 24 2026 (W52) → 14 days later, Jan 7 2027.
    const set = status('n18', 'SetFruit', '2026-12-24T15:00:00.000Z', 2026, 52)
    expect(nodeClock(n18, set, at('2027-01-07T14:59:00.000Z'), RULES)).toBeNull()
    expect(nodeClock(n18, set, at('2027-01-07T15:00:00.000Z'), RULES)).toMatchObject({ ageDays: 14 })
  })

  it('DST: exact elapsed hours, so the switch never shifts it by a day', () => {
    // Fall back (Nov 1 2026): Flower Sun Oct 25 10:00 EDT → Sun Nov 1 09:00 EST is exactly 168 h.
    const fall = status('n18', 'Flower', '2026-10-25T14:00:00.000Z')
    expect(nodeClock(n18, fall, at('2026-11-01T13:59:00.000Z'), RULES)).toBeNull()
    expect(nodeClock(n18, fall, at('2026-11-01T14:00:00.000Z'), RULES)).toMatchObject({ ageDays: 7 })
    // Spring forward (Mar 8 2026): Set fruit Sun Mar 1 10:00 EST → Sun Mar 15 11:00 EDT is exactly 336 h.
    const spring = status('n18', 'SetFruit', '2026-03-01T15:00:00.000Z')
    expect(nodeClock(n18, spring, at('2026-03-15T14:00:00.000Z'), RULES)).toBeNull() // 10:00 EDT, 335 h
    expect(nodeClock(n18, spring, at('2026-03-15T15:00:00.000Z'), RULES)).toMatchObject({ ageDays: 14 })
    // Mature green across both switches (Mar 1 → Apr 19, 49 days).
    const mg = status('n18', 'MatureGreen', '2026-03-01T15:00:00.000Z')
    expect(nodeClock(n18, mg, at('2026-04-19T14:59:00.000Z'), RULES)).toBeNull()
    expect(nodeClock(n18, mg, at('2026-04-19T15:00:00.000Z'), RULES)).toMatchObject({ ageDays: 49 })
  })
})

describe('duplicates (shared with the desktop twin)', () => {
  const a = node('a', 12, { created_at: '2026-07-17T11:18:48.639Z' })
  const b = node('b', 12, { created_at: '2026-07-17T11:18:48.653Z' })
  const c = node('c', 12, { created_at: '2026-07-17T11:18:48.665Z' })
  const p9 = node('p9', 9)
  const s1 = shoot('s1', p9, 1, { created_at: '2026-07-10T12:00:23.834Z' })
  const s2 = shoot('s2', p9, 1, { created_at: '2026-07-10T12:00:24.003Z' })

  it('flags main-stem nodes sharing a number', () => {
    const d = duplicatesByNode([a, b, p9])
    expect(d.get('a')).toMatchObject({ count: 2, index: 0 })
    expect(d.get('b')).toMatchObject({ count: 2, index: 1 })
    expect(d.has('p9')).toBe(false)
    expect(duplicateExplanation(d.get('a')!)).toBe('Another node on this stem is also numbered 12.')
    expect(duplicateExplanation(duplicatesByNode([a, b, c]).get('c')!)).toBe('2 other nodes on this stem are also numbered 12.')
  })

  it('flags side shoots sharing a label on the same parent', () => {
    const d = duplicatesByNode([p9, s1, s2])
    expect(duplicateExplanation(d.get('s2')!)).toBe('Another side shoot is also labelled 9+1.')
    // Same label under different parents (or different stems) is not a duplicate.
    const other = node('p9b', 9, { measurement_stem_id: 's2' })
    expect(findDuplicateGroups([p9, s1, other, shoot('s3', other, 1, { measurement_stem_id: 's2' })])).toEqual([])
  })

  it('ignores removed records, and clears once corrected and refetched', () => {
    expect(findDuplicateGroups([a, { ...b, is_active: false }])).toEqual([])
    expect(findDuplicateGroups([a, { ...b, node_number: 13 }])).toEqual([])
    const now = at('2026-07-18T00:00:00.000Z')
    expect(rowAttention([a, b], [], now, RULES).get('b')?.duplicate).toBeTruthy()
    expect(rowAttention([a, { ...b, node_number: 13 }], [], now, RULES).get('b')).toBeUndefined()
  })
})

describe('row attention', () => {
  const now = at('2026-10-05T13:00:00.000Z')
  const n17 = node('n17', 17)
  const n18 = node('n18', 18)
  const d18 = node('d18', 18, { created_at: '2026-06-02T00:00:00.000Z' })
  const statuses = [
    status('n17', 'SetFruit', '2026-10-05T12:00:00.000Z', 2026, 41),
    status('n18', 'Flower', '2026-09-26T12:00:00.000Z', 2026, 39),
    status('d18', 'Flower', '2026-10-05T12:00:00.000Z', 2026, 41),
  ]

  it('nodes on the same stem are independent, and both badges can show together', () => {
    const r = rowAttention([n17, n18, d18], statuses, now, RULES)
    expect(r.has('n17')).toBe(false)
    expect(r.get('n18')).toEqual({
      duplicate: expect.objectContaining({ count: 2, index: 0 }),
      clock: { kind: 'overdue', ageDays: 9, intervalDays: 7, status: 'Flower', year: 2026, week: 39, observedAt: '2026-09-26T12:00:00.000Z' },
    })
    expect(r.get('d18')).toEqual({ duplicate: expect.objectContaining({ count: 2, index: 1 }), clock: null })
  })
})

describe('offline: indicators follow this device’s queued writes', () => {
  const row = { id: 'r1', ...base, row_name: 'Row 1', sort_order: 1, is_active: true, created_by: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }
  const stem = { id: 's1', ...base, measurement_row_id: 'r1', stem_name: 'Stem 1', sort_order: 1, is_active: true, created_by: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }
  const n18 = node('n18', 18)
  const n19 = node('n19', 19)
  const server: RowCanvasData = {
    row, stems: [stem], nodes: [n18, n19], growth: [],
    statuses: [status('n18', 'SetFruit', '2026-09-20T13:00:00.000Z', 2026, 38), status('n19', 'SetFruit', '2026-09-20T13:00:00.000Z', 2026, 38)],
  }
  const now = at('2026-10-05T14:00:00.000Z') // 15 days after both Set fruit records: both overdue
  const saved: QueuedWrite = { type: 'record_status', record: { id: 'o-new', ...base, plant_node_id: 'n18', year: 2026, week_number: 41, status: 'MatureGreen', observed_at: '2026-10-05T13:59:00.000Z' } }
  const queued = (status: 'pending' | 'failed'): QueuedAction => ({ ...saved, id: 'q1', userId: 'u', status, error: status === 'failed' ? 'rejected' : null, attempts: 0, createdAt: now - MIN }) as QueuedAction
  const clocks = (data: RowCanvasData, t = now) => [...rowAttention(data.nodes, data.statuses, t, RULES)].filter(([, a]) => a.clock).map(([id]) => id)

  it('a status saved offline removes that node’s clock at once; its neighbour keeps one', () => {
    expect(clocks(server)).toEqual(['n18', 'n19'])
    expect(clocks(mergeRowCanvas(server, 'r1', [queued('pending')]))).toEqual(['n19'])
  })

  it('…and the node then follows the new status’s interval (Mature green: 49 days)', () => {
    const merged = mergeRowCanvas(server, 'r1', [queued('pending')])
    expect(clocks(merged, at('2026-11-22T13:58:00.000Z'))).toEqual(['n19']) // 48 d 23 h 59 min
    expect(clocks(merged, at('2026-11-23T13:59:00.000Z'))).toEqual(['n18', 'n19']) // 49 d
  })

  it('a rejected save stays on the device (kept, never discarded), so the node stays updated there', () => {
    expect(clocks(mergeRowCanvas(server, 'r1', [queued('failed')]))).toEqual(['n19'])
  })

  it('when the queued write is gone without reaching the server, the clock comes back', () => {
    expect(clocks(mergeRowCanvas(server, 'r1', []))).toEqual(['n18', 'n19'])
  })

  it('once synced, the server data alone keeps the clock off', () => {
    const synced = { ...server, statuses: [{ ...server.statuses[0], ...status('n18', 'MatureGreen', '2026-10-05T13:59:00.000Z', 2026, 41) }, server.statuses[1]] }
    expect(clocks(mergeRowCanvas(synced, 'r1', []))).toEqual(['n19'])
  })
})

describe('a node added offline: its age starts when the worker added it', () => {
  const row = { id: 'r1', ...base, row_name: 'Row 1', sort_order: 1, is_active: true, created_by: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }
  const stem = { id: 's1', ...base, measurement_row_id: 'r1', stem_name: 'Stem 1', sort_order: 1, is_active: true, created_by: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }
  const server: RowCanvasData = { row, stems: [stem], nodes: [], statuses: [], growth: [] }
  const monday = '2026-10-05T13:00:00.000Z'
  const record = { id: 'new', ...base, measurement_stem_id: 's1', node_number: 31, sort_order: 31, is_side_shoot: false, parent_node_id: null, node_label: null, side: null, is_active: true }
  const queuedNode = (rec: Record<string, unknown>, createdAt: number): QueuedAction =>
    ({ type: 'create_node', record: rec, id: 'q-node', userId: 'u', status: 'pending', error: null, attempts: 0, createdAt }) as QueuedAction
  const clockOf = (data: RowCanvasData, t: number) => rowAttention(data.nodes, data.statuses, t, RULES).get('new')?.clock ?? null

  it('while queued (offline Monday → still unsynced the next Monday): counts from Monday', () => {
    const merged = mergeRowCanvas(server, 'r1', [queuedNode({ ...record, created_at: monday }, at(monday) + 50)])
    expect(merged.nodes[0].created_at).toBe(monday)
    expect(clockOf(merged, at(monday) + 7 * DAY - MIN)).toBeNull()
    expect(clockOf(merged, at(monday) + 7 * DAY)).toMatchObject({ kind: 'never', ageDays: 7, intervalDays: 7 })
  })

  it('after it syncs on Friday, the server keeps Monday, so the clock still shows the next Monday', () => {
    // What the database stores for the queued record (it keeps a plausible phone time).
    const synced = { ...server, nodes: [node('new', 31, { created_at: monday })] }
    expect(clockOf(synced, at('2026-10-09T13:00:00.000Z'))).toBeNull() // Friday
    expect(clockOf(synced, at('2026-10-12T13:00:00.000Z'))).toMatchObject({ kind: 'never', ageDays: 7 })
  })

  it('an older queued write without a creation time falls back to the queue time', () => {
    const merged = mergeRowCanvas(server, 'r1', [queuedNode(record, at(monday))])
    expect(merged.nodes[0].created_at).toBe(monday)
  })

  it('a phone clock ahead of real time never makes the node look old', () => {
    const future = '2026-10-20T13:00:00.000Z'
    const merged = mergeRowCanvas(server, 'r1', [queuedNode({ ...record, created_at: future }, at(future))])
    expect(clockOf(merged, at(monday))).toBeNull()
  })
})
