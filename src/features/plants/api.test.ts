import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { fakeSupabase, shuffled } from '../collector/testing/fakePostgrest'

// The Plants page's row query against a fake PostgREST that, like Supabase,
// returns at most 1,000 records per request.
const env = vi.hoisted(() => ({ client: null as unknown as { from: (t: string) => unknown } }))
vi.mock('../../lib/supabase', () => ({
  supabase: { from: (table: string) => env.client.from(table) },
  authStorageKey: 'test-auth-token',
  isSupabaseConfigured: true,
}))

const { plantsRowQuery } = await import('./api')

const ROW = '0d000000-0000-4000-8000-000000000001'
const uuid = (p: string, n: number) => `${p}000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

describe('Plants row loading', () => {
  it('loads every node, status and growth reading of a row larger than 1,000 nodes', async () => {
    const stems = Array.from({ length: 14 }, (_, i) => ({ id: uuid('1a', i), measurement_row_id: ROW, is_active: true, sort_order: i + 1, stem_name: `Stem ${i + 1}` }))
    const nodes = Array.from({ length: 1500 }, (_, i) => ({ id: uuid('2b', i + 1), measurement_stem_id: stems[i % 14].id, node_number: Math.floor(i / 14) + 1, is_active: true, measurement_stems: { measurement_row_id: ROW } }))
    const statuses = nodes.map((n, i) => ({ id: uuid('3c', i + 1), plant_node_id: n.id, measurement_row_id: ROW, year: 2026, week_number: 40, status: 'SetFruit', observed_at: '2026-10-01T12:00:00Z' }))
    const growth = Array.from({ length: 1100 }, (_, i) => ({ id: uuid('4d', i + 1), measurement_stem_id: stems[i % 14].id, growth_cm: '8.0', year: 2026, week_number: 1 + (i % 52), measurement_stems: { measurement_row_id: ROW } }))
    const server = { maxRows: 1000, requests: {} as Record<string, number> }
    env.client = fakeSupabase(
      {
        measurement_rows: [{ id: ROW, row_name: 'Row 1' }],
        measurement_stems: shuffled(stems),
        plant_nodes: shuffled(nodes),
        node_latest_statuses: shuffled(statuses),
        stem_growth_measurements: shuffled(growth),
      },
      server,
    )
    const data = await new QueryClient().fetchQuery(plantsRowQuery(ROW))
    expect(data.nodes).toHaveLength(1500)
    expect(new Set(data.nodes.map((n) => n.id)).size).toBe(1500)
    expect(data.statuses).toHaveLength(1500)
    expect(data.growth).toHaveLength(1100)
    expect(data.stems).toHaveLength(14)
    expect(server.requests.plant_nodes).toBe(2)
  })

  it('always refetches: on open, on focus, never served stale', () => {
    expect(plantsRowQuery(ROW)).toMatchObject({ staleTime: 0, refetchOnMount: 'always', refetchOnWindowFocus: 'always' })
  })
})
