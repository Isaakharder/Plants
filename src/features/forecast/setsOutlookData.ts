// Inputs of the Sets production potential (engine/sets.ts) for one variety,
// loaded as the signed-in user (RLS applies), and their assembly. Nothing
// here is saved: the estimate is recalculated on the page.

import { useQuery } from '@tanstack/react-query'
import type { PepperTypeRow, SamplingWeekRow, SetCohortOutcomeRow, WeeklyNewSetsRow } from '../../lib/database.types'
import type { Crop } from '../crops/model'
import { supabase } from '../../lib/supabase'
import { setsPotential, type ModelGroup, type SetsPotential, type VarietyOverrides } from './engine/sets'
import type { EngineAfw } from './engine/types'
import { weekIndex, weekLabel } from './engine/weeks'
import { cohortsFrom, modelGroupFrom, setsWeeks, typeCohortsFrom } from './setsInputs'

/** "on" shows the experimental Sets production potential on Harvest Forecast. Off by default (planning estimates, not validated). */
export const SETS_OUTLOOK_ENABLED = import.meta.env.VITE_SETS_OUTLOOK === 'on'

export type SetsOutlookData = {
  crop: { id: string; pepperTypeId: string; overrides: VarietyOverrides }
  group: ModelGroup
  newSets: WeeklyNewSetsRow[]
  sampling: SamplingWeekRow[]
  cohorts: SetCohortOutcomeRow[]
  /** Cohorts of every variety of the same pepper type: loaded only when the type allows pooling. */
  typeCohorts: (SetCohortOutcomeRow & { crop_id: string; pepper_type_id: string })[]
  afw: EngineAfw[]
}

const check = <T,>({ data, error }: { data: T | null; error: unknown }): T => {
  if (error) throw error
  return data as T
}

/**
 * The variety's own weekly Sets, sampling coverage, cohort outcomes and AFW
 * for the year (Plants observations only), and its pepper type's model
 * group. Cohorts of other varieties come only from
 * pepper_type_cohort_outcomes for the variety's own type, and only when the
 * type allows pooling.
 */
export function useSetsOutlookData(cropId: string, year: number, enabled: boolean) {
  return useQuery({
    queryKey: ['forecast', 'setsPotential', cropId, year] as const,
    enabled,
    queryFn: async (): Promise<SetsOutlookData> => {
      const crop = check(
        await supabase.from('crops').select('id, pepper_type_id, sets_provisional_survival, sets_provisional_timing').eq('id', cropId).single(),
      ) as Pick<Crop, 'id' | 'pepper_type_id' | 'sets_provisional_survival' | 'sets_provisional_timing'>
      const type = check(await supabase.from('pepper_types').select('*').eq('id', crop.pepper_type_id).single()) as PepperTypeRow
      const group = modelGroupFrom(type)
      const [newSets, sampling, cohorts, afw, typeCohorts] = await Promise.all([
        supabase.rpc('weekly_new_sets', { p_crop_id: cropId, p_year: year }).then(check),
        supabase.rpc('sampling_weeks', { p_crop_id: cropId, p_year: year }).then(check),
        supabase.rpc('set_cohort_outcomes', { p_crop_id: cropId, p_year: year }).then(check),
        supabase.from('weekly_harvest_afw').select('year, week, afw_g').eq('crop_id', cropId).then(check),
        group.poolWithinType ? supabase.rpc('pepper_type_cohort_outcomes', { p_pepper_type_id: group.pepperTypeId, p_year: year }).then(check) : Promise.resolve([]),
      ])
      return {
        crop: {
          id: crop.id,
          pepperTypeId: crop.pepper_type_id,
          overrides: {
            provisionalSurvival: crop.sets_provisional_survival === null ? null : Number(crop.sets_provisional_survival),
            provisionalTiming: crop.sets_provisional_timing?.map(Number) ?? null,
          },
        },
        group,
        newSets: newSets.map((r) => ({ ...r, sets_per_m2: r.sets_per_m2 === null ? null : Number(r.sets_per_m2) })),
        sampling,
        cohorts,
        typeCohorts,
        afw: afw.map((a) => ({ year: a.year, week: a.week, afwG: Number(a.afw_g) })),
      }
    },
  })
}

/** The variety's Sets production potential as of its latest sampling week, within its pepper type's model group. */
export function buildSetsPotential(
  data: SetsOutlookData,
  areaM2: number,
  year: number,
  originWeek: number,
  currentWeek: number,
  options: { provisionalSurvival?: number; includePossibleCatchup?: boolean } = {},
): SetsPotential {
  return setsPotential({
    cohorts: cohortsFrom(data.cohorts, data.crop.id, data.crop.pepperTypeId),
    typeCohorts: typeCohortsFrom(data.typeCohorts),
    group: data.group,
    overrides: data.crop.overrides,
    sets: setsWeeks(data.newSets, data.sampling, year, currentWeek),
    originIndex: weekIndex(year, originWeek),
    areaM2,
    afw: data.afw,
    weeksAhead: 9,
    label: (index) => weekLabel(index, year),
    ...options,
  })
}
