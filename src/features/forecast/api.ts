// Harvest Forecast for the app: the shared data functions (data.ts) bound to
// the signed-in user's client, and the React Query hooks.

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import type { ForecastRunRow, ForecastRunWeekRow, SamplingWeekRow } from '../../lib/database.types'
import type { Crop } from '../crops/model'
import { createForecastData } from './data'
import { greenhouseWeekIndex, indexYw, weekOfIndex } from './engine/weeks'

export type { HistoricalReplay, Preview, SamplingCompletion } from './data'

const data = createForecastData(supabase)
export const { loadEngineInput, latestCompletion, computePreview, lockForecast, loadLiveAccuracy, runHistoricalReplay } = data

const check = <T>(res: { data: T | null; error: { message: string } | null }): T => {
  if (res.error) throw new Error(res.error.message)
  return res.data as T
}

export function useLiveAccuracy(crop: Crop | undefined) {
  return useQuery({
    queryKey: ['forecast', 'liveAccuracy', crop?.id],
    enabled: Boolean(crop),
    queryFn: () => loadLiveAccuracy(crop!),
  })
}

/** Whether a sampling completion's data has reached the server (forecast_lock_readiness). */
export async function lockReadiness(samplingEventId: string) {
  const rows = check(await supabase.rpc('forecast_lock_readiness', { p_sampling_event_id: samplingEventId }))
  return rows[0]
}

/** Server-side lock jobs of the crop (their state, for the status line). */
export function useLockJobs(cropId: string | undefined) {
  return useQuery({
    queryKey: ['forecast', 'lockJobs', cropId],
    enabled: Boolean(cropId),
    refetchInterval: 30_000,
    queryFn: async () =>
      check(await supabase.from('forecast_lock_jobs').select('*').eq('crop_id', cropId!).order('created_at', { ascending: false }).limit(20)),
  })
}

// ── Queries ───────────────────────────────────────────────────────────────

export const forecastKeys = {
  runs: (cropId: string | undefined) => ['forecast', 'runs', cropId] as const,
  weeks: (runId: string | undefined) => ['forecast', 'runWeeks', runId] as const,
  sampling: (cropId: string | undefined, year: number) => ['forecast', 'sampling', cropId, year] as const,
}

/** The crop's locked forecasts, newest sampling week first. */
export function useForecastRuns(cropId: string | undefined) {
  return useQuery({
    queryKey: forecastKeys.runs(cropId),
    enabled: Boolean(cropId),
    queryFn: async (): Promise<ForecastRunRow[]> =>
      check(await supabase.from('forecast_runs').select('*').eq('crop_id', cropId!).order('origin_year', { ascending: false }).order('origin_week', { ascending: false })).map(
        (r) => ({ ...r, scale: Number(r.scale), marketing_kg: r.marketing_kg === null ? null : Number(r.marketing_kg), marketing_crop_fruit: Number(r.marketing_crop_fruit), marketing_sample_fruit: Number(r.marketing_sample_fruit) }),
      ),
  })
}

const num = (v: number | null) => (v === null ? null : Number(v))

/** The weeks of one locked forecast. */
export function useForecastRunWeeks(runId: string | undefined) {
  return useQuery({
    queryKey: forecastKeys.weeks(runId),
    enabled: Boolean(runId),
    queryFn: async (): Promise<ForecastRunWeekRow[]> =>
      check(await supabase.from('forecast_run_weeks').select('*').eq('run_id', runId!).order('horizon')).map((w) => ({
        ...w,
        sample_fruit: Number(w.sample_fruit),
        sample_variance: Number(w.sample_variance),
        crop_fruit: Number(w.crop_fruit),
        expected_aborted: Number(w.expected_aborted),
        expected_pruned: Number(w.expected_pruned),
        afw_g: num(w.afw_g),
        kg: num(w.kg),
        cases: num(w.cases),
      })),
  })
}

/** Sampling coverage and completion for the year (sampling_weeks), for the status line. */
export function useSamplingYear(cropId: string | undefined, year: number) {
  return useQuery({
    queryKey: forecastKeys.sampling(cropId, year),
    enabled: Boolean(cropId),
    queryFn: async (): Promise<SamplingWeekRow[]> => check(await supabase.rpc('sampling_weeks', { p_crop_id: cropId!, p_year: year })),
  })
}

/** Reloads forecasts and varieties (a variety's case weight is shown with its forecasts). */
export function useInvalidateForecasts() {
  const queryClient = useQueryClient()
  return () => Promise.all([queryClient.invalidateQueries({ queryKey: ['forecast'] }), queryClient.invalidateQueries({ queryKey: ['crops'] })])
}

/** Saves the crop's case weight (kg per case; null hides cases). */
export async function saveCaseWeight(cropId: string, kg: number | null) {
  check(await supabase.from('crops').update({ case_weight_kg: kg }).eq('id', cropId).select('id'))
}

/** The current greenhouse week. */
export function currentWeek() {
  const index = greenhouseWeekIndex(new Date())
  return { index, ...weekOfIndex(index), yw: indexYw(index) }
}
