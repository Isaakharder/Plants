// Inputs of the Sets production potential (engine/sets.ts) for one variety,
// loaded as the signed-in user (RLS applies), and their assembly. Nothing
// here is saved: the estimate is recalculated on the page.

import { useQuery } from '@tanstack/react-query'
import type { SamplingWeekRow, SetCohortOutcomeRow, WeeklyNewSetsRow } from '../../lib/database.types'
import { supabase } from '../../lib/supabase'
import { setsPotential, type SetsPotential } from './engine/sets'
import type { EngineAfw } from './engine/types'
import { weekIndex, weekLabel } from './engine/weeks'
import { cohortsFrom, setsWeeks } from './setsInputs'

/** "on" shows the experimental Sets production potential on Harvest Forecast. Off by default (planning estimates, not validated). */
export const SETS_OUTLOOK_ENABLED = import.meta.env.VITE_SETS_OUTLOOK === 'on'

export type SetsOutlookData = {
  newSets: WeeklyNewSetsRow[]
  sampling: SamplingWeekRow[]
  cohorts: SetCohortOutcomeRow[]
  afw: EngineAfw[]
}

const check = <T,>({ data, error }: { data: T | null; error: unknown }): T => {
  if (error) throw error
  return data as T
}

/** The variety's own weekly Sets, sampling coverage, cohort outcomes and AFW for the year (Plants observations only). */
export function useSetsOutlookData(cropId: string, year: number, enabled: boolean) {
  return useQuery({
    queryKey: ['forecast', 'setsPotential', cropId, year] as const,
    enabled,
    queryFn: async (): Promise<SetsOutlookData> => {
      const [newSets, sampling, cohorts, afw] = await Promise.all([
        supabase.rpc('weekly_new_sets', { p_crop_id: cropId, p_year: year }).then(check),
        supabase.rpc('sampling_weeks', { p_crop_id: cropId, p_year: year }).then(check),
        supabase.rpc('set_cohort_outcomes', { p_crop_id: cropId, p_year: year }).then(check),
        supabase.from('weekly_harvest_afw').select('year, week, afw_g').eq('crop_id', cropId).then(check),
      ])
      return { newSets: newSets.map((r) => ({ ...r, sets_per_m2: r.sets_per_m2 === null ? null : Number(r.sets_per_m2) })), sampling, cohorts, afw: afw.map((a) => ({ year: a.year, week: a.week, afwG: Number(a.afw_g) })) }
    },
  })
}

/** The variety's Sets production potential as of its latest sampling week. */
export function buildSetsPotential(
  data: SetsOutlookData,
  areaM2: number,
  year: number,
  originWeek: number,
  currentWeek: number,
  options: { provisionalSurvival?: number; includePossibleCatchup?: boolean } = {},
): SetsPotential {
  return setsPotential({
    cohorts: cohortsFrom(data.cohorts),
    sets: setsWeeks(data.newSets, data.sampling, year, currentWeek),
    originIndex: weekIndex(year, originWeek),
    areaM2,
    afw: data.afw,
    weeksAhead: 9,
    label: (index) => weekLabel(index, year),
    ...options,
  })
}
