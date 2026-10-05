import { QueryClient, dehydrate } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NodeStatus, RowCanvasData } from './types'
import { OfflineQueue, memoryStorage } from './offline/offlineQueue'
import { fakeSupabase, shuffled, type FakeServer } from './testing/fakePostgrest'

// The collector's real loading path (rowCanvasQuery → fetchRowCanvas) runs
// against a fake PostgREST that, like Supabase, returns at most 1,000 records
// per request.
const env = vi.hoisted(() => ({ client: null as unknown as { from: (t: string) => unknown }, queue: null as unknown }))
vi.mock('../../lib/supabase', () => ({
  supabase: { from: (table: string) => env.client.from(table) },
  authStorageKey: 'test-auth-token',
  isSupabaseConfigured: true,
}))
vi.mock('./offline/networkStatus', () => ({
  collectorQueue: () => env.queue,
  triggerSync: async () => {},
}))

const { rowCanvasQuery, NotOnDeviceError } = await import('./api')

// ── A row with 2,345 nodes (three 1,000-record pages) ──────────────────────

const ORG = '0a000000-0000-4000-8000-000000000001'
const CROP = '0c000000-0000-4000-8000-000000000001'
const ROW = '0d000000-0000-4000-8000-000000000001'
const OTHER_ROW = '0d000000-0000-4000-8000-000000000002'
const USER = '0e000000-0000-4000-8000-000000000001'
const uuid = (prefix: string, n: number) => `${prefix}000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const STATUSES: NodeStatus[] = ['Aborted', 'Pruned', 'Flower', 'SetFruit', 'MatureGreen', 'BreakerFruit', 'Harvested']

const NODE_COUNT = 2345
const STEM_COUNT = 25
const WEEKS = 48 // 25 stems × 48 weeks = 1,200 growth readings
// Node n has id order n, so nodes 1–1000 are page 1, 1001–2000 page 2, 2001–2345 page 3.
// Side shoots straddle both page boundaries, with parents on the other page.
const SHOOTS: Record<number, number> = { 999: 1004, 1000: 1003, 1001: 997, 1002: 996, 2000: 2002, 2001: 1998 }
const PARENTS = new Set(Object.values(SHOOTS))

function buildDatabase() {
  const stemId = (i: number) => uuid('1a', i)
  const nodeId = (n: number) => uuid('2b', n)
  const stemOf = (n: number): number => (SHOOTS[n] ? stemOf(SHOOTS[n]) : n % STEM_COUNT)
  const stems = Array.from({ length: STEM_COUNT }, (_, i) => ({
    id: stemId(i), organization_id: ORG, crop_id: CROP, measurement_row_id: ROW, stem_name: `Stem ${i + 1}`, sort_order: i + 1, is_active: true,
    created_by: USER, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  }))
  const nodes = Array.from({ length: NODE_COUNT }, (_, i) => {
    const n = i + 1
    const parent = SHOOTS[n]
    const nodeNumber = parent ?? Math.floor(n / STEM_COUNT) + 1
    return {
      id: nodeId(n), organization_id: ORG, crop_id: CROP, measurement_stem_id: stemId(stemOf(n)),
      node_number: nodeNumber, sort_order: nodeNumber,
      is_side_shoot: Boolean(parent), parent_node_id: parent ? nodeId(parent) : null, node_label: parent ? `${nodeNumber}+1` : null, side: parent ? 'right' : null,
      is_active: true, created_by: USER, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      measurement_stems: { measurement_row_id: ROW },
    }
  })
  // Every node has a latest status (node_latest_statuses: one record per node).
  const latest = nodes.map((node, i) => ({
    id: uuid('3c', i + 1), plant_node_id: node.id, measurement_row_id: ROW, measurement_stem_id: node.measurement_stem_id,
    year: 2026, week_number: 1 + (i % 40), status: STATUSES[i % STATUSES.length], observed_at: '2026-06-01T12:00:00Z',
  }))
  const growth = stems.flatMap((stem, s) =>
    Array.from({ length: WEEKS }, (_, w) => ({
      id: uuid('4d', s * WEEKS + w + 1), organization_id: ORG, crop_id: CROP, measurement_stem_id: stem.id, year: 2026, week_number: w + 1,
      growth_cm: '5.50', top_node_number: w + 1, notes: null, observed_at: '2026-06-01T12:00:00Z', created_by: USER,
      created_at: '2026-06-01T12:00:00Z', updated_at: '2026-06-01T12:00:00Z', measurement_stems: { measurement_row_id: ROW },
    })),
  )
  // Another row's data must never leak in.
  const otherStem = { ...stems[0], id: uuid('1a', 999), measurement_row_id: OTHER_ROW }
  const otherNode = { ...nodes[0], id: uuid('2b', 99999), measurement_stem_id: otherStem.id, measurement_stems: { measurement_row_id: OTHER_ROW } }
  return {
    tables: {
      measurement_rows: [
        { id: ROW, organization_id: ORG, crop_id: CROP, row_name: 'Row 1', sort_order: 1, is_active: true, created_by: USER, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
        { id: OTHER_ROW, organization_id: ORG, crop_id: CROP, row_name: 'Row 2', sort_order: 2, is_active: true, created_by: USER, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
      ],
      measurement_stems: shuffled([...stems, otherStem]),
      plant_nodes: shuffled([...nodes, otherNode]),
      node_latest_statuses: shuffled([...latest, { ...latest[0], id: uuid('3c', 99999), plant_node_id: otherNode.id, measurement_row_id: OTHER_ROW }]),
      stem_growth_measurements: shuffled(growth),
    },
    expected: { stems, nodes, latest, growth, nodeId },
  }
}

const db = buildDatabase()
let server: FakeServer
let queryClient: QueryClient

beforeEach(() => {
  server = { maxRows: 1000, requests: {} }
  env.client = fakeSupabase(db.tables, server)
  env.queue = new OfflineQueue(memoryStorage(), () => crypto.randomUUID())
  vi.stubGlobal('navigator', { onLine: true })
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})
afterEach(() => vi.unstubAllGlobals())

const load = () => queryClient.fetchQuery(rowCanvasQuery(queryClient, ROW, USER)) as Promise<RowCanvasData>

describe('row canvas loading with more than 1,000 nodes', () => {
  it('loads every node of the row across three pages, with no duplicates and nothing from other rows', async () => {
    const data = await load()
    expect(server.requests.plant_nodes).toBe(3)
    expect(data.nodes).toHaveLength(NODE_COUNT)
    expect(new Set(data.nodes.map((n) => n.id)).size).toBe(NODE_COUNT)
    expect(new Set(data.nodes.map((n) => n.id))).toEqual(new Set(db.expected.nodes.map((n) => n.id)))
    expect(data.nodes.every((n) => !('measurement_stems' in n))).toBe(true)
  })

  it('keeps side shoots and their parents together across page boundaries', async () => {
    const data = await load()
    const byId = new Map(data.nodes.map((n) => [n.id, n]))
    for (const [shoot, parent] of Object.entries(SHOOTS)) {
      const node = byId.get(db.expected.nodeId(Number(shoot)))
      expect(node, `shoot ${shoot}`).toMatchObject({ is_side_shoot: true, parent_node_id: db.expected.nodeId(parent) })
      const parentNode = byId.get(db.expected.nodeId(parent))
      expect(parentNode, `parent of ${shoot}`).toMatchObject({ is_side_shoot: false, measurement_stem_id: node!.measurement_stem_id })
    }
    expect(data.nodes.filter((n) => n.is_side_shoot)).toHaveLength(Object.keys(SHOOTS).length)
    expect([...PARENTS].every((p) => byId.has(db.expected.nodeId(p)))).toBe(true)
  })

  it('loads the latest status of every node (more than 1,000), each matching its node', async () => {
    const data = await load()
    expect(server.requests.node_latest_statuses).toBe(3)
    expect(data.statuses).toHaveLength(NODE_COUNT)
    const expected = new Map(db.expected.latest.map((s) => [s.plant_node_id, s]))
    for (const status of data.statuses) {
      expect(status).toMatchObject({ status: expected.get(status.plant_node_id)!.status, week_number: expected.get(status.plant_node_id)!.week_number })
    }
    // Including the shoots on the page boundaries.
    const statusOf = new Map(data.statuses.map((s) => [s.plant_node_id, s.status]))
    for (const shoot of Object.keys(SHOOTS)) expect(statusOf.has(db.expected.nodeId(Number(shoot)))).toBe(true)
  })

  it('loads every growth reading (1,200) and every stem', async () => {
    const data = await load()
    expect(server.requests.stem_growth_measurements).toBe(2)
    expect(data.growth).toHaveLength(STEM_COUNT * WEEKS)
    expect(new Set(data.growth.map((g) => g.id)).size).toBe(STEM_COUNT * WEEKS)
    expect(data.growth.every((g) => g.growth_cm === 5.5)).toBe(true)
    expect(data.stems).toHaveLength(STEM_COUNT)
  })

  it('still loads everything when the server allows fewer than 1,000 records per request', async () => {
    server.maxRows = 300
    const data = await load()
    expect(data.nodes).toHaveLength(NODE_COUNT)
    expect(data.statuses).toHaveLength(NODE_COUNT)
    expect(data.growth).toHaveLength(STEM_COUNT * WEEKS)
    expect(server.requests.plant_nodes).toBe(Math.ceil(NODE_COUNT / 300))
  })

  it('saves the complete row for offline use', async () => {
    await load()
    // queryPersistence.ts saves exactly this dehydrated state to IndexedDB.
    const saved = dehydrate(queryClient).queries.find((q) => q.queryKey[2] === ROW)!.state.data as RowCanvasData
    expect(saved.nodes).toHaveLength(NODE_COUNT)
    expect(saved.statuses).toHaveLength(NODE_COUNT)
    expect(saved.growth).toHaveLength(STEM_COUNT * WEEKS)
  })

  it('never keeps a partial row when a later page fails: it falls back to the last complete copy', async () => {
    await load()
    server.requests = {}
    server.failRequest = { table: 'plant_nodes', nth: 2 } // page 2 of 3 drops
    const data = await queryClient.fetchQuery({ ...rowCanvasQuery(queryClient, ROW, USER), staleTime: 0 }) as RowCanvasData
    expect(server.requests.plant_nodes).toBe(2)
    expect(data.nodes).toHaveLength(NODE_COUNT)
  })

  it('with no complete copy on the device, reports the row as unavailable instead of showing part of it', async () => {
    server.failRequest = { table: 'plant_nodes', nth: 2 }
    await expect(load()).rejects.toBeInstanceOf(NotOnDeviceError)
  })
})
