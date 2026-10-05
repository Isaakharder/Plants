import { QueryClient, QueryObserver, dehydrate, hydrate, onlineManager } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OfflineQueue, memoryStorage } from './offline/offlineQueue'
import { fakeSupabase, type FakeServer } from './testing/fakePostgrest'
import type { RowCanvasData } from './types'

// The collector opened with no signal (from the copy saved on the phone), then
// the connection returns: the row on screen and the attention rules are re-read
// once, through their normal loaders, with queued writes kept on top.
const env = vi.hoisted(() => ({ client: null as unknown as { from: (t: string) => unknown }, queue: null as unknown }))
vi.mock('../../lib/supabase', () => ({
  supabase: { from: (table: string) => env.client.from(table) },
  authStorageKey: 'test-auth-token',
  isSupabaseConfigured: true,
}))
vi.mock('./offline/networkStatus', () => ({ collectorQueue: () => env.queue, triggerSync: async () => {} }))

const { rowCanvasQuery, attentionRulesQuery } = await import('./api')
const { rowAttention } = await import('./attention')
const { syncOnlineState } = await import('./offline/onlineState')

const ORG = '0a000000-0000-4000-8000-000000000001'
const CROP = '0c000000-0000-4000-8000-000000000001'
const ROW = '0d000000-0000-4000-8000-000000000001'
const STEM = '1a000000-0000-4000-8000-000000000001'
const USER = '0e000000-0000-4000-8000-000000000001'
const nodeId = (n: number) => `2b000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const stamp = { created_by: null, created_at: '2026-06-01T12:00:00Z', updated_at: '2026-06-01T12:00:00Z' }
const NOW = Date.parse('2026-10-05T12:00:00Z')

let tables: Record<string, Record<string, unknown>[]>
let server: FakeServer
let queue: OfflineQueue
const online = (on: boolean) => vi.stubGlobal('navigator', { onLine: on })

function database() {
  const node = (n: number, extra = {}) => ({
    id: nodeId(n), organization_id: ORG, crop_id: CROP, measurement_stem_id: STEM, node_number: n, sort_order: n,
    is_side_shoot: false, parent_node_id: null, node_label: null, side: null, is_active: true, ...stamp, measurement_stems: { measurement_row_id: ROW }, ...extra,
  })
  const status = (n: number, s: string, observedAt: string, week: number) => ({
    id: `3c000000-0000-4000-8000-${String(n).padStart(12, '0')}`, plant_node_id: nodeId(n), measurement_row_id: ROW, measurement_stem_id: STEM,
    year: 2026, week_number: week, status: s, observed_at: observedAt,
  })
  return {
    measurement_rows: [{ id: ROW, organization_id: ORG, crop_id: CROP, row_name: 'Row 1', sort_order: 1, is_active: true, ...stamp }],
    measurement_stems: [{ id: STEM, organization_id: ORG, crop_id: CROP, measurement_row_id: ROW, stem_name: 'Stem 1', sort_order: 1, is_active: true, ...stamp }],
    // Node 1: Set fruit 20 days ago (overdue) · node 2 and node 3: both numbered 2 (duplicate) · node 4: Flower 2 days ago
    plant_nodes: [node(1), node(2), node(3, { node_number: 2, sort_order: 2 }), node(4)],
    node_latest_statuses: [status(1, 'SetFruit', '2026-09-15T12:00:00Z', 38), status(2, 'Flower', '2026-10-04T12:00:00Z', 40), status(3, 'Flower', '2026-10-04T12:00:00Z', 40), status(4, 'Flower', '2026-10-03T12:00:00Z', 40)],
    stem_growth_measurements: [],
    node_attention_rules: [['NoStatus', 7], ['Flower', 7], ['SetFruit', 14], ['MatureGreen', 49], ['BreakerFruit', 14]].map(([rule_key, max_days]) => ({ organization_id: ORG, rule_key, max_days })),
  }
}

const reads = () => ({ nodes: server.requests.plant_nodes ?? 0, rules: server.requests.node_attention_rules ?? 0 })
const settle = () => new Promise((r) => setTimeout(r, 20))

/** A phone that loaded the row once, closed the app, and reopens it now — online or not. */
async function reopen(startOnline: boolean, startupSync = true) {
  const first = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  online(true)
  await first.fetchQuery(rowCanvasQuery(first, ROW, USER))
  await first.fetchQuery(attentionRulesQuery(first, ORG, USER))
  const saved = dehydrate(first)
  first.clear()

  online(startOnline)
  if (startupSync) syncOnlineState() // what the collector does when it starts
  else onlineManager.setOnline(true) // the library's own assumption
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } })
  client.mount() // as QueryClientProvider does: subscribes the cache to focus/online changes
  hydrate(client, saved)
  const row = new QueryObserver(client, rowCanvasQuery(client, ROW, USER))
  const rules = new QueryObserver(client, attentionRulesQuery(client, ORG, USER))
  const stop = [row.subscribe(() => {}), rules.subscribe(() => {})]
  await settle()
  return { client, row, rules, stop: () => (stop.forEach((s) => s()), client.unmount()) }
}

/** The browser's `online` event, as TanStack Query's own listener delivers it. */
const connectionReturns = () => {
  online(true)
  onlineManager.setOnline(true)
}

const clocks = (data: RowCanvasData, rules: Parameters<typeof rowAttention>[3]) =>
  [...rowAttention(data.nodes, data.statuses, NOW, rules)].filter(([, a]) => a.clock).map(([id]) => id)
const warnings = (data: RowCanvasData, rules: Parameters<typeof rowAttention>[3]) =>
  [...rowAttention(data.nodes, data.statuses, NOW, rules)].filter(([, a]) => a.duplicate).map(([id]) => id)

beforeEach(() => {
  tables = database()
  server = { maxRows: 1000, requests: {} }
  env.client = fakeSupabase(tables, server)
  queue = new OfflineQueue(memoryStorage(), () => crypto.randomUUID())
  env.queue = queue
})
afterEach(() => {
  onlineManager.setOnline(true)
  vi.unstubAllGlobals()
})

describe('collector reconnect', () => {
  it('opened offline: the row and the attention rules re-read once when the connection returns', async () => {
    const app = await reopen(false)
    expect(onlineManager.isOnline()).toBe(false)
    const offline = reads()
    expect(app.row.getCurrentResult().data?.nodes).toHaveLength(4) // from the phone's saved copy
    // Meanwhile on the server: node 1 got a new status, and Set fruit's rule changed.
    tables.node_latest_statuses[0] = { ...tables.node_latest_statuses[0], status: 'MatureGreen', week_number: 41, observed_at: '2026-10-05T08:00:00Z' }
    tables.node_attention_rules[2].max_days = 30

    connectionReturns()
    await settle()
    expect(reads()).toEqual({ nodes: offline.nodes + 1, rules: offline.rules + 1 })
    const data = app.row.getCurrentResult().data!
    expect(data.statuses.find((s) => s.plant_node_id === nodeId(1))?.status).toBe('MatureGreen')
    expect(app.rules.getCurrentResult().data).toMatchObject({ SetFruit: 30 })
    app.stop()
  })

  it('without the start-up sync (the old behaviour), the open row would not re-read', async () => {
    const app = await reopen(false, false)
    const before = reads()
    connectionReturns()
    await settle()
    expect(reads()).toEqual(before)
    app.stop()
  })

  it('a status recorded offline stays on top of the fresh server data', async () => {
    const app = await reopen(false)
    await queue.enqueue({ type: 'record_status', record: { id: 'o-new', organization_id: ORG, crop_id: CROP, plant_node_id: nodeId(4), year: 2026, week_number: 41, status: 'SetFruit', observed_at: '2026-10-05T11:00:00Z' } }, USER)
    connectionReturns()
    await settle()
    const data = app.row.getCurrentResult().data!
    expect(data.statuses.find((s) => s.plant_node_id === nodeId(4))).toMatchObject({ status: 'SetFruit', week_number: 41 })
    expect(queue.list(USER)).toHaveLength(1) // still queued: the sync sends it, not the refresh
    app.stop()
  })

  it('⚠ and 🕒 recalculate from the reconciled data', async () => {
    const app = await reopen(false)
    const before = app.row.getCurrentResult().data!
    const rulesBefore = app.rules.getCurrentResult().data!
    expect(clocks(before, rulesBefore)).toEqual([nodeId(1)])
    expect(warnings(before, rulesBefore).sort()).toEqual([nodeId(2), nodeId(3)])
    // Server: node 1 updated today; the duplicate fixed (node 3 renumbered to 3).
    tables.node_latest_statuses[0] = { ...tables.node_latest_statuses[0], status: 'MatureGreen', week_number: 41, observed_at: '2026-10-05T08:00:00Z' }
    tables.plant_nodes[2] = { ...tables.plant_nodes[2], node_number: 3, sort_order: 3 }
    connectionReturns()
    await settle()
    const after = app.row.getCurrentResult().data!
    const rulesAfter = app.rules.getCurrentResult().data!
    expect(clocks(after, rulesAfter)).toEqual([])
    expect(warnings(after, rulesAfter)).toEqual([])
    app.stop()
  })

  it('repeated online events and a flickering connection don’t cause a refresh loop', async () => {
    const app = await reopen(false)
    const offline = reads()
    connectionReturns()
    connectionReturns()
    connectionReturns()
    await settle()
    expect(reads()).toEqual({ nodes: offline.nodes + 1, rules: offline.rules + 1 })
    // Off and on again quickly while a read is in flight: still one read.
    const before = reads()
    onlineManager.setOnline(false)
    connectionReturns()
    onlineManager.setOnline(false)
    connectionReturns()
    await settle()
    expect(reads().nodes - before.nodes).toBeLessThanOrEqual(1)
    await new Promise((r) => setTimeout(r, 100))
    const quiet = reads()
    await new Promise((r) => setTimeout(r, 100))
    expect(reads()).toEqual(quiet) // nothing keeps refetching
    app.stop()
  })

  it('opened online: loads normally, with no extra reads', async () => {
    const app = await reopen(true)
    expect(onlineManager.isOnline()).toBe(true)
    // The saved copy is fresh (30 s), so nothing re-reads on open; the row is there.
    expect(app.row.getCurrentResult().data?.nodes).toHaveLength(4)
    const before = reads()
    connectionReturns() // an `online` event while already online changes nothing
    await settle()
    expect(reads()).toEqual(before)
    app.stop()
  })
})
