import { describe, expect, it } from 'vitest'
import { DEFAULT_ATTENTION_RULES } from '../collector/attention'
import { draftFromRules, rowsFromDraft, sameDraft, validateDraft } from './model'

describe('Mobile attention rules form', () => {
  it('shows the rules as days per status', () => {
    expect(draftFromRules(DEFAULT_ATTENTION_RULES)).toEqual({ NoStatus: '7', Flower: '7', SetFruit: '14', MatureGreen: '49', BreakerFruit: '14' })
    expect(draftFromRules({ Flower: 3 })).toEqual({ NoStatus: '', Flower: '3', SetFruit: '', MatureGreen: '', BreakerFruit: '' })
  })

  it('accepts whole days from 1 to 365, like the database', () => {
    const ok = { NoStatus: '7', Flower: '1', SetFruit: ' 14 ', MatureGreen: '365', BreakerFruit: '14' }
    expect(validateDraft(ok)).toEqual({})
    expect(Object.keys(validateDraft({ NoStatus: '0', Flower: '0', SetFruit: '366', MatureGreen: '7.5', BreakerFruit: '' }))).toEqual(['NoStatus', 'Flower', 'SetFruit', 'MatureGreen', 'BreakerFruit'])
  })

  it('saves one row per rule (No status yet + four statuses) for the organization', () => {
    expect(rowsFromDraft('org', { NoStatus: '5', Flower: '7', SetFruit: '10', MatureGreen: '49', BreakerFruit: '14' })).toEqual([
      { organization_id: 'org', rule_key: 'NoStatus', max_days: 5 },
      { organization_id: 'org', rule_key: 'Flower', max_days: 7 },
      { organization_id: 'org', rule_key: 'SetFruit', max_days: 10 },
      { organization_id: 'org', rule_key: 'MatureGreen', max_days: 49 },
      { organization_id: 'org', rule_key: 'BreakerFruit', max_days: 14 },
    ])
  })

  it('knows when nothing changed', () => {
    const d = draftFromRules(DEFAULT_ATTENTION_RULES)
    expect(sameDraft(d, { ...d, Flower: ' 7 ' })).toBe(true)
    expect(sameDraft(d, { ...d, Flower: '8' })).toBe(false)
  })
})
