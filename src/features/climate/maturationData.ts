// Loads what the maturation study needs for one variety, read-only, as the
// signed-in user (RLS applies). The climate comes only from the canonical
// variety functions; nothing is recombined here.

import { useQuery } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { fetchAll } from '../collector/fetchAll'
import { addDays } from './reports'
import { localDateOf, studyFruits, type Fruit, type StudyClimate, type StudyFlag, type StudyNode, type StudyObservation } from './maturation'
import { analysesInEffect, progressionPoints, type ColourAnalysis, type DatedHarvest, type ProgressionPoint } from './colourProgression'
import { hasHarvestDate } from '../harvests/model'

const check = <T,>(res: { data: T | null; error: { message: string } | null }): T => {
  if (res.error) throw new Error(res.error.message)
  return res.data as T
}

export type MaturationData = {
  fruits: Fruit[]
  climateFrom: string | null
  climateTo: string | null
  /** Colour → harvest points from post-harvest inspections; null when the harvest functions aren't available. */
  progression: { points: ProgressionPoint[]; datedFruit: number; measuredFruit: number } | null
}

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
  return {
    fruits: studyFruits(observations, nodes, visits, studyFlags, climate, timeZone),
    climateFrom,
    climateTo,
    progression: await loadProgression(cropId, observations, nodes, climate, timeZone),
  }
}

/**
 * Colour measurements of fruit with a dated harvest (inferred or confirmed).
 * Null when the harvest functions don't exist yet (database not migrated):
 * the rest of the study still loads.
 */
async function loadProgression(
  cropId: string,
  observations: StudyObservation[],
  nodes: StudyNode[],
  climate: StudyClimate,
  timeZone: string,
): Promise<MaturationData['progression']> {
  const links = await supabase.rpc('fruit_harvest_links', { p_crop_id: cropId })
  if (links.error) {
    console.warn('[maturation] harvest links not available', links.error.message)
    return null
  }
  const crop = check(await supabase.from('crops').select('organization_id').eq('id', cropId).single()) as { organization_id: string }
  const events = check(await supabase.rpc('harvest_events_in_effect', { p_organization_id: crop.organization_id, p_crop_id: cropId }))
  const minColour = new Map(events.map((e) => [e.event_id, Number(e.min_colour_percent)]))
  const dated: DatedHarvest[] = (links.data ?? [])
    .filter((l) => hasHarvestDate(l.link_status) && l.harvest_date && l.link_event_id)
    .map((l) => ({ node: l.plant_node_id, harvestDate: l.harvest_date!, status: l.link_status as DatedHarvest['status'], minColour: minColour.get(l.link_event_id!) ?? null }))
  const analyses = await fetchAll<ColourAnalysis>((after, limit, withCount) => {
    let q = supabase
      .from('photo_colour_analyses')
      .select('id, node_observation_id, kind, combined_percent, confidence, supersedes_id, created_at', withCount ? { count: 'exact' as const } : undefined)
      .eq('crop_id', cropId)
    if (after) q = q.gt('id', after)
    return q.order('id').limit(limit)
  }, (a) => a.id)
  const obsById = new Map(observations.map((o) => [o.id, o]))
  const stemOf = new Map(nodes.map((n) => [n.id, n.measurement_stem_id]))
  const measurements = [...analysesInEffect(analyses.map((a) => ({ ...a, combined_percent: Number(a.combined_percent), confidence: a.confidence === null ? null : Number(a.confidence) }))).values()]
    .map((a) => ({ a, o: obsById.get(a.node_observation_id) }))
    .filter((x) => x.o)
    .map(({ a, o }) => ({
      node: o!.plant_node_id,
      stem: stemOf.get(o!.plant_node_id) ?? '',
      observationId: o!.id,
      at: o!.observed_at,
      percent: a.combined_percent,
      byPerson: a.kind !== 'automatic',
      confidence: a.confidence,
    }))
  const points = progressionPoints(measurements, dated, climate, timeZone)
  return { points, datedFruit: dated.length, measuredFruit: new Set(points.map((p) => p.node)).size }
}

export function useMaturation(cropId: string | undefined, timeZone: string) {
  return useQuery({
    queryKey: ['climate', 'maturation', cropId, timeZone],
    enabled: Boolean(cropId),
    staleTime: 5 * 60_000,
    queryFn: () => loadMaturation(cropId!, timeZone),
  })
}
