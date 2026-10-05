import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { normalizeWeek, type SetHarvestCohortRow, type WeeklyPlantDataRow } from './model'

/**
 * The whole ISO year for one variety in a single request, calculated in the
 * database (weekly_plant_data) as the signed-in user, so RLS applies.
 */
export function useWeeklyPlantData(cropId: string | undefined, year: number | undefined) {
  return useQuery({
    queryKey: ['projections', 'weeklyPlantData', cropId, year] as const,
    enabled: Boolean(cropId && year),
    queryFn: async (): Promise<WeeklyPlantDataRow[]> => {
      const { data, error } = await supabase.rpc('weekly_plant_data', { p_crop_id: cropId!, p_year: year! })
      if (error) throw error
      return data.map(normalizeWeek)
    },
  })
}

/**
 * Set → Harvest cohorts for the whole ISO year, one row per harvest week with
 * its delay cells nested (set_harvest_cohorts), in a single request.
 */
export function useSetHarvestCohorts(cropId: string | undefined, year: number | undefined) {
  return useQuery({
    queryKey: ['projections', 'setHarvestCohorts', cropId, year] as const,
    enabled: Boolean(cropId && year),
    queryFn: async (): Promise<SetHarvestCohortRow[]> => {
      const { data, error } = await supabase.rpc('set_harvest_cohorts', { p_crop_id: cropId!, p_year: year! })
      if (error) throw error
      return data
    },
  })
}

// ── Manual AFW per set-week cohort (cohort_afw) ────────────────────────────

const afwKey = (cropId: string | undefined, year: number | undefined) => ['projections', 'afw', cropId, year] as const

/** The crop's saved AFW (grams per fruit) for each set week of the year. */
export function useCohortAfw(cropId: string | undefined, year: number | undefined) {
  return useQuery({
    queryKey: afwKey(cropId, year),
    enabled: Boolean(cropId && year),
    queryFn: async (): Promise<Map<number, number>> => {
      const { data, error } = await supabase.from('cohort_afw').select('set_week, afw_g').eq('crop_id', cropId!).eq('set_year', year!)
      if (error) throw error
      return new Map(data.map((r) => [r.set_week, Number(r.afw_g)]))
    },
  })
}

export type AfwChange = { setWeek: number; afwG: number | null }

/** Saves changed AFWs in one go: new and edited values are upserted, cleared ones removed. */
export async function saveCohortAfw(organizationId: string, cropId: string, year: number, changes: AfwChange[]): Promise<void> {
  const upserts = changes.filter((c) => c.afwG !== null).map((c) => ({ organization_id: organizationId, crop_id: cropId, set_year: year, set_week: c.setWeek, afw_g: c.afwG! }))
  const cleared = changes.filter((c) => c.afwG === null).map((c) => c.setWeek)
  if (upserts.length) {
    const { error } = await supabase.from('cohort_afw').upsert(upserts, { onConflict: 'crop_id,set_year,set_week' })
    if (error) throw new Error(error.message)
  }
  if (cleared.length) {
    const { error } = await supabase.from('cohort_afw').delete().eq('crop_id', cropId).eq('set_year', year).in('set_week', cleared)
    if (error) throw new Error(error.message)
  }
}

export function useSaveCohortAfw(organizationId: string, cropId: string | undefined, year: number | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (changes: AfwChange[]) => saveCohortAfw(organizationId, cropId!, year!, changes),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: afwKey(cropId, year) }),
  })
}
