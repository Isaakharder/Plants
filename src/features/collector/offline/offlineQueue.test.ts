import { describe, expect, it } from 'vitest'
import { OfflineQueue, memoryStorage, type QueuedWrite, type WriteExecutor } from './offlineQueue'

const ORG = 'org-1'
const CROP = 'crop-1'
const USER = 'user-1'

let seq = 0
const ids = () => `id-${++seq}`

const row = (id: string): QueuedWrite => ({
  type: 'create_row',
  record: { id, organization_id: ORG, crop_id: CROP, row_name: 'Row 1', sort_order: 1, is_active: true },
})
const stem = (id: string, rowId: string): QueuedWrite => ({
  type: 'create_stem',
  record: { id, organization_id: ORG, crop_id: CROP, measurement_row_id: rowId, stem_name: 'Stem 1', sort_order: 1, is_active: true },
})
const node = (id: string, stemId: string): QueuedWrite => ({
  type: 'create_node',
  record: { id, organization_id: ORG, crop_id: CROP, measurement_stem_id: stemId, node_number: 1, sort_order: 1, is_side_shoot: false, parent_node_id: null, node_label: null, side: null, is_active: true },
})
const status = (id: string, nodeId: string): QueuedWrite => ({
  type: 'record_status',
  record: { id, organization_id: ORG, crop_id: CROP, plant_node_id: nodeId, year: 2026, week_number: 41, status: 'Flower', observed_at: '2026-10-06T12:00:00Z' },
})
const growth = (id: string, stemId: string): QueuedWrite => ({
  type: 'upsert_growth',
  record: { id, organization_id: ORG, crop_id: CROP, measurement_stem_id: stemId, year: 2026, week_number: 41, growth_cm: 8.5, top_node_number: 1, notes: null, observed_at: '2026-10-06T12:00:00Z' },
})

/** A stand-in database: inserts are keyed by the record's id (ON CONFLICT (id) DO NOTHING). */
function fakeDatabase() {
  const rows = new Map<string, QueuedWrite>()
  const sent: string[] = []
  let failNext: null | { retryable: boolean; afterWrite: boolean } = null
  const execute: WriteExecutor = async (write) => {
    sent.push(write.record.id)
    if (failNext && !failNext.afterWrite) {
      const { retryable } = failNext
      failNext = null
      return { ok: false, retryable, message: retryable ? 'Failed to fetch' : 'violates foreign key constraint' }
    }
    if (!rows.has(write.record.id)) rows.set(write.record.id, write)
    if (failNext?.afterWrite) {
      failNext = null
      // The write reached the database but the response never came back.
      return { ok: false, retryable: true, message: 'Failed to fetch' }
    }
    return { ok: true }
  }
  return { rows, sent, execute, fail: (f: { retryable: boolean; afterWrite: boolean }) => (failNext = f) }
}

describe('OfflineQueue', () => {
  it('keeps writes until they are sent, then removes them', async () => {
    const queue = new OfflineQueue(memoryStorage(), ids)
    const db = fakeDatabase()
    await queue.enqueue(row('r1'), USER)
    await queue.enqueue(growth('g1', 's1'), USER)
    expect(queue.counts(USER)).toEqual({ pending: 2, failed: 0 })

    const result = await queue.sync(USER, db.execute)
    expect(result).toEqual({ synced: 2, failed: 0, remaining: 0, interrupted: false })
    expect([...db.rows.keys()]).toEqual(['r1', 'g1'])
  })

  it('sends writes in the order they were made (row → stem → node → status)', async () => {
    const queue = new OfflineQueue(memoryStorage(), ids)
    const db = fakeDatabase()
    for (const w of [row('r1'), stem('s1', 'r1'), node('n1', 's1'), status('o1', 'n1')]) await queue.enqueue(w, USER)
    await queue.sync(USER, db.execute)
    expect(db.sent).toEqual(['r1', 's1', 'n1', 'o1'])
  })

  it('does not duplicate a write whose response was lost and is retried', async () => {
    const queue = new OfflineQueue(memoryStorage(), ids)
    const db = fakeDatabase()
    await queue.enqueue(row('r1'), USER)
    await queue.enqueue(stem('s1', 'r1'), USER)

    db.fail({ retryable: true, afterWrite: true })
    const first = await queue.sync(USER, db.execute)
    expect(first).toMatchObject({ synced: 0, interrupted: true, remaining: 2 })
    expect(db.rows.size).toBe(1) // r1 reached the database

    const second = await queue.sync(USER, db.execute)
    expect(second).toMatchObject({ synced: 2, remaining: 0 })
    expect(db.sent).toEqual(['r1', 'r1', 's1']) // r1 was sent twice…
    expect([...db.rows.keys()]).toEqual(['r1', 's1']) // …and stored once
  })

  it('stops at a network failure and keeps the rest queued in order', async () => {
    const queue = new OfflineQueue(memoryStorage(), ids)
    const db = fakeDatabase()
    await queue.enqueue(row('r1'), USER)
    await queue.enqueue(stem('s1', 'r1'), USER)
    db.fail({ retryable: true, afterWrite: false })
    await queue.sync(USER, db.execute)
    expect(db.sent).toEqual(['r1'])
    expect(queue.list(USER).map((a) => [a.record.id, a.status, a.attempts])).toEqual([['r1', 'pending', 1], ['s1', 'pending', 0]])
  })

  it('keeps a rejected write as failed instead of discarding it, and retries it on request', async () => {
    const queue = new OfflineQueue(memoryStorage(), ids)
    const db = fakeDatabase()
    await queue.enqueue(status('o1', 'n1'), USER)
    db.fail({ retryable: false, afterWrite: false })
    const result = await queue.sync(USER, db.execute)
    expect(result).toMatchObject({ synced: 0, failed: 1 })
    expect(queue.list(USER)[0]).toMatchObject({ status: 'failed', error: 'violates foreign key constraint' })

    // Not retried automatically…
    await queue.sync(USER, db.execute)
    expect(db.sent).toEqual(['o1'])
    // …but "Sync now" resets it.
    await queue.resetFailed(USER)
    await queue.sync(USER, db.execute)
    expect(db.rows.has('o1')).toBe(true)
    expect(queue.list(USER)).toEqual([])
  })

  it('only replays writes made by the signed-in user', async () => {
    const queue = new OfflineQueue(memoryStorage(), ids)
    const db = fakeDatabase()
    await queue.enqueue(row('mine'), USER)
    await queue.enqueue(row('theirs'), 'user-2')
    await queue.sync(USER, db.execute)
    expect([...db.rows.keys()]).toEqual(['mine'])
    expect(queue.counts('user-2').pending).toBe(1)
  })

  it('survives a reload: a new queue on the same storage sees unsynced writes', async () => {
    const storage = memoryStorage()
    await new OfflineQueue(storage, ids).enqueue(growth('g1', 's1'), USER)
    const reopened = new OfflineQueue(storage, ids)
    await reopened.ready
    expect(reopened.list(USER).map((a) => a.type)).toEqual(['upsert_growth'])
  })

  it('withdraws an unsent node creation when its status picker is cancelled', async () => {
    const queue = new OfflineQueue(memoryStorage(), ids)
    const n1 = await queue.enqueue(node('n1', 's1'), USER)
    await queue.enqueue(node('n2', 's1'), USER)
    await queue.enqueue(status('o2', 'n2'), USER)
    expect(await queue.withdrawCreateNode('n1')).toBe(true)
    // n2 already has a status queued against it, so it must be deactivated instead.
    expect(await queue.withdrawCreateNode('n2')).toBe(false)
    expect(queue.list(USER).map((a) => a.record.id)).toEqual(['n2', 'o2'])
    // Reads that started before the withdrawal use this to not bring the node back.
    expect(queue.wasWithdrawn(n1.id)).toBe(true)
  })

  it('does not withdraw a node creation that was already sent', async () => {
    const queue = new OfflineQueue(memoryStorage(), ids)
    const db = fakeDatabase()
    await queue.enqueue(node('n1', 's1'), USER)
    await queue.sync(USER, db.execute)
    expect(await queue.withdrawCreateNode('n1')).toBe(false)
  })
})
