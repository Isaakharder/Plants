import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { collectorKeys, fetchMobileStatusOptions } from '../collector/api'
import { rowsFromStatusDraft, type StatusDraft } from './model'

const settingsKey = (organizationId: string) => ['mobileStatusOptions', organizationId] as const

/** The organization's mobile status options, for Settings. */
export function useMobileStatusOptionSettings(organizationId: string) {
  return useQuery({ queryKey: settingsKey(organizationId), queryFn: () => fetchMobileStatusOptions(organizationId) })
}

/** Saves every status in one request (owners only; the database enforces it and keeps at least one enabled). */
export async function saveMobileStatusOptions(organizationId: string, draft: StatusDraft): Promise<void> {
  const { error } = await supabase.from('mobile_status_options').upsert(rowsFromStatusDraft(organizationId, draft), { onConflict: 'organization_id,status' })
  if (error) throw new Error(error.message)
}

/** Saves the form and refreshes the options wherever they're used. */
export function useSaveMobileStatusOptions(organizationId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (draft: StatusDraft) => saveMobileStatusOptions(organizationId, draft),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: settingsKey(organizationId) }),
        // A collector open in this browser picks the change up straight away; phones on their next sync.
        queryClient.invalidateQueries({ queryKey: collectorKeys.statusOptions(organizationId) }),
      ]),
  })
}
