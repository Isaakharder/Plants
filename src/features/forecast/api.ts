// Harvest Forecast for the app: the shared data functions (data.ts) bound to
// the signed-in user's client, and the React Query hooks.

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import type { ForecastBasisSettingRow, ForecastRunRow, ForecastRunWeekRow, SamplingWeekRow } from '../../lib/database.types'
import type { Crop } from '../crops/model'
import { createForecastData } from './data'
import { ENGINE_VERSION } from './engine/types'
import type { SourceWeek } from './productionTotals'
import { greenhouseWeekIndex, indexYw, weekOfIndex } from './engine/weeks'

export type { HistoricalReplay, LiveAccuracyResult, Preview, SamplingCompletion, SavedPreview, ValidatedByBasis } from './data'

const data = createForecastData(supabase)
export const { loadEngineInput, latestCompletion, computePreview, generatePreview, latestPreview, inputSignature, lockForecast, loadLiveAccuracy, runHistoricalReplay } = data

/**
 * The newest saved preliminary forecast of a variety and sampling week, and
 * whether the data it was computed from has changed since (outdated): the
 * current signature is re-read whenever the page is shown or refocused.
 */
export function useSavedPreview(cropId: string | undefined, year: number, week: number) {
  const saved = useQuery({
    queryKey: ['forecast', 'preview', cropId, year, week],
    enabled: Boolean(cropId),
    queryFn: () => latestPreview(cropId!, year, week),
  })
  const signature = useQuery({
    queryKey: ['forecast', 'signature', cropId, year, week],
    enabled: Boolean(cropId) && Boolean(saved.data),
    staleTime: 0,
    refetchOnWindowFocus: true,
    queryFn: () => inputSignature(cropId!, year, week),
  })
  const outdated = saved.data && signature.data ? saved.data.inputSignature !== signature.data || saved.data.engineVersion !== ENGINE_VERSION : false
  return { saved: saved.data ?? null, loading: saved.isPending && Boolean(cropId), outdated, error: saved.error ?? signature.error }
}

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

const num = (v: number | null) => (v === null ? null : Number(v))

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
        (r) => ({
          ...r,
          scale: Number(r.scale),
          marketing_kg: num(r.marketing_kg),
          marketing_crop_fruit: num(r.marketing_crop_fruit),
          marketing_sample_fruit: num(r.marketing_sample_fruit),
          harvest_ready_share: num(r.harvest_ready_share),
          coverage: num(r.coverage),
        }),
      ),
  })
}

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

/** The crop's forecast basis settings, newest first (append-only history). */
export function useBasisSettings(cropId: string | undefined) {
  return useQuery({
    queryKey: ['forecast', 'basisSettings', cropId],
    enabled: Boolean(cropId),
    queryFn: async (): Promise<ForecastBasisSettingRow[]> =>
      check(await supabase.from('forecast_basis_settings').select('*').eq('crop_id', cropId!).order('created_at', { ascending: false }).order('id')).map((r) => ({
        ...r,
        harvest_ready_share: r.harvest_ready_share === null ? null : Number(r.harvest_ready_share),
      })),
  })
}

/** Adds a basis setting (from a week on); earlier settings stay in the history. */
export async function addBasisSetting(row: { organizationId: string; cropId: string; fromYear: number; fromWeek: number; basis: 'lifecycle' | 'breaker_only'; share: number | null; note: string | null }) {
  check(
    await supabase
      .from('forecast_basis_settings')
      .insert({
        organization_id: row.organizationId,
        crop_id: row.cropId,
        from_year: row.fromYear,
        from_week: row.fromWeek,
        basis: row.basis,
        harvest_ready_share: row.basis === 'breaker_only' ? row.share : null,
        note: row.note,
      })
      .select('id'),
  )
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

// ── Production Totals ─────────────────────────────────────────────────────

/**
 * Every stored forecast week of the varieties that can target `year`: locked
 * forecasts (their stored weeks) and saved preliminary forecasts (their newest
 * version per sampling week, flagged when its data changed since). Production
 * Totals picks one per variety and week (productionTotals.ts).
 */
export function useProductionSources(cropIds: string[], year: number) {
  return useQuery({
    queryKey: ['forecast', 'productionSources', [...cropIds].sort().join(','), year],
    enabled: cropIds.length > 0,
    queryFn: async (): Promise<SourceWeek[]> => {
      const origins = [year - 1, year]
      const runs = check(
        await supabase.from('forecast_runs').select('id, crop_id, origin_year, origin_week, kind').in('crop_id', cropIds).in('origin_year', origins),
      )
      const runWeeks = runs.length
        ? check(
            await supabase
              .from('forecast_run_weeks')
              .select('run_id, target_year, target_week, available, crop_fruit, kg, cases')
              .in('run_id', runs.map((r) => r.id))
              .eq('target_year', year),
          )
        : []
      const runById = new Map(runs.map((r) => [r.id, r]))
      const locked: SourceWeek[] = runWeeks.map((w) => {
        const r = runById.get(w.run_id)!
        return {
          cropId: r.crop_id,
          targetYw: w.target_year * 100 + w.target_week,
          originYw: r.origin_year * 100 + r.origin_week,
          status: r.kind,
          available: w.available,
          cropFruit: num(w.crop_fruit),
          kg: num(w.kg),
          cases: num(w.cases),
        }
      })

      // Saved preliminary forecasts: only their weeks are read, then the newest version per variety and sampling week.
      type PreviewWeek = { targetYw: number; available?: boolean; cropFruit: number; kg: number | null }
      const previews = check(
        await supabase
          .from('forecast_previews')
          // Only the weeks of the saved preview are read (a JSON path); typed below.
          .select('id, crop_id, origin_year, origin_week, created_at, input_signature, engine_version, weeks:preview->result->weeks' as '*')
          .in('crop_id', cropIds)
          .in('origin_year', origins)
          .order('created_at', { ascending: false }),
      ) as unknown as { id: string; crop_id: string; origin_year: number; origin_week: number; created_at: string; input_signature: string; engine_version: string; weeks: PreviewWeek[] | null }[]
      const newest = new Map<string, (typeof previews)[number]>()
      for (const p of previews) {
        const key = `${p.crop_id}:${p.origin_year}:${p.origin_week}`
        if (!newest.has(key)) newest.set(key, p)
      }
      const latest = [...newest.values()]
      // Whether each one's data changed since it was generated (as on the Harvest Forecast page).
      const outdated = await Promise.all(
        latest.map(async (p) => p.engine_version !== ENGINE_VERSION || (await inputSignature(p.crop_id, p.origin_year, p.origin_week)) !== p.input_signature),
      )
      const preliminary: SourceWeek[] = latest.flatMap((p, i) =>
        (p.weeks ?? [])
          .filter((w) => Math.floor(w.targetYw / 100) === year)
          .map((w) => {
            const available = w.available !== false
            return {
              cropId: p.crop_id,
              targetYw: w.targetYw,
              originYw: p.origin_year * 100 + p.origin_week,
              status: 'preliminary' as const,
              available,
              cropFruit: available ? w.cropFruit : null,
              kg: available ? w.kg : null,
              cases: null,
              outdated: outdated[i],
              createdAt: p.created_at,
            }
          }),
      )
      return [...locked, ...preliminary]
    },
  })
}
