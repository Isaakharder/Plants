// Loads what the maturation study needs for one variety, read-only, as the
// signed-in user (RLS applies). The climate comes only from the canonical
// variety functions; nothing is recombined here.

import { useQuery } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { fetchAll } from '../collector/fetchAll'
import { addDays } from './reports'
import { localDateOf, studyFruits, type Fruit, type StudyClimate, type StudyFlag, type StudyNode, type StudyObservation } from './maturation'

const check = <T,>(res: { data: T | null; error: { message: string } | null }): T => {
  if (res.error) throw new Error(res.error.message)
  return res.data as T
}

export type MaturationData = { fruits: Fruit[]; climateFrom: string | null; climateTo: string | null }

export async function loadMaturation(cropId: string, timeZone: string): Promise<MaturationData> {
  const count = (withCount: boolean) => (withCount ? { count: 'exact' as const } : undefined)
  const [observations, nodes, checks, flags] = await Promise.all([
    fetchAll<StudyObservation>((after, limit, withCount) => {
      let q = supabase.from('node_observations').select('id, plant_node_id, status, observed_at, recorded_at, created_by', count(withCount)).eq('crop_id', cropId)
      if (after) q = q.gt('id', after)
      return q.order('id').limit(limit)
    }, (o) => o.id),
    fetchAll<StudyNode>((after, limit, withCount) => {
      let q = supabase.from('plant_nodes').select('id, measurement_stem_id, is_active', count(withCount)).eq('crop_id', cropId)
      if (after) q = q.gt('id', after)
      return q.order('id').limit(limit)
    }, (n) => n.id),
    fetchAll<{ id: string; measurement_stem_id: string; checked: boolean; observed_at: string }>((after, limit, withCount) => {
      let q = supabase.from('stem_visits').select('id, measurement_stem_id, checked, observed_at', count(withCount)).eq('crop_id', cropId)
      if (after) q = q.gt('id', after)
      return q.order('id').limit(limit)
    }, (v) => v.id),
    supabase.rpc('crop_quality_flags', { p_crop_id: cropId }).then(check),
  ])

  // Explicit "✓ Stem checked" per stem and day (the latest of a day wins; a retraction cancels it).
  // Growth readings and other fruits' records aren't evidence that a given fruit was looked at.
  const visits = new Map<string, Set<string>>()
  const add = (stem: string | undefined, iso: string) => stem && (visits.get(stem) ?? visits.set(stem, new Set()).get(stem)!).add(localDateOf(iso, timeZone))
  const latestCheck = new Map<string, { at: string; checked: boolean }>()
  for (const c of checks) {
    const key = `${c.measurement_stem_id}|${localDateOf(c.observed_at, timeZone)}`
    const cur = latestCheck.get(key)
    if (!cur || c.observed_at > cur.at) latestCheck.set(key, { at: c.observed_at, checked: c.checked })
  }
  for (const [key, c] of latestCheck) if (c.checked) add(key.split('|')[0], c.at)

  const studyFlags: StudyFlag[] = (flags as { scope: string; plant_node_id: string | null; rule_id: string; review_decision: string | null }[])
    .filter((f) => f.scope === 'node' && f.plant_node_id)
    .map((f) => ({ node: f.plant_node_id!, rule_id: f.rule_id, review_decision: f.review_decision }))

  // The variety's daily climate over the whole study period (one request: crop_climate_daily).
  const dates = observations.map((o) => localDateOf(o.observed_at, timeZone)).sort()
  const climate: StudyClimate = { daily: new Map(), radiationFinal: new Map() }
  let climateFrom: string | null = null
  let climateTo: string | null = null
  if (dates.length) {
    const rows = check(
      await supabase.rpc('crop_climate_daily', { p_crop_id: cropId, p_from: addDays(dates[0], -1), p_to: addDays(dates[dates.length - 1], 1) }).select('local_date, metric, value, status, hours'),
    ) as unknown as { local_date: string; metric: string; value: number | null; status: string; hours: number }[]
    for (const d of rows) {
      if (d.value === null) continue
      if (d.metric === 'radiation_sum') {
        if (d.status === 'final') climate.radiationFinal.set(d.local_date, Number(d.value))
        continue
      }
      const k = d.metric === 'air_temperature' ? 'temp' : d.metric === 'relative_humidity' ? 'rh' : d.metric === 'co2' ? 'co2' : null
      if (!k || !(d.hours > 0)) continue
      const day = climate.daily.get(d.local_date) ?? climate.daily.set(d.local_date, {}).get(d.local_date)!
      day[k] = { mean: Number(d.value), hours: d.hours }
    }
    const covered = [...climate.daily.keys()].sort()
    climateFrom = covered[0] ?? null
    climateTo = covered[covered.length - 1] ?? null
  }
  return { fruits: studyFruits(observations, nodes, visits, studyFlags, climate, timeZone), climateFrom, climateTo }
}

export function useMaturation(cropId: string | undefined, timeZone: string) {
  return useQuery({
    queryKey: ['climate', 'maturation', cropId, timeZone],
    enabled: Boolean(cropId),
    staleTime: 5 * 60_000,
    queryFn: () => loadMaturation(cropId!, timeZone),
  })
}
