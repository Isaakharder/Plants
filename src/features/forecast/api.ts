// Harvest Forecast for the app: the shared data functions (data.ts) bound to
// the signed-in user's client, and the React Query hooks.

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import type { ForecastBasisSettingRow, ForecastRunRow, ForecastRunWeekRow, SamplingWeekRow } from '../../lib/database.types'
import type { Crop } from '../crops/model'
import { createForecastData } from './data'
import { ENGINE_VERSION } from './engine/types'
import { latestActuals, type Actual, type Snapshot } from './productionHistory'
import { fetchAll } from '../collector/fetchAll'
import { greenhouseWeekIndex, indexYw, weekOfIndex } from './engine/weeks'

export type { LiveAccuracyResult, Preview, SamplingCompletion, SavedPreview, ValidatedByBasis } from './data'

const data = createForecastData(supabase)
export const { loadEngineInput, latestCompletion, computePreview, generatePreview, latestPreview, inputSignature, lockForecast, loadLiveAccuracy } = data

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

/** The crop's locked forecasts (every version), newest sampling week first, its latest revision first. */
export function useForecastRuns(cropId: string | undefined) {
  return useQuery({
    queryKey: forecastKeys.runs(cropId),
    enabled: Boolean(cropId),
    queryFn: async (): Promise<ForecastRunRow[]> =>
      check(await supabase.from('forecast_runs').select('*').eq('crop_id', cropId!).order('origin_year', { ascending: false }).order('origin_week', { ascending: false }).order('revision', { ascending: false })).map(
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

/**
 * Publishes a revised official forecast with another Ready % (a new version;
 * the earlier ones are kept). The server recomputes it from the locked
 * numbers and refuses once the sampling week has ended.
 */
export async function reviseOfficialForecast(runId: string, percent: number, note: string | null) {
  const rows = check(await supabase.rpc('revise_official_forecast', { p_run_id: runId, p_harvest_ready_share: Math.round(percent * 10) / 1000, p_note: note }))
  return rows[0] ?? null
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
 * Production Totals: every saved forecast whose target week is in `years`
 * (locked forecasts and every saved preliminary version, with when each was
 * saved) and the actual kg entered per variety and week. Read as stored; no
 * forecast is recalculated (productionHistory.ts chooses which one counts).
 */
export function useProductionHistory(cropIds: string[], years: number[]) {
  return useQuery({
    queryKey: ['forecast', 'productionHistory', [...cropIds].sort().join(','), years.join(',')],
    enabled: cropIds.length > 0 && years.length > 0,
    queryFn: async (): Promise<{ snapshots: Snapshot[]; actuals: Actual[] }> => {
      const origins = [Math.min(...years) - 1, ...years]
      const inYears = (yw: number) => years.includes(Math.floor(yw / 100))
      const runs = check(
        await supabase.from('forecast_runs').select('id, crop_id, origin_year, origin_week, kind, locked_at').in('crop_id', cropIds).in('origin_year', origins),
      )
      const runWeeks = runs.length
        ? check(
            await supabase
              .from('forecast_run_weeks')
              .select('run_id, target_year, target_week, available, kg')
              .in('run_id', runs.map((r) => r.id))
              .in('target_year', years),
          )
        : []
      const runById = new Map(runs.map((r) => [r.id, r]))
      const locked: Snapshot[] = runWeeks.map((w) => {
        const r = runById.get(w.run_id)!
        return {
          cropId: r.crop_id,
          targetYw: w.target_year * 100 + w.target_week,
          originYw: r.origin_year * 100 + r.origin_week,
          kind: r.kind,
          savedAt: r.locked_at,
          available: w.available,
          kg: w.available ? num(w.kg) : null,
        }
      })

      // Every saved preliminary version (only the weeks of each, a JSON path), read in full.
      type PreviewWeek = { targetYw: number; available?: boolean; kg: number | null }
      type PreviewRow = { id: string; crop_id: string; origin_year: number; origin_week: number; created_at: string; weeks: PreviewWeek[] | null }
      const previews = (await fetchAll((after, limit, withCount) => {
        let q = supabase
          .from('forecast_previews')
          .select('id, crop_id, origin_year, origin_week, created_at, weeks:preview->result->weeks' as '*', withCount ? { count: 'exact' } : undefined)
          .in('crop_id', cropIds)
          .in('origin_year', origins)
        if (after) q = q.gt('id', after)
        return q.order('id').limit(limit)
      }, (r) => (r as unknown as PreviewRow).id)) as unknown as PreviewRow[]
      const preliminary: Snapshot[] = previews.flatMap((p) =>
        (p.weeks ?? [])
          .filter((w) => inYears(w.targetYw))
          .map((w) => ({
            cropId: p.crop_id,
            targetYw: w.targetYw,
            originYw: p.origin_year * 100 + p.origin_week,
            kind: 'preliminary' as const,
            savedAt: p.created_at,
            available: w.available !== false,
            kg: w.available !== false ? num(w.kg) : null,
          })),
      )

      // Every actual-kg entry of the year; the newest per variety and week counts.
      const entries = await fetchAll((after, limit, withCount) => {
        let q = supabase
          .from('weekly_harvest_actuals')
          .select('id, crop_id, year, week, actual_kg, entered_at', withCount ? { count: 'exact' } : undefined)
          .in('crop_id', cropIds)
          .in('year', years)
        if (after) q = q.gt('id', after)
        return q.order('id').limit(limit)
      }, (r) => String(r.id))
      return { snapshots: [...locked, ...preliminary], actuals: latestActuals(entries) }
    },
  })
}
