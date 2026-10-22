import { describe, expect, it } from 'vitest'
import { canMarkHarvestable } from './harvestable'
import { OfflineQueue, memoryStorage, type QueuedAction, type QueuedWrite } from './offline/offlineQueue'
import { harvestableNodes, mergeRowCanvas } from './offline/optimisticStore'
import type { HarvestableMark, RowCanvasData } from './types'

const ORG = 'org-1'
const CROP = 'crop-1'
const base = { organization_id: ORG, crop_id: CROP }
const stamp = { created_by: 'u', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' }
const W43 = { year: 2026, week: 43 }

let n = 0
const queued = (write: QueuedWrite): QueuedAction =>
  ({ ...write, id: `q${++n}`, userId: 'u', status: 'pending', error: null, attempts: 0, createdAt: Date.parse('2026-10-21T12:00:00Z') + n }) as QueuedAction

const mark = (id: string, node: string, week: number, harvestable: boolean, at: string) =>
  ({ id, ...base, plant_node_id: node, year: 2026, week_number: week, harvestable, observed_at: at })

const node = (id: string) => ({ id, ...base, measurement_stem_id: 's1', node_number: 1, sort_order: 1, is_side_shoot: false, parent_node_id: null, node_label: null, side: null, is_active: true, ...stamp })
// B1: Breaker since W42 (the Friday walkthrough); G1: Mature Green.
const server: RowCanvasData = {
  row: { id: 'r1', ...base, row_name: 'Row 1', sort_order: 1, is_active: true, ...stamp },
  stems: [{ id: 's1', ...base, measurement_row_id: 'r1', stem_name: 'Stem 1', sort_order: 1, is_active: true, ...stamp }],
  nodes: [node('b1'), node('g1')],
  statuses: [
    { id: 'o1', plant_node_id: 'b1', year: 2026, week_number: 42, status: 'BreakerFruit', observed_at: '2026-10-16T14:00:00Z' },
    { id: 'o2', plant_node_id: 'g1', year: 2026, week_number: 42, status: 'MatureGreen', observed_at: '2026-10-16T14:01:00Z' },
  ],
  growth: [],
  visits: [],
}

describe('canMarkHarvestable', () => {
  it('offers fruit still on the plant, and Undo for a marked pepper', () => {
    expect(['SetFruit', 'MatureGreen', 'BreakerFruit'].map((s) => canMarkHarvestable(s as never, false))).toEqual([true, true, true])
    expect(['Flower', 'Aborted', 'Pruned', 'Harvested', null].map((s) => canMarkHarvestable(s as never, false))).toEqual([false, false, false, false, false])
    expect(canMarkHarvestable('Harvested', true)).toBe(true)
  })
})

describe('harvestableNodes', () => {
  it('counts a pepper once however often it is marked in a week; the latest mark wins', () => {
    const marks: HarvestableMark[] = [
      mark('m1', 'b1', 43, true, '2026-10-21T14:00:00Z'),
      mark('m2', 'b1', 43, true, '2026-10-21T14:05:00Z'),
      mark('m3', 'g1', 43, true, '2026-10-21T14:06:00Z'),
      mark('m4', 'g1', 43, false, '2026-10-21T14:07:00Z'),
    ]
    expect([...harvestableNodes(marks, W43).keys()]).toEqual(['b1'])
  })

  it('belongs to its own week only: a W43 mark is not shown in W44', () => {
    const marks = [mark('m1', 'b1', 43, true, '2026-10-21T14:00:00Z')]
    expect(harvestableNodes(marks, W43).size).toBe(1)
    expect(harvestableNodes(marks, { year: 2026, week: 44 }).size).toBe(0)
  })
})

describe('Harvestable on the collector canvas', () => {
  it('shows a queued mark (offline) without touching the Breaker status', () => {
    const merged = mergeRowCanvas(server, 'r1', [queued({ type: 'record_harvestable', record: mark('m1', 'b1', 43, true, '2026-10-21T14:00:00Z') })])
    expect(merged.statuses).toEqual(server.statuses)
    expect([...harvestableNodes(merged.harvestable ?? [], W43).keys()]).toEqual(['b1'])
  })

  it('is idempotent and keeps marks already on the server', () => {
    const withServer = { ...server, harvestable: [mark('m0', 'g1', 43, true, '2026-10-21T13:00:00Z')] }
    const writes = [queued({ type: 'record_harvestable', record: mark('m1', 'b1', 43, true, '2026-10-21T14:00:00Z') })]
    const once = mergeRowCanvas(withServer, 'r1', writes)
    expect(mergeRowCanvas(once, 'r1', writes)).toEqual(once)
    expect([...harvestableNodes(once.harvestable ?? [], W43).keys()].sort()).toEqual(['b1', 'g1'])
  })

  it('Wednesday Harvestable then Friday Still Breaker: both kept, status stays Breaker', () => {
    const merged = mergeRowCanvas(server, 'r1', [
      queued({ type: 'record_harvestable', record: mark('m1', 'b1', 43, true, '2026-10-21T14:00:00Z') }),
      queued({ type: 'record_status', record: { id: 'o3', ...base, plant_node_id: 'b1', year: 2026, week_number: 43, status: 'BreakerFruit', observed_at: '2026-10-23T14:00:00Z' } }),
    ])
    expect(merged.statuses.find((s) => s.plant_node_id === 'b1')).toEqual(expect.objectContaining({ status: 'BreakerFruit', week_number: 43 }))
    expect(harvestableNodes(merged.harvestable ?? [], W43).has('b1')).toBe(true)
  })

  it('reads copies saved before Harvestable existed (no harvestable field)', () => {
    expect(mergeRowCanvas(server, 'r1', []).harvestable).toEqual([])
  })
})

describe('Harvestable in the offline queue', () => {
  it('sends marks in the order they were made, once each, even after a lost response', async () => {
    const queue = new OfflineQueue(memoryStorage(), (() => { let i = 0; return () => `a${++i}` })())
    await queue.enqueue({ type: 'record_status', record: { id: 'o3', ...base, plant_node_id: 'b1', year: 2026, week_number: 43, status: 'BreakerFruit', observed_at: '2026-10-21T13:59:00Z' } }, 'u')
    await queue.enqueue({ type: 'record_harvestable', record: mark('m1', 'b1', 43, true, '2026-10-21T14:00:00Z') }, 'u')
    await queue.enqueue({ type: 'record_harvestable', record: mark('m2', 'b1', 43, false, '2026-10-21T14:01:00Z') }, 'u')
    const sent: string[] = []
    let dropped = false
    // The first mark reaches the server but its response is lost: it is sent again (an insert-once upsert server-side).
    const first = await queue.sync('u', async (w) => {
      sent.push((w.record as { id: string }).id)
      if (w.type === 'record_harvestable' && !dropped) { dropped = true; return { ok: false, retryable: true, message: 'network' } }
      return { ok: true }
    })
    expect(first.interrupted).toBe(true)
    await queue.sync('u', async (w) => { sent.push((w.record as { id: string }).id); return { ok: true } })
    expect(sent).toEqual(['o3', 'm1', 'm1', 'm2'])
    expect(queue.list('u')).toEqual([])
  })

  it('keeps a node whose mark is still queued (a cancelled picker cannot withdraw it)', async () => {
    const queue = new OfflineQueue(memoryStorage(), (() => { let i = 0; return () => `a${++i}` })())
    await queue.enqueue({ type: 'create_node', record: { id: 'n9', ...base, measurement_stem_id: 's1', node_number: 9, sort_order: 9, is_side_shoot: false, parent_node_id: null, node_label: null, side: null, is_active: true } }, 'u')
    await queue.enqueue({ type: 'record_harvestable', record: mark('m1', 'n9', 43, true, '2026-10-21T14:00:00Z') }, 'u')
    expect(await queue.withdrawCreateNode('n9')).toBe(false)
  })
})
