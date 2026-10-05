import { describe, expect, it } from 'vitest'
import type { RowCanvasData } from '../types'
import type { QueuedAction, QueuedWrite } from './offlineQueue'
import { mergeRowCanvas, mergeRowCards } from './optimisticStore'

const ORG = 'org-1'
const CROP = 'crop-1'
const base = { organization_id: ORG, crop_id: CROP }
const stamp = { created_by: 'u', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' }

let n = 0
const queued = (write: QueuedWrite): QueuedAction =>
  ({ ...write, id: `q${++n}`, userId: 'u', status: 'pending', error: null, attempts: 0, createdAt: Date.parse('2026-10-06T12:00:00Z') + n }) as QueuedAction

const serverRow = { id: 'r1', ...base, row_name: 'Row 1', sort_order: 1, is_active: true, ...stamp }
const serverStem = { id: 's1', ...base, measurement_row_id: 'r1', stem_name: 'Stem 1', sort_order: 1, is_active: true, ...stamp }
const serverNode = { id: 'n1', ...base, measurement_stem_id: 's1', node_number: 1, sort_order: 1, is_side_shoot: false, parent_node_id: null, node_label: null, side: null, is_active: true, ...stamp }
const server: RowCanvasData = {
  row: serverRow,
  stems: [serverStem],
  nodes: [serverNode],
  statuses: [{ id: 'o1', plant_node_id: 'n1', year: 2026, week_number: 40, status: 'Flower', observed_at: '2026-09-30T12:00:00Z' }],
  growth: [],
}

describe('mergeRowCanvas', () => {
  const writes = [
    queued({ type: 'create_stem', record: { id: 's2', ...base, measurement_row_id: 'r1', stem_name: 'Stem 2', sort_order: 2, is_active: true } }),
    queued({ type: 'create_node', record: { id: 'n2', ...base, measurement_stem_id: 's2', node_number: 1, sort_order: 1, is_side_shoot: false, parent_node_id: null, node_label: null, side: null, is_active: true } }),
    queued({ type: 'record_status', record: { id: 'o2', ...base, plant_node_id: 'n1', year: 2026, week_number: 41, status: 'SetFruit', observed_at: '2026-10-06T12:00:00Z' } }),
    queued({ type: 'upsert_growth', record: { id: 'g1', ...base, measurement_stem_id: 's1', year: 2026, week_number: 41, growth_cm: 8.5, top_node_number: 1, notes: null, observed_at: '2026-10-06T12:00:00Z' } }),
  ]

  it('shows unsynced stems, nodes, statuses and growth on top of server data', () => {
    const merged = mergeRowCanvas(server, 'r1', writes)
    expect(merged.stems.map((s) => s.id)).toEqual(['s1', 's2'])
    expect(merged.nodes.map((x) => x.id)).toEqual(['n1', 'n2'])
    expect(merged.statuses).toEqual([expect.objectContaining({ plant_node_id: 'n1', status: 'SetFruit', week_number: 41 })])
    expect(merged.growth).toEqual([expect.objectContaining({ id: 'g1', growth_cm: 8.5 })])
  })

  it('is idempotent (safe to apply to already-merged data)', () => {
    const once = mergeRowCanvas(server, 'r1', writes)
    expect(mergeRowCanvas(once, 'r1', writes)).toEqual(once)
  })

  it('does not let an older queued status replace a newer one from the server', () => {
    const older = queued({ type: 'record_status', record: { id: 'o0', ...base, plant_node_id: 'n1', year: 2026, week_number: 39, status: 'Aborted', observed_at: '2026-09-22T12:00:00Z' } })
    expect(mergeRowCanvas(server, 'r1', [older]).statuses[0].status).toBe('Flower')
  })

  it('builds the row itself when the row was created offline', () => {
    const empty: RowCanvasData = { row: null, stems: [], nodes: [], statuses: [], growth: [] }
    const created = queued({ type: 'create_row', record: { id: 'r9', ...base, row_name: 'Row 9', sort_order: 9, is_active: true } })
    expect(mergeRowCanvas(empty, 'r9', [created]).row).toMatchObject({ id: 'r9', row_name: 'Row 9', crop_id: CROP })
  })

  it('hides a node that was deactivated offline', () => {
    const deactivate = queued({ type: 'deactivate_node', record: { id: 'n1', organization_id: ORG, measurement_stem_id: 's1' } })
    expect(mergeRowCanvas(server, 'r1', [deactivate]).nodes[0].is_active).toBe(false)
  })

  it('ignores writes for other rows', () => {
    const elsewhere = queued({ type: 'create_stem', record: { id: 's3', ...base, measurement_row_id: 'r2', stem_name: 'Other', sort_order: 1, is_active: true } })
    expect(mergeRowCanvas(server, 'r1', [elsewhere]).stems).toHaveLength(1)
  })
})

describe('mergeRowCards', () => {
  it('adds rows created offline and counts their queued stems', () => {
    const card = { id: 'r1', row_name: 'Row 1', crop_id: CROP, sort_order: 1, stem_ids: ['s1'], stem_count: 1, last_updated: '2026-10-01T00:00:00Z' }
    const writes = [
      queued({ type: 'create_row', record: { id: 'r2', ...base, row_name: 'Row 2', sort_order: 2, is_active: true } }),
      queued({ type: 'create_stem', record: { id: 's2', ...base, measurement_row_id: 'r2', stem_name: 'Stem 1', sort_order: 1, is_active: true } }),
      queued({ type: 'create_stem', record: { id: 's1', ...base, measurement_row_id: 'r1', stem_name: 'Stem 1', sort_order: 1, is_active: true } }),
    ]
    const merged = mergeRowCards([card], ORG, writes)
    expect(merged.map((c) => [c.id, c.stem_count])).toEqual([['r1', 1], ['r2', 1]])
    expect(mergeRowCards(merged, ORG, writes)).toEqual(merged)
  })
})
