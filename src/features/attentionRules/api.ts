import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { collectorKeys, fetchAttentionRules } from '../collector/api'
import { rowsFromDraft, type RuleDraft } from './model'

const settingsKey = (organizationId: string) => ['attentionRules', organizationId] as const

/** The organization's mobile attention rules, for Settings. */
export function useAttentionRuleSettings(organizationId: string) {
  return useQuery({ queryKey: settingsKey(organizationId), queryFn: () => fetchAttentionRules(organizationId) })
}

/** Saves every rule in one request, updating the existing rows (owners only; the database enforces it). */
export async function saveAttentionRules(organizationId: string, draft: RuleDraft): Promise<void> {
  const { error } = await supabase.from('node_attention_rules').upsert(rowsFromDraft(organizationId, draft), { onConflict: 'organization_id,rule_key' })
  if (error) throw new Error(error.message)
}

/** Saves the form and refreshes the rules wherever they're shown. */
export function useSaveAttentionRules(organizationId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (draft: RuleDraft) => saveAttentionRules(organizationId, draft),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: settingsKey(organizationId) }),
        // A collector open in this browser picks the change up straight away; phones on their next sync.
        queryClient.invalidateQueries({ queryKey: collectorKeys.attentionRules(organizationId) }),
      ]),
  })
}
