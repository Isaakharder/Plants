import { RULE_KEYS, type AttentionRules } from '../collector/attention'

// Settings › Mobile attention rules: form values ↔ rules, validated the same
// way the database checks them (whole days, 1–365).

export type RuleKey = (typeof RULE_KEYS)[number]
export type RuleDraft = Record<RuleKey, string>

export const RULE_LABELS: Record<RuleKey, string> = {
  NoStatus: 'No status yet',
  Flower: 'Flower',
  SetFruit: 'Set Fruit',
  MatureGreen: 'Mature Green',
  BreakerFruit: 'Breaker',
}

export const MIN_DAYS = 1
export const MAX_DAYS = 365

export const draftFromRules = (rules: AttentionRules): RuleDraft =>
  Object.fromEntries(RULE_KEYS.map((s) => [s, rules[s] == null ? '' : String(rules[s])])) as RuleDraft

/** An error message per invalid field (none = valid). */
export function validateDraft(draft: RuleDraft): Partial<Record<RuleKey, string>> {
  const errors: Partial<Record<RuleKey, string>> = {}
  for (const s of RULE_KEYS) {
    const v = draft[s].trim()
    if (!/^\d+$/.test(v) || Number(v) < MIN_DAYS || Number(v) > MAX_DAYS) errors[s] = `Enter whole days, ${MIN_DAYS}–${MAX_DAYS}.`
  }
  return errors
}

/** Rows to save for a valid draft. */
export const rowsFromDraft = (organizationId: string, draft: RuleDraft) =>
  RULE_KEYS.map((rule_key) => ({ organization_id: organizationId, rule_key, max_days: Number(draft[rule_key].trim()) }))

export const sameDraft = (a: RuleDraft, b: RuleDraft) => RULE_KEYS.every((s) => a[s].trim() === b[s].trim())
