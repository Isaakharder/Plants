import { QueryClient, dehydrate, hydrate } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OfflineQueue, memoryStorage } from './offline/offlineQueue'
import { fakeSupabase, type FakeServer } from './testing/fakePostgrest'

// The collector's attention rules: read from node_attention_rules through the
// same offline-aware query as the rest of the collector, and saved with it.
const env = vi.hoisted(() => ({ client: null as unknown as { from: (t: string) => unknown }, queue: null as unknown }))
vi.mock('../../lib/supabase', () => ({
  supabase: { from: (table: string) => env.client.from(table) },
  authStorageKey: 'test-auth-token',
  isSupabaseConfigured: true,
}))
vi.mock('./offline/networkStatus', () => ({ collectorQueue: () => env.queue, triggerSync: async () => {} }))

const { attentionRulesQuery, rulesOrDefaults, NotOnDeviceError, collectorKeys } = await import('./api')
const { DEFAULT_ATTENTION_RULES } = await import('./attention')

const ORG = '0a000000-0000-4000-8000-000000000001'
const OTHER = '0a000000-0000-4000-8000-000000000002'
const USER = '0e000000-0000-4000-8000-000000000001'
const rule = (org: string, rule_key: string, max_days: number) => ({ organization_id: org, rule_key, max_days })
let rows: ReturnType<typeof rule>[]
let server: FakeServer
let queryClient: QueryClient
const online = (on: boolean) => vi.stubGlobal('navigator', { onLine: on })
const load = (client = queryClient) => client.fetchQuery({ ...attentionRulesQuery(client, ORG, USER), staleTime: 0 })

beforeEach(() => {
  rows = [rule(ORG, 'Flower', 7), rule(ORG, 'SetFruit', 14), rule(ORG, 'MatureGreen', 49), rule(ORG, 'BreakerFruit', 14), rule(ORG, 'NoStatus', 7), rule(OTHER, 'Flower', 2)]
  server = { maxRows: 1000, requests: {} }
  env.client = fakeSupabase({ node_attention_rules: rows }, server)
  env.queue = new OfflineQueue(memoryStorage(), () => crypto.randomUUID())
  online(true)
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})
afterEach(() => vi.unstubAllGlobals())

describe('mobile attention rules', () => {
  it('loads the organization’s rules (and only its own) in one request', async () => {
    expect(await load()).toEqual({ NoStatus: 7, Flower: 7, SetFruit: 14, MatureGreen: 49, BreakerFruit: 14 })
    expect(server.requests.node_attention_rules).toBe(1)
  })

  it('a changed Settings value reaches the phone on its next sync', async () => {
    await load()
    rows[1].max_days = 10
    rows[4].max_days = 3 // No status yet
    expect(await load()).toMatchObject({ SetFruit: 10, NoStatus: 3 })
  })

  it('offline, the last downloaded rules apply, even after a reload, never the defaults', async () => {
    rows[2].max_days = 60
    rows[4].max_days = 5
    await load()
    // The app is closed and reopened with no signal: the saved cache is restored.
    const saved = dehydrate(queryClient)
    const reopened = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    hydrate(reopened, saved)
    online(false)
    rows[2].max_days = 30 // changed on the server meanwhile; the phone can't know yet
    rows[4].max_days = 20
    const offline = await load(reopened)
    expect(offline).toMatchObject({ MatureGreen: 60, NoStatus: 5 })
    expect(rulesOrDefaults(offline)).toEqual({ rules: offline, source: 'organization' })
    expect(server.requests.node_attention_rules).toBe(1)
    // A failing connection (not just "offline") also keeps them.
    online(true)
    env.client = fakeSupabase({ node_attention_rules: rows }, { ...server, failRequest: { table: 'node_attention_rules', nth: 2 } })
    expect(await load(reopened)).toMatchObject({ MatureGreen: 60 })
  })

  it('a new device with no signal uses the documented defaults, without saving them as the organization’s', async () => {
    online(false)
    await expect(load()).rejects.toBeInstanceOf(NotOnDeviceError)
    expect(queryClient.getQueryData(collectorKeys.attentionRules(ORG))).toBeUndefined()
    expect(rulesOrDefaults(undefined)).toEqual({ rules: DEFAULT_ATTENTION_RULES, source: 'defaults' })
    expect(DEFAULT_ATTENTION_RULES).toEqual({ NoStatus: 7, Flower: 7, SetFruit: 14, MatureGreen: 49, BreakerFruit: 14 })
    // First successful sync replaces them.
    online(true)
    rows[0].max_days = 5
    expect(rulesOrDefaults(await load()).rules).toMatchObject({ Flower: 5 })
  })
})
