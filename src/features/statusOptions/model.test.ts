import { describe, expect, it, vi } from 'vitest'
import { ALL_STATUSES } from '../collector/statusOptions'
import { draftFromEnabled, enabledCount, rowsFromStatusDraft, sameStatusDraft, validateStatusDraft } from './model'

const upsert = vi.hoisted(() => vi.fn())
const from = vi.hoisted(() => vi.fn(() => ({ upsert })))
vi.mock('../../lib/supabase', () => ({ supabase: { from }, authStorageKey: 'test-auth-token', isSupabaseConfigured: true }))
const { saveMobileStatusOptions } = await import('./api')

describe('Settings › Mobile status options', () => {
  it('starts from the saved choice', () => {
    const draft = draftFromEnabled(['Aborted', 'Pruned', 'SetFruit', 'BreakerFruit', 'Harvested'])
    expect(draft).toEqual({ Aborted: true, Pruned: true, Flower: false, SetFruit: true, MatureGreen: false, BreakerFruit: true, Harvested: true })
    expect(enabledCount(draft)).toBe(5)
    expect(sameStatusDraft(draft, draftFromEnabled(ALL_STATUSES))).toBe(false)
  })

  it('rejects a choice with no status at all', () => {
    const none = Object.fromEntries(ALL_STATUSES.map((s) => [s, false])) as ReturnType<typeof draftFromEnabled>
    expect(validateStatusDraft(none)).toBe('Keep at least one status available.')
    expect(validateStatusDraft({ ...none, Harvested: true })).toBeNull()
  })

  it('saves every status explicitly, in one upsert by (organization, status)', async () => {
    upsert.mockResolvedValue({ error: null })
    await saveMobileStatusOptions('org', draftFromEnabled(['Aborted', 'Pruned', 'SetFruit', 'BreakerFruit', 'Harvested']))
    expect(from).toHaveBeenCalledWith('mobile_status_options')
    expect(upsert).toHaveBeenCalledTimes(1)
    const [rows, options] = upsert.mock.calls[0]
    expect(options).toEqual({ onConflict: 'organization_id,status' })
    expect(rows).toEqual([
      { organization_id: 'org', status: 'Aborted', enabled: true },
      { organization_id: 'org', status: 'Pruned', enabled: true },
      { organization_id: 'org', status: 'Flower', enabled: false },
      { organization_id: 'org', status: 'SetFruit', enabled: true },
      { organization_id: 'org', status: 'MatureGreen', enabled: false },
      { organization_id: 'org', status: 'BreakerFruit', enabled: true },
      { organization_id: 'org', status: 'Harvested', enabled: true },
    ])
    expect(rowsFromStatusDraft('org', draftFromEnabled(ALL_STATUSES)).every((r) => r.enabled)).toBe(true)
  })

  it('reports a refused save (not an owner, or the database refusing zero statuses)', async () => {
    upsert.mockResolvedValue({ error: { message: 'At least one mobile status must stay enabled.' } })
    await expect(saveMobileStatusOptions('org', draftFromEnabled(['Harvested']))).rejects.toThrow('At least one mobile status')
  })
})
