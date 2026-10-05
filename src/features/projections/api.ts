import { useQuery } from '@tanstack/react-query'
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
