import { QueryClient, QueryObserver, dehydrate, hydrate, onlineManager } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OfflineQueue, memoryStorage } from './offline/offlineQueue'
import { fakeSupabase, type FakeServer } from './testing/fakePostgrest'

// The collector's mobile status options: read from mobile_status_options
// through the same offline-aware query as the attention rules, saved on the
// device, refreshed when the connection returns, and never a reason for the
// collector to stop working.
const env = vi.hoisted(() => ({ client: null as unknown as { from: (t: string) => unknown }, queue: null as unknown }))
vi.mock('../../lib/supabase', () => ({
  supabase: { from: (table: string) => env.client.from(table) },
  authStorageKey: 'test-auth-token',
  isSupabaseConfigured: true,
}))
vi.mock('./offline/networkStatus', () => ({ collectorQueue: () => env.queue, triggerSync: async () => {} }))

const { mobileStatusOptionsQuery, rowCanvasQuery, attentionRulesQuery, NotOnDeviceError, collectorKeys } = await import('./api')
const { ALL_STATUSES, pickerOptions, statusOptionsOrDefaults } = await import('./statusOptions')
const { rowAttention } = await import('./attention')
const { syncOnlineState } = await import('./offline/onlineState')

const ORG = '0a000000-0000-4000-8000-000000000001'
const OTHER = '0a000000-0000-4000-8000-000000000002'
const CROP = '0c000000-0000-4000-8000-000000000001'
const ROW = '0d000000-0000-4000-8000-000000000001'
const STEM = '1a000000-0000-4000-8000-000000000001'
const USER = '0e000000-0000-4000-8000-000000000001'
const nodeId = (n: number) => `2b000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const stamp = { created_by: null, created_at: '2026-06-01T12:00:00Z', updated_at: '2026-06-01T12:00:00Z' }
const NOW = Date.parse('2026-10-05T12:00:00Z')

let tables: Record<string, Record<string, unknown>[]>
let server: FakeServer
let queryClient: QueryClient
const online = (on: boolean) => vi.stubGlobal('navigator', { onLine: on })
const option = (org: string, status: string, enabled = true) => ({ organization_id: org, status, enabled })
const setEnabled = (status: string, enabled: boolean) => {
  const row = tables.mobile_status_options.find((r) => r.organization_id === ORG && r.status === status)!
  row.enabled = enabled
}
const load = (client = queryClient) => client.fetchQuery({ ...mobileStatusOptionsQuery(client, ORG, USER), staleTime: 0 })
const reads = () => server.requests.mobile_status_options ?? 0
const settle = () => new Promise((r) => setTimeout(r, 20))

function database() {
  const node = (n: number) => ({
    id: nodeId(n), organization_id: ORG, crop_id: CROP, measurement_stem_id: STEM, node_number: n, sort_order: n,
    is_side_shoot: false, parent_node_id: null, node_label: null, side: null, is_active: true, ...stamp, measurement_stems: { measurement_row_id: ROW },
  })
  const status = (n: number, s: string, observedAt: string, week: number) => ({
    id: `3c000000-0000-4000-8000-${String(n).padStart(12, '0')}`, plant_node_id: nodeId(n), measurement_row_id: ROW, measurement_stem_id: STEM,
    year: 2026, week_number: week, status: s, observed_at: observedAt,
  })
  return {
    mobile_status_options: [...ALL_STATUSES.map((s) => option(ORG, s)), option(OTHER, 'Harvested', false)],
    measurement_rows: [{ id: ROW, organization_id: ORG, crop_id: CROP, row_name: 'Row 1', sort_order: 1, is_active: true, ...stamp }],
    measurement_stems: [{ id: STEM, organization_id: ORG, crop_id: CROP, measurement_row_id: ROW, stem_name: 'Stem 1', sort_order: 1, is_active: true, ...stamp }],
    // Historical statuses that the organization is about to hide: node 1 Flower, node 2 Mature Green (60 days ago: overdue at 49).
    plant_nodes: [node(1), node(2), node(3)],
    node_latest_statuses: [
      status(1, 'Flower', '2026-10-04T12:00:00Z', 40),
      status(2, 'MatureGreen', '2026-08-06T12:00:00Z', 32),
      status(3, 'SetFruit', '2026-10-01T12:00:00Z', 40),
    ],
    stem_growth_measurements: [],
    node_attention_rules: [['NoStatus', 7], ['Flower', 7], ['SetFruit', 14], ['MatureGreen', 49], ['BreakerFruit', 14]].map(([rule_key, max_days]) => ({ organization_id: ORG, rule_key, max_days })),
  }
}

beforeEach(() => {
  tables = database()
  server = { maxRows: 1000, requests: {} }
  env.client = fakeSupabase(tables, server)
  env.queue = new OfflineQueue(memoryStorage(), () => crypto.randomUUID())
  online(true)
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})
afterEach(() => {
  onlineManager.setOnline(true)
  vi.unstubAllGlobals()
})

describe('mobile status options in the collector', () => {
  it('an existing organization (seeded all enabled) offers all seven, reading only its own rows in one request', async () => {
    expect(await load()).toEqual(ALL_STATUSES)
    expect(reads()).toBe(1)
  })

  it('a change in Settings reaches the phone on its next sync', async () => {
    await load()
    setEnabled('Flower', false)
    setEnabled('MatureGreen', false)
    const enabled = await load()
    expect(enabled).toEqual(['Aborted', 'Pruned', 'SetFruit', 'BreakerFruit', 'Harvested'])
    expect(pickerOptions(enabled, 'SetFruit').map((o) => o.value)).toEqual(['Aborted', 'Pruned', 'SetFruit', 'BreakerFruit', 'Harvested'])
  })

  it('offline, the last downloaded choice applies, even after the app is reopened', async () => {
    setEnabled('Flower', false)
    setEnabled('MatureGreen', false)
    await load()
    const reopened = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    hydrate(reopened, dehydrate(queryClient))
    online(false)
    setEnabled('Flower', true) // changed on the server meanwhile; the phone can't know yet
    const offline = await load(reopened)
    expect(offline).toEqual(['Aborted', 'Pruned', 'SetFruit', 'BreakerFruit', 'Harvested'])
    expect(statusOptionsOrDefaults(offline).source).toBe('organization')
    expect(reads()).toBe(1)
  })

  it('a failed request keeps the last downloaded choice, and the collector keeps working', async () => {
    setEnabled('MatureGreen', false)
    await load()
    // A dropped connection while online: falls back to the device copy.
    env.client = fakeSupabase(tables, { ...server, failRequest: { table: 'mobile_status_options', nth: 2 } })
    expect(await load()).not.toContain('MatureGreen')
    // A server error (not the network): the read fails, but the copy on the device stays.
    env.client = { from: () => ({ select: () => ({ eq: async () => ({ data: null, error: { message: 'boom' }, status: 500 }) }) }) }
    await expect(load()).rejects.toThrow('boom')
    const kept = queryClient.getQueryData<readonly string[]>(collectorKeys.statusOptions(ORG))
    expect(kept).not.toContain('MatureGreen')
    expect(statusOptionsOrDefaults(kept as never).enabled).not.toContain('MatureGreen')
  })

  it('a new device that can’t download the choice offers every status (never an empty picker), without saving that as the organization’s', async () => {
    online(false)
    await expect(load()).rejects.toBeInstanceOf(NotOnDeviceError)
    expect(queryClient.getQueryData(collectorKeys.statusOptions(ORG))).toBeUndefined()
    expect(statusOptionsOrDefaults(undefined)).toEqual({ enabled: ALL_STATUSES, source: 'defaults' })
  })

  it('opened offline, the choice is re-read once when the connection returns', async () => {
    await load()
    const saved = dehydrate(queryClient)
    online(false)
    syncOnlineState()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } })
    client.mount()
    hydrate(client, saved)
    const observer = new QueryObserver(client, mobileStatusOptionsQuery(client, ORG, USER))
    const stop = observer.subscribe(() => {})
    await settle()
    const offline = reads()
    expect(observer.getCurrentResult().data).toEqual(ALL_STATUSES)
    setEnabled('Flower', false) // saved in Settings meanwhile
    online(true)
    onlineManager.setOnline(true)
    await settle()
    expect(reads()).toBe(offline + 1)
    expect(observer.getCurrentResult().data).not.toContain('Flower')
    stop()
    client.unmount()
  })

  it('hidden statuses stay on the canvas exactly as recorded, and the attention clock is unchanged', async () => {
    const before = await queryClient.fetchQuery(rowCanvasQuery(queryClient, ROW, USER))
    const rules = await queryClient.fetchQuery(attentionRulesQuery(queryClient, ORG, USER))
    const clockBefore = [...rowAttention(before.nodes, before.statuses, NOW, rules)].map(([id, a]) => [id, a.clock?.kind])
    setEnabled('Flower', false)
    setEnabled('MatureGreen', false)
    await load()
    const after = await queryClient.fetchQuery({ ...rowCanvasQuery(queryClient, ROW, USER), staleTime: 0 })
    expect(after.statuses.map((s) => [s.plant_node_id, s.status])).toEqual(before.statuses.map((s) => [s.plant_node_id, s.status]))
    expect(after.statuses.map((s) => s.status).sort()).toEqual(['Flower', 'MatureGreen', 'SetFruit'])
    expect([...rowAttention(after.nodes, after.statuses, NOW, rules)].map(([id, a]) => [id, a.clock?.kind])).toEqual(clockBefore)
    expect(clockBefore).toEqual([[nodeId(2), 'overdue']]) // the Mature Green node, still on its 49-day rule
  })
})
