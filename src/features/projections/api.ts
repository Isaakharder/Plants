import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { normalizeFruitLoss, normalizeWeek, type SetHarvestCohortRow, type WeeklyFruitLossRow, type WeeklyPlantDataRow } from './model'

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

/** Fruit Loss % for every ISO week of the year (weekly_fruit_loss), in a single request. */
export function useWeeklyFruitLoss(cropId: string | undefined, year: number | undefined) {
  return useQuery({
    queryKey: ['projections', 'weeklyFruitLoss', cropId, year] as const,
    enabled: Boolean(cropId && year),
    queryFn: async (): Promise<WeeklyFruitLossRow[]> => {
      const { data, error } = await supabase.rpc('weekly_fruit_loss', { p_crop_id: cropId!, p_year: year! })
      if (error) throw error
      return data.map(normalizeFruitLoss)
    },
  })
}

// ── Manual AFW per harvest week (weekly_harvest_afw) ───────────────────────
// AFW for week W = average grams per pepper harvested in week W.

const afwKey = (cropId: string | undefined, year: number | undefined) => ['projections', 'afw', cropId, year] as const

/** The crop's saved AFW (average grams per pepper harvested that week) for each week of the year. */
export function useWeeklyHarvestAfw(cropId: string | undefined, year: number | undefined) {
  return useQuery({
    queryKey: afwKey(cropId, year),
    enabled: Boolean(cropId && year),
    queryFn: async (): Promise<Map<number, number>> => {
      const { data, error } = await supabase.from('weekly_harvest_afw').select('week, afw_g').eq('crop_id', cropId!).eq('year', year!)
      if (error) throw error
      return new Map(data.map((r) => [r.week, Number(r.afw_g)]))
    },
  })
}

export type AfwChange = { week: number; afwG: number | null }

/** Saves changed AFWs in one go: new and edited values are upserted, cleared ones removed. */
export async function saveWeeklyHarvestAfw(organizationId: string, cropId: string, year: number, changes: AfwChange[]): Promise<void> {
  const upserts = changes.filter((c) => c.afwG !== null).map((c) => ({ organization_id: organizationId, crop_id: cropId, year, week: c.week, afw_g: c.afwG! }))
  const cleared = changes.filter((c) => c.afwG === null).map((c) => c.week)
  if (upserts.length) {
    const { error } = await supabase.from('weekly_harvest_afw').upsert(upserts, { onConflict: 'crop_id,year,week' })
    if (error) throw new Error(error.message)
  }
  if (cleared.length) {
    const { error } = await supabase.from('weekly_harvest_afw').delete().eq('crop_id', cropId).eq('year', year).in('week', cleared)
    if (error) throw new Error(error.message)
  }
}

export function useSaveWeeklyHarvestAfw(organizationId: string, cropId: string | undefined, year: number | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (changes: AfwChange[]) => saveWeeklyHarvestAfw(organizationId, cropId!, year!, changes),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: afwKey(cropId, year) }),
  })
}
