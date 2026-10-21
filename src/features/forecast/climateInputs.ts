// Projection climate inputs for a variety: the same combined values the
// Climate page shows (crop_climate_daily, rolled up by weeklyClimate), as they
// stood at a cutoff. Used by nothing in the engine yet: climate does not
// change any forecast until climate-to-yield relationships are approved.
//
// Guarantees for when it is wired in:
//   * same calculation as the Climate page (no second averaging of zones);
//   * radiation counted once (greenhouse-wide), cumulative values from their 23:00 reading;
//   * missing values stay null (never 0), with hours / final-day counts;
//   * as of the cutoff: no later files, review decisions or zone changes;
//   * to keep a locked forecast reproducible, store the returned inputs with it.

import type { Db } from './data'
import { VARIETY_METRICS, normalizeDay, weeklyClimate, type ClimateWeek, type VarietyDay, type VarietyMetric } from '../climate/varietyClimate'

export type ClimateInputs = {
  cropId: string
  from: string
  to: string
  /** The moment the inputs reflect (ISO); also bounds the hours used. */
  asOf: string
  weeks: Record<VarietyMetric, ClimateWeek[]>
}

export async function loadClimateInputs(db: Db, cropId: string, from: string, to: string, asOf: string): Promise<ClimateInputs> {
  const res = await db.rpc('crop_climate_daily', { p_crop_id: cropId, p_from: from, p_to: to, p_as_of: asOf })
  if (res.error) throw new Error(res.error.message)
  const days = (res.data as VarietyDay[]).map(normalizeDay)
  const weeks = Object.fromEntries(VARIETY_METRICS.map((m) => [m.key, weeklyClimate(days, m.key)])) as Record<VarietyMetric, ClimateWeek[]>
  return { cropId, from, to, asOf, weeks }
}
