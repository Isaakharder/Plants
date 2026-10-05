import { describe, expect, it, vi } from 'vitest'

const upsert = vi.hoisted(() => vi.fn())
const from = vi.hoisted(() => vi.fn(() => ({ upsert })))
vi.mock('../../lib/supabase', () => ({ supabase: { from }, authStorageKey: 'test-auth-token', isSupabaseConfigured: true }))

const { saveAttentionRules } = await import('./api')

describe('saving Mobile attention rules', () => {
  it('updates the five existing rows by (organization, rule key) in one request', async () => {
    upsert.mockResolvedValue({ error: null })
    await saveAttentionRules('org', { NoStatus: '2', Flower: '7', SetFruit: '14', MatureGreen: '49', BreakerFruit: '14' })
    expect(from).toHaveBeenCalledWith('node_attention_rules')
    expect(upsert).toHaveBeenCalledTimes(1)
    const [rows, options] = upsert.mock.calls[0]
    expect(options).toEqual({ onConflict: 'organization_id,rule_key' })
    expect(rows).toEqual([
      { organization_id: 'org', rule_key: 'NoStatus', max_days: 2 },
      { organization_id: 'org', rule_key: 'Flower', max_days: 7 },
      { organization_id: 'org', rule_key: 'SetFruit', max_days: 14 },
      { organization_id: 'org', rule_key: 'MatureGreen', max_days: 49 },
      { organization_id: 'org', rule_key: 'BreakerFruit', max_days: 14 },
    ])
  })

  it('reports a refused save (e.g. not an owner)', async () => {
    upsert.mockResolvedValue({ error: { message: 'new row violates row-level security policy' } })
    await expect(saveAttentionRules('org', { NoStatus: '7', Flower: '7', SetFruit: '14', MatureGreen: '49', BreakerFruit: '14' })).rejects.toThrow('row-level security')
  })
})
